import { WithdrawalScope } from '@palcert/contracts';
import type {
  TenantClient,
  TenantPrismaService,
} from '../../infrastructure/tenant/tenant-prisma.service';
import type { WithdrawalOwner } from './withdrawal-support';

/**
 * Run work in the database scope the owner's money lives in.
 *
 * A user's own rows under their own identity; an organization's under that
 * organization's tenant context; PalCert's under the audited platform
 * elevation. RLS is therefore the boundary even if a route forgot a check:
 * a user context cannot see another user's destinations, and an organization
 * context cannot see another organization's.
 */
export function runAs<T>(
  tenant: TenantPrismaService,
  owner: WithdrawalOwner,
  reason: string,
  work: (tx: TenantClient) => Promise<T>,
): Promise<T> {
  switch (owner.scope) {
    case WithdrawalScope.USER:
      return tenant.withUser(owner.userId, work);
    case WithdrawalScope.ORGANIZATION:
      return tenant.withTenant(
        { organizationId: owner.organizationId, userId: owner.userId },
        work,
      );
    default:
      return tenant.withPlatformAdmin({ actorUserId: owner.userId, reason }, work);
  }
}

/** The `where` that names exactly this owner's rows, on top of RLS. */
export function ownerWhere(owner: WithdrawalOwner): {
  scope: WithdrawalScope;
  ownerUserId?: string;
  organizationId?: string | null;
} {
  switch (owner.scope) {
    case WithdrawalScope.USER:
      return { scope: WithdrawalScope.USER, ownerUserId: owner.userId };
    case WithdrawalScope.ORGANIZATION:
      return { scope: WithdrawalScope.ORGANIZATION, organizationId: owner.organizationId };
    default:
      return { scope: WithdrawalScope.PLATFORM };
  }
}
