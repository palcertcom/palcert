import { Injectable, Logger } from '@nestjs/common';
import {
  API_CLIENT_MAX_PER_ORGANIZATION,
  API_CLIENT_MAX_ROTATION_OVERLAP_SECONDS,
  API_CLIENT_ROTATION_OVERLAP_SECONDS,
  AppError,
  isApiClientScope,
  PalCertErrorCode,
  type ApiClientScope,
  type ApiClientSecretRevealView,
  type ApiClientView,
} from '@palcert/contracts';
import { createHash } from 'node:crypto';
import { openSecret, sealSecret } from '../../../common/crypto/secret-box';
import { ApiConfigService } from '../../../config/api-config.service';
import {
  TenantPrismaService,
  type TenantClient,
} from '../../../infrastructure/tenant/tenant-prisma.service';
import type { TenantContext } from '../../organizations/tenant-context';
import { SecurityEventService } from '../../auth/services/security-event.service';
import { ApiClientCredentialService } from './api-client-credential.service';

/** How long an identical repeat returns the identical secret. */
const REVEAL_WINDOW_SECONDS = 24 * 60 * 60;

/** The furthest out an expiry may be set: two years. */
const MAX_EXPIRY_SECONDS = 2 * 365 * 24 * 60 * 60;

export interface CreateApiClientInput {
  readonly displayName: string;
  readonly description?: string | null;
  readonly scopes: readonly string[];
  readonly expiresAt?: string | null;
  readonly idempotencyKey: string;
}

export interface RotateApiClientInput {
  readonly apiClientId: string;
  readonly overlapSeconds?: number;
  readonly idempotencyKey: string;
}

/**
 * The credential lifecycle (Phase 19).
 *
 * Two properties are worth stating because the code is arranged around them.
 *
 * **A secret is returned exactly once, and a retry returns the same one.**
 * Writing an HTTP response is not the same as a client receiving it, so
 * without a bounded recovery window a lost 201 means a credential that exists
 * and that nobody holds. The window is the Phase 17 shape: the same
 * organization, operation, key, actor and request fingerprint gets the same
 * answer for 24 hours, and after that PalCert refuses **before decrypting
 * anything** rather than opening an envelope it promised to stop opening.
 *
 * **Rotation cannot leave two permanent credentials.** The overlap is bounded
 * in the contract, written onto the row, and enforced by the authentication
 * path rather than by a sweeper — so a rotated-out secret stops working on
 * time even if no background job ever runs. The partial unique indexes make
 * "at most one active, at most one on the way out" a property of the schema.
 */
@Injectable()
export class ApiClientService {
  private readonly logger = new Logger(ApiClientService.name);

  constructor(
    private readonly tenant: TenantPrismaService,
    private readonly credentials: ApiClientCredentialService,
    private readonly config: ApiConfigService,
    private readonly events: SecurityEventService,
  ) {}

  /**
   * Record a lifecycle act.
   *
   * The state carries the client id, the scopes and the status — everything an
   * auditor reconstructing "what could this credential reach, and when?" needs.
   * It carries **no secret, no verifier and no hint**, and there is no branch
   * in which one could arrive: the secret is not in scope at any call site
   * below, and `sanitizeState` would drop it by key name even if it were.
   */
  private async audit(
    context: TenantContext,
    action: string,
    client: { id: string; clientId: string; status: string; scopes: string[] },
    before?: Record<string, unknown>,
  ): Promise<void> {
    await this.events.audit({
      action,
      actor: { type: 'USER', userId: context.userId },
      targetType: 'API_CLIENT',
      targetId: client.id,
      requestId: context.requestId,
      beforeState: before ?? null,
      afterState: {
        organizationId: context.organizationId,
        clientId: client.clientId,
        status: client.status,
        scopes: client.scopes,
      },
    });
  }

  async list(context: TenantContext): Promise<ApiClientView[]> {
    return this.tenant.withTenant(
      { organizationId: context.organizationId, userId: context.userId },
      async (tx) => {
        const rows = await this.systemScope(tx, () =>
          tx.apiClient.findMany({
            where: { organizationId: context.organizationId },
            orderBy: { createdAt: 'desc' },
            include: { secrets: { where: { status: { in: ['ACTIVE', 'ROTATING_OUT'] } } } },
          }),
        );
        return rows.map((row) => this.toView(row));
      },
    );
  }

  async get(context: TenantContext, apiClientId: string): Promise<ApiClientView> {
    return this.tenant.withTenant(
      { organizationId: context.organizationId, userId: context.userId },
      async (tx) => this.toView(await this.load(tx, context.organizationId, apiClientId)),
    );
  }

