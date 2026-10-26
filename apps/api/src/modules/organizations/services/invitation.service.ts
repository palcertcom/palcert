import { Injectable } from '@nestjs/common';
import {
  AppError,
  InvitationStatus,
  MembershipStatus,
  PalCertErrorCode,
  RoleCode,
  RoleScope,
  SecurityEventType,
  buildPage,
  decodeCursor,
  encodeCursor,
  getRoleDefinition,
  isGlobalRole,
  resolveLimit,
  type InvitationPreview,
  type OrganizationInvitationSummary,
  type Page,
} from '@palcert/contracts';
import { normalizeEmail } from '../../../common/crypto/email-normalizer';
import { generateSecretToken, hashSecretToken } from '../../../common/crypto/secret-token';
import { ApiConfigService } from '../../../config/api-config.service';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import {
  TenantPrismaService,
  type TenantClient,
} from '../../../infrastructure/tenant/tenant-prisma.service';
import { ClockPort } from '../../auth/ports/clock.port';
import { MailDeliveryPort, MailTemplate } from '../../auth/ports/mail.port';
import { SecurityEventService } from '../../auth/services/security-event.service';
import type { TenantContext } from '../tenant-context';

/** Invitations expire well before a credential token would; a week is generous. */
const INVITATION_TTL_MINUTES = 7 * 24 * 60;

