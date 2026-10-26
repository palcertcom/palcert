import { Injectable } from '@nestjs/common';
import {
  AppError,
  MembershipStatus,
  OrganizationStatus,
  Permission,
  PalCertErrorCode,
  SecurityEventType,
  membershipPermitsAccess,
  organizationPermitsAccess,
} from '@palcert/contracts';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { TenantPrismaService } from '../../../infrastructure/tenant/tenant-prisma.service';
import { SecurityEventService } from '../../auth/services/security-event.service';
import type { RequestPrincipal } from '../../auth/authenticated-request';
import type { TenantContext } from '../tenant-context';

export interface ResolveTenantParams {
  readonly principal: RequestPrincipal;
  readonly organizationId: string;
  readonly allowPlatformAdmin: boolean;
  readonly requestId: string | null;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
  readonly method: string;
  readonly path: string;
}

/**
 * The one place a tenant context is created (§13).
 *
 * Controllers never resolve tenancy themselves. Everything that could grant or
 * deny organization access — existence, membership, membership status,
 * organization status, role resolution, platform-admin elevation — happens
 * here, so there is a single implementation to review and a single place a
 * mistake could live.
 */
@Injectable()
export class TenantResolverService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantPrismaService,
    private readonly events: SecurityEventService,
  ) {}

  async resolve(params: ResolveTenantParams): Promise<TenantContext> {
    const { principal, organizationId } = params;

    // Read through the caller's own user context, never elevated.
    //
    // Row-level security then does half the work for us: a non-member sees null
    // for both lookups, which is exactly the "indistinguishable from
    // non-existent" behaviour §14 requires — the application does not have to
    // remember to fake it.
    const { organization, membership } = await this.tenant.withUser(
      principal.userId,
      async (tx) => ({
        organization: await tx.organization.findUnique({
          where: { id: organizationId },
          select: { id: true, slug: true, status: true },
        }),
        membership: await tx.organizationMembership.findUnique({
          where: { organizationId_userId: { organizationId, userId: principal.userId } },
          select: { id: true, status: true },
        }),
      }),
    );

    const isPlatformAdmin =
      params.allowPlatformAdmin && principal.permissions.has(Permission.ADMIN_ORGANIZATION_READ);

    // Staff reaching a tenant they do not belong to: the only case that needs
    // to see past row-level security, and it is opt-in per route.
    if (organization === null && membership === null && isPlatformAdmin) {
      const elevated = await this.tenant.withPlatformAdmin(
        {
          actorUserId: principal.userId,
          organizationId,
          reason: `Administrative access: ${params.method} ${params.path}`,
        },
        async (tx) =>
          tx.organization.findUnique({
            where: { id: organizationId },
            select: { id: true, slug: true, status: true },
          }),
      );

      if (elevated !== null) {
        await this.events.record({
          type: SecurityEventType.PLATFORM_ADMIN_TENANT_ACCESS,
          userId: principal.userId,
          actorUserId: principal.userId,
          metadata: { organizationId, method: params.method, path: params.path },
          requestId: params.requestId,
          ipAddress: params.ipAddress,
          userAgent: params.userAgent,
        });

        return {
          organizationId: elevated.id,
          organizationSlug: elevated.slug,
          organizationStatus: elevated.status as OrganizationStatus,
          userId: principal.userId,
          membershipId: '',
          membershipStatus: MembershipStatus.ACTIVE,
          roles: [],
          // Elevation grants exactly the platform permissions the caller already
          // holds — never the organization's own permission set.
          permissions: principal.permissions,
          viaPlatformAdmin: true,
          requestId: params.requestId,
        };
      }
    }

    // Non-existent and inaccessible are reported identically, so a caller
    // cannot probe for which organization ids are real (§14, §65).
    if (organization === null || (membership === null && !isPlatformAdmin)) {
      await this.recordDenial(params, organization === null ? 'NOT_FOUND' : 'NOT_A_MEMBER');
      throw new AppError(PalCertErrorCode.ORGANIZATION_NOT_FOUND, {
        message: 'Organization not found.',
        internalContext: {
          organizationId,
          userId: principal.userId,
          reason: organization === null ? 'NOT_FOUND' : 'NOT_A_MEMBER',
        },
      });
    }

    // From here the caller is a genuine member.
    const activeMembership = membership!;

    if (!membershipPermitsAccess(activeMembership.status as MembershipStatus)) {
      await this.recordDenial(params, `MEMBERSHIP_${activeMembership.status}`);
      throw new AppError(
        activeMembership.status === MembershipStatus.SUSPENDED
          ? PalCertErrorCode.MEMBERSHIP_SUSPENDED
          : PalCertErrorCode.ORGANIZATION_NOT_FOUND,
        {
          message:
            activeMembership.status === MembershipStatus.SUSPENDED
              ? 'Your access to this organization is suspended.'
              : 'Organization not found.',
        },
      );
    }

    if (!organizationPermitsAccess(organization.status as OrganizationStatus)) {
      await this.recordDenial(params, `ORGANIZATION_${organization.status}`);
      throw new AppError(
        organization.status === OrganizationStatus.SUSPENDED
          ? PalCertErrorCode.ORGANIZATION_SUSPENDED
          : PalCertErrorCode.ORGANIZATION_CLOSED,
        {
          message:
            organization.status === OrganizationStatus.SUSPENDED
              ? 'This organization is suspended. Please contact PalCert support.'
              : 'This organization has been closed.',
        },
      );
    }

    const { roles, permissions } = await this.resolveOrganizationAuthorization(
      principal.userId,
      organizationId,
    );

    return {
      organizationId: organization.id,
      organizationSlug: organization.slug,
      organizationStatus: organization.status as OrganizationStatus,
      userId: principal.userId,
      membershipId: activeMembership.id,
      membershipStatus: activeMembership.status as MembershipStatus,
      roles,
      permissions,
      viaPlatformAdmin: false,
      requestId: params.requestId,
    };
  }

  /**
   * Resolve the caller's roles and permissions *in one organization*.
   *
   * Scoped by `organizationId`, so a role held in another organization
   * contributes nothing. This is what makes "owner of A has zero authority over
   * B" true rather than merely intended (§7).
   */
  async resolveOrganizationAuthorization(
    userId: string,
    organizationId: string,
  ): Promise<{ roles: string[]; permissions: Set<string> }> {
    const assignments = await this.tenant.withTenant({ organizationId, userId }, async (tx) =>
      tx.userRole.findMany({
        where: { userId, organizationId },
        include: { role: { include: { permissions: { include: { permission: true } } } } },
      }),
    );

    const roles: string[] = [];
    const permissions = new Set<string>();

    for (const assignment of assignments) {
      roles.push(assignment.role.code);
      for (const rolePermission of assignment.role.permissions) {
        permissions.add(rolePermission.permission.code);
      }
    }

    return { roles, permissions };
  }

  private async recordDenial(params: ResolveTenantParams, reason: string): Promise<void> {
    await this.events.record({
      type: SecurityEventType.CROSS_TENANT_ACCESS_DENIED,
      userId: params.principal.userId,
      actorUserId: params.principal.userId,
      metadata: {
        organizationId: params.organizationId,
        reason,
        method: params.method,
        path: params.path,
      },
      requestId: params.requestId,
      ipAddress: params.ipAddress,
      userAgent: params.userAgent,
    });
  }
}
