import { Injectable } from '@nestjs/common';
import {
  AppError,
  MembershipStatus,
  PalCertErrorCode,
  RoleCode,
  RoleScope,
  SecurityEventType,
  buildPage,
  canTransitionMembershipStatus,
  decodeCursor,
  encodeCursor,
  getRoleDefinition,
  isGlobalRole,
  resolveLimit,
  type OrganizationMember,
  type Page,
} from '@palcert/contracts';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import {
  TenantPrismaService,
  type TenantClient,
} from '../../../infrastructure/tenant/tenant-prisma.service';
import { SecurityEventService } from '../../auth/services/security-event.service';
import { ClockPort } from '../../auth/ports/clock.port';
import type { TenantContext } from '../tenant-context';

@Injectable()
export class MembershipService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantPrismaService,
    private readonly events: SecurityEventService,
    private readonly clock: ClockPort,
  ) {}

  async list(
    context: TenantContext,
    page: { cursor?: string | undefined; limit?: number | undefined },
  ): Promise<Page<OrganizationMember>> {
    const limit = resolveLimit(page.limit);
    const decoded = page.cursor === undefined ? null : decodeCursor(page.cursor);
    if (page.cursor !== undefined && decoded === null) {
      throw new AppError(PalCertErrorCode.VALIDATION_FAILED, { message: 'Invalid cursor.' });
    }

    return this.tenant.withTenant(
      { organizationId: context.organizationId, userId: context.userId },
      async (tx) => {
        const rows = await tx.organizationMembership.findMany({
          where: {
            organizationId: context.organizationId,
            status: { in: [MembershipStatus.ACTIVE, MembershipStatus.SUSPENDED] },
            ...(decoded !== null
              ? {
                  OR: [
                    { joinedAt: { gt: new Date(decoded.sortValue) } },
                    { joinedAt: new Date(decoded.sortValue), id: { gt: decoded.id } },
                  ],
                }
              : {}),
          },
          include: { user: { select: { id: true, email: true, displayName: true } } },
          orderBy: [{ joinedAt: 'asc' }, { id: 'asc' }],
          take: limit + 1,
        });

        const roles = await tx.userRole.findMany({
          where: {
            organizationId: context.organizationId,
            userId: { in: rows.map((row) => row.userId) },
          },
          include: { role: { select: { code: true } } },
        });

        const rolesByUser = new Map<string, string[]>();
        for (const row of roles) {
          const existing = rolesByUser.get(row.userId) ?? [];
          existing.push(row.role.code);
          rolesByUser.set(row.userId, existing);
        }

        const members: OrganizationMember[] = rows.map((row) => ({
          membershipId: row.id,
          userId: row.userId,
          email: row.user.email,
          displayName: row.user.displayName,
          status: row.status as MembershipStatus,
          roles: rolesByUser.get(row.userId) ?? [],
          joinedAt: row.joinedAt.toISOString(),
          suspendedAt: row.suspendedAt?.toISOString() ?? null,
        }));

        return buildPage(members, limit, (member) =>
          encodeCursor(member.joinedAt, member.membershipId),
        );
      },
    );
  }

  /**
   * Change a member's status.
   *
   * Strictly organization-local: it never touches the user's PalCert account,
   * their sessions, or their standing in any other organization (§39). A
   * suspended member's next request to *this* organization is refused by
   * `TenantResolverService`, while their requests to other organizations are
   * unaffected.
   */
  async changeStatus(
    context: TenantContext,
    membershipId: string,
    to: MembershipStatus,
  ): Promise<OrganizationMember> {
    return this.tenant.withTenant(
      { organizationId: context.organizationId, userId: context.userId },
      async (tx) => {
        const membership = await this.findMembershipInTenant(tx, context, membershipId);
        const from = membership.status as MembershipStatus;

        if (!canTransitionMembershipStatus(from, to)) {
          throw new AppError(PalCertErrorCode.CONFLICT, {
            message: `A membership cannot move from ${from} to ${to}.`,
            details: { from, to },
          });
        }

        // Losing ACTIVE means potentially losing the last owner, so the
        // invariant is checked inside the same transaction as the write.
        if (from === MembershipStatus.ACTIVE) {
          await this.assertNotLastActiveOwner(tx, context.organizationId, membership.userId);
        }

        const now = this.clock.now();
        const updated = await tx.organizationMembership.update({
          where: { id: membershipId },
          data: {
            status: to,
            suspendedAt: to === MembershipStatus.SUSPENDED ? now : null,
            ...(to === MembershipStatus.REMOVED ? { removedAt: now } : {}),
          },
          include: { user: { select: { id: true, email: true, displayName: true } } },
        });

        // Removing a member also removes their organization roles: leaving them
        // would let a re-invited person silently regain former powers.
        if (to === MembershipStatus.REMOVED) {
          await tx.userRole.deleteMany({
            where: { userId: membership.userId, organizationId: context.organizationId },
          });
        }

        const eventType =
          to === MembershipStatus.SUSPENDED
            ? SecurityEventType.MEMBER_SUSPENDED
            : to === MembershipStatus.REMOVED
              ? SecurityEventType.MEMBER_REMOVED
              : SecurityEventType.MEMBER_REACTIVATED;

        await this.events.record({
          type: eventType,
          userId: membership.userId,
          actorUserId: context.userId,
          metadata: { organizationId: context.organizationId, from, to },
          requestId: context.requestId,
        });
        await this.events.audit({
          action: eventType,
          actorUserId: context.userId,
          targetType: 'OrganizationMembership',
          targetId: membershipId,
          requestId: context.requestId,
          beforeState: { status: from, organizationId: context.organizationId },
          afterState: { status: to, organizationId: context.organizationId },
        });

        const roles = await tx.userRole.findMany({
          where: { userId: membership.userId, organizationId: context.organizationId },
          include: { role: { select: { code: true } } },
        });

        return {
          membershipId: updated.id,
          userId: updated.userId,
          email: updated.user.email,
          displayName: updated.user.displayName,
          status: updated.status as MembershipStatus,
          roles: roles.map((row) => row.role.code),
          joinedAt: updated.joinedAt.toISOString(),
          suspendedAt: updated.suspendedAt?.toISOString() ?? null,
        };
      },
    );
  }

  /**
   * Grant an organization role.
   *
   * Every check that matters happens here and inside one transaction:
   * the role exists, its scope is ORGANIZATION, the target is a member of
   * *this* organization, and granting ownership requires the ownership
   * permission rather than mere role-assignment rights (§36).
   */
  async assignRole(
    context: TenantContext,
    membershipId: string,
    roleCode: string,
  ): Promise<string[]> {
    // A global role code must be refused before anything else: this is the
    // escalation path an attacker would try (§37).
    if (isGlobalRole(roleCode)) {
      throw new AppError(PalCertErrorCode.ROLE_SCOPE_INVALID, {
        message: 'Platform roles cannot be granted through an organization.',
        details: { roleCode },
      });
    }

    const definition = getRoleDefinition(roleCode);
    if (definition === undefined || definition.scope !== RoleScope.ORGANIZATION) {
      throw new AppError(PalCertErrorCode.ROLE_SCOPE_INVALID, {
        message: 'Unknown organization role.',
        details: { roleCode },
      });
    }

    // Only an owner may create another owner.
    if (
      roleCode === RoleCode.ORGANIZATION_OWNER &&
      !context.permissions.has('organization:ownership:transfer')
    ) {
      throw new AppError(PalCertErrorCode.ORGANIZATION_ACCESS_DENIED, {
        message: 'Only an organization owner can grant the owner role.',
      });
    }

    return this.tenant.withTenant(
      { organizationId: context.organizationId, userId: context.userId },
      async (tx) => {
        const membership = await this.findMembershipInTenant(tx, context, membershipId);
        if (membership.status !== MembershipStatus.ACTIVE) {
          throw new AppError(PalCertErrorCode.MEMBERSHIP_SUSPENDED, {
            message: 'Only an active member can hold a role.',
          });
        }

        const role = await this.prisma.role.findUnique({ where: { code: roleCode } });
        if (role === null) {
          throw new AppError(PalCertErrorCode.ROLE_SCOPE_INVALID, {
            message: 'Unknown organization role.',
          });
        }

        const existing = await tx.userRole.findFirst({
          where: {
            userId: membership.userId,
            roleId: role.id,
            organizationId: context.organizationId,
          },
        });

        if (existing === null) {
          await tx.userRole.create({
            data: {
              userId: membership.userId,
              roleId: role.id,
              organizationId: context.organizationId,
              scope: RoleScope.ORGANIZATION,
              grantedByUserId: context.userId,
            },
          });

          await this.events.record({
            type: SecurityEventType.ORGANIZATION_ROLE_ASSIGNED,
            userId: membership.userId,
            actorUserId: context.userId,
            metadata: { organizationId: context.organizationId, role: roleCode },
            requestId: context.requestId,
          });
          await this.events.audit({
            action: 'ORGANIZATION_ROLE_ASSIGNED',
            actorUserId: context.userId,
            targetType: 'OrganizationMembership',
            targetId: membershipId,
            requestId: context.requestId,
            afterState: { role: roleCode, organizationId: context.organizationId },
          });
        }

        return this.rolesFor(tx, membership.userId, context.organizationId);
      },
    );
  }

  async removeRole(
    context: TenantContext,
    membershipId: string,
    roleCode: string,
  ): Promise<string[]> {
    return this.tenant.withTenant(
      { organizationId: context.organizationId, userId: context.userId },
      async (tx) => {
        const membership = await this.findMembershipInTenant(tx, context, membershipId);

        const role = await this.prisma.role.findUnique({ where: { code: roleCode } });
        if (role === null) {
          throw new AppError(PalCertErrorCode.NOT_FOUND, { message: 'Role assignment not found.' });
        }

        // Removing the owner role from the last owner would strand the
        // organization, so it is refused in the same transaction as the delete.
        if (roleCode === RoleCode.ORGANIZATION_OWNER) {
          await this.assertNotLastActiveOwner(tx, context.organizationId, membership.userId);
        }

        const deleted = await tx.userRole.deleteMany({
          where: {
            userId: membership.userId,
            roleId: role.id,
            organizationId: context.organizationId,
          },
        });

        if (deleted.count === 0) {
          throw new AppError(PalCertErrorCode.NOT_FOUND, { message: 'Role assignment not found.' });
        }

        await this.events.record({
          type: SecurityEventType.ORGANIZATION_ROLE_REMOVED,
          userId: membership.userId,
          actorUserId: context.userId,
          metadata: { organizationId: context.organizationId, role: roleCode },
          requestId: context.requestId,
        });
        await this.events.audit({
          action: 'ORGANIZATION_ROLE_REMOVED',
          actorUserId: context.userId,
          targetType: 'OrganizationMembership',
          targetId: membershipId,
          requestId: context.requestId,
          beforeState: { role: roleCode, organizationId: context.organizationId },
        });

        return this.rolesFor(tx, membership.userId, context.organizationId);
      },
    );
  }

  /**
   * Transfer ownership to another active member.
   *
   * Done as one transaction in which the new owner is granted *before* the old
   * one is downgraded, so there is no instant at which the organization has no
   * owner (§35). Because the grant happens first, the last-owner check on the
   * downgrade sees two owners and passes legitimately.
   */
  async transferOwnership(
    context: TenantContext,
    params: { toMembershipId: string; stepDown: boolean },
  ): Promise<{ newOwnerUserId: string; previousOwnerRetainedOwnership: boolean }> {
    return this.tenant.withTenant(
      { organizationId: context.organizationId, userId: context.userId },
      async (tx) => {
        const target = await this.findMembershipInTenant(tx, context, params.toMembershipId);

        if (target.status !== MembershipStatus.ACTIVE) {
          throw new AppError(PalCertErrorCode.MEMBERSHIP_SUSPENDED, {
            message: 'Ownership can only be transferred to an active member.',
          });
        }
        if (target.userId === context.userId) {
          throw new AppError(PalCertErrorCode.VALIDATION_FAILED, {
            message: 'You already own this organization.',
          });
        }

        const ownerRole = await this.prisma.role.findUniqueOrThrow({
          where: { code: RoleCode.ORGANIZATION_OWNER },
        });

        // Grant first — the organization now has two owners.
        const alreadyOwner = await tx.userRole.findFirst({
          where: {
            userId: target.userId,
            roleId: ownerRole.id,
            organizationId: context.organizationId,
          },
        });
        if (alreadyOwner === null) {
          await tx.userRole.create({
            data: {
              userId: target.userId,
              roleId: ownerRole.id,
              organizationId: context.organizationId,
              scope: RoleScope.ORGANIZATION,
              grantedByUserId: context.userId,
            },
          });
        }

        // Then optionally step down — safe, because an owner still remains.
        if (params.stepDown) {
          await this.assertNotLastActiveOwner(tx, context.organizationId, context.userId);
          await tx.userRole.deleteMany({
            where: {
              userId: context.userId,
              roleId: ownerRole.id,
              organizationId: context.organizationId,
            },
          });
        }

        await this.events.record({
          type: SecurityEventType.ORGANIZATION_OWNERSHIP_TRANSFERRED,
          userId: target.userId,
          actorUserId: context.userId,
          metadata: {
            organizationId: context.organizationId,
            steppedDown: params.stepDown,
          },
          requestId: context.requestId,
        });
        await this.events.audit({
          action: 'ORGANIZATION_OWNERSHIP_TRANSFERRED',
          actorUserId: context.userId,
          targetType: 'Organization',
          targetId: context.organizationId,
          requestId: context.requestId,
          beforeState: { owner: context.userId },
          afterState: { owner: target.userId, previousOwnerSteppedDown: params.stepDown },
        });

        return {
          newOwnerUserId: target.userId,
          previousOwnerRetainedOwnership: !params.stepDown,
        };
      },
    );
  }

  /**
   * Refuse an operation that would leave the organization with no active owner.
   *
   * `FOR UPDATE` locks the owner rows for the duration of the transaction, so
   * two concurrent removals cannot each observe "two owners exist" and both
   * proceed. This is the reason the invariant lives in a transaction rather
   * than in a check constraint, which cannot express a cross-row rule (§34).
   */
  private async assertNotLastActiveOwner(
    tx: TenantClient,
    organizationId: string,
    userId: string,
  ): Promise<void> {
    const owners = await tx.$queryRaw<Array<{ user_id: string }>>`
      SELECT ur.user_id
      FROM user_roles ur
      JOIN roles r ON r.id = ur.role_id
      JOIN organization_memberships m
        ON m.user_id = ur.user_id AND m.organization_id = ur.organization_id
      WHERE ur.organization_id = ${organizationId}::uuid
        AND r.code = ${RoleCode.ORGANIZATION_OWNER}
        AND m.status = 'ACTIVE'
      FOR UPDATE OF ur
    `;

    const isOwner = owners.some((row) => row.user_id === userId);
    if (isOwner && owners.length <= 1) {
      throw new AppError(PalCertErrorCode.LAST_OWNER_REQUIRED, {
        message:
          'This organization must always have at least one active owner. Transfer ownership first.',
      });
    }
  }

  private async findMembershipInTenant(
    tx: TenantClient,
    context: TenantContext,
    membershipId: string,
  ): Promise<{ id: string; userId: string; status: string }> {
    // Scoped by organization as well as id: even though row-level security
    // already confines this query to the tenant, the application must not rely
    // on that alone (§15 — RLS is defence in depth, never the only control).
    const membership = await tx.organizationMembership.findFirst({
      where: { id: membershipId, organizationId: context.organizationId },
      select: { id: true, userId: true, status: true },
    });

    if (membership === null) {
      throw new AppError(PalCertErrorCode.MEMBERSHIP_NOT_FOUND, {
        message: 'Member not found.',
      });
    }
    return membership;
  }

  private async rolesFor(
    tx: TenantClient,
    userId: string,
    organizationId: string,
  ): Promise<string[]> {
    const rows = await tx.userRole.findMany({
      where: { userId, organizationId },
      include: { role: { select: { code: true } } },
    });
    return rows.map((row) => row.role.code);
  }
}