@Injectable()
export class InvitationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantPrismaService,
    private readonly config: ApiConfigService,
    private readonly clock: ClockPort,
    private readonly mail: MailDeliveryPort,
    private readonly events: SecurityEventService,
  ) {}

  /**
   * Invite an address to join in a specific organization role.
   *
   * The role is resolved and validated here, then stored on the invitation row.
   * Acceptance reads it from that row and never from the client, which is what
   * makes the intended role unforgeable (§30).
   */
  async invite(
    context: TenantContext,
    params: { email: string; roleCode: string },
  ): Promise<OrganizationInvitationSummary> {
    if (isGlobalRole(params.roleCode)) {
      throw new AppError(PalCertErrorCode.ROLE_SCOPE_INVALID, {
        message: 'Platform roles cannot be granted through an organization invitation.',
        details: { roleCode: params.roleCode },
      });
    }

    const definition = getRoleDefinition(params.roleCode);
    if (definition === undefined || definition.scope !== RoleScope.ORGANIZATION) {
      throw new AppError(PalCertErrorCode.ROLE_SCOPE_INVALID, {
        message: 'Unknown organization role.',
        details: { roleCode: params.roleCode },
      });
    }

    if (
      params.roleCode === RoleCode.ORGANIZATION_OWNER &&
      !context.permissions.has('organization:ownership:transfer')
    ) {
      throw new AppError(PalCertErrorCode.ORGANIZATION_ACCESS_DENIED, {
        message: 'Only an organization owner can invite another owner.',
      });
    }

    const role = await this.prisma.role.findUniqueOrThrow({ where: { code: params.roleCode } });
    const normalizedEmail = normalizeEmail(params.email);
    const token = generateSecretToken();
    const expiresAt = this.clock.plusMinutes(INVITATION_TTL_MINUTES);

    const invitation = await this.tenant.withTenant(
      { organizationId: context.organizationId, userId: context.userId },
      async (tx) => {
        // Already a member? Say so rather than sending a useless invitation.
        const existingMember = await tx.organizationMembership.findFirst({
          where: {
            organizationId: context.organizationId,
            status: { in: [MembershipStatus.ACTIVE, MembershipStatus.SUSPENDED] },
            user: { normalizedEmail },
          },
        });
        if (existingMember !== null) {
          throw new AppError(PalCertErrorCode.MEMBERSHIP_ALREADY_EXISTS, {
            message: 'That person is already a member of this organization.',
          });
        }

        // Retire any lapsed invitation first, so the partial unique index on
        // (organization, email) WHERE status='PENDING' reflects reality.
        await this.expireLapsedInvitations(tx, context.organizationId);

        const pending = await tx.organizationInvitation.findFirst({
          where: {
            organizationId: context.organizationId,
            normalizedEmail,
            status: InvitationStatus.PENDING,
          },
        });
        if (pending !== null) {
          throw new AppError(PalCertErrorCode.INVITATION_ALREADY_PENDING, {
            message: 'An invitation for that address is already outstanding.',
          });
        }

        return tx.organizationInvitation.create({
          data: {
            organizationId: context.organizationId,
            email: params.email.trim(),
            normalizedEmail,
            roleId: role.id,
            scope: RoleScope.ORGANIZATION,
            tokenHash: token.hash,
            status: InvitationStatus.PENDING,
            expiresAt,
            invitedByUserId: context.userId,
          },
        });
      },
    );

    const organization = await this.tenant.withTenant(
      { organizationId: context.organizationId, userId: context.userId },
      async (tx) =>
        tx.organization.findUniqueOrThrow({
          where: { id: context.organizationId },
          select: { displayName: true, defaultLocale: true },
        }),
    );

    await this.mail.send({
      to: params.email.trim(),
      locale: organization.defaultLocale,
      template: MailTemplate.ORGANIZATION_INVITATION,
      variables: {
        token: token.raw,
        url: `${this.config.publicWebUrl}/${organization.defaultLocale}/invitations/accept?token=${encodeURIComponent(token.raw)}`,
        organizationName: organization.displayName,
        roleCode: params.roleCode,
        expiresAt: expiresAt.toISOString(),
      },
    });

    await this.events.record({
      type: SecurityEventType.MEMBER_INVITED,
      actorUserId: context.userId,
      metadata: {
        organizationId: context.organizationId,
        role: params.roleCode,
        invitationId: invitation.id,
      },
      requestId: context.requestId,
    });
    await this.events.audit({
      action: 'MEMBER_INVITED',
      actorUserId: context.userId,
      targetType: 'OrganizationInvitation',
      targetId: invitation.id,
      requestId: context.requestId,
      // The address is recorded; the token never is.
      afterState: {
        organizationId: context.organizationId,
        email: normalizedEmail,
        role: params.roleCode,
      },
    });

    return this.toSummary(invitation, params.roleCode);
  }

  async list(
    context: TenantContext,
    page: { cursor?: string | undefined; limit?: number | undefined },
  ): Promise<Page<OrganizationInvitationSummary>> {
    const limit = resolveLimit(page.limit);
    const decoded = page.cursor === undefined ? null : decodeCursor(page.cursor);
    if (page.cursor !== undefined && decoded === null) {
      throw new AppError(PalCertErrorCode.VALIDATION_FAILED, { message: 'Invalid cursor.' });
    }

    return this.tenant.withTenant(
      { organizationId: context.organizationId, userId: context.userId },
      async (tx) => {
        await this.expireLapsedInvitations(tx, context.organizationId);

        const rows = await tx.organizationInvitation.findMany({
          where: {
            organizationId: context.organizationId,
            ...(decoded !== null
              ? {
                  OR: [
                    { createdAt: { lt: new Date(decoded.sortValue) } },
                    { createdAt: new Date(decoded.sortValue), id: { lt: decoded.id } },
                  ],
                }
              : {}),
          },
          include: { role: { select: { code: true } } },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: limit + 1,
        });

        return buildPage(
          rows.map((row) => this.toSummary(row, row.role.code)),
          limit,
          (row) => encodeCursor(row.createdAt, row.id),
        );
      },
    );
  }

  async revoke(context: TenantContext, invitationId: string): Promise<void> {
    await this.tenant.withTenant(
      { organizationId: context.organizationId, userId: context.userId },
      async (tx) => {
        // Scoped by organization as well as id: an invitation id from another
        // tenant must read as "not found", not as "forbidden".
        const invitation = await tx.organizationInvitation.findFirst({
          where: { id: invitationId, organizationId: context.organizationId },
        });
        if (invitation === null) {
          throw new AppError(PalCertErrorCode.INVITATION_NOT_FOUND, {
            message: 'Invitation not found.',
          });
        }
        if (invitation.status !== InvitationStatus.PENDING) {
          throw new AppError(PalCertErrorCode.CONFLICT, {
            message: 'Only an outstanding invitation can be revoked.',
            details: { status: invitation.status },
          });
        }

        await tx.organizationInvitation.update({
          where: { id: invitationId },
          data: {
            status: InvitationStatus.REVOKED,
            revokedAt: this.clock.now(),
            revokedByUserId: context.userId,
          },
        });
      },
    );

    await this.events.record({
      type: SecurityEventType.INVITATION_REVOKED,
      actorUserId: context.userId,
      metadata: { organizationId: context.organizationId, invitationId },
      requestId: context.requestId,
    });
    await this.events.audit({
      action: 'INVITATION_REVOKED',
      actorUserId: context.userId,
      targetType: 'OrganizationInvitation',
      targetId: invitationId,
      requestId: context.requestId,
      beforeState: { status: InvitationStatus.PENDING },
      afterState: { status: InvitationStatus.REVOKED },
    });
  }

  /**
   * Describe an invitation to its recipient, before they accept.
   *
   * Deliberately minimal (§32): the organization's display name, the role and
   * the expiry — nothing about its members, size or internal state. Someone who
   * guesses a token learns only what they would need in order to decide whether
   * to accept.
   */
  async preview(rawToken: string): Promise<InvitationPreview> {
    const invitation = await this.loadUsableInvitation(rawToken);

    const organization = await this.tenant.withTenant(
      { organizationId: invitation.organizationId, userId: '' },
      async (tx) =>
        tx.organization.findUniqueOrThrow({
          where: { id: invitation.organizationId },
          select: { displayName: true },
        }),
    );

    // `roles` and `users` are not tenant-scoped, so these need no context.
    const [role, existingUser] = await Promise.all([
      this.prisma.role.findUniqueOrThrow({
        where: { id: invitation.roleId },
        select: { code: true },
      }),
      this.prisma.user.findUnique({
        where: { normalizedEmail: invitation.normalizedEmail },
        select: { id: true },
      }),
    ]);

    return {
      organizationDisplayName: organization.displayName,
      roleCode: role.code,
      expiresAt: invitation.expiresAt.toISOString(),
      requiresRegistration: existingUser === null,
    };
  }

  /**
   * Accept an invitation and create the membership.
   *
   * The organization and role come exclusively from the stored invitation. The
   * accepting user must be signed in as the invited address — otherwise anyone
   * who intercepted the link could join with an account of their choosing.
   */
  async accept(params: {
    rawToken: string;
    userId: string;
    requestId: string | null;
  }): Promise<{ organizationId: string; roleCode: string }> {
    const invitation = await this.loadUsableInvitation(params.rawToken);

    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: params.userId },
      select: { normalizedEmail: true },
    });

    // Same normalization as account identity, so `Ali@x.com` accepts an
    // invitation addressed to `ali@x.com` (§62).
    if (user.normalizedEmail !== invitation.normalizedEmail) {
      throw new AppError(PalCertErrorCode.INVITATION_EMAIL_MISMATCH, {
        message: 'This invitation was sent to a different email address.',
      });
    }

    const role = await this.prisma.role.findUniqueOrThrow({
      where: { id: invitation.roleId },
      select: { id: true, code: true, scope: true },
    });

    // Defence in depth: the invitation table has a check constraint and a
    // composite foreign key enforcing this, but a stored row is still verified
    // before it is acted upon.
    if (role.scope !== RoleScope.ORGANIZATION) {
      throw new AppError(PalCertErrorCode.ROLE_SCOPE_INVALID, {
        message: 'This invitation is not valid.',
        internalContext: { invitationId: invitation.id, roleCode: role.code },
      });
    }

    await this.tenant.withTenant(
      { organizationId: invitation.organizationId, userId: params.userId },
      async (tx) => {
        // Consume atomically: the update is conditional on the invitation still
        // being PENDING, so two concurrent acceptances cannot both succeed.
        const consumed = await tx.organizationInvitation.updateMany({
          where: { id: invitation.id, status: InvitationStatus.PENDING },
          data: {
            status: InvitationStatus.ACCEPTED,
            acceptedAt: this.clock.now(),
            acceptedByUserId: params.userId,
          },
        });
        if (consumed.count !== 1) {
          throw new AppError(PalCertErrorCode.INVITATION_ALREADY_USED, {
            message: 'This invitation has already been used.',
          });
        }

        const existing = await tx.organizationMembership.findUnique({
          where: {
            organizationId_userId: {
              organizationId: invitation.organizationId,
              userId: params.userId,
            },
          },
        });

        if (existing === null) {
          await tx.organizationMembership.create({
            data: {
              organizationId: invitation.organizationId,
              userId: params.userId,
              status: MembershipStatus.ACTIVE,
              joinedAt: this.clock.now(),
              invitedByUserId: invitation.invitedByUserId,
              invitationId: invitation.id,
            },
          });
        } else {
          // A previously removed member re-joining through a fresh invitation.
          await tx.organizationMembership.update({
            where: { id: existing.id },
            data: {
              status: MembershipStatus.ACTIVE,
              suspendedAt: null,
              removedAt: null,
              joinedAt: this.clock.now(),
              invitationId: invitation.id,
            },
          });
        }

        await tx.userRole.create({
          data: {
            userId: params.userId,
            roleId: role.id,
            organizationId: invitation.organizationId,
            scope: RoleScope.ORGANIZATION,
            grantedByUserId: invitation.invitedByUserId,
          },
        });
      },
    );

    await this.events.record({
      type: SecurityEventType.INVITATION_ACCEPTED,
      userId: params.userId,
      actorUserId: params.userId,
      metadata: {
        organizationId: invitation.organizationId,
        invitationId: invitation.id,
        role: role.code,
      },
      requestId: params.requestId,
    });
    await this.events.audit({
      action: 'INVITATION_ACCEPTED',
      actorUserId: params.userId,
      targetType: 'OrganizationInvitation',
      targetId: invitation.id,
      requestId: params.requestId,
      afterState: { organizationId: invitation.organizationId, role: role.code },
    });

    return { organizationId: invitation.organizationId, roleCode: role.code };
  }

  /**
   * Look up an invitation by token and reject every unusable state.
   *
   * The recipient is by definition not yet a member, so there is no tenant
   * context to inherit. Rather than reading past row-level security, the token
   * digest is exchanged for its organization id through
   * `app_organization_for_invitation`, and the row is then read under ordinary
   * tenant policies — so this path is not an exception to the isolation model,
   * only a way of entering it.
   */
  private async loadUsableInvitation(rawToken: string) {
    const tokenHash = hashSecretToken(rawToken);

    const resolved = await this.prisma.$queryRaw<Array<{ organization_id: string | null }>>`
      SELECT app_organization_for_invitation(${tokenHash}) AS organization_id
    `;
    const organizationId = resolved[0]?.organization_id ?? null;

    const invitation =
      organizationId === null
        ? null
        : await this.tenant.withTenant({ organizationId, userId: '' }, async (tx) =>
            tx.organizationInvitation.findUnique({ where: { tokenHash } }),
          );

    if (invitation === null) {
      throw new AppError(PalCertErrorCode.INVITATION_NOT_FOUND, {
        message: 'This invitation link is not valid.',
      });
    }

    if (invitation.status === InvitationStatus.REVOKED) {
      throw new AppError(PalCertErrorCode.INVITATION_REVOKED, {
        message: 'This invitation has been withdrawn.',
      });
    }
    if (invitation.status === InvitationStatus.ACCEPTED) {
      throw new AppError(PalCertErrorCode.INVITATION_ALREADY_USED, {
        message: 'This invitation has already been used.',
      });
    }
    if (
      invitation.status === InvitationStatus.EXPIRED ||
      invitation.expiresAt.getTime() <= this.clock.now().getTime()
    ) {
      throw new AppError(PalCertErrorCode.INVITATION_EXPIRED, {
        message: 'This invitation has expired. Ask for a new one.',
      });
    }

    return invitation;
  }

  /** Materialize EXPIRED so the stored status always matches reality (§31). */
  private async expireLapsedInvitations(tx: TenantClient, organizationId: string): Promise<void> {
    await tx.organizationInvitation.updateMany({
      where: {
        organizationId,
        status: InvitationStatus.PENDING,
        expiresAt: { lte: this.clock.now() },
      },
      data: { status: InvitationStatus.EXPIRED },
    });
  }

  private toSummary(
    invitation: {
      id: string;
      email: string;
      status: string;
      invitedByUserId: string;
      expiresAt: Date;
      createdAt: Date;
    },
    roleCode: string,
  ): OrganizationInvitationSummary {
    return {
      id: invitation.id,
      email: invitation.email,
      roleCode,
      status: invitation.status as InvitationStatus,
      invitedByUserId: invitation.invitedByUserId,
      expiresAt: invitation.expiresAt.toISOString(),
      createdAt: invitation.createdAt.toISOString(),
    };
  }
}
