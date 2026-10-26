import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  AppError,
  PalCertErrorCode,
  WithdrawalScope,
  normalizePayoutDestination,
  summarizePayoutDestination,
  type PayoutDestinationInput,
  type PayoutDestinationView,
} from '@palcert/contracts';
import { TenantPrismaService } from '../../../infrastructure/tenant/tenant-prisma.service';
import { ClockPort } from '../../auth/ports/clock.port';
import { SecurityEventService } from '../../auth/services/security-event.service';
import { PayoutDestinationKeyring, PayoutSealPurpose } from '../payout-destination-keyring';
import { ownerWhere, runAs } from '../withdrawal-scope';
import {
  destinationNotFound,
  destinationView,
  type RequestContext,
  type WithdrawalOwner,
} from '../withdrawal-support';

/** Saved destinations one beneficiary may keep at once. */
const MAX_LIVE_DESTINATIONS = 10;

/**
 * Saved payout destinations for all three scopes (spec §12–§15, policy 1).
 *
 * A user's belong to the user; an organization's to the organization,
 * managed by holders of the organization payout-destination permission;
 * PalCert's to its treasury, managed by finance. The controllers check the
 * permission; this service runs every read and write in the owner's own
 * database scope, so the boundary holds even if a route did not.
 *
 * Details are sealed with the payout key ring before they are written, and
 * a write is refused outright when no key ring is configured (D7). Only a
 * masked summary is ever stored in the clear or returned from here.
 */
@Injectable()
export class PayoutDestinationService {
  constructor(
    private readonly tenant: TenantPrismaService,
    private readonly keyring: PayoutDestinationKeyring,
    private readonly events: SecurityEventService,
    private readonly clock: ClockPort,
  ) {}

