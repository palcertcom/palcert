import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  AppError,
  CreditClass,
  CreditHoldPurpose,
  LedgerReferenceType,
  PalCertErrorCode,
  RESERVING_WITHDRAWAL_STATUSES,
  WITHDRAWAL_LIMITS,
  WithdrawalActorSide,
  WithdrawalEventType,
  WithdrawalReservationStatus,
  WithdrawalScope,
  WithdrawalStatus,
  formatMinorUnits,
  isKnownCurrency,
  parseMinorUnits,
  summarizePayoutDestination,
  withdrawalReservationKey,
  type DownloadAuthorizationView,
  type OrganizationEarningsView,
  type PlatformFundsView,
  type UserWithdrawableView,
  type WithdrawalRequestView,
} from '@palcert/contracts';
import type { Prisma } from '@palcert/database';
import {
  TenantPrismaService,
  type TenantClient,
} from '../../../infrastructure/tenant/tenant-prisma.service';
import { ClockPort } from '../../auth/ports/clock.port';
import { SecurityEventService } from '../../auth/services/security-event.service';
import { CreditHoldService } from '../../finance/services/credit-hold.service';
import { CreditLedgerService } from '../../finance/services/credit-ledger.service';
import { ManualTopUpFiles } from '../../manual-topups/manual-topup-files';
import { DomainEventService } from '../../notifications/services/domain-event.service';
import { PayoutDestinationKeyring, PayoutSealPurpose } from '../payout-destination-keyring';
import { ownerWhere, runAs } from '../withdrawal-scope';
import {
  DESTINATION_SNAPSHOT_VERSION,
  REQUESTER_CANCELLABLE,
  REQUEST_INCLUDE,
  boundedText,
  clampLimit,
  destinationNotFound,
  invalid,
  isUniqueViolation,
  requestView,
  sealedOf,
  staleVersion,
  transitionInvalid,
  withdrawalNotFound,
  type DestinationSnapshot,
  type RequestContext,
  type RequestRow,
  type WithdrawalOwner,
} from '../withdrawal-support';
import { WithdrawalFundsService } from './withdrawal-funds.service';
import { WithdrawalPolicyService } from './withdrawal-policy.service';
import { readyProofOf } from './withdrawal-proofs';

export interface SubmitWithdrawalInput {
  readonly currency: string;
  readonly amountMinorUnits: string;
  readonly destinationId: string;
  readonly note?: string | null | undefined;
}

export interface HistoryFilter {
  readonly status?: WithdrawalStatus | undefined;
  readonly limit?: number | undefined;
  readonly cursor?: string | undefined;
}

/**
 * The requester's side of a withdrawal: ask, see, withdraw the ask.
 *
 * Submission is one transaction that locks the beneficiary's funds, derives
 * what is withdrawable again on the server, refuses anything above it,
 * freezes the destination, writes the request and reserves the money (spec
 * §9). Two requests against the same funds therefore serialize on one lock
 * and the second sees what the first reserved: with 100 withdrawable, 80 and
 * 80 reserve 80, never 160.
 *
 * The beneficiary always comes from the route and the session — the user, the
 * organization in the path, or PalCert — never from the body.
 */
@Injectable()
export class WithdrawalRequestService {
  constructor(
    private readonly tenant: TenantPrismaService,
    private readonly funds: WithdrawalFundsService,
    private readonly policy: WithdrawalPolicyService,
    private readonly holds: CreditHoldService,
    private readonly ledger: CreditLedgerService,
    private readonly keyring: PayoutDestinationKeyring,
    private readonly domainEvents: DomainEventService,
    private readonly files: ManualTopUpFiles,
    private readonly events: SecurityEventService,
    private readonly clock: ClockPort,
  ) {}

  // -------------------------------------------------------------------------
  // Funds
  // -------------------------------------------------------------------------

  async userWithdrawable(userId: string, currency: string): Promise<UserWithdrawableView> {
    if (!isKnownCurrency(currency)) throw invalid('currency', 'Choose a supported currency.');
    return this.tenant.withUser(userId, (tx) => this.funds.userView(tx, userId, currency));
  }

  async organizationEarnings(
    organizationId: string,
    userId: string,
  ): Promise<OrganizationEarningsView> {
    return this.tenant.withTenant({ organizationId, userId }, (tx) =>
      this.funds.organizationView(tx, organizationId),
    );
  }

