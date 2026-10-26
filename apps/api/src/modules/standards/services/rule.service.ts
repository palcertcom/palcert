import { Injectable } from '@nestjs/common';
import {
  AppError,
  PalCertErrorCode,
  buildPage,
  decodeCursor,
  encodeCursor,
  resolveLimit,
  validateRuleDefinition,
  type Page,
  type RuleCategory,
  type RuleDefinition,
  type RuleView,
} from '@palcert/contracts';
import {
  TenantPrismaService,
  type TenantClient,
} from '../../../infrastructure/tenant/tenant-prisma.service';
import { SecurityEventService } from '../../auth/services/security-event.service';
import type { TenantContext } from '../../organizations/tenant-context';
import { lockDraft } from './standard-version.service';
import { toRuleDefinition, toRuleView, type StandardRuleRow } from './rule-mapping';

export interface RequestContext {
  readonly requestId: string | null;
  readonly ipAddress: string | null;
}

/** The rule payload as it arrives, before it has been proven valid. */
export type RuleInput = Partial<RuleDefinition> & { displayOrder?: number | undefined };

export interface RuleMutationResult {
  readonly rule: RuleView;
  /** The parent version's new revision, returned as the response ETag. */
  readonly revision: number;
}

@Injectable()
export class RuleService {
  constructor(
    private readonly tenant: TenantPrismaService,
    private readonly events: SecurityEventService,
  ) {}

  async list(
    context: TenantContext,
    standardId: string,
    versionId: string,
    query: {
      cursor?: string | undefined;
      limit?: number | undefined;
      category?: RuleCategory | undefined;
    },
  ): Promise<Page<RuleView>> {
    const limit = resolveLimit(query.limit);
    const cursor = parseCursor(query.cursor);

    const rows = await this.tenant.withTenant(scopeOf(context), async (tx) => {
      await assertVersionExists(tx, standardId, versionId);

      return tx.standardRule.findMany({
        where: {
          standardVersionId: versionId,
          ...(query.category === undefined ? {} : { category: query.category }),
          ...(cursor === null
            ? {}
            : {
                OR: [
                  { displayOrder: { gt: Number.parseInt(cursor.sortValue, 10) } },
                  { displayOrder: Number.parseInt(cursor.sortValue, 10), id: { gt: cursor.id } },
                ],
              }),
        },
        // Display order is what the report uses, so it is what the list uses;
        // the id tie-break keeps the page boundary stable when two rules share
        // an order, which is possible mid-reorder.
        orderBy: [{ displayOrder: 'asc' }, { id: 'asc' }],
        take: limit + 1,
      });
    });

    return buildPage((rows as StandardRuleRow[]).map(toRuleView), limit, (item) =>
      encodeCursor(String(item.displayOrder), item.id),
    );
  }

  async get(
    context: TenantContext,
    standardId: string,
    versionId: string,
    ruleId: string,
  ): Promise<RuleView> {
    const row = await this.tenant.withTenant(scopeOf(context), async (tx) => {
      await assertVersionExists(tx, standardId, versionId);
      return tx.standardRule.findFirst({ where: { id: ruleId, standardVersionId: versionId } });
    });
    if (row === null) throw ruleNotFound();
    return toRuleView(row as StandardRuleRow);
  }