  async create(
    context: TenantContext,
    input: CreateApiClientInput,
  ): Promise<ApiClientSecretRevealView> {
    const scopes = this.validateScopes(input.scopes);
    const expiresAt = this.validateExpiry(input.expiresAt ?? null);
    const fingerprint = this.fingerprint({
      displayName: input.displayName,
      description: input.description ?? null,
      scopes,
      expiresAt: expiresAt?.toISOString() ?? null,
    });

    return this.tenant.withTenant(
      { organizationId: context.organizationId, userId: context.userId },
      async (tx) => {
        const replay = await this.replay(
          tx,
          context,
          'CREATE_CLIENT',
          input.idempotencyKey,
          fingerprint,
        );
        if (replay !== null) return replay;

        const live = await this.systemScope(tx, () =>
          tx.apiClient.count({
            where: { organizationId: context.organizationId, status: { not: 'REVOKED' } },
          }),
        );
        if (live >= API_CLIENT_MAX_PER_ORGANIZATION) {
          throw new AppError(PalCertErrorCode.API_CLIENT_LIMIT_REACHED, {
            message: `An organization may hold at most ${API_CLIENT_MAX_PER_ORGANIZATION} API clients.`,
          });
        }

        const credential = await this.credentials.generate();

        return this.systemScope(tx, async () => {
          const client = await tx.apiClient.create({
            data: {
              organizationId: context.organizationId,
              clientId: credential.clientId,
              displayName: input.displayName,
              description: input.description ?? null,
              scopes,
              expiresAt,
              createdByUserId: context.userId,
            },
          });

          try {
            await tx.apiClientSecret.create({
              data: {
                apiClientId: client.id,
                secretVerifier: credential.verifier,
                secretHint: credential.hint,
                createdByUserId: context.userId,
                status: 'ACTIVE',
              },
            });
          } catch (error) {
            // Two rotations of the same client at the same moment. Both read a
            // single ACTIVE secret, both decided there was room, and the
            // partial unique index let exactly one of them insert — which is
            // the index doing its job. What must not happen is the loser
            // getting a 500: the answer is the same conflict the sequential
            // path already returns, so a client retrying sees one story.
            if (isUniqueViolation(error)) {
              throw new AppError(PalCertErrorCode.API_CLIENT_ROTATION_IN_PROGRESS, {
                message: 'A rotation is already in progress for this client.',
              });
            }
            throw error;
          }

          await this.recordOperation(
            tx,
            context,
            'CREATE_CLIENT',
            input.idempotencyKey,
            fingerprint,
            client.id,
            credential.secret,
          );

          const withSecrets = await this.load(tx, context.organizationId, client.id);
          await this.audit(context, 'api_client.created', withSecrets);
          return {
            client: this.toView(withSecrets),
            clientSecret: credential.secret,
            previousSecretRetiresAt: null,
          };
        });
      },
    );
  }