  async platformFunds(actorUserId: string): Promise<PlatformFundsView> {
    return this.tenant.withPlatformAdmin(
      { actorUserId, reason: 'read PalCert platform funds' },
      (tx) => this.funds.platformView(tx),
    );
  }

  // -------------------------------------------------------------------------
  // Submission
  // -------------------------------------------------------------------------

  async submit(
    owner: WithdrawalOwner,
    input: SubmitWithdrawalInput,
    idempotencyKey: string | undefined,
    context: RequestContext,
  ): Promise<WithdrawalRequestView> {
    const currency = input.currency;
    if (!isKnownCurrency(currency)) throw invalid('currency', 'Choose a supported currency.');
    let amount: bigint;
    try {
      amount = parseMinorUnits(input.amountMinorUnits);
    } catch {
      throw invalid('amountMinorUnits', 'Enter the amount as a whole number of minor units.');
    }
    if (amount <= 0n) throw invalid('amountMinorUnits', 'The amount must be greater than zero.');
    const note = boundedText(input.note, WITHDRAWAL_LIMITS.requesterNote, 'note');

    const requestId = randomUUID();
    let created: { id: string; replayed: boolean };
    try {
      created = await runAs(this.tenant, owner, 'request a PalCert platform payout', (tx) =>
        this.submitIn(
          tx,
          owner,
          { requestId, currency, amount, note, input, idempotencyKey },
          context,
        ),
      );
    } catch (error) {
      // Two identical submissions with one key, racing: the loser finds the winner's.
      if (idempotencyKey !== undefined && isUniqueViolation(error, 'idempotency')) {
        const existing = await runAs(this.tenant, owner, 'read a PalCert platform payout', (tx) =>
          tx.withdrawalRequest.findFirst({
            where: { requesterUserId: owner.userId, idempotencyKey },
            select: { id: true },
          }),
        );
        if (existing !== null) return this.get(owner, existing.id);
      }
      throw error;
    }

    if (!created.replayed) {
      await this.events.audit({
        action: 'WITHDRAWAL_CREATED',
        actorUserId: owner.userId,
        targetType: 'WithdrawalRequest',
        targetId: created.id,
        requestId: context.requestId,
        ipAddress: context.ipAddress,
        afterState: {
          scope: owner.scope,
          organizationId:
            owner.scope === WithdrawalScope.ORGANIZATION ? owner.organizationId : null,
          currency,
          amountMinor: amount.toString(),
        },
      });
      await this.events.audit({
        action: 'WITHDRAWAL_RESERVED',
        actorUserId: owner.userId,
        targetType: 'WithdrawalRequest',
        targetId: created.id,
        requestId: context.requestId,
        ipAddress: context.ipAddress,
        afterState: { currency, amountMinor: amount.toString() },
      });
    }
    return this.get(owner, created.id);
  }

