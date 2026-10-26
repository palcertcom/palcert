import { Injectable } from '@nestjs/common';
import {
  AppError,
  PalCertErrorCode,
  RULE_SCHEMA_VERSION,
  StandardVersionStatus,
  buildPage,
  canTransitionStandardVersionStatus,
  decodeCursor,
  encodeCursor,
  resolveLimit,
  validateRuleDefinition,
  type CanonicalStandardInput,
  type Page,
  type RuleDefinition,
  type StandardVersionUsageView,
  type StandardVersionValidationView,
  type StandardVersionView,
} from '@palcert/contracts';
import {
  TenantPrismaService,
  type TenantClient,
} from '../../../infrastructure/tenant/tenant-prisma.service';
import { ClockPort } from '../../auth/ports/clock.port';
import { SecurityEventService } from '../../auth/services/security-event.service';
import type { Standard, StandardVersion, StandardVersionImport } from '@palcert/database';
import type { TenantContext } from '../../organizations/tenant-context';
import { assertRevisionMatches } from '../concurrency';
import { StandardHasherService } from './standard-hasher.service';
import { toProvenanceView } from './standard-transfer.service';
import { toRuleDefinition, type StandardRuleRow } from './rule-mapping';
import { assertPlainText } from './text-safety';

export interface RequestContext {
  readonly requestId: string | null;
  readonly ipAddress: string | null;
}

interface VersionRow {
  id: string;
  standardId: string;
  versionLabel: string;
  status: string;
  effectiveFrom: Date | null;
  effectiveUntil: Date | null;
  contentHash: string | null;
  canonicalizationVersion: number | null;
  ruleSchemaVersion: number;
  revision: number;
  publishedAt: Date | null;
  publishedByUserId: string | null;
  archivedAt: Date | null;
  supersededAt: Date | null;
  supersededByVersionId: string | null;
  clonedFromVersionId: string | null;
  createdAt: Date;
  updatedAt: Date;
  _count?: { rules: number };
  supersededBy?: { versionLabel: string } | null;
  importRecord?: StandardVersionImport | null;
}

const VERSION_INCLUDE = {
  _count: { select: { rules: true } },
  supersededBy: { select: { versionLabel: true } },
  importRecord: true,
};

@Injectable()
export class StandardVersionService {
  constructor(
    private readonly tenant: TenantPrismaService,
    private readonly events: SecurityEventService,
    private readonly hasher: StandardHasherService,
    private readonly clock: ClockPort,
  ) {}

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  async list(
    context: TenantContext,
    standardId: string,
    query: { cursor?: string | undefined; limit?: number | undefined; status?: string | undefined },
  ): Promise<Page<StandardVersionView>> {
    const limit = resolveLimit(query.limit);
    const cursor = parseCursor(query.cursor);

    const rows = await this.tenant.withTenant(scopeOf(context), async (tx) => {
      await assertStandardExists(tx, standardId);

      return tx.standardVersion.findMany({
        where: {
          standardId,
          ...(query.status === undefined ? {} : { status: query.status as StandardVersionStatus }),
          ...(cursor === null
            ? {}
            : {
                OR: [
                  { createdAt: { lt: new Date(cursor.sortValue) } },
                  { createdAt: new Date(cursor.sortValue), id: { gt: cursor.id } },
                ],
              }),
        },
        // Newest first: an author's own recent drafts are what they came for.
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        take: limit + 1,
        include: VERSION_INCLUDE,
      });
    });

    return buildPage(rows.map(toView), limit, (item) => encodeCursor(item.createdAt, item.id));
  }

  async get(
    context: TenantContext,
    standardId: string,
    versionId: string,
  ): Promise<StandardVersionView> {
    const row = await this.tenant.withTenant(scopeOf(context), (tx) =>
      tx.standardVersion.findFirst({
        where: { id: versionId, standardId },
        include: VERSION_INCLUDE,
      }),
    );
    if (row === null) throw versionNotFound();
    return toView(row);
  }

