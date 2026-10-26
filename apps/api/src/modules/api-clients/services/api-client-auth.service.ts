import { Injectable, Logger } from '@nestjs/common';
import {
  AppError,
  isApiClientScope,
  OrganizationStatus,
  PalCertErrorCode,
  type ApiClientScope,
} from '@palcert/contracts';
import { MetricsService } from '../../../infrastructure/metrics/metrics.service';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import { TenantPrismaService } from '../../../infrastructure/tenant/tenant-prisma.service';
import type { MachinePrincipal } from '../machine-principal';
import { ApiClientCredentialService } from './api-client-credential.service';

/** Why a credential was refused. Recorded server-side; never sent to the caller. */
type RefusalReason =
  | 'MALFORMED'
  | 'UNKNOWN_CLIENT'
  | 'CLIENT_DISABLED'
  | 'CLIENT_REVOKED'
  | 'CLIENT_EXPIRED'
  | 'ORGANIZATION_NOT_ACTIVE'
  | 'NO_LIVE_SECRET'
  | 'SECRET_MISMATCH'
  | 'OVERLAP_ELAPSED';

export interface PresentedCredential {
  readonly clientId: string;
  readonly secret: string;
}

/**
 * Turning a presented credential into a machine principal (Phase 19).
 *
 * **One rejection for every cause.** Unknown client id, wrong secret, revoked,
 * disabled, expired, organization suspended — all of them return the same
 * error, the same status and the same body. The difference between two
 * rejections is an oracle: a caller that can tell "no such client" from "wrong
 * secret" can enumerate which client ids exist, and one that can tell
 * "disabled" from "revoked" learns an organization's internal state. The real
 * reason is logged, where the administrator who needs it can see it.
 *
 * **Argon2 runs at most once per request, and only for a well-formed secret.**
 * The shape check is free; the verification is not. Without that order a caller
 * sending garbage could make PalCert spend memory-hard work on their behalf.
 *
 * **This path holds no tenant context.** Which organization the caller belongs
 * to is the question being answered, so it cannot also be the premise. The
 * credential lookup and the verifier comparison are reached through the
 * explicit system-context flag instead, which the database bounds to a read
 * plus the one bookkeeping column — see the migration's "The system context".
 */
@Injectable()
export class ApiClientAuthService {
  private readonly logger = new Logger(ApiClientAuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenant: TenantPrismaService,
    private readonly credentials: ApiClientCredentialService,
    private readonly metrics: MetricsService,
  ) {}

  async authenticate(
    presented: PresentedCredential,
    context: { readonly requestId: string | null; readonly ipAddress: string | null },
  ): Promise<MachinePrincipal> {
    const now = new Date();

    // Shape first, and before any database work. A malformed credential is
    // refused without a lookup, so a scanner cannot use PalCert's own index to
    // measure anything.
    if (
      !this.credentials.looksLikeClientId(presented.clientId) ||
      !this.credentials.looksLikeSecret(presented.secret)
    ) {
      this.refuse('MALFORMED', presented.clientId, context);
    }

    const client = await this.withSystemRead(async (tx) =>
      tx.apiClient.findUnique({
        where: { clientId: presented.clientId },
        include: {
          secrets: {
            where: { status: { in: ['ACTIVE', 'ROTATING_OUT'] } },
            orderBy: { createdAt: 'desc' },
          },
        },
      }),
    );

    if (client === null) {
      // A wasted Argon2 verification against a dummy verifier would equalize
      // timing here. It is deliberately *not* done: the throttle in front of
      // this path already caps how many measurements an attacker can take, and
      // burning memory-hard work on every unknown id would hand them a cheap
      // amplification lever instead. Timing is mitigated by the rate limit,
      // not by making every request expensive.
      this.refuse('UNKNOWN_CLIENT', presented.clientId, context);
    }

    if (client.status === 'REVOKED') this.refuse('CLIENT_REVOKED', presented.clientId, context);
    if (client.status === 'DISABLED') this.refuse('CLIENT_DISABLED', presented.clientId, context);
    if (client.expiresAt !== null && client.expiresAt.getTime() <= now.getTime()) {
      this.refuse('CLIENT_EXPIRED', presented.clientId, context);
    }

    // A credential is only as live as the organization behind it. A suspended
    // institution's integrations stop with the institution, without anybody
    // having to remember to revoke them one by one.
    //
    // Read under tenant context rather than joined into the lookup above, and
    // the distinction matters. `organizations` is a Phase-2 tenant table whose
    // policy answers `id = app_current_organization()`; a join from the
    // system-context read would return null and the check would quietly pass on
    // an unreadable row. The organization id used here is the one on the
    // credential row PalCert just read — never anything the caller sent — so
    // establishing that context is a consequence of the lookup, not a claim
    // being trusted, and it is the same context the request will run under.
    const organization = await this.tenant.withTenant(
      { organizationId: client.organizationId, userId: '' },
      (tx) =>
        tx.organization.findFirst({
          where: { id: client.organizationId },
          select: { status: true },
        }),
    );

    if (organization === null || organization.status !== OrganizationStatus.ACTIVE) {
      this.refuse('ORGANIZATION_NOT_ACTIVE', presented.clientId, context);
    }

    // Live means "not swept yet" in the database and "still inside its
    // overlap" here. The sweeper is hygiene; this is the authority, so a row
    // nobody swept does not still work.
    const usable = client.secrets.filter(
      (secret) =>
        secret.status === 'ACTIVE' ||
        (secret.overlapEndsAt !== null && secret.overlapEndsAt.getTime() > now.getTime()),
    );

    if (usable.length === 0) {
      const elapsed = client.secrets.length > 0;
      this.refuse(elapsed ? 'OVERLAP_ELAPSED' : 'NO_LIVE_SECRET', presented.clientId, context);
    }

    // At most two, by the partial unique indexes. Active first, so the normal
    // case costs one verification and only a request still using the previous
    // secret during an overlap costs two.
    const rank = (status: string): number => (status === 'ACTIVE' ? 0 : 1);
    const ordered = [...usable].sort((a, b) => rank(a.status) - rank(b.status));

    let matched: (typeof ordered)[number] | null = null;
    for (const secret of ordered) {
      if (await this.credentials.verifySecret(presented.secret, secret.secretVerifier)) {
        matched = secret;
        break;
      }
    }

    if (matched === null) this.refuse('SECRET_MISMATCH', presented.clientId, context);

    const scopes = new Set<ApiClientScope>(
      client.scopes.filter((scope): scope is ApiClientScope => isApiClientScope(scope)),
    );

    await this.recordUse(client.id, matched.id, now);
    // Outcome only. Splitting this by reason would rebuild on the metrics
    // endpoint precisely the enumeration oracle the refusal path exists to
    // deny; the reason is logged, where an administrator can see it.
    this.metrics.apiClientAuth.inc({ outcome: 'succeeded' });

    return {
      kind: 'API_CLIENT',
      apiClientId: client.id,
      clientId: client.clientId,
      organizationId: client.organizationId,
      displayName: client.displayName,
      scopes,
      secretId: matched.id,
    };
  }