  private async submitIn(
    tx: TenantClient,
    owner: WithdrawalOwner,
    params: {
      readonly requestId: string;
      readonly currency: string;
      readonly amount: bigint;
      readonly note: string | null;
      readonly input: SubmitWithdrawalInput;
      readonly idempotencyKey: string | undefined;
    },
    context: RequestContext,
  ): Promise<{ id: string; replayed: boolean }> {
    const { requestId, currency, amount, note, input, idempotencyKey } = params;

    // A retried submission returns the request it already made.
    if (idempotencyKey !== undefined) {
      const existing = await tx.withdrawalRequest.findFirst({
        where: { requesterUserId: owner.userId, idempotencyKey },
        select: { id: true },
      });
      if (existing !== null) return { id: existing.id, replayed: true };
    }

    // The destination: a live one of this beneficiary, in this currency.
    const destination = await tx.payoutDestination.findFirst({
      where: { id: input.destinationId, archivedAt: null, ...destinationOwnerWhere(owner) },
    });
    if (destination === null) throw destinationNotFound();
    if (destination.currency !== null && destination.currency !== currency) {
      throw invalid(
        'destinationId',
        `This payout destination receives ${destination.currency} only.`,
      );
    }

    // Freeze it: the masked half in the clear, the details sealed again under
    // this request's own binding, so later edits to the saved destination can
    // never change where this request is paid (§14).
    const details = this.keyring.open(sealedOf(destination), {
      purpose: PayoutSealPurpose.DESTINATION,
      recordId: destination.id,
    });
    const now = this.clock.now();
    const summary = summarizePayoutDestination({
      type: destination.type as DestinationSnapshot['type'],
      label: destination.label,
      beneficiaryName: destination.beneficiaryName,
      currency: destination.currency,
      ...details,
    });
    const snapshot: DestinationSnapshot = {
      ...summary,
      snapshotVersion: DESTINATION_SNAPSHOT_VERSION,
      destinationId: destination.id,
      destinationVersion: destination.version,
      capturedAt: now.toISOString(),
    };
    const sealed = this.keyring.seal(details, {
      purpose: PayoutSealPurpose.REQUEST_SNAPSHOT,
      recordId: requestId,
    });

    // The lock, then the server-side figure. Everything after this line, until
    // commit, is serialized against every other reservation on these funds.
    const lockId = await this.lockFunds(tx, owner, currency);
    const available = await this.availableIn(tx, owner, currency);

    const limit = await this.policy.limitFor(tx, currency);
    if (
      (limit.minAmountMinor !== null && amount < limit.minAmountMinor) ||
      (limit.maxAmountMinor !== null && amount > limit.maxAmountMinor)
    ) {
      throw new AppError(PalCertErrorCode.WITHDRAWAL_AMOUNT_OUT_OF_RANGE, {
        message: rangeMessage(currency, limit.minAmountMinor, limit.maxAmountMinor),
        details: {
          currency,
          minAmountMinorUnits: limit.minAmountMinor?.toString() ?? null,
          maxAmountMinorUnits: limit.maxAmountMinor?.toString() ?? null,
        },
      });
    }
    if (amount > available) {
      throw new AppError(PalCertErrorCode.WITHDRAWAL_EXCEEDS_AVAILABLE, {
        message: `You can withdraw at most ${formatMinorUnits(available, currency)} ${currency} right now.`,
        details: {
          currency,
          availableMinorUnits: available.toString(),
          requestedMinorUnits: amount.toString(),
        },
      });
    }

    const open = await tx.withdrawalRequest.count({
      where: {
        ...requestOwnerWhere(owner),
        status: { in: [...RESERVING_WITHDRAWAL_STATUSES] },
      },
    });
    if (open >= WITHDRAWAL_LIMITS.maxOpenPerBeneficiary) {
      throw new AppError(PalCertErrorCode.WITHDRAWAL_TOO_MANY_OPEN, {
        message: `At most ${WITHDRAWAL_LIMITS.maxOpenPerBeneficiary} withdrawals can be open at once.`,
      });
    }

    const organizationId =
      owner.scope === WithdrawalScope.ORGANIZATION ? owner.organizationId : null;
    await tx.withdrawalRequest.create({
      data: {
        id: requestId,
        scope: owner.scope,
        requesterUserId: owner.userId,
        beneficiaryUserId: owner.scope === WithdrawalScope.USER ? owner.userId : null,
        organizationId,
        currency,
        amountMinor: amount,
        destinationId: destination.id,
        destinationSnapshot: { ...snapshot },
        destinationSealedCiphertext: sealed.ciphertext,
        destinationSealedIv: sealed.iv,
        destinationSealedAuthTag: sealed.authTag,
        destinationSealedKid: sealed.kid,
        requesterNote: note,
        idempotencyKey: idempotencyKey ?? null,
      },
    });
    await this.history(tx, requestId, owner, WithdrawalEventType.CREATED);

    // Reserve. A user's money by a CASH hold through the one hold path, which
    // takes the same account lock; anyone else's by a reservation row.
    let holdId: string | null = null;
    let reservationId: string | null = null;
    if (owner.scope === WithdrawalScope.USER) {
      const hold = await this.holds.create(tx, {
        ownerUserId: owner.userId,
        currency,
        creditClass: CreditClass.CASH,
        amountMinor: amount,
        purpose: CreditHoldPurpose.WITHDRAWAL,
        referenceType: LedgerReferenceType.WITHDRAWAL_REQUEST,
        referenceId: requestId,
        idempotencyKey: withdrawalReservationKey(requestId),
        expiresInSeconds: null,
      });
      holdId = hold.id;
    } else {
      const reservation = await tx.withdrawalReservation.create({
        data: {
          accountId: lockId,
          requestId,
          scope: owner.scope,
          organizationId,
          currency,
          amountMinor: amount,
        },
        select: { id: true },
      });
      reservationId = reservation.id;
    }

    await tx.withdrawalRequest.update({
      where: { id: requestId },
      data: {
        status: WithdrawalStatus.PENDING_REVIEW,
        submittedAt: now,
        availableBeforeMinor: available,
        holdId,
        reservationId,
        version: 2,
        updatedAt: now,
      },
    });
    const submitted = await this.history(tx, requestId, owner, WithdrawalEventType.SUBMITTED);
    await this.history(tx, requestId, owner, WithdrawalEventType.RESERVED);
    await this.domainEvents.emitWithdrawal(tx, submitted);

    await this.events.auditWithin(tx, {
      action: 'WITHDRAWAL_SUBMITTED',
      actorUserId: owner.userId,
      targetType: 'WithdrawalRequest',
      targetId: requestId,
      requestId: context.requestId,
      ipAddress: context.ipAddress,
      afterState: {
        scope: owner.scope,
        organizationId,
        currency,
        amountMinor: amount.toString(),
        availableBeforeMinor: available.toString(),
        destinationId: destination.id,
        destinationVersion: destination.version,
      },
    });
    return { id: requestId, replayed: false };
  }