  async rotate(
    context: TenantContext,
    input: RotateApiClientInput,
  ): Promise<ApiClientSecretRevealView> {
    const overlapSeconds = input.overlapSeconds ?? API_CLIENT_ROTATION_OVERLAP_SECONDS;
    if (overlapSeconds < 0 || overlapSeconds > API_CLIENT_MAX_ROTATION_OVERLAP_SECONDS) {
      throw new AppError(PalCertErrorCode.API_CLIENT_ROTATION_OVERLAP_TOO_LONG, {
        message: `The rotation overlap must be between 0 and ${API_CLIENT_MAX_ROTATION_OVERLAP_SECONDS} seconds.`,
        details: { field: 'overlapSeconds' },
      });
    }
    const fingerprint = this.fingerprint({ apiClientId: input.apiClientId, overlapSeconds });

    return this.tenant.withTenant(
      { organizationId: context.organizationId, userId: context.userId },
      async (tx) => {
        const replay = await this.replay(
          tx,
          context,
          'ROTATE_SECRET',
          input.idempotencyKey,
          fingerprint,
        );
        if (replay !== null) return replay;

        const client = await this.load(tx, context.organizationId, input.apiClientId);
        if (client.status === 'REVOKED') {
          throw new AppError(PalCertErrorCode.API_CLIENT_REVOKED, {
            message: 'This API client has been revoked.',
          });
        }

        const now = new Date();

        // A second rotation while an overlap is still running would need a
        // third live secret, which the schema refuses. Reported as a conflict
        // rather than silently retiring the previous one early: whoever is
        // still using it would lose access without being told.
        const rotatingOut = client.secrets.find((secret) => secret.status === 'ROTATING_OUT');
        if (
          rotatingOut !== undefined &&
          (rotatingOut.overlapEndsAt?.getTime() ?? 0) > now.getTime()
        ) {
          throw new AppError(PalCertErrorCode.API_CLIENT_ROTATION_IN_PROGRESS, {
            message: 'A rotation is already in progress for this client.',
          });
        }

        const credential = await this.credentials.generate();
        const overlapEndsAt = new Date(now.getTime() + overlapSeconds * 1000);

        return this.systemScope(tx, async () => {
          // Retire an elapsed overlap first, so the partial unique index has
          // room. Doing it here rather than trusting a sweeper is what makes
          // rotation work on a quiet system.
          if (rotatingOut !== undefined) {
            await tx.apiClientSecret.update({
              where: { id: rotatingOut.id },
              data: { status: 'RETIRED', retiredAt: now },
            });
          }

          const current = client.secrets.find((secret) => secret.status === 'ACTIVE');
          if (current !== undefined) {
            await tx.apiClientSecret.update({
              where: { id: current.id },
              data:
                overlapSeconds === 0
                  ? { status: 'RETIRED', retiredAt: now }
                  : { status: 'ROTATING_OUT', overlapEndsAt },
            });
          }

          try {
            await tx.apiClientSecret.create({
              data: {
                apiClientId: client.id,
                secretVerifier: credential.verifier,
                secretHint: credential.hint,
                createdByUserId: context.userId,
                status: 'ACTIVE',
              },
            });
          } catch (error) {
            // Two rotations of the same client at the same moment. Both read a
            // single ACTIVE secret, both decided there was room, and the
            // partial unique index let exactly one of them insert — which is
            // the index doing its job. What must not happen is the loser
            // getting a 500: the answer is the same conflict the sequential
            // path already returns, so a client retrying sees one story.
            if (isUniqueViolation(error)) {
              throw new AppError(PalCertErrorCode.API_CLIENT_ROTATION_IN_PROGRESS, {
                message: 'A rotation is already in progress for this client.',
              });
            }
            throw error;
          }

          await this.recordOperation(
            tx,
            context,
            'ROTATE_SECRET',
            input.idempotencyKey,
            fingerprint,
            client.id,
            credential.secret,
          );

          const refreshed = await this.load(tx, context.organizationId, client.id);
          await this.audit(context, 'api_client.secret_rotated', refreshed, {
            overlapSeconds,
          });
          return {
            client: this.toView(refreshed),
            clientSecret: credential.secret,
            previousSecretRetiresAt:
              current === undefined || overlapSeconds === 0 ? null : overlapEndsAt.toISOString(),
          };
        });
      },
    );
  }

  /**
   * Revoke: final, immediate, and it takes every secret with it.
   *
   * Not a status change alone. A revoked client whose secrets still verified
   * would be a credential an organization was told is dead and that still
   * opens the door, which is the worst possible gap between what a screen says
   * and what is true.
   */
  async revoke(context: TenantContext, apiClientId: string): Promise<ApiClientView> {
    return this.tenant.withTenant(
      { organizationId: context.organizationId, userId: context.userId },
      async (tx) => {
        const client = await this.load(tx, context.organizationId, apiClientId);
        if (client.status === 'REVOKED') return this.toView(client);

        const now = new Date();
        return this.systemScope(tx, async () => {
          await tx.apiClientSecret.updateMany({
            where: { apiClientId: client.id, status: { in: ['ACTIVE', 'ROTATING_OUT'] } },
            data: { status: 'RETIRED', retiredAt: now },
          });
          await tx.apiClient.update({
            where: { id: client.id },
            data: {
              status: 'REVOKED',
              revokedAt: now,
              revokedByUserId: context.userId,
              disabledAt: null,
            },
          });
          const revoked = await this.load(tx, context.organizationId, client.id);
          await this.audit(context, 'api_client.revoked', revoked, { status: client.status });
          return this.toView(revoked);
        });
      },
    );
  }