  /**
   * Record that the credential was used, to the minute.
   *
   * Truncated deliberately: an administrator's questions are "has this been
   * used?" and "is anything still calling?", and both are answered at minute
   * resolution. Second-level timestamps across a set of clients start to
   * describe a customer's internal schedule, which is not PalCert's to publish
   * back to them.
   *
   * Best-effort, and outside the authentication decision. A failed bookkeeping
   * write must never turn a valid credential into a 401 — the caller did
   * nothing wrong and retrying would not help them.
   */
  private async recordUse(apiClientId: string, secretId: string, now: Date): Promise<void> {
    const minute = new Date(now);
    minute.setSeconds(0, 0);
    try {
      await this.withSystemWrite(async (tx) => {
        // Bookkeeping must never make a revocation wait. If the lifecycle path
        // holds the rows, this gives up rather than queueing behind it — the
        // catch below is already the answer for "could not record".
        await tx.$executeRaw`SET LOCAL lock_timeout = '250ms'`;
        // Secret before client, which is the order `revoke` uses. Two writers
        // taking the same two rows in opposite orders is a deadlock, and it was
        // one: PostgreSQL reported 40P01 and killed whichever transaction it
        // chose, so a revocation could fail because somebody used the
        // credential at the same moment. Same order, no cycle.
        await tx.apiClientSecret.update({
          where: { id: secretId },
          data: { lastUsedAt: minute },
        });
        await tx.apiClient.update({ where: { id: apiClientId }, data: { lastUsedAt: minute } });
      });
    } catch (error) {
      this.logger.warn({ apiClientId, err: error }, 'Could not record API client usage');
    }
  }

  /**
   * Refuse, loudly in the log and identically on the wire.
   *
   * The client id is logged because it is public and an administrator
   * investigating needs it. **The secret never is**, in any branch, at any
   * level — it is not a parameter of this method and there is nowhere for it to
   * arrive.
   */
  private refuse(
    reason: RefusalReason,
    clientId: string,
    context: { readonly requestId: string | null; readonly ipAddress: string | null },
  ): never {
    this.logger.warn(
      {
        reason,
        // Only when it is well-formed. An arbitrary string from a caller must
        // not be written into the log verbatim.
        clientId: this.credentials.looksLikeClientId(clientId) ? clientId : null,
        requestId: context.requestId,
        ipAddress: context.ipAddress,
      },
      'API client authentication refused',
    );
    this.metrics.apiClientAuth.inc({ outcome: 'refused' });
    throw new AppError(PalCertErrorCode.API_CLIENT_AUTHENTICATION_FAILED, {
      message: 'The credential could not be authenticated.',
    });
  }

  /**
   * Read the API-client tables, announcing the intent.
   *
   * Not `withTenant`: the tenant is what is being determined. The flag is set
   * inside the transaction and PostgreSQL discards it at COMMIT and ROLLBACK,
   * so a pooled connection cannot carry it into the next request.
   */
  private async withSystemRead<T>(
    work: (tx: Parameters<Parameters<PrismaService['$transaction']>[0]>[0]) => Promise<T>,
  ): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('palcert.api_client_system_context', 'on', true)`;
      return work(tx);
    });
  }

  private async withSystemWrite<T>(
    work: (tx: Parameters<Parameters<PrismaService['$transaction']>[0]>[0]) => Promise<T>,
  ): Promise<T> {
    return this.withSystemRead(work);
  }
}