  /**
   * The row every reservation on these funds serializes on: the user's CASH
   * account, or the organization's or PalCert's lock anchor in this currency,
   * created on first use. Returns the anchor id for a non-user reservation.
   */
  private async lockFunds(
    tx: TenantClient,
    owner: WithdrawalOwner,
    currency: string,
  ): Promise<string> {
    if (owner.scope === WithdrawalScope.USER) {
      const account = await this.ledger.accountFor(tx, {
        ownerUserId: owner.userId,
        currency,
        creditClass: CreditClass.CASH,
      });
      await tx.$queryRaw`SELECT "id" FROM "customer_credit_accounts" WHERE "id" = ${account.id}::uuid FOR UPDATE`;
      return account.id;
    }
    if (owner.scope === WithdrawalScope.ORGANIZATION) {
      await tx.$executeRaw`
        INSERT INTO "withdrawal_accounts" ("scope", "organization_id", "currency")
        VALUES ('ORGANIZATION', ${owner.organizationId}::uuid, ${currency})
        ON CONFLICT ("organization_id", "currency") WHERE "scope" = 'ORGANIZATION' DO NOTHING`;
      const rows = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "withdrawal_accounts"
         WHERE "scope" = 'ORGANIZATION' AND "organization_id" = ${owner.organizationId}::uuid
           AND "currency" = ${currency}
         FOR UPDATE`;
      return requireRow(rows);
    }
    await tx.$executeRaw`
      INSERT INTO "withdrawal_accounts" ("scope", "organization_id", "currency")
      VALUES ('PLATFORM', NULL, ${currency})
      ON CONFLICT ("currency") WHERE "scope" = 'PLATFORM' DO NOTHING`;
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "withdrawal_accounts"
       WHERE "scope" = 'PLATFORM' AND "currency" = ${currency}
       FOR UPDATE`;
    return requireRow(rows);
  }

  private async availableIn(
    tx: TenantClient,
    owner: WithdrawalOwner,
    currency: string,
  ): Promise<bigint> {
    if (owner.scope === WithdrawalScope.USER) {
      return (await this.funds.user(tx, owner.userId, currency)).withdrawableMinor;
    }
    if (owner.scope === WithdrawalScope.ORGANIZATION) {
      const rows = await this.funds.organization(tx, owner.organizationId);
      return rows.find((row) => row.currency === currency)?.availableMinor ?? 0n;
    }
    const rows = await this.funds.platform(tx);
    return rows.find((row) => row.currency === currency)?.availableMinor ?? 0n;
  }

  // -------------------------------------------------------------------------
  // Cancellation
  // -------------------------------------------------------------------------

  /**
   * Withdraw a request before anybody has started paying it (§26). Releases
   * the reservation in the same transaction; moves no money. Only the person
   * who asked may withdraw the ask.
   */
  async cancel(
    owner: WithdrawalOwner,
    requestId: string,
    expectedVersion: number | undefined,
    context: RequestContext,
  ): Promise<WithdrawalRequestView> {
    const cancelled = await runAs(
      this.tenant,
      owner,
      'cancel a PalCert platform payout',
      async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "withdrawal_requests" WHERE "id" = ${requestId}::uuid FOR UPDATE`;
        const current = await tx.withdrawalRequest.findFirst({
          where: { id: requestId, ...requestOwnerWhere(owner) },
        });
        if (current === null) throw withdrawalNotFound();
        if (current.requesterUserId !== owner.userId) {
          throw new AppError(PalCertErrorCode.FORBIDDEN, {
            message: 'Only the person who requested this withdrawal can cancel it.',
          });
        }
        const status = current.status as WithdrawalStatus;
        if (status === WithdrawalStatus.CANCELLED) return false;
        if (expectedVersion !== undefined && current.version !== expectedVersion) {
          throw staleVersion(current.version);
        }
        if (!REQUESTER_CANCELLABLE.includes(status)) throw transitionInvalid(status, 'cancelled');

        await this.releaseReservation(tx, current);
        const now = this.clock.now();
        await tx.withdrawalRequest.update({
          where: { id: requestId },
          data: {
            status: WithdrawalStatus.CANCELLED,
            cancelledAt: now,
            cancelledByUserId: owner.userId,
            version: current.version + 1,
            updatedAt: now,
          },
        });
        await this.history(tx, requestId, owner, WithdrawalEventType.CANCELLED);
        await this.history(tx, requestId, owner, WithdrawalEventType.RESERVATION_RELEASED);
        return true;
      },
    );
    if (cancelled) {
      for (const action of ['WITHDRAWAL_CANCELLED', 'WITHDRAWAL_RESERVATION_RELEASED']) {
        await this.events.audit({
          action,
          actorUserId: owner.userId,
          targetType: 'WithdrawalRequest',
          targetId: requestId,
          requestId: context.requestId,
          ipAddress: context.ipAddress,
          afterState: { by: 'REQUESTER' },
        });
      }
    }
    return this.get(owner, requestId);
  }

  /** Give the reserved money back: release the hold, or mark the reservation released. */
  async releaseReservation(
    tx: TenantClient,
    request: { holdId: string | null; reservationId: string | null },
  ): Promise<void> {
    if (request.holdId !== null) {
      await this.holds.release(tx, request.holdId);
      return;
    }
    if (request.reservationId !== null) {
      await tx.withdrawalReservation.updateMany({
        where: { id: request.reservationId, status: WithdrawalReservationStatus.ACTIVE },
        data: { status: WithdrawalReservationStatus.RELEASED, releasedAt: this.clock.now() },
      });
    }
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  async list(
    owner: WithdrawalOwner,
    filter: HistoryFilter,
  ): Promise<{ items: readonly WithdrawalRequestView[]; nextCursor: string | null }> {
    const limit = clampLimit(filter.limit);
    return runAs(this.tenant, owner, 'read PalCert platform payouts', async (tx) => {
      const rows: RequestRow[] = await tx.withdrawalRequest.findMany({
        where: {
          ...requestOwnerWhere(owner),
          // A draft exists only inside a submission transaction; never listed.
          status: filter.status ?? { not: WithdrawalStatus.DRAFT },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
        ...(filter.cursor === undefined ? {} : { cursor: { id: filter.cursor }, skip: 1 }),
        include: REQUEST_INCLUDE,
      });
      const page = rows.slice(0, limit);
      const names = await this.requesterNames(tx, page);
      const orgName = await this.organizationName(tx, owner);
      return {
        items: page.map((row) => requestView(row, { organizationName: orgName, names })),
        nextCursor: rows.length > limit ? (page[page.length - 1]?.id ?? null) : null,
      };
    });
  }

  async get(owner: WithdrawalOwner, requestId: string): Promise<WithdrawalRequestView> {
    return runAs(this.tenant, owner, 'read a PalCert platform payout', async (tx) => {
      const row: RequestRow | null = await tx.withdrawalRequest.findFirst({
        where: { id: requestId, ...requestOwnerWhere(owner) },
        include: REQUEST_INCLUDE,
      });
      if (row === null || row.status === WithdrawalStatus.DRAFT) throw withdrawalNotFound();
      const names = await this.requesterNames(tx, [row]);
      return requestView(row, { organizationName: await this.organizationName(tx, owner), names });
    });
  }

  /**
   * The payout proof of the requester's own request, by a short-lived signed
   * URL. Recorded every time, like finance's own viewing.
   */
  async proofDownload(
    owner: WithdrawalOwner,
    requestId: string,
    context: RequestContext,
  ): Promise<DownloadAuthorizationView> {
    const proof = await runAs(this.tenant, owner, 'read a PalCert payout proof', async (tx) => {
      const request = await tx.withdrawalRequest.findFirst({
        where: { id: requestId, ...requestOwnerWhere(owner) },
        select: { id: true },
      });
      if (request === null) throw withdrawalNotFound();
      return readyProofOf(tx, requestId);
    });
    const grant = await this.files.download(proof, 'inline');
    await this.events.audit({
      action: 'WITHDRAWAL_PROOF_VIEWED',
      actorUserId: owner.userId,
      targetType: 'WithdrawalRequest',
      targetId: requestId,
      requestId: context.requestId,
      ipAddress: context.ipAddress,
      afterState: { proofId: proof.id, by: 'REQUESTER' },
    });
    return grant;
  }

  // -------------------------------------------------------------------------

  /** Requester-side names only: finance staff are not named to a customer. */
  private async requesterNames(
    tx: TenantClient,
    rows: readonly RequestRow[],
  ): Promise<Map<string, { displayName: string | null }>> {
    const ids = [
      ...new Set(
        rows.flatMap((row) =>
          (row.events ?? [])
            .filter((event) => event.actorSide === WithdrawalActorSide.REQUESTER)
            .map((event) => event.actorUserId)
            .filter((id): id is string => id !== null),
        ),
      ),
    ];
    if (ids.length === 0) return new Map();
    const users = await tx.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, displayName: true },
    });
    return new Map(users.map((user) => [user.id, { displayName: user.displayName }]));
  }

  private async organizationName(tx: TenantClient, owner: WithdrawalOwner): Promise<string | null> {
    if (owner.scope !== WithdrawalScope.ORGANIZATION) return null;
    const org = await tx.organization.findUnique({
      where: { id: owner.organizationId },
      select: { displayName: true },
    });
    return org?.displayName ?? null;
  }

  private async history(
    tx: TenantClient,
    requestId: string,
    owner: WithdrawalOwner,
    eventType: WithdrawalEventType,
  ): Promise<string> {
    const row = await tx.withdrawalRequestEvent.create({
      data: {
        requestId,
        requesterUserId: owner.userId,
        organizationId: owner.scope === WithdrawalScope.ORGANIZATION ? owner.organizationId : null,
        eventType,
        actorSide: WithdrawalActorSide.REQUESTER,
        actorUserId: owner.userId,
      },
      select: { id: true },
    });
    return row.id;
  }
}

/** A request's beneficiary, as a `where` on withdrawal_requests. */
export function requestOwnerWhere(owner: WithdrawalOwner): Prisma.WithdrawalRequestWhereInput {
  switch (owner.scope) {
    case WithdrawalScope.USER:
      return { scope: WithdrawalScope.USER, requesterUserId: owner.userId };
    case WithdrawalScope.ORGANIZATION:
      return { scope: WithdrawalScope.ORGANIZATION, organizationId: owner.organizationId };
    default:
      return { scope: WithdrawalScope.PLATFORM };
  }
}

function destinationOwnerWhere(owner: WithdrawalOwner): Prisma.PayoutDestinationWhereInput {
  return ownerWhere(owner);
}

function requireRow(rows: Array<{ id: string }>): string {
  const id = rows[0]?.id;
  if (id === undefined) {
    throw new AppError(PalCertErrorCode.INTERNAL_ERROR, {
      message: 'An unexpected error occurred.',
      internalContext: { reason: 'withdrawal lock anchor missing after upsert' },
    });
  }
  return id;
}

function rangeMessage(currency: string, min: bigint | null, max: bigint | null): string {
  const show = (value: bigint) => `${formatMinorUnits(value, currency)} ${currency}`;
  if (min !== null && max !== null) {
    return `A withdrawal must be between ${show(min)} and ${show(max)}.`;
  }
  if (min !== null) return `A withdrawal must be at least ${show(min)}.`;
  return `A withdrawal may be at most ${show(max ?? 0n)}.`;
}