  async list(
    owner: WithdrawalOwner,
    options: { readonly includeArchived?: boolean } = {},
  ): Promise<readonly PayoutDestinationView[]> {
    return runAs(this.tenant, owner, 'read PalCert payout destinations', async (tx) => {
      const rows = await tx.payoutDestination.findMany({
        where: {
          ...ownerWhere(owner),
          ...(options.includeArchived === true ? {} : { archivedAt: null }),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });
      return rows.map(destinationView);
    });
  }

  async create(
    owner: WithdrawalOwner,
    input: PayoutDestinationInput,
    context: RequestContext,
  ): Promise<PayoutDestinationView> {
    const value = this.validate(input);
    const id = randomUUID();
    // Sealed before anything is written: with no key ring this refuses, and
    // no destination is created (D7).
    const sealed = this.keyring.seal(value, {
      purpose: PayoutSealPurpose.DESTINATION,
      recordId: id,
    });
    const view = await runAs(this.tenant, owner, 'add a PalCert payout destination', async (tx) => {
      const live = await tx.payoutDestination.count({
        where: { ...ownerWhere(owner), archivedAt: null },
      });
      if (live >= MAX_LIVE_DESTINATIONS) {
        throw new AppError(PalCertErrorCode.PAYOUT_DESTINATION_INVALID, {
          message: `You can keep at most ${MAX_LIVE_DESTINATIONS} payout destinations. Archive one first.`,
        });
      }
      const row = await tx.payoutDestination.create({
        data: {
          id,
          scope: owner.scope,
          ownerUserId: owner.scope === WithdrawalScope.USER ? owner.userId : null,
          organizationId:
            owner.scope === WithdrawalScope.ORGANIZATION ? owner.organizationId : null,
          type: value.type,
          label: value.label,
          beneficiaryName: value.beneficiaryName,
          currency: value.currency,
          summary: { ...summarizePayoutDestination(value) },
          detailsCiphertext: sealed.ciphertext,
          detailsIv: sealed.iv,
          detailsAuthTag: sealed.authTag,
          detailsKid: sealed.kid,
          createdByUserId: owner.userId,
        },
      });
      return destinationView(row);
    });

    await this.events.audit({
      action: 'WITHDRAWAL_DESTINATION_CREATED',
      actorUserId: owner.userId,
      targetType: 'PayoutDestination',
      targetId: view.id,
      requestId: context.requestId,
      ipAddress: context.ipAddress,
      // The masked summary only. Never an IBAN, an account or a number.
      afterState: {
        scope: owner.scope,
        organizationId: view.organizationId,
        type: view.type,
        ibanMasked: view.ibanMasked,
        accountNumberMasked: view.accountNumberMasked,
        mobileNumberMasked: view.mobileNumberMasked,
      },
    });
    return view;
  }

  /**
   * Replace a destination's details. Requests already submitted against it
   * keep the copy frozen at their submission (spec §14), so this never
   * changes where an existing request is paid.
   */
  async update(
    owner: WithdrawalOwner,
    destinationId: string,
    input: PayoutDestinationInput,
    expectedVersion: number,
    context: RequestContext,
  ): Promise<PayoutDestinationView> {
    const value = this.validate(input);
    const sealed = this.keyring.seal(value, {
      purpose: PayoutSealPurpose.DESTINATION,
      recordId: destinationId,
    });
    const { before, after } = await runAs(
      this.tenant,
      owner,
      'change a PalCert payout destination',
      async (tx) => {
        const current = await this.lockOwn(tx, owner, destinationId);
        if (current.archivedAt !== null) {
          throw new AppError(PalCertErrorCode.PAYOUT_DESTINATION_ARCHIVED, {
            message: 'An archived payout destination cannot be changed.',
          });
        }
        if (current.version !== expectedVersion) {
          throw new AppError(PalCertErrorCode.PAYOUT_DESTINATION_CONFLICT, {
            message: 'This destination changed since you opened it. Reload it and try again.',
            details: { version: current.version },
          });
        }
        const row = await tx.payoutDestination.update({
          where: { id: destinationId },
          data: {
            type: value.type,
            label: value.label,
            beneficiaryName: value.beneficiaryName,
            currency: value.currency,
            summary: { ...summarizePayoutDestination(value) },
            detailsCiphertext: sealed.ciphertext,
            detailsIv: sealed.iv,
            detailsAuthTag: sealed.authTag,
            detailsKid: sealed.kid,
            version: current.version + 1,
            updatedByUserId: owner.userId,
            updatedAt: this.clock.now(),
          },
        });
        return { before: destinationView(current), after: destinationView(row) };
      },
    );
    await this.events.audit({
      action: 'WITHDRAWAL_DESTINATION_UPDATED',
      actorUserId: owner.userId,
      targetType: 'PayoutDestination',
      targetId: destinationId,
      requestId: context.requestId,
      ipAddress: context.ipAddress,
      beforeState: maskedAudit(before),
      afterState: maskedAudit(after),
    });
    return after;
  }

  /** Archive for good. Existing requests are unaffected; new ones cannot use it. */
  async archive(
    owner: WithdrawalOwner,
    destinationId: string,
    expectedVersion: number,
    context: RequestContext,
  ): Promise<PayoutDestinationView> {
    const view = await runAs(
      this.tenant,
      owner,
      'archive a PalCert payout destination',
      async (tx) => {
        const current = await this.lockOwn(tx, owner, destinationId);
        if (current.archivedAt !== null) return destinationView(current);
        if (current.version !== expectedVersion) {
          throw new AppError(PalCertErrorCode.PAYOUT_DESTINATION_CONFLICT, {
            message: 'This destination changed since you opened it. Reload it and try again.',
            details: { version: current.version },
          });
        }
        const now = this.clock.now();
        const row = await tx.payoutDestination.update({
          where: { id: destinationId },
          data: {
            archivedAt: now,
            version: current.version + 1,
            updatedByUserId: owner.userId,
            updatedAt: now,
          },
        });
        return destinationView(row);
      },
    );
    await this.events.audit({
      action: 'WITHDRAWAL_DESTINATION_ARCHIVED',
      actorUserId: owner.userId,
      targetType: 'PayoutDestination',
      targetId: destinationId,
      requestId: context.requestId,
      ipAddress: context.ipAddress,
      afterState: { scope: owner.scope },
    });
    return view;
  }

  private validate(input: PayoutDestinationInput) {
    const { value, issues } = normalizePayoutDestination(input);
    if (issues.length > 0) {
      throw new AppError(PalCertErrorCode.PAYOUT_DESTINATION_INVALID, {
        message: 'Check the highlighted payout destination fields.',
        details: { issues: issues.map((issue) => ({ field: issue.field, code: issue.code })) },
      });
    }
    return value;
  }

  private async lockOwn(
    tx: Parameters<Parameters<typeof runAs>[3]>[0],
    owner: WithdrawalOwner,
    destinationId: string,
  ) {
    await tx.$queryRaw`SELECT "id" FROM "payout_destinations" WHERE "id" = ${destinationId}::uuid FOR UPDATE`;
    const row = await tx.payoutDestination.findFirst({
      where: { id: destinationId, ...ownerWhere(owner) },
    });
    if (row === null) throw destinationNotFound();
    return row;
  }
}

function maskedAudit(view: PayoutDestinationView): Record<string, unknown> {
  return {
    type: view.type,
    label: view.label,
    ibanMasked: view.ibanMasked,
    accountNumberMasked: view.accountNumberMasked,
    mobileNumberMasked: view.mobileNumberMasked,
    version: view.version,
  };
}
