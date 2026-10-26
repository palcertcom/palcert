import { Injectable } from '@nestjs/common';
import {
  type AdminOrganizationDetailView,
  type AdminOverviewView,
  AppError,
  MembershipStatus,
  OrganizationStatus,
  OrganizationVerificationStatus,
  PalCertErrorCode,
  RoleCode,
  RoleScope,
  SecurityEventType,
  buildPage,
  decodeCursor,
  encodeCursor,
  resolveLimit,
  type OrganizationMembershipSummary,
  type OrganizationProfile,
  type OrganizationType,
  type Page,
} from '@palcert/contracts';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { TenantPrismaService } from '../../../infrastructure/tenant/tenant-prisma.service';
import { SecurityEventService } from '../../auth/services/security-event.service';
import { ClockPort } from '../../auth/ports/clock.port';
import type { TenantContext } from '../tenant-context';
import { isValidSlug, normalizeSlug, slugCandidateFromName } from './slug.service';

export interface CreateOrganizationParams {
  readonly userId: string;
  readonly type: OrganizationType;
  readonly legalName: string;
  readonly displayName: string;
  readonly slug?: string | undefined;
  readonly countryCode: string;
  readonly timezone: string;
  readonly website?: string | undefined;
  readonly defaultLocale: string;
  readonly requestId: string | null;
  readonly ipAddress: string | null;
}