  /**
   * What relies on a version, as far as its organization can see: the
   * submissions checked against it and the certificates issued on them. It is
   * what makes "superseded, not forgotten" visible on a historical version.
   */
  async usage(
    context: TenantContext,
    standardId: string,
    versionId: string,
  ): Promise<StandardVersionUsageView> {
    return this.tenant.withTenant(scopeOf(context), async (tx) => {
      const version = await tx.standardVersion.findFirst({
        where: { id: versionId, standardId },
        select: { id: true },
      });
      if (version === null) throw versionNotFound();

      const [submissionCount, certificateCount] = await Promise.all([
        tx.submissionRevision.count({
          where: {
            organizationId: context.organizationId,
            standardVersionId: versionId,
            processingStatus: 'READY',
          },
        }),
        tx.complianceCertificate.count({
          where: {
            organizationId: context.organizationId,
            issuedAt: { not: null },
            revision: { standardVersionId: versionId },
          },
        }),
      ]);
      return { standardVersionId: versionId, submissionCount, certificateCount };
    });
  }

  // -------------------------------------------------------------------------
  // Draft lifecycle
  // -------------------------------------------------------------------------

  async create(
    context: TenantContext,
    standardId: string,
    params: { versionLabel: string; effectiveFrom?: string; effectiveUntil?: string },
    request: RequestContext,
  ): Promise<StandardVersionView> {
    assertPlainText('versionLabel', params.versionLabel);
    const window = parseEffectiveWindow(params.effectiveFrom, params.effectiveUntil);

    const row = await this.tenant
      .withTenant(scopeOf(context), async (tx) => {
        const standard = await assertStandardExists(tx, standardId);
        if (standard.status === 'ARCHIVED') {
          throw new AppError(PalCertErrorCode.STANDARD_ARCHIVED, {
            message: 'This standard is archived. Restore it before adding a version.',
          });
        }

        if (await labelIsTaken(tx, standardId, params.versionLabel, null)) throw labelTaken();

        return tx.standardVersion.create({
          data: {
            organizationId: context.organizationId,
            standardId,
            versionLabel: params.versionLabel,
            status: StandardVersionStatus.DRAFT,
            effectiveFrom: window.from,
            effectiveUntil: window.until,
            ruleSchemaVersion: RULE_SCHEMA_VERSION,
            createdByUserId: context.userId,
          },
          include: VERSION_INCLUDE,
        });
      })
      .catch(rethrowLabelConflict);

    await this.events.audit({
      action: 'STANDARD_VERSION_CREATED',
      actorUserId: context.userId,
      targetType: 'StandardVersion',
      targetId: row.id,
      requestId: request.requestId,
      ipAddress: request.ipAddress,
      afterState: { standardId, versionLabel: row.versionLabel },
    });

    return toView(row);
  }

  async update(
    context: TenantContext,
    standardId: string,
    versionId: string,
    expectedRevision: number,
    params: { versionLabel?: string; effectiveFrom?: string; effectiveUntil?: string },
    request: RequestContext,
  ): Promise<StandardVersionView> {
    assertPlainText('versionLabel', params.versionLabel);

    const row = await this.tenant
      .withTenant(scopeOf(context), async (tx) => {
        const current = await lockDraft(tx, standardId, versionId, expectedRevision);

        const window = parseEffectiveWindow(
          params.effectiveFrom ?? current.effectiveFrom?.toISOString(),
          params.effectiveUntil ?? current.effectiveUntil?.toISOString(),
        );

        if (
          params.versionLabel !== undefined &&
          (await labelIsTaken(tx, standardId, params.versionLabel, versionId))
        ) {
          throw labelTaken();
        }

        return tx.standardVersion.update({
          where: { id: versionId },
          data: {
            ...(params.versionLabel === undefined ? {} : { versionLabel: params.versionLabel }),
            effectiveFrom: window.from,
            effectiveUntil: window.until,
            revision: { increment: 1 },
          },
          include: VERSION_INCLUDE,
        });
      })
      .catch(rethrowLabelConflict);

    await this.events.audit({
      action: 'STANDARD_VERSION_UPDATED',
      actorUserId: context.userId,
      targetType: 'StandardVersion',
      targetId: versionId,
      requestId: request.requestId,
      ipAddress: request.ipAddress,
      afterState: { versionLabel: row.versionLabel, revision: row.revision },
    });

    return toView(row);
  }