  async create(
    context: TenantContext,
    standardId: string,
    versionId: string,
    expectedRevision: number,
    input: RuleInput,
    request: RequestContext,
  ): Promise<RuleMutationResult> {
    const result = await this.tenant
      .withTenant(scopeOf(context), async (tx) => {
        const draft = await lockDraft(tx, standardId, versionId, expectedRevision);

        // Appending rather than defaulting to 0: a new rule belongs at the end
        // of the report unless the author says otherwise.
        const displayOrder =
          input.displayOrder ??
          (await tx.standardRule
            .aggregate({
              where: { standardVersionId: versionId },
              _max: { displayOrder: true },
            })
            .then((aggregate) => (aggregate._max.displayOrder ?? -1) + 1));

        // Judged by the schema version of the draft it is being added to, not
        // by whatever version this release happens to ship. A rule sitting in
        // a v1 draft is a v1 rule and must satisfy the v1 invariants; the
        // database trigger enforces the same pairing, so validating against
        // any other version would produce a confusing constraint error instead
        // of a field-level explanation.
        const definition = assertValidRule({ ...input, displayOrder }, draft.ruleSchemaVersion);

        if (await ruleCodeIsTaken(tx, versionId, definition.ruleCode, null)) throw ruleCodeTaken();

        const created = await insertRule(tx, {
          organizationId: context.organizationId,
          versionId,
          definition,
          ruleSchemaVersion: draft.ruleSchemaVersion,
        });

        const version = await bumpVersionRevision(tx, versionId);
        return { created, revision: version.revision };
      })
      .catch(rethrowRuleCodeConflict);

    await this.events.audit({
      action: 'STANDARD_RULE_CREATED',
      actorUserId: context.userId,
      targetType: 'StandardRule',
      targetId: result.created.id,
      requestId: request.requestId,
      ipAddress: request.ipAddress,
      afterState: { standardVersionId: versionId, ruleCode: result.created.ruleCode },
    });

    return { rule: toRuleView(result.created as StandardRuleRow), revision: result.revision };
  }

  async update(
    context: TenantContext,
    standardId: string,
    versionId: string,
    ruleId: string,
    expectedRevision: number,
    input: RuleInput,
    request: RequestContext,
  ): Promise<RuleMutationResult> {
    const result = await this.tenant
      .withTenant(scopeOf(context), async (tx) => {
        const draft = await lockDraft(tx, standardId, versionId, expectedRevision);

        const existing = await tx.standardRule.findFirst({
          where: { id: ruleId, standardVersionId: versionId },
        });
        if (existing === null) throw ruleNotFound();

        // A rule is validated as a whole, never field by field: the invariants
        // that matter (operator against value type, tolerance, blocking) are
        // relationships between fields, so a partial update is merged onto the
        // stored rule and the *result* is what gets checked.
        const merged = {
          ...toRuleDefinition(existing as StandardRuleRow),
          ...stripUndefined(input),
        };
        const definition = assertValidRule(merged, draft.ruleSchemaVersion);

        if (await ruleCodeIsTaken(tx, versionId, definition.ruleCode, ruleId)) {
          throw ruleCodeTaken();
        }

        const updated = await tx.standardRule.update({
          where: { id: ruleId },
          data: {
            ruleCode: definition.ruleCode,
            category: definition.category,
            evaluationMode: definition.evaluationMode,
            scope: definition.scope as object,
            operator: definition.operator,
            expectedValue: definition.expected as object,
            unit: definition.unit,
            tolerance: definition.tolerance,
            severity: definition.severity,
            blocking: definition.blocking,
            autofix: definition.autofix,
            origin: definition.origin,
            originReference: definition.originReference,
            titleEn: definition.titleEn,
            titleAr: definition.titleAr,
            descriptionEn: definition.descriptionEn,
            descriptionAr: definition.descriptionAr,
            guidanceEn: definition.guidanceEn,
            guidanceAr: definition.guidanceAr,
            displayOrder: definition.displayOrder,
          },
        });

        const version = await this.bumpRevision(tx, versionId);
        return { updated, before: existing, revision: version.revision };
      })
      .catch(rethrowRuleCodeConflict);

    await this.events.audit({
      action: 'STANDARD_RULE_UPDATED',
      actorUserId: context.userId,
      targetType: 'StandardRule',
      targetId: ruleId,
      requestId: request.requestId,
      ipAddress: request.ipAddress,
      beforeState: { ruleCode: result.before.ruleCode, severity: result.before.severity },
      afterState: { ruleCode: result.updated.ruleCode, severity: result.updated.severity },
    });

    return { rule: toRuleView(result.updated as StandardRuleRow), revision: result.revision };
  }