@Injectable()
export class OrganizationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantPrismaService,
    private readonly events: SecurityEventService,
    private readonly clock: ClockPort,
  ) {}

  /**
   * Create an organization and make the creator its owner.
   *
   * The whole thing is one transaction (§6): an organization that exists
   * without an owner would be unreachable by anyone, including the person who
   * created it, and would need manual repair. The tenant context is set to the
   * new organization's id *before* the inserts so the row-level security
   * WITH CHECK clauses are satisfied by the same mechanism that protects every
   * other write — no elevation, no exception carved out for creation.
   */
  async create(params: CreateOrganizationParams): Promise<OrganizationProfile> {
    const organizationId = randomUUID();
    const slug = await this.resolveAvailableSlug(params.slug, params.displayName);

    const ownerRole = await this.prisma.role.findUnique({
      where: { code: RoleCode.ORGANIZATION_OWNER },
    });
    if (ownerRole === null) {
      throw new AppError(PalCertErrorCode.INTERNAL_ERROR, {
        message: 'Organization creation is temporarily unavailable.',
        internalContext: { reason: 'ORGANIZATION_OWNER role missing — run migrations' },
      });
    }

    const organization = await this.tenant.withTenant(
      { organizationId, userId: params.userId },
      async (tx) => {
        const created = await tx.organization.create({
          data: {
            id: organizationId,
            type: params.type,
            legalName: params.legalName.trim(),
            displayName: params.displayName.trim(),
            slug,
            countryCode: params.countryCode.toUpperCase(),
            timezone: params.timezone,
            website: params.website?.trim() || null,
            defaultLocale: params.defaultLocale,
            status: OrganizationStatus.ACTIVE,
            verificationStatus: OrganizationVerificationStatus.UNVERIFIED,
            createdByUserId: params.userId,
          },
        });

        await tx.organizationMembership.create({
          data: {
            organizationId,
            userId: params.userId,
            status: MembershipStatus.ACTIVE,
            joinedAt: this.clock.now(),
          },
        });

        // The composite foreign key to organization_memberships means this
        // insert can only succeed because the membership above exists.
        await tx.userRole.create({
          data: {
            userId: params.userId,
            roleId: ownerRole.id,
            organizationId,
            scope: RoleScope.ORGANIZATION,
            grantedByUserId: params.userId,
          },
        });

        return created;
      },
    );

    await this.events.record({
      type: SecurityEventType.ORGANIZATION_CREATED,
      userId: params.userId,
      actorUserId: params.userId,
      metadata: { organizationId, type: params.type },
      requestId: params.requestId,
      ipAddress: params.ipAddress,
    });
    await this.events.audit({
      action: 'ORGANIZATION_CREATED',
      actorUserId: params.userId,
      targetType: 'Organization',
      targetId: organizationId,
      requestId: params.requestId,
      ipAddress: params.ipAddress,
      afterState: { slug, type: params.type, displayName: organization.displayName },
    });

    return this.toProfile(organization, 1);
  }

  /**
   * Organizations the caller belongs to (§48).
   *
   * Runs with a user context and no tenant, so row-level security exposes only
   * rows reachable through the caller's own memberships. This endpoint is not a
   * directory: it cannot return an organization the caller has no standing in,
   * even if it wanted to.
   */
  async listForUser(userId: string): Promise<OrganizationMembershipSummary[]> {
    return this.tenant.withUser(userId, async (tx) => {
      const memberships = await tx.organizationMembership.findMany({
        where: { userId, status: { in: [MembershipStatus.ACTIVE, MembershipStatus.SUSPENDED] } },
        include: { organization: true },
        orderBy: [{ joinedAt: 'desc' }, { id: 'desc' }],
      });

      // Inside the same user context: the user_roles policy lets a caller see
      // their own assignments, which is what makes a cross-organization view
      // possible without any elevation.
      const roleRows = await tx.userRole.findMany({
        where: { userId, organizationId: { in: memberships.map((m) => m.organizationId) } },
        include: { role: { select: { code: true } } },
      });

      const rolesByOrganization = new Map<string, string[]>();
      for (const row of roleRows) {
        if (row.organizationId === null) continue;
        const existing = rolesByOrganization.get(row.organizationId) ?? [];
        existing.push(row.role.code);
        rolesByOrganization.set(row.organizationId, existing);
      }

      return memberships.map((membership) => ({
        organization: {
          id: membership.organization.id,
          slug: membership.organization.slug,
          displayName: membership.organization.displayName,
          type: membership.organization.type as OrganizationType,
          status: membership.organization.status as OrganizationStatus,
          verificationStatus: membership.organization
            .verificationStatus as OrganizationVerificationStatus,
          countryCode: membership.organization.countryCode,
        },
        membershipId: membership.id,
        membershipStatus: membership.status,
        roles: rolesByOrganization.get(membership.organizationId) ?? [],
        joinedAt: membership.joinedAt.toISOString(),
      }));
    });
  }

  async getProfile(context: TenantContext): Promise<OrganizationProfile> {
    return this.tenant.withTenant(
      { organizationId: context.organizationId, userId: context.userId },
      async (tx) => {
        const organization = await tx.organization.findUnique({
          where: { id: context.organizationId },
        });
        if (organization === null) {
          throw new AppError(PalCertErrorCode.ORGANIZATION_NOT_FOUND, {
            message: 'Organization not found.',
          });
        }

        const memberCount = await tx.organizationMembership.count({
          where: { organizationId: context.organizationId, status: MembershipStatus.ACTIVE },
        });

        return this.toProfile(organization, memberCount);
      },
    );
  }

  /**
   * Update the mutable profile fields.
   *
   * The parameter type lists exactly what an organization user may change.
   * Verification status, operational status, creation metadata and internal
   * notes are absent by construction, not filtered out afterwards (§23).
   */
  async updateProfile(
    context: TenantContext,
    changes: {
      displayName?: string;
      legalName?: string;
      website?: string | null;
      countryCode?: string;
      timezone?: string;
      defaultLocale?: string;
      type?: OrganizationType;
    },
  ): Promise<OrganizationProfile> {
    const profile = await this.tenant.withTenant(
      { organizationId: context.organizationId, userId: context.userId },
      async (tx) => {
        const before = await tx.organization.findUniqueOrThrow({
          where: { id: context.organizationId },
        });

        const updated = await tx.organization.update({
          where: { id: context.organizationId },
          data: {
            ...(changes.displayName !== undefined
              ? { displayName: changes.displayName.trim() }
              : {}),
            ...(changes.legalName !== undefined ? { legalName: changes.legalName.trim() } : {}),
            ...(changes.website !== undefined ? { website: changes.website?.trim() || null } : {}),
            ...(changes.countryCode !== undefined
              ? { countryCode: changes.countryCode.toUpperCase() }
              : {}),
            ...(changes.timezone !== undefined ? { timezone: changes.timezone } : {}),
            ...(changes.defaultLocale !== undefined
              ? { defaultLocale: changes.defaultLocale }
              : {}),
            ...(changes.type !== undefined ? { type: changes.type } : {}),
          },
        });

        const memberCount = await tx.organizationMembership.count({
          where: { organizationId: context.organizationId, status: MembershipStatus.ACTIVE },
        });

        await this.events.audit({
          action: 'ORGANIZATION_PROFILE_UPDATED',
          actorUserId: context.userId,
          targetType: 'Organization',
          targetId: context.organizationId,
          requestId: context.requestId,
          beforeState: {
            displayName: before.displayName,
            legalName: before.legalName,
            website: before.website,
            countryCode: before.countryCode,
            timezone: before.timezone,
            type: before.type,
          },
          afterState: {
            displayName: updated.displayName,
            legalName: updated.legalName,
            website: updated.website,
            countryCode: updated.countryCode,
            timezone: updated.timezone,
            type: updated.type,
          },
        });

        return this.toProfile(updated, memberCount);
      },
    );

    await this.events.record({
      type: SecurityEventType.ORGANIZATION_PROFILE_UPDATED,
      userId: context.userId,
      actorUserId: context.userId,
      metadata: { organizationId: context.organizationId },
      requestId: context.requestId,
    });

    return profile;
  }

  /** Administrative listing across all tenants, via the explicit elevated path. */
  async listAllForAdmin(params: {
    actorUserId: string;
    cursor?: string | undefined;
    limit?: number | undefined;
    requestId: string | null;
  }): Promise<Page<OrganizationProfile>> {
    const limit = resolveLimit(params.limit);
    const decoded = params.cursor === undefined ? null : decodeCursor(params.cursor);

    if (params.cursor !== undefined && decoded === null) {
      throw new AppError(PalCertErrorCode.VALIDATION_FAILED, { message: 'Invalid cursor.' });
    }

    const rows = await this.tenant.withPlatformAdmin(
      { actorUserId: params.actorUserId, reason: 'Administrative organization listing' },
      async (tx) =>
        tx.organization.findMany({
          // Stable sort: a non-unique column plus the primary key, so rows can
          // never be skipped or repeated across pages.
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: limit + 1,
          ...(decoded !== null
            ? {
                where: {
                  OR: [
                    { createdAt: { lt: new Date(decoded.sortValue) } },
                    { createdAt: new Date(decoded.sortValue), id: { lt: decoded.id } },
                  ],
                },
              }
            : {}),
        }),
    );

    return buildPage(
      rows.map((row) => this.toProfile(row, 0)),
      limit,
      (row) => encodeCursor(row.createdAt, row.id),
    );
  }

  private async resolveAvailableSlug(
    requested: string | undefined,
    displayName: string,
  ): Promise<string> {
    if (requested !== undefined && requested.trim() !== '') {
      const normalized = normalizeSlug(requested);
      if (!isValidSlug(normalized)) {
        throw new AppError(PalCertErrorCode.VALIDATION_FAILED, {
          message:
            'The organization handle must be 3-63 characters of lowercase letters, digits and hyphens, and must not be a reserved word.',
          details: { slug: normalized },
        });
      }
      if (await this.slugTaken(normalized)) {
        throw new AppError(PalCertErrorCode.ORGANIZATION_SLUG_TAKEN, {
          message: 'That organization handle is already in use.',
          details: { slug: normalized },
        });
      }
      return normalized;
    }

    // Derive one, appending a numeric suffix until it is free. Bounded so a
    // pathological name cannot spin.
    const stem = slugCandidateFromName(displayName);
    if (!(await this.slugTaken(stem))) return stem;

    for (let suffix = 2; suffix <= 100; suffix += 1) {
      const candidate = `${stem}-${suffix}`;
      if (!(await this.slugTaken(candidate))) return candidate;
    }

    // Fall back to something guaranteed unique rather than failing the request.
    return `${stem}-${randomUUID().slice(0, 8)}`;
  }

  /**
   * Slug availability is inherently a global-namespace question: a caller must
   * not be able to claim a handle that row-level security hides from them.
   * `app_slug_available` is a SECURITY DEFINER function that answers with a
   * single boolean — strictly less than the resulting 409 already discloses.
   */
  private async slugTaken(slug: string): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<Array<{ available: boolean }>>`
      SELECT app_slug_available(${slug}) AS available
    `;
    return rows[0]?.available !== true;
  }

  /**
   * One organization as PalCert staff see it (admin console).
   *
   * Cross-tenant by nature, so it goes through the logged platform-admin
   * elevation like every other staff read. Unlike the admin listing, the
   * member count here is real: it is counted, not defaulted.
   */
  async getForAdmin(params: {
    actorUserId: string;
    organizationId: string;
    includeInternalNotes: boolean;
  }): Promise<AdminOrganizationDetailView> {
    return this.tenant.withPlatformAdmin(
      {
        actorUserId: params.actorUserId,
        organizationId: params.organizationId,
        reason: 'Administrative organization review',
      },
      async (tx) => {
        const organization = await tx.organization.findUnique({
          where: { id: params.organizationId },
          include: {
            verificationRequests: { orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }], take: 20 },
          },
        });
        if (organization === null) {
          throw new AppError(PalCertErrorCode.ORGANIZATION_NOT_FOUND, {
            message: 'Organization not found.',
          });
        }
        const memberCount = await tx.organizationMembership.count({
          where: { organizationId: organization.id, status: MembershipStatus.ACTIVE },
        });
        return {
          organization: this.toProfile(organization, memberCount),
          suspendedAt: organization.suspendedAt?.toISOString() ?? null,
          suspensionReason: organization.suspensionReason ?? null,
          verificationRequests: organization.verificationRequests.map((request) => ({
            id: request.id,
            status: request.status,
            requestedAt: request.requestedAt.toISOString(),
            submissionNote: request.submissionNote,
            reviewedAt: request.reviewedAt?.toISOString() ?? null,
            decisionReason: request.decisionReason,
            ...(params.includeInternalNotes ? { internalNotes: request.internalNotes } : {}),
          })),
        };
      },
    );
  }

  /**
   * Platform-wide counts for the staff dashboard: what the database says now,
   * grouped, and nothing derived.
   */
  async overviewForAdmin(actorUserId: string): Promise<AdminOverviewView> {
    return this.tenant.withPlatformAdmin(
      { actorUserId, reason: 'Administrative platform overview' },
      async (tx) => {
        const [byStatus, byVerification, pending, users] = await Promise.all([
          tx.organization.groupBy({ by: ['status'], _count: { _all: true } }),
          tx.organization.groupBy({ by: ['verificationStatus'], _count: { _all: true } }),
          tx.organizationVerificationRequest.count({ where: { status: 'PENDING' } }),
          tx.user.groupBy({ by: ['status'], _count: { _all: true } }),
        ]);
        const tally = (rows: readonly { _count: { _all: number } }[], key: string) =>
          Object.fromEntries(
            rows.map((row) => [(row as unknown as Record<string, string>)[key], row._count._all]),
          );
        return {
          generatedAt: this.clock.now().toISOString(),
          organizations: {
            total: byStatus.reduce((sum, row) => sum + row._count._all, 0),
            byStatus: tally(byStatus, 'status'),
            byVerificationStatus: tally(byVerification, 'verificationStatus'),
            pendingVerificationRequests: pending,
          },
          users: {
            total: users.reduce((sum, row) => sum + row._count._all, 0),
            byStatus: tally(users, 'status'),
          },
        };
      },
    );
  }

  private toProfile(
    organization: {
      id: string;
      slug: string;
      displayName: string;
      legalName: string;
      type: string;
      status: string;
      verificationStatus: string;
      countryCode: string;
      website: string | null;
      defaultLocale: string;
      timezone: string;
      createdAt: Date;
      updatedAt: Date;
    },
    memberCount: number,
  ): OrganizationProfile {
    return {
      id: organization.id,
      slug: organization.slug,
      displayName: organization.displayName,
      legalName: organization.legalName,
      type: organization.type as OrganizationType,
      status: organization.status as OrganizationStatus,
      verificationStatus: organization.verificationStatus as OrganizationVerificationStatus,
      countryCode: organization.countryCode,
      website: organization.website,
      defaultLocale: organization.defaultLocale,
      timezone: organization.timezone,
      createdAt: organization.createdAt.toISOString(),
      updatedAt: organization.updatedAt.toISOString(),
      memberCount,
    };
  }
}