  /**
   * Clone a version into a new draft.
   *
   * This is the *only* supported way to change a published standard, so the
   * copy has to be complete: every rule, with every field, carried across
   * verbatim. What is deliberately not carried is the publication state —
   * hash, timestamp, publisher — because the clone has not been published and
   * must not appear to have been.
   *
   * The rule schema version is carried across too, so cloning a v1 version
   * produces a v1 draft. Upgrading it is a separate, explicit decision the
   * caller makes with `upgradeRuleSchema`: the newer schema relaxes an
   * invariant, and quietly re-stamping copied content with a version its author
   * never chose would misrepresent what they wrote. The upgrade applies to the
   * new draft only; the source version is never modified on either path.
   */
  async clone(
    context: TenantContext,
    standardId: string,
    versionId: string,
    versionLabel: string,
    request: RequestContext,
    options: { upgradeRuleSchema?: boolean | undefined } = {},
  ): Promise<StandardVersionView> {
    assertPlainText('versionLabel', versionLabel);

    const row = await this.tenant
      .withTenant(scopeOf(context), async (tx) => {
        const source = await tx.standardVersion.findFirst({
          where: { id: versionId, standardId },
          include: { rules: true },
        });
        if (source === null) throw versionNotFound();

        if (await labelIsTaken(tx, standardId, versionLabel, null)) throw labelTaken();

        const targetSchemaVersion = resolveCloneSchemaVersion(
          source.ruleSchemaVersion,
          options.upgradeRuleSchema === true,
        );

        const draft = await tx.standardVersion.create({
          data: {
            organizationId: context.organizationId,
            standardId,
            versionLabel,
            status: StandardVersionStatus.DRAFT,
            effectiveFrom: null,
            effectiveUntil: null,
            ruleSchemaVersion: targetSchemaVersion,
            clonedFromVersionId: source.id,
            createdByUserId: context.userId,
          },
          include: VERSION_INCLUDE,
        });

        if (source.rules.length > 0) {
          await tx.standardRule.createMany({
            data: source.rules.map((rule) => ({
              organizationId: context.organizationId,
              standardVersionId: draft.id,
              ruleCode: rule.ruleCode,
              category: rule.category,
              evaluationMode: rule.evaluationMode,
              scope: rule.scope as object,
              operator: rule.operator,
              expectedValue: rule.expectedValue as object,
              unit: rule.unit,
              tolerance: rule.tolerance,
              severity: rule.severity,
              blocking: rule.blocking,
              autofix: rule.autofix,
              origin: rule.origin,
              originReference: rule.originReference,
              titleEn: rule.titleEn,
              titleAr: rule.titleAr,
              descriptionEn: rule.descriptionEn,
              descriptionAr: rule.descriptionAr,
              guidanceEn: rule.guidanceEn,
              guidanceAr: rule.guidanceAr,
              displayOrder: rule.displayOrder,
              // Every rule carries the draft's version: the database trigger
              // requires the pairing, and a draft holding a mix of schema
              // versions could not be validated coherently.
              ruleSchemaVersion: targetSchemaVersion,
            })),
          });
        }

        return {
          ...draft,
          _count: { rules: source.rules.length },
          sourceSchemaVersion: source.ruleSchemaVersion,
        };
      })
      .catch(rethrowLabelConflict);

    await this.events.audit({
      action: 'STANDARD_VERSION_CLONED',
      actorUserId: context.userId,
      targetType: 'StandardVersion',
      targetId: row.id,
      requestId: request.requestId,
      ipAddress: request.ipAddress,
      // The schema versions on both sides are recorded, so an upgrade is
      // legible in the audit trail rather than inferable only by comparing two
      // versions that may since have changed.
      afterState: {
        clonedFromVersionId: versionId,
        versionLabel: row.versionLabel,
        sourceRuleSchemaVersion: row.sourceSchemaVersion,
        ruleSchemaVersion: row.ruleSchemaVersion,
        ruleSchemaUpgraded: row.ruleSchemaVersion !== row.sourceSchemaVersion,
      },
    });

    return toView(row);
  }

  // -------------------------------------------------------------------------
  // Validation
  // -------------------------------------------------------------------------

  /**
   * Validate a draft without changing anything.
   *
   * The same routine publication runs, exposed so an author can see every
   * problem at once instead of discovering them one failed publish at a time.
   */
  async validate(
    context: TenantContext,
    standardId: string,
    versionId: string,
  ): Promise<StandardVersionValidationView> {
    const rules = await this.tenant.withTenant(scopeOf(context), async (tx) => {
      const version = await tx.standardVersion.findFirst({ where: { id: versionId, standardId } });
      if (version === null) throw versionNotFound();
      return tx.standardRule.findMany({
        where: { standardVersionId: versionId },
        orderBy: [{ displayOrder: 'asc' }, { id: 'asc' }],
      });
    });

    return validateForPublication(rules as StandardRuleRow[]);
  }

  // -------------------------------------------------------------------------
  // Publication
  // -------------------------------------------------------------------------