  async remove(
    context: TenantContext,
    standardId: string,
    versionId: string,
    ruleId: string,
    expectedRevision: number,
    request: RequestContext,
  ): Promise<{ revision: number }> {
    const result = await this.tenant.withTenant(scopeOf(context), async (tx) => {
      await lockDraft(tx, standardId, versionId, expectedRevision);

      const existing = await tx.standardRule.findFirst({
        where: { id: ruleId, standardVersionId: versionId },
      });
      if (existing === null) throw ruleNotFound();

      await tx.standardRule.delete({ where: { id: ruleId } });
      const version = await this.bumpRevision(tx, versionId);
      return { ruleCode: existing.ruleCode, revision: version.revision };
    });

    await this.events.audit({
      action: 'STANDARD_RULE_DELETED',
      actorUserId: context.userId,
      targetType: 'StandardRule',
      targetId: ruleId,
      requestId: request.requestId,
      ipAddress: request.ipAddress,
      beforeState: { standardVersionId: versionId, ruleCode: result.ruleCode },
    });

    return { revision: result.revision };
  }

  /**
   * Reorder every rule in the draft.
   *
   * The complete set of ids is required. A partial reorder would leave the
   * unlisted rules holding stale positions that silently interleave with the
   * new ones — an ordering bug that would only surface in a printed report.
   *
   * The two-pass write (offset everything far out of the way, then set the
   * final values) exists because display order is not unique: writing the final
   * positions directly can transiently collide, and a future unique index would
   * turn that into a failure.
   */
  async reorder(
    context: TenantContext,
    standardId: string,
    versionId: string,
    expectedRevision: number,
    ruleIds: readonly string[],
    request: RequestContext,
  ): Promise<{ revision: number }> {
    const revision = await this.tenant.withTenant(scopeOf(context), async (tx) => {
      await lockDraft(tx, standardId, versionId, expectedRevision);

      const existing = await tx.standardRule.findMany({
        where: { standardVersionId: versionId },
        select: { id: true },
      });

      const existingIds = new Set(existing.map((row) => row.id));
      const requested = new Set(ruleIds);

      if (requested.size !== ruleIds.length) {
        throw new AppError(PalCertErrorCode.VALIDATION_FAILED, {
          message: 'ruleIds contains the same rule more than once.',
          details: { field: 'ruleIds' },
        });
      }
      if (
        requested.size !== existingIds.size ||
        [...requested].some((id) => !existingIds.has(id))
      ) {
        throw new AppError(PalCertErrorCode.VALIDATION_FAILED, {
          message:
            'ruleIds must list every rule in this version exactly once. Reload the rules and ' +
            'send the complete order.',
          details: { field: 'ruleIds', expectedCount: existingIds.size, received: ruleIds.length },
        });
      }

      const OFFSET = 1_000_000;
      for (const [index, id] of ruleIds.entries()) {
        await tx.standardRule.update({ where: { id }, data: { displayOrder: OFFSET + index } });
      }
      for (const [index, id] of ruleIds.entries()) {
        await tx.standardRule.update({ where: { id }, data: { displayOrder: index } });
      }

      const version = await this.bumpRevision(tx, versionId);
      return version.revision;
    });

    await this.events.audit({
      action: 'STANDARD_RULES_REORDERED',
      actorUserId: context.userId,
      targetType: 'StandardVersion',
      targetId: versionId,
      requestId: request.requestId,
      ipAddress: request.ipAddress,
      afterState: { standardId, ruleCount: ruleIds.length },
    });

    return { revision };
  }

  /**
   * Bump the parent version's revision.
   *
   * Called by every rule mutation: the version is the aggregate root, so two
   * authors editing different rules of the same draft are in conflict, and the
   * revision has to reflect that.
   */
  private async bumpRevision(tx: TenantClient, versionId: string): Promise<{ revision: number }> {
    return bumpVersionRevision(tx, versionId);
  }
}

/**
 * Write one validated rule, inside the caller's transaction.
 *
 * Exported so Phase 9 can accept a rule proposal through *this* path rather
 * than a parallel one of its own. An accepted proposal becomes an ordinary
 * draft rule — same columns, same validation, same revision bump — and there is
 * deliberately no second insert site an "AI rule" could take instead (§123).
 */
