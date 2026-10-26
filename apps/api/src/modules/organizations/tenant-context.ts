import type { MembershipStatus, OrganizationStatus } from '@palcert/contracts';
import type { AuthenticatedRequest } from '../auth/authenticated-request';

/**
 * A *verified* tenant context.
 *
 * The existence of this object on a request is the proof that the caller's
 * membership and permissions in this organization were checked server-side. An
 * organization id arriving in a route, header, query or body is only a
 * selector; it becomes a context solely by passing `OrganizationContextGuard`
 * (§12, ADR-0017).
 */
export interface TenantContext {
  readonly organizationId: string;
  readonly organizationSlug: string;
  readonly organizationStatus: OrganizationStatus;
  readonly userId: string;
  readonly membershipId: string;
  readonly membershipStatus: MembershipStatus;
  /** Organization roles held by the caller *in this organization only*. */
  readonly roles: readonly string[];
  /** Permissions effective in this organization. Never platform-wide ones. */
  readonly permissions: ReadonlySet<string>;
  /** True when access was granted by platform-admin elevation, not membership. */
  readonly viaPlatformAdmin: boolean;
  readonly requestId: string | null;
}

export interface TenantRequest extends AuthenticatedRequest {
  tenant?: TenantContext;
}