  /**
   * Publish a draft, superseding the version in force.
   *
   * One transaction, in this order:
   *
   *   1. lock the target row (`FOR UPDATE`), so two publishes of the same
   *      draft serialize rather than both computing a snapshot;
   *   2. re-validate every rule — including rules written before a validation
   *      rule was tightened;
   *   3. lock the version currently in force, if there is one, and check it is
   *      the one the caller expects to replace;
   *   4. mark it SUPERSEDED, recording this version as its successor;
   *   5. canonicalize, hash and insert the snapshot (unique on the version, so
   *      a retry cannot produce a second one);
   *   6. flip this version to PUBLISHED with its hash;
   *   7. write both audit events.
   *
   * Everything commits together or not at all. Step 4 has to precede step 6
   * because the one-published-version index is checked per statement; the
   * database's deferred supersession trigger then refuses to commit a
   * superseded version whose successor did not end up PUBLISHED, so a failure
   * anywhere after step 4 cannot leave the standard with nothing in force.
   *
   * Two drafts published at once: both lock their own row, then queue on the
   * version in force. The first supersedes it and commits; the second then
   * finds that row no longer PUBLISHED. With `replacesVersionId` it is refused
   * outright; without it, it goes on to publish and the partial unique index
   * refuses it. Either way it is told CONFLICT, and never are two versions in
   * force.
   *
   * Idempotent by design: publishing an already-published version returns its
   * existing state rather than failing, because a client that retried after a
   * dropped response should not be told it broke something. `If-Match` is not
   * required here — the locks, not a client-supplied revision, are what make
   * this safe, and demanding one would make the retry path fail spuriously.
   */
  async publish(
    context: TenantContext,
    standardId: string,
    versionId: string,
    request: RequestContext,
    options: { replacesVersionId?: string | null } = {},
  ): Promise<StandardVersionView> {
    const row = await this.tenant
      .withTenant(scopeOf(context), async (tx) => {
        const locked = await tx.$queryRaw<Array<{ id: string; status: string }>>`
        SELECT "id", "status"::text AS status
        FROM "standard_versions"
        WHERE "id" = ${versionId}::uuid AND "standard_id" = ${standardId}::uuid
        FOR UPDATE
      `;
        if (locked.length === 0) throw versionNotFound();

        const status = locked[0]!.status as StandardVersionStatus;

        if (status === StandardVersionStatus.PUBLISHED) {
          return tx.standardVersion.findUniqueOrThrow({
            where: { id: versionId },
            include: VERSION_INCLUDE,
          });
        }

        if (status === StandardVersionStatus.SUPERSEDED) {
          const current = await tx.standardVersion.findUniqueOrThrow({
            where: { id: versionId },
            include: VERSION_INCLUDE,
          });
          throw supersededVersion(current.supersededBy?.versionLabel ?? null);
        }

        if (!canTransitionStandardVersionStatus(status, StandardVersionStatus.PUBLISHED)) {
          throw new AppError(PalCertErrorCode.STANDARD_VERSION_ARCHIVED, {
            message: 'An archived version cannot be published. Clone it into a new draft instead.',
          });
        }

        const [standard, rules] = await Promise.all([
          tx.standard.findUniqueOrThrow({
            where: { id: standardId },
            include: { documentType: { select: { name: true, systemCategory: true } } },
          }),
          tx.standardRule.findMany({ where: { standardVersionId: versionId } }),
        ]);

        if (rules.length === 0) {
          throw new AppError(PalCertErrorCode.STANDARD_VERSION_EMPTY, {
            message:
              'A standard version must contain at least one rule before it can be published.',
          });
        }

        const validation = validateRuleSet(rules as StandardRuleRow[]);
        if (!validation.valid) {
          throw new AppError(PalCertErrorCode.STANDARD_VERSION_INVALID, {
            message: `This draft has ${validation.issues.length} problem(s) that must be fixed before publishing.`,
            details: { issues: validation.issues },
          });
        }

        const version = await tx.standardVersion.findUniqueOrThrow({ where: { id: versionId } });

        // The version in force, locked so a concurrent publish of another
        // draft queues behind this one. Under READ COMMITTED a waiter re-reads
        // the row once the lock is released and gets nothing back if it was
        // superseded meanwhile, which is exactly what the checks below catch.
        const inForce = await tx.$queryRaw<Array<{ id: string; versionLabel: string }>>`
        SELECT "id", "version_label" AS "versionLabel"
        FROM "standard_versions"
        WHERE "standard_id" = ${standardId}::uuid AND "status" = 'PUBLISHED'
        FOR UPDATE
      `;
        const previous = inForce[0] ?? null;

        if (
          options.replacesVersionId !== undefined &&
          options.replacesVersionId !== (previous?.id ?? null)
        ) {
          throw inForceChanged(previous?.versionLabel ?? null);
        }

        const now = this.clock.now();

        if (previous !== null) {
          await tx.standardVersion.update({
            where: { id: previous.id },
            data: {
              status: StandardVersionStatus.SUPERSEDED,
              supersededAt: now,
              supersededByVersionId: versionId,
              revision: { increment: 1 },
            },
          });
        }

        const input: CanonicalStandardInput = {
          standardCode: standard.code,
          standardNameEn: standard.nameEn,
          standardNameAr: standard.nameAr,
          standardDescriptionEn: standard.descriptionEn,
          standardDescriptionAr: standard.descriptionAr,
          documentTypeCategory: standard.documentType
            .systemCategory as CanonicalStandardInput['documentTypeCategory'],
          documentTypeName: standard.documentType.name,
          versionLabel: version.versionLabel,
          effectiveFrom: version.effectiveFrom?.toISOString() ?? null,
          effectiveUntil: version.effectiveUntil?.toISOString() ?? null,
          ruleSchemaVersion: version.ruleSchemaVersion,
          rules: (rules as StandardRuleRow[]).map(toRuleDefinition),
        };

        const snapshot = this.hasher.build(input);

        await tx.standardVersionSnapshot.create({
          data: {
            organizationId: context.organizationId,
            standardVersionId: versionId,
            canonical: snapshot.canonical as object,
            contentHash: snapshot.contentHash,
            canonicalizationVersion: snapshot.canonicalizationVersion,
            ruleSchemaVersion: version.ruleSchemaVersion,
            ruleCount: snapshot.ruleCount,
          },
        });

        const published = await tx.standardVersion.update({
          where: { id: versionId },
          data: {
            status: StandardVersionStatus.PUBLISHED,
            contentHash: snapshot.contentHash,
            canonicalizationVersion: snapshot.canonicalizationVersion,
            publishedAt: now,
            publishedByUserId: context.userId,
            revision: { increment: 1 },
          },
          include: VERSION_INCLUDE,
        });

        // Both records are part of the change. The earlier PUBLISHED event of
        // the superseded version is left exactly as it was.
        if (previous !== null) {
          await this.events.auditWithin(tx, {
            action: 'STANDARD_VERSION_SUPERSEDED',
            actorUserId: context.userId,
            targetType: 'StandardVersion',
            targetId: previous.id,
            requestId: request.requestId,
            ipAddress: request.ipAddress,
            beforeState: { status: StandardVersionStatus.PUBLISHED },
            afterState: {
              standardId,
              status: StandardVersionStatus.SUPERSEDED,
              previousVersionId: previous.id,
              previousVersionLabel: previous.versionLabel,
              supersededByVersionId: versionId,
              supersededByVersionLabel: published.versionLabel,
              supersededAt: now.toISOString(),
            },
          });
        }

        await this.events.auditWithin(tx, {
          action: 'STANDARD_VERSION_PUBLISHED',
          actorUserId: context.userId,
          targetType: 'StandardVersion',
          targetId: versionId,
          requestId: request.requestId,
          ipAddress: request.ipAddress,
          afterState: {
            standardId,
            versionLabel: published.versionLabel,
            contentHash: published.contentHash,
            ruleCount: published._count?.rules ?? 0,
            supersededVersionId: previous?.id ?? null,
            supersededVersionLabel: previous?.versionLabel ?? null,
          },
        });

        return published;
      })
      .catch(rethrowPublishConflict);

    return toView(row);
  }