export async function insertRule(
  tx: TenantClient,
  params: {
    organizationId: string;
    versionId: string;
    definition: RuleDefinition;
    ruleSchemaVersion: number;
  },
): Promise<StandardRuleRow> {
  const definition = params.definition;
  return (await tx.standardRule.create({
    data: {
      organizationId: params.organizationId,
      standardVersionId: params.versionId,
      ruleCode: definition.ruleCode,
      category: definition.category,
      evaluationMode: definition.evaluationMode,
      scope: definition.scope as object,
      operator: definition.operator,
      expectedValue: definition.expected as object,
      unit: definition.unit,
      tolerance: definition.tolerance,
      severity: definition.severity,
      blocking: definition.blocking,
      autofix: definition.autofix,
      origin: definition.origin,
      originReference: definition.originReference,
      titleEn: definition.titleEn,
      titleAr: definition.titleAr,
      descriptionEn: definition.descriptionEn,
      descriptionAr: definition.descriptionAr,
      guidanceEn: definition.guidanceEn,
      guidanceAr: definition.guidanceAr,
      displayOrder: definition.displayOrder,
      ruleSchemaVersion: params.ruleSchemaVersion,
    },
  })) as StandardRuleRow;
}

/** The version is the aggregate root; its rules have no independent lifecycle. */
export async function bumpVersionRevision(
  tx: TenantClient,
  versionId: string,
): Promise<{ revision: number }> {
  return tx.standardVersion.update({
    where: { id: versionId },
    data: { revision: { increment: 1 } },
  });
}

function scopeOf(context: TenantContext): { organizationId: string; userId: string } {
  return { organizationId: context.organizationId, userId: context.userId };
}

/**
 * Validate a rule and turn any failure into one error carrying every issue.
 *
 * Returning all of them at once is what lets the builder mark each offending
 * field, instead of the author fixing one problem per round trip.
 */
function assertValidRule(input: RuleInput, schemaVersion: number): RuleDefinition {
  const result = validateRuleDefinition(input, { schemaVersion });
  if (!result.valid) {
    throw new AppError(PalCertErrorCode.RULE_SCHEMA_INVALID, {
      message: `This rule has ${result.issues.length} problem(s).`,
      details: { issues: result.issues },
    });
  }
  return input as RuleDefinition;
}

/** Drop keys the caller did not send, so a PATCH does not null out fields. */
function stripUndefined(input: RuleInput): RuleInput {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  ) as RuleInput;
}

async function assertVersionExists(
  tx: TenantClient,
  standardId: string,
  versionId: string,
): Promise<void> {
  const version = await tx.standardVersion.findFirst({ where: { id: versionId, standardId } });
  if (version === null) {
    throw new AppError(PalCertErrorCode.STANDARD_VERSION_NOT_FOUND, {
      message: 'That standard version does not exist.',
    });
  }
}

function ruleNotFound(): AppError {
  return new AppError(PalCertErrorCode.RULE_NOT_FOUND, { message: 'That rule does not exist.' });
}

function parseCursor(cursor: string | undefined): { sortValue: string; id: string } | null {
  if (cursor === undefined) return null;
  const decoded = decodeCursor(cursor);
  if (decoded === null || !/^\d+$/.test(decoded.sortValue)) {
    throw new AppError(PalCertErrorCode.VALIDATION_FAILED, {
      message: 'That page cursor is not one this API issued.',
      details: { field: 'cursor' },
    });
  }
  return decoded;
}

/**
 * Backstop for a rule-code collision that slips past the pre-check.
 *
 * By model, not constraint name: `meta.target` is null under the
 * least-privileged role. `standard_rules` has exactly one unique constraint,
 * `(standard_version_id, rule_code)`.
 */
function rethrowRuleCodeConflict(error: unknown): never {
  const code = (error as { code?: string }).code;
  const model = (error as { meta?: { modelName?: string } }).meta?.modelName;

  if (code === 'P2002' && model === 'StandardRule') throw ruleCodeTaken();
  throw error as Error;
}

function ruleCodeTaken(): AppError {
  return new AppError(PalCertErrorCode.RULE_CODE_TAKEN, {
    message: 'Another rule in this version already uses that code.',
  });
}

/** Is this rule code already used within the version? */
async function ruleCodeIsTaken(
  tx: TenantClient,
  versionId: string,
  ruleCode: string,
  excludingId: string | null,
): Promise<boolean> {
  const existing = await tx.standardRule.findFirst({
    where: {
      standardVersionId: versionId,
      ruleCode,
      ...(excludingId === null ? {} : { NOT: { id: excludingId } }),
    },
    select: { id: true },
  });
  return existing !== null;
}