  /**
   * Disable and enable: reversible, and the secrets survive.
   *
   * The difference from revocation is the whole reason both exist. Disabling is
   * "stop this for now" — an integration being migrated, a vendor being
   * investigated — and re-enabling must not force the customer to redeploy a
   * new secret. Revoking is "this is compromised" and is final.
   */
  async setEnabled(
    context: TenantContext,
    apiClientId: string,
    enabled: boolean,
  ): Promise<ApiClientView> {
    return this.tenant.withTenant(
      { organizationId: context.organizationId, userId: context.userId },
      async (tx) => {
        const client = await this.load(tx, context.organizationId, apiClientId);
        if (client.status === 'REVOKED') {
          throw new AppError(PalCertErrorCode.API_CLIENT_REVOKED, {
            message: 'This API client has been revoked.',
          });
        }
        const target = enabled ? 'ACTIVE' : 'DISABLED';
        if (client.status === target) return this.toView(client);

        return this.systemScope(tx, async () => {
          await tx.apiClient.update({
            where: { id: client.id },
            data: { status: target, disabledAt: enabled ? null : new Date() },
          });
          const updated = await this.load(tx, context.organizationId, client.id);
          await this.audit(
            context,
            enabled ? 'api_client.enabled' : 'api_client.disabled',
            updated,
            { status: client.status },
          );
          return this.toView(updated);
        });
      },
    );
  }

  // --- internals -----------------------------------------------------------

  private async load(tx: TenantClient, organizationId: string, apiClientId: string) {
    const client = await this.systemScope(tx, () =>
      tx.apiClient.findFirst({
        where: { id: apiClientId, organizationId },
        include: { secrets: { where: { status: { in: ['ACTIVE', 'ROTATING_OUT'] } } } },
      }),
    );
    if (client === null) {
      // Identical to "belongs to another organization". The tenant filter above
      // already makes them the same query; this makes them the same answer.
      throw new AppError(PalCertErrorCode.API_CLIENT_NOT_FOUND, {
        message: 'API client not found.',
      });
    }
    return client;
  }

  private validateScopes(scopes: readonly string[]): string[] {
    if (scopes.length === 0) {
      throw new AppError(PalCertErrorCode.API_CLIENT_SCOPES_REQUIRED, {
        message: 'An API client must hold at least one scope.',
        details: { field: 'scopes' },
      });
    }
    for (const scope of scopes) {
      if (!isApiClientScope(scope)) {
        throw new AppError(PalCertErrorCode.API_CLIENT_SCOPE_INVALID, {
          message: 'One or more scopes are not recognized.',
          details: { field: 'scopes' },
        });
      }
    }
    // Sorted and deduplicated here as well as in the database. The constraint
    // is the guarantee; doing it here means a caller who sent duplicates gets a
    // client rather than a 500.
    return [...new Set(scopes)].sort();
  }

  private validateExpiry(value: string | null): Date | null {
    if (value === null) return null;
    const parsed = new Date(value);
    const now = Date.now();
    if (Number.isNaN(parsed.getTime()) || parsed.getTime() <= now) {
      throw new AppError(PalCertErrorCode.API_CLIENT_EXPIRY_INVALID, {
        message: 'The expiry must be a future instant.',
        details: { field: 'expiresAt' },
      });
    }
    if (parsed.getTime() - now > MAX_EXPIRY_SECONDS * 1000) {
      throw new AppError(PalCertErrorCode.API_CLIENT_EXPIRY_INVALID, {
        message: 'The expiry may be at most two years away.',
        details: { field: 'expiresAt' },
      });
    }
    return parsed;
  }

  /**
   * An identical repeat of a settled secret-bearing operation.
   *
   * Three outcomes, and the third is the one that matters: no record (proceed),
   * a record with a different fingerprint (conflict — the same key was used for
   * a different request), or a record whose window has closed (refused **before
   * decrypting**, so the promise not to open the envelope again is kept by the
   * control flow rather than by a sweeper).
   */
  private async replay(
    tx: TenantClient,
    context: TenantContext,
    operation: string,
    idempotencyKey: string,
    fingerprint: string,
  ): Promise<ApiClientSecretRevealView | null> {
    const keyHash = this.digest(idempotencyKey);
    const existing = await this.systemScope(tx, () =>
      tx.apiClientOperation.findUnique({
        where: {
          organizationId_operation_idempotencyKeyHash: {
            organizationId: context.organizationId,
            operation,
            idempotencyKeyHash: keyHash,
          },
        },
      }),
    );
    if (existing === null) return null;

    if (existing.requestFingerprint !== fingerprint) {
      throw new AppError(PalCertErrorCode.API_CLIENT_IDEMPOTENCY_KEY_CONFLICT, {
        message: 'This Idempotency-Key was already used for a different request.',
        details: { field: 'Idempotency-Key' },
      });
    }

    // The actor is part of the identity. Two administrators using the same key
    // by coincidence are two requests, and the second must not be handed a
    // credential the first minted.
    if (existing.actorUserId !== context.userId) {
      throw new AppError(PalCertErrorCode.API_CLIENT_IDEMPOTENCY_KEY_CONFLICT, {
        message: 'This Idempotency-Key was already used for a different request.',
        details: { field: 'Idempotency-Key' },
      });
    }

    if (
      existing.revealCiphertext === null ||
      existing.revealExpiresAt === null ||
      existing.revealExpiresAt.getTime() <= Date.now()
    ) {
      throw new AppError(PalCertErrorCode.API_CLIENT_SECRET_NO_LONGER_RECOVERABLE, {
        message:
          'This operation already completed and its secret is no longer recoverable. ' +
          'Rotate the client to obtain a new secret.',
      });
    }

    const secret = openSecret(
      {
        ciphertext: existing.revealCiphertext,
        iv: existing.revealIv ?? '',
        authTag: existing.revealAuthTag ?? '',
      },
      this.config.apiClientRevealKey,
    );

    const client = await this.load(tx, context.organizationId, existing.apiClientId ?? '');
    return {
      client: this.toView(client),
      clientSecret: secret,
      previousSecretRetiresAt:
        client.secrets.find((s) => s.status === 'ROTATING_OUT')?.overlapEndsAt?.toISOString() ??
        null,
    };
  }

