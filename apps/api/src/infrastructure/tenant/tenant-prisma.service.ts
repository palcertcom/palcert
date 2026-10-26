import { Injectable } from '@nestjs/common';
import { AppError, PalCertErrorCode } from '@palcert/contracts';
import type { Prisma } from '@palcert/database';
import { PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../prisma/prisma.service';

/** A Prisma client already bound to a verified tenant. */
export type TenantClient = Omit<
  Prisma.TransactionClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

export interface TenantScope {
  readonly organizationId: string;
  readonly userId: string;
}

/**
 * Explicit bounds for one interactive transaction.
 *
 * Omitted, a transaction keeps Prisma's defaults (a 5-second timeout), which
 * is what every web request should run under: a request that holds a
 * transaction longer than that is a bug to fix, not a limit to raise.
 *
 * Background work that writes a bounded batch in one atomic step (a finished
 * extraction's proposals, say) may ask for longer, up to a hard ceiling. The
 * ceiling exists so that no caller can hold a pooled connection and its row
 * locks for minutes.
 */
export interface TenantTransactionOptions {
  /** Milliseconds the transaction may run. Clamped to at most 60 s. */
  readonly timeoutMs: number;
  /** Milliseconds to wait for a pooled connection. Clamped to at most 10 s. */
  readonly maxWaitMs?: number;
}

export const MAX_TRANSACTION_TIMEOUT_MS = 60_000;
export const MAX_TRANSACTION_WAIT_MS = 10_000;

/** For background jobs that write one bounded batch atomically. */
export const BACKGROUND_BATCH_TRANSACTION: TenantTransactionOptions = {
  timeoutMs: 30_000,
  maxWaitMs: 5_000,
};

function prismaOptions(
  options: TenantTransactionOptions | undefined,
): { timeout: number; maxWait?: number } | undefined {
  if (options === undefined) return undefined;
  const timeout = Math.min(Math.max(1, Math.floor(options.timeoutMs)), MAX_TRANSACTION_TIMEOUT_MS);
  return options.maxWaitMs === undefined
    ? { timeout }
    : {
        timeout,
        maxWait: Math.min(Math.max(1, Math.floor(options.maxWaitMs)), MAX_TRANSACTION_WAIT_MS),
      };
}

/**
 * The single supported way to touch tenant-owned data (ADR-0019).
 *
 * Every callback runs inside one transaction that begins by setting the tenant
 * context with `set_config(..., is_local => true)`. PostgreSQL discards
 * transaction-local settings at COMMIT *and* at ROLLBACK, which is precisely
 * what makes a pooled connection safe: there is no code path — not even an
 * exception — by which one request's tenant survives into the next request that
 * happens to reuse the connection.
 *
 * Nothing here grants authority. The organization id passed in must already
 * have been verified by `OrganizationContextGuard`; this class only ensures the
 * database enforces the same boundary the application believes it is enforcing.
 */
@Injectable()
export class TenantPrismaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(TenantPrismaService.name);
  }

  /**
   * Run a unit of work scoped to one organization.
   *
   * The user id is set alongside the organization because some policies (the
   * organization switcher, a member reading their own membership) are
   * user-scoped rather than tenant-scoped.
   */
  async withTenant<T>(
    scope: TenantScope,
    work: (tx: TenantClient) => Promise<T>,
    options?: TenantTransactionOptions,
  ): Promise<T> {
    // The tenant context is set inside every transaction, bounded or not: a
    // longer timeout changes how long, never whose data.
    return this.prisma.$transaction(async (tx) => {
      await this.applyContext(tx, scope.organizationId, scope.userId, false);
      return work(tx);
    }, prismaOptions(options));
  }

  /**
   * Run a unit of work with only a user identity and no organization.
   *
   * Used by the organization switcher and invitation acceptance, where the
   * caller legitimately has no single tenant yet. Tenant tables remain
   * invisible except through the explicitly user-scoped policies.
   */
  async withUser<T>(userId: string, work: (tx: TenantClient) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      await this.applyContext(tx, null, userId, false);
      return work(tx);
    });
  }

  /**
   * Run a unit of work with platform-administrator elevation (§22).
   *
   * This is the *only* place that sets the elevation flag, and it demands an
   * explicit reason so the intent is recorded rather than inferred. Ordinary
   * tenant request paths never call it; the admin controllers do, and every
   * call site also writes an audit record.
   */
  async withPlatformAdmin<T>(
    params: { actorUserId: string; reason: string; organizationId?: string },
    work: (tx: TenantClient) => Promise<T>,
  ): Promise<T> {
    if (params.reason.trim().length === 0) {
      throw new AppError(PalCertErrorCode.INTERNAL_ERROR, {
        message: 'An unexpected error occurred.',
        internalContext: { reason: 'platform-admin elevation requested with no stated reason' },
      });
    }

    this.logger.warn(
      {
        actorUserId: params.actorUserId,
        organizationId: params.organizationId ?? null,
        reason: params.reason,
      },
      'Platform-administrator cross-tenant elevation',
    );

    return this.prisma.$transaction(async (tx) => {
      await this.applyContext(tx, params.organizationId ?? null, params.actorUserId, true);
      return work(tx);
    });
  }

  private async applyContext(
    tx: Prisma.TransactionClient,
    organizationId: string | null,
    userId: string | null,
    platformAdmin: boolean,
  ): Promise<void> {
    // Parameterized, never interpolated: these values reach a SQL function and
    // must not be capable of altering the statement.
    await tx.$executeRaw`SELECT set_config('palcert.current_organization_id', ${organizationId ?? ''}, true)`;
    await tx.$executeRaw`SELECT set_config('palcert.current_user_id', ${userId ?? ''}, true)`;
    await tx.$executeRaw`SELECT set_config('palcert.platform_admin', ${platformAdmin ? 'on' : 'off'}, true)`;
  }
}