  /**
   * Retire a version deliberately.
   *
   * A draft or the version in force may be archived. A superseded version may
   * not: it is already history, and archiving it would overwrite "replaced by
   * 1.2" with a retirement nobody decided on.
   */
  async archive(
    context: TenantContext,
    standardId: string,
    versionId: string,
    request: RequestContext,
  ): Promise<StandardVersionView> {
    const row = await this.tenant.withTenant(scopeOf(context), async (tx) => {
      const current = await tx.standardVersion.findFirst({
        where: { id: versionId, standardId },
        include: VERSION_INCLUDE,
      });
      if (current === null) throw versionNotFound();

      const status = current.status as StandardVersionStatus;
      if (status === StandardVersionStatus.SUPERSEDED) {
        throw supersededVersion(current.supersededBy?.versionLabel ?? null);
      }
      if (!canTransitionStandardVersionStatus(status, StandardVersionStatus.ARCHIVED)) {
        throw new AppError(PalCertErrorCode.STANDARD_VERSION_ARCHIVED, {
          message: 'This version is already archived.',
        });
      }

      return tx.standardVersion.update({
        where: { id: versionId },
        data: {
          status: StandardVersionStatus.ARCHIVED,
          archivedAt: this.clock.now(),
          revision: { increment: 1 },
        },
        include: VERSION_INCLUDE,
      });
    });

    await this.events.audit({
      action: 'STANDARD_VERSION_ARCHIVED',
      actorUserId: context.userId,
      targetType: 'StandardVersion',
      targetId: versionId,
      requestId: request.requestId,
      ipAddress: request.ipAddress,
      afterState: { standardId, status: StandardVersionStatus.ARCHIVED },
    });

    return toView(row);
  }