  private async recordOperation(
    tx: TenantClient,
    context: TenantContext,
    operation: string,
    idempotencyKey: string,
    fingerprint: string,
    apiClientId: string,
    secret: string,
  ): Promise<void> {
    const sealed = sealSecret(secret, this.config.apiClientRevealKey);
    await tx.apiClientOperation.create({
      data: {
        organizationId: context.organizationId,
        operation,
        idempotencyKeyHash: this.digest(idempotencyKey),
        requestFingerprint: fingerprint,
        actorUserId: context.userId,
        apiClientId,
        revealCiphertext: sealed.ciphertext,
        revealIv: sealed.iv,
        revealAuthTag: sealed.authTag,
        revealExpiresAt: new Date(Date.now() + REVEAL_WINDOW_SECONDS * 1000),
      },
    });
  }

  /** The key's hash, never the key: it is a client-chosen token. */
  private digest(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
  }

  private fingerprint(payload: Record<string, unknown>): string {
    return createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex');
  }

  /**
   * Announce a SYSTEM-table access inside an existing tenant transaction.
   *
   * The flag is set and cleared around the work rather than for the whole
   * transaction, so the window in which the SYSTEM tables are reachable is as
   * small as the statements that need them.
   */
  private async systemScope<T>(tx: TenantClient, work: () => Promise<T>): Promise<T> {
    await tx.$executeRaw`SELECT set_config('palcert.api_client_system_context', 'on', true)`;
    const result = await work();
    // Cleared on the way out, and deliberately **not** in a `finally`. Once a
    // statement inside `work` has failed, PostgreSQL has aborted the
    // transaction and refuses every further command with 25P02 — so a cleanup
    // there would throw over the real error and report a generic raw-query
    // failure instead of the thing that actually went wrong. There is nothing
    // to clean up on that path anyway: the flag is transaction-local and the
    // rollback discards it.
    await tx.$executeRaw`SELECT set_config('palcert.api_client_system_context', 'off', true)`;
    return result;
  }

  private toView(row: {
    id: string;
    organizationId: string;
    clientId: string;
    displayName: string;
    description: string | null;
    status: string;
    scopes: string[];
    createdAt: Date;
    createdByUserId: string;
    expiresAt: Date | null;
    revokedAt: Date | null;
    disabledAt: Date | null;
    lastUsedAt: Date | null;
    secrets: { status: string; overlapEndsAt: Date | null }[];
  }): ApiClientView {
    const live = row.secrets.filter((secret) => secret.status !== 'RETIRED');
    const rotating = live.find((secret) => secret.status === 'ROTATING_OUT');
    return {
      apiClientId: row.id,
      organizationId: row.organizationId,
      clientId: row.clientId,
      displayName: row.displayName,
      description: row.description,
      status: row.status as ApiClientView['status'],
      scopes: row.scopes.filter((scope): scope is ApiClientScope => isApiClientScope(scope)),
      createdAt: row.createdAt.toISOString(),
      createdByUserId: row.createdByUserId,
      expiresAt: row.expiresAt?.toISOString() ?? null,
      revokedAt: row.revokedAt?.toISOString() ?? null,
      disabledAt: row.disabledAt?.toISOString() ?? null,
      lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
      liveSecretCount: live.length,
      rotationOverlapEndsAt: rotating?.overlapEndsAt?.toISOString() ?? null,
    };
  }
}

/**
 * A unique-constraint violation, by code rather than by message.
 *
 * `meta.target` is null under the least-privileged role, so which index it was
 * is not available here — but rotation is the only place this service races
 * with itself, so the code alone is enough.
 */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002'
  );
}
