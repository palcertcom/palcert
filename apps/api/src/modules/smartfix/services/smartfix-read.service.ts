import { Injectable } from '@nestjs/common';
import {
  AppError,
  PalCertErrorCode,
  type SmartFixRequestStatus,
  type SmartFixAIPlanning,
  money,
  type MoneyView,
} from '@palcert/contracts';
import { PinoLogger } from 'nestjs-pino';
import { TenantPrismaService } from '../../../infrastructure/tenant/tenant-prisma.service';

/** What a plan looks like to the person deciding whether to buy it. */
export interface SmartFixPlanView {
  readonly reservation?: {
    readonly status: string;
    readonly priceQuoteId: string;
    readonly amount: MoneyView;
  };
  readonly aiPlanning?: SmartFixAIPlanning;
  readonly id: string;
  readonly checkId: string;
  readonly documentVersionId: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly fixEngineVersion: string;
  /** Set when the document cannot be corrected at all. */
  readonly refusalCode: string | null;
  readonly ruleCount: number;
  readonly fixableRuleCount: number;
  readonly actionCount: number;
  /** Per rule: what SmartFix would do about it, and why not when it would not. */
  readonly rules: readonly SmartFixPlanRuleView[];
}

export interface SmartFixPlanRuleView {
  readonly ruleCode: string;
  readonly fixability: string;
  readonly reasonCode: string | null;
  readonly targetCount: number;
  readonly fixableTargetCount: number;
}

/** What a correction looks like while it runs, and after. */
export interface SmartFixRequestView {
  readonly id: string;
  readonly planId: string;
  readonly checkId: string;
  readonly status: SmartFixRequestStatus;
  readonly failureCode: string | null;
  readonly correctedDocumentVersionId: string | null;
  readonly recheckCheckId: string | null;
  readonly createdAt: string;
  readonly deliveredAt: string | null;
}

/** One applied change, as the user reads it. */
export interface SmartFixManifestView {
  readonly requestId: string;
  readonly fixEngineVersion: string;
  readonly entryCount: number;
  readonly changedParts: readonly string[];
  /** The proofs, as a single answer rather than eight digests. */
  readonly textUnchanged: boolean;
  readonly mediaUnchanged: boolean;
  readonly fieldsUnchanged: boolean;
  readonly relationshipsUnchanged: boolean;
  readonly entries: readonly Record<string, unknown>[];
}

/**
 * Reading corrections back (§112, §113).
 *
 * Views, not rows: a plan's artifact carries engine internals the user has no
 * use for, and a manifest's eight integrity digests answer one question the
 * user actually has — "did you change anything but the formatting?" — which
 * this collapses into four booleans.
 */
@Injectable()
export class SmartFixReadService {
  constructor(
    private readonly tenant: TenantPrismaService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(SmartFixReadService.name);
  }

  async plan(
    userId: string,
    planId: string,
    artifact: Record<string, unknown>,
  ): Promise<SmartFixPlanView> {
    const row = await this.tenant.withUser(userId, (tx) =>
      tx.smartFixPlan.findFirst({ where: { id: planId, ownerUserId: userId } }),
    );
    if (row === null) {
      throw new AppError(PalCertErrorCode.NOT_FOUND, {
        message: 'That correction plan could not be found.',
      });
    }
    const rules = Array.isArray(artifact.rules) ? artifact.rules : [];
    const reservation = await this.tenant.withUser(userId, (tx) =>
      tx.smartFixPlanningReservation.findFirst({
        where: { id: planId, ownerUserId: userId },
        include: { servicePurchase: true },
      }),
    );
    return {
      ...(reservation
        ? {
            reservation: {
              status: reservation.status,
              priceQuoteId: reservation.servicePurchase.priceQuoteId,
              amount: money(
                reservation.servicePurchase.currency,
                reservation.servicePurchase.amountMinor,
              ),
            },
          }
        : {}),
      id: row.id,
      checkId: row.checkId,
      documentVersionId: row.documentVersionId,
      createdAt: row.createdAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
      fixEngineVersion: row.fixEngineVersion,
      refusalCode: row.refusalCode,
      ruleCount: row.ruleCount,
      fixableRuleCount: row.fixableRuleCount,
      actionCount: row.actionCount,
      ...(artifact.aiPlanning ? { aiPlanning: artifact.aiPlanning as SmartFixAIPlanning } : {}),
      rules: rules.map((rule) => {
        const entry = rule as Record<string, unknown>;
        return {
          ruleCode: String(entry.ruleCode ?? ''),
          fixability: String(entry.fixability ?? ''),
          reasonCode: entry.reasonCode === undefined ? null : String(entry.reasonCode),
          targetCount: Number(entry.targetCount ?? 0),
          fixableTargetCount: Number(entry.fixableTargetCount ?? 0),
        };
      }),
    };
  }

  async request(userId: string, requestId: string): Promise<SmartFixRequestView> {
    const row = await this.tenant.withUser(userId, (tx) =>
      tx.smartFixRequest.findFirst({ where: { id: requestId, ownerUserId: userId } }),
    );
    if (row === null) {
      throw new AppError(PalCertErrorCode.NOT_FOUND, {
        message: 'That correction could not be found.',
      });
    }
    return toRequestView(row);
  }

  async requestsForCheck(userId: string, checkId: string): Promise<readonly SmartFixRequestView[]> {
    const rows = await this.tenant.withUser(userId, (tx) =>
      tx.smartFixRequest.findMany({
        where: { ownerUserId: userId, checkId },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
    );
    return rows.map(toRequestView);
  }

  async manifest(
    userId: string,
    requestId: string,
    entries: readonly Record<string, unknown>[],
  ): Promise<SmartFixManifestView> {
    const row = await this.tenant.withUser(userId, (tx) =>
      tx.smartFixManifest.findFirst({ where: { requestId, ownerUserId: userId } }),
    );
    if (row === null) {
      throw new AppError(PalCertErrorCode.NOT_FOUND, {
        message: 'That correction has no change manifest.',
      });
    }
    return {
      requestId: row.requestId,
      fixEngineVersion: row.fixEngineVersion,
      entryCount: row.entryCount,
      changedParts: row.changedParts,
      textUnchanged: row.sourceVisibleTextHash === row.outputVisibleTextHash,
      mediaUnchanged: row.sourceMediaSetHash === row.outputMediaSetHash,
      fieldsUnchanged: row.sourceFieldInstructionHash === row.outputFieldInstructionHash,
      relationshipsUnchanged: row.sourceRelationshipHash === row.outputRelationshipHash,
      entries,
    };
  }
}

function toRequestView(row: {
  id: string;
  planId: string;
  checkId: string;
  status: string;
  failureCode: string | null;
  correctedDocumentVersionId: string | null;
  recheckCheckId: string | null;
  createdAt: Date;
  deliveredAt: Date | null;
}): SmartFixRequestView {
  return {
    id: row.id,
    planId: row.planId,
    checkId: row.checkId,
    status: row.status as SmartFixRequestStatus,
    failureCode: row.failureCode,
    // Only after delivery does the corrected version mean anything to the
    // user; before that it exists but is not theirs to reach (§84).
    correctedDocumentVersionId: row.status === 'DELIVERED' ? row.correctedDocumentVersionId : null,
    recheckCheckId: row.recheckCheckId,
    createdAt: row.createdAt.toISOString(),
    deliveredAt: row.deliveredAt === null ? null : row.deliveredAt.toISOString(),
  };
}