  /**
   * Read the published snapshot, re-verifying its hash on the way out.
   *
   * Verification is done on every read rather than trusted from storage: the
   * whole value of the snapshot is that it can be checked, and a snapshot
   * nobody ever checks is a snapshot nobody would notice being wrong.
   */
  async snapshot(
    context: TenantContext,
    standardId: string,
    versionId: string,
  ): Promise<{
    standardVersionId: string;
    contentHash: string;
    canonicalizationVersion: number;
    ruleSchemaVersion: number;
    ruleCount: number;
    canonical: Record<string, unknown>;
    hashVerified: boolean;
    createdAt: string;
  }> {
    const row = await this.tenant.withTenant(scopeOf(context), async (tx) => {
      const version = await tx.standardVersion.findFirst({ where: { id: versionId, standardId } });
      if (version === null) throw versionNotFound();
      return tx.standardVersionSnapshot.findUnique({ where: { standardVersionId: versionId } });
    });

    if (row === null) {
      throw new AppError(PalCertErrorCode.STANDARD_VERSION_NOT_DRAFT, {
        message: 'This version has never been published, so it has no snapshot.',
      });
    }

    return {
      standardVersionId: row.standardVersionId,
      contentHash: row.contentHash,
      canonicalizationVersion: row.canonicalizationVersion,
      ruleSchemaVersion: row.ruleSchemaVersion,
      ruleCount: row.ruleCount,
      canonical: row.canonical as Record<string, unknown>,
      hashVerified: this.hasher.verify(row.canonical, row.contentHash),
      createdAt: row.createdAt.toISOString(),
    };
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function scopeOf(context: TenantContext): { organizationId: string; userId: string } {
  return { organizationId: context.organizationId, userId: context.userId };
}

/**
 * Decide which rule schema version a clone is written under.
 *
 * Deterministic and total: preserve the source version, or move to the current
 * one when the caller asked. A "downgrade" is refused rather than silently
 * ignored — it cannot be honoured, because content written under a newer schema
 * may rely on an invariant the older one enforces, and pretending otherwise
 * would produce a draft that fails validation for reasons the caller did not
 * cause.
 */
export function resolveCloneSchemaVersion(sourceVersion: number, upgrade: boolean): number {
  if (!upgrade) return sourceVersion;
  if (sourceVersion > RULE_SCHEMA_VERSION) {
    throw new AppError(PalCertErrorCode.RULE_SCHEMA_INVALID, {
      message:
        `This version already uses rule schema version ${sourceVersion}, which is newer than ` +
        `the ${RULE_SCHEMA_VERSION} this release writes. It cannot be upgraded here.`,
      details: { sourceRuleSchemaVersion: sourceVersion, ruleSchemaVersion: RULE_SCHEMA_VERSION },
    });
  }
  return RULE_SCHEMA_VERSION;
}

/**
 * Validate a whole rule set.
 *
 * Per-rule validation plus the one property that is a fact about the *set*:
 * rule codes must be unique. Duplicate codes would make findings ambiguous and
 * would make the canonical ordering undefined.
 */
export function validateRuleSet(rules: readonly StandardRuleRow[]): StandardVersionValidationView {
  const issues: StandardVersionValidationView['issues'][number][] = [];

  for (const row of rules) {
    const definition: RuleDefinition = toRuleDefinition(row);
    // Each rule is judged under its own stored schema version. A v1 version
    // that was valid when it was written stays valid: the v2 amendment relaxed
    // an invariant, and re-judging history under the newer rules would report
    // problems in content nobody may still edit.
    for (const issue of validateRuleDefinition(definition, {
      schemaVersion: row.ruleSchemaVersion,
    }).issues) {
      issues.push({
        ruleCode: row.ruleCode,
        path: issue.path,
        code: issue.code,
        message: issue.message,
      });
    }
  }

  const seen = new Set<string>();
  for (const row of rules) {
    if (seen.has(row.ruleCode)) {
      issues.push({
        ruleCode: row.ruleCode,
        path: 'ruleCode',
        code: 'DUPLICATE',
        message: `More than one rule uses the code ${row.ruleCode}.`,
      });
    }
    seen.add(row.ruleCode);
  }

  return { valid: issues.length === 0, ruleCount: rules.length, issues };
}

/**
 * Lock a draft for editing and check the caller's precondition.
 *
 * `FOR UPDATE` is taken before the revision is compared, so two requests
 * arriving with the same revision cannot both pass the check: the second waits,
 * then sees the incremented value and is refused.
 */
export async function lockDraft(
  tx: TenantClient,
  standardId: string,
  versionId: string,
  expectedRevision: number,
): Promise<StandardVersion> {
  const locked = await tx.$queryRaw<Array<{ status: string; revision: number }>>`
    SELECT "status"::text AS status, "revision"
    FROM "standard_versions"
    WHERE "id" = ${versionId}::uuid AND "standard_id" = ${standardId}::uuid
    FOR UPDATE
  `;
  if (locked.length === 0) throw versionNotFound();

  const { status, revision } = locked[0]!;

  if (status === 'PUBLISHED') {
    throw new AppError(PalCertErrorCode.STANDARD_VERSION_IMMUTABLE, {
      message:
        'This version is published and cannot be edited. Clone it into a new draft, change the ' +
        'draft, and publish that.',
    });
  }
  if (status === 'SUPERSEDED') {
    throw supersededVersion(null);
  }
  if (status === 'ARCHIVED') {
    throw new AppError(PalCertErrorCode.STANDARD_VERSION_ARCHIVED, {
      message: 'This version is archived and cannot be edited.',
    });
  }

  assertRevisionMatches(expectedRevision, revision);

  return tx.standardVersion.findUniqueOrThrow({ where: { id: versionId } });
}

async function assertStandardExists(tx: TenantClient, standardId: string): Promise<Standard> {
  const standard = await tx.standard.findUnique({ where: { id: standardId } });
  if (standard === null) {
    throw new AppError(PalCertErrorCode.STANDARD_NOT_FOUND, {
      message: 'That standard does not exist.',
    });
  }
  return standard;
}

function versionNotFound(): AppError {
  return new AppError(PalCertErrorCode.STANDARD_VERSION_NOT_FOUND, {
    message: 'That standard version does not exist.',
  });
}

function parseCursor(cursor: string | undefined): { sortValue: string; id: string } | null {
  if (cursor === undefined) return null;
  const decoded = decodeCursor(cursor);
  if (decoded === null || Number.isNaN(Date.parse(decoded.sortValue))) {
    throw new AppError(PalCertErrorCode.VALIDATION_FAILED, {
      message: 'That page cursor is not one this API issued.',
      details: { field: 'cursor' },
    });
  }
  return decoded;
}

function parseEffectiveWindow(
  from: string | undefined,
  until: string | undefined,
): { from: Date | null; until: Date | null } {
  const start = from === undefined || from === '' ? null : new Date(from);
  const end = until === undefined || until === '' ? null : new Date(until);

  if (start !== null && end !== null && start > end) {
    throw new AppError(PalCertErrorCode.VALIDATION_FAILED, {
      message: 'effectiveFrom must not be later than effectiveUntil.',
      details: { field: 'effectiveFrom' },
    });
  }
  return { from: start, until: end };
}

/**
 * Backstop for a label collision that slips past the pre-check.
 *
 * Only used on the draft-creation paths (create, update, clone), never on
 * publish: `meta.target` is null under the least-privileged role, so a P2002
 * on `StandardVersion` cannot be told apart from the partial
 * one-published-per-standard index by inspection. Keeping this catch off the
 * publish path is what stops the two being confused — publish has its own.
 */
function rethrowLabelConflict(error: unknown): never {
  const code = (error as { code?: string }).code;
  const model = (error as { meta?: { modelName?: string } }).meta?.modelName;

  if (code === 'P2002' && model === 'StandardVersion') throw labelTaken();
  throw error as Error;
}

/**
 * The caller confirmed replacing one version, but another is in force now —
 * someone published in between. Replacing a version the caller never saw would
 * be a decision they did not make.
 */
function inForceChanged(currentLabel: string | null): AppError {
  return new AppError(PalCertErrorCode.CONFLICT, {
    message:
      currentLabel === null
        ? 'The version you expected to replace is no longer in force. Reload and try again.'
        : `Version ${currentLabel} is now the version in force, so this is no longer the ` +
          'replacement you confirmed. Reload and try again.',
    details: { publishedVersionLabel: currentLabel },
  });
}

function supersededVersion(successorLabel: string | null): AppError {
  return new AppError(PalCertErrorCode.STANDARD_VERSION_SUPERSEDED, {
    message:
      (successorLabel === null
        ? 'This version was superseded by a newer version'
        : `This version was superseded by version ${successorLabel}`) +
      ' and is kept as read-only history. Clone it into a new draft to use its content again.',
    details: { supersededByVersionLabel: successorLabel },
  });
}

/**
 * Backstop for the publish race.
 *
 * Two concurrent publishes of different drafts of one standard both pass the
 * in-force check, and the partial unique index refuses the second. `meta.target`
 * is null under the least-privileged role, but on this path a P2002 on
 * `StandardVersion` can only be that index: the version label was fixed at
 * creation and publish never changes it.
 */
function rethrowPublishConflict(error: unknown): never {
  const code = (error as { code?: string }).code;
  const model = (error as { meta?: { modelName?: string } }).meta?.modelName;

  if (code === 'P2002' && model === 'StandardVersion') {
    throw new AppError(PalCertErrorCode.CONFLICT, {
      message:
        'Another version of this standard was published at the same moment. Reload and retry.',
    });
  }
  throw error as Error;
}

function labelTaken(): AppError {
  return new AppError(PalCertErrorCode.STANDARD_VERSION_LABEL_TAKEN, {
    message: 'This standard already has a version with that label.',
  });
}

/** Is this label already used within the standard? */
async function labelIsTaken(
  tx: TenantClient,
  standardId: string,
  versionLabel: string,
  excludingId: string | null,
): Promise<boolean> {
  const existing = await tx.standardVersion.findFirst({
    where: {
      standardId,
      versionLabel,
      ...(excludingId === null ? {} : { NOT: { id: excludingId } }),
    },
    select: { id: true },
  });
  return existing !== null;
}

function toView(row: VersionRow): StandardVersionView {
  return {
    id: row.id,
    standardId: row.standardId,
    versionLabel: row.versionLabel,
    status: row.status as StandardVersionStatus,
    effectiveFrom: row.effectiveFrom?.toISOString() ?? null,
    effectiveUntil: row.effectiveUntil?.toISOString() ?? null,
    ruleCount: row._count?.rules ?? 0,
    contentHash: row.contentHash,
    canonicalizationVersion: row.canonicalizationVersion,
    ruleSchemaVersion: row.ruleSchemaVersion,
    revision: row.revision,
    publishedAt: row.publishedAt?.toISOString() ?? null,
    publishedByUserId: row.publishedByUserId,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    supersededAt: row.supersededAt?.toISOString() ?? null,
    supersededByVersionId: row.supersededByVersionId,
    supersededByVersionLabel: row.supersededBy?.versionLabel ?? null,
    clonedFromVersionId: row.clonedFromVersionId,
    importProvenance:
      row.importRecord === undefined || row.importRecord === null
        ? null
        : toProvenanceView(row.importRecord),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * What publication checks, as a result rather than an exception.
 *
 * `validate` promises the same verdict `publish` would reach. It used to run
 * only the per-rule checks, so a draft with no rules was reported "ready to
 * publish" and then refused by publish with STANDARD_VERSION_EMPTY — the page
 * said both things at once. The empty check now lives here too.
 */
export function validateForPublication(
  rules: readonly StandardRuleRow[],
): StandardVersionValidationView {
  if (rules.length === 0) {
    return {
      valid: false,
      ruleCount: 0,
      issues: [
        {
          ruleCode: null,
          path: 'rules',
          code: PalCertErrorCode.STANDARD_VERSION_EMPTY,
          message: 'A standard version must contain at least one rule before it can be published.',
        },
      ],
    };
  }
  return validateRuleSet(rules);
}
