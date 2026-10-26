import { Injectable } from '@nestjs/common';
import {
  AppError,
  PalCertErrorCode,
  Permission,
  PortablePackageErrorCode,
  RULE_SCHEMA_VERSION,
  STANDARD_CANONICALIZATION_VERSION,
  StandardImportMode,
  StandardVersionStatus,
  VERSION_LABEL_MAX_LENGTH,
  buildPortableStandardPackage,
  isValidStandardCode,
  portableStandardFileName,
  readPortableStandardPackage,
  serializePortableStandardPackage,
  type DocumentSystemCategory,
  type PortablePackageError,
  type PortableStandardRule,
  type StandardImportPreviewView,
  type StandardImportProvenanceView,
  type StandardImportResultView,
  type StandardImportTargetView,
  type StandardImportWarningView,
} from '@palcert/contracts';
import type { StandardVersionImport } from '@palcert/database';
import {
  TenantPrismaService,
  type TenantClient,
} from '../../../infrastructure/tenant/tenant-prisma.service';
import { ClockPort } from '../../auth/ports/clock.port';
import { SecurityEventService } from '../../auth/services/security-event.service';
import type { TenantContext } from '../../organizations/tenant-context';
import { toRuleDefinition, type StandardRuleRow } from './rule-mapping';
import type { RequestContext } from './standard-version.service';
import { assertPlainText } from './text-safety';

export interface StandardImportInput {
  readonly package: string;
  readonly packageHash: string;
  readonly mode: StandardImportMode;
  readonly standardId?: string | undefined;
  readonly code?: string | undefined;
  readonly nameEn?: string | undefined;
  readonly nameAr?: string | undefined;
  readonly documentTypeId?: string | undefined;
  readonly versionLabel: string;
  readonly acknowledgeDuplicate?: boolean | undefined;
}

/**
 * Portable standard packages: export, preview, import.
 *
 * Everything here is deterministic and local. Nothing reaches an AI provider,
 * the document engine or object storage: a package is read, checked and turned
 * into ordinary rows, or refused.
 *
 * The three operations mirror the lifecycle rather than bypassing it:
 *
 *  - **export** reads one version, of any status, and writes a package with no
 *    identifier in it;
 *  - **preview** reads a package and the organization's own standards and
 *    changes nothing — the same answer however often it is asked;
 *  - **import** re-reads the same package (the hash the caller previewed is
 *    required, so the browser cannot substitute other content), and in one
 *    transaction creates the standard if asked, one DRAFT version, its rules,
 *    the provenance record and the audit event. It never publishes.
 */
@Injectable()
export class StandardTransferService {
  constructor(
    private readonly tenant: TenantPrismaService,
    private readonly events: SecurityEventService,
    private readonly clock: ClockPort,
  ) {}

  // -------------------------------------------------------------------------
  // Export
  // -------------------------------------------------------------------------

  async export(
    context: TenantContext,
    standardId: string,
    versionId: string,
    request: RequestContext,
  ): Promise<{ fileName: string; body: string; packageHash: string; ruleCount: number }> {
    const loaded = await this.tenant.withTenant(scopeOf(context), async (tx) => {
      const version = await tx.standardVersion.findFirst({
        where: { id: versionId, standardId },
        include: {
          standard: { include: { documentType: { select: { name: true, systemCategory: true } } } },
          rules: { orderBy: [{ displayOrder: 'asc' }, { ruleCode: 'asc' }] },
        },
      });
      if (version === null) {
        throw new AppError(PalCertErrorCode.STANDARD_VERSION_NOT_FOUND, {
          message: 'That standard version does not exist.',
        });
      }
      const organization = await tx.organization.findUniqueOrThrow({
        where: { id: context.organizationId },
        select: { displayName: true },
      });
      return { version, organization };
    });

    const { version, organization } = loaded;
    if (version.rules.length === 0) {
      throw new AppError(PalCertErrorCode.STANDARD_VERSION_EMPTY, {
        message: 'This version has no rules, so there is nothing to export.',
      });
    }

    const standard = version.standard;
    const pkg = buildPortableStandardPackage(
      {
        source: {
          organizationName: organization.displayName,
          standardCode: standard.code,
          standardNameEn: standard.nameEn,
          standardNameAr: standard.nameAr,
          versionLabel: version.versionLabel,
          versionStatus: version.status as StandardVersionStatus,
        },
        schema: {
          ruleSchemaVersion: version.ruleSchemaVersion,
          canonicalizationVersion: STANDARD_CANONICALIZATION_VERSION,
        },
        standard: {
          code: standard.code,
          nameEn: standard.nameEn,
          nameAr: standard.nameAr,
          descriptionEn: standard.descriptionEn,
          descriptionAr: standard.descriptionAr,
        },
        documentType: {
          systemCategory: standard.documentType.systemCategory as DocumentSystemCategory,
          name: standard.documentType.name,
        },
        version: {
          versionLabel: version.versionLabel,
          effectiveFrom: version.effectiveFrom?.toISOString() ?? null,
          effectiveUntil: version.effectiveUntil?.toISOString() ?? null,
        },
        rules: (version.rules as StandardRuleRow[]).map(toRuleDefinition),
      },
      this.clock.now(),
    );

    await this.events.audit({
      action: 'STANDARD_EXPORTED',
      actorUserId: context.userId,
      targetType: 'StandardVersion',
      targetId: versionId,
      requestId: request.requestId,
      ipAddress: request.ipAddress,
      afterState: {
        standardId,
        versionLabel: version.versionLabel,
        versionStatus: version.status,
        ruleCount: version.rules.length,
        formatVersion: pkg.formatVersion,
        packageSha256: pkg.contentHash,
      },
    });

    return {
      fileName: portableStandardFileName(standard.code, version.versionLabel),
      body: serializePortableStandardPackage(pkg),
      packageHash: pkg.contentHash,
      ruleCount: pkg.rules.length,
    };
  }

  // -------------------------------------------------------------------------
  // Preview
  // -------------------------------------------------------------------------

  /** Read-only: every query here is a SELECT, and nothing is audited. */
  async preview(context: TenantContext, raw: string): Promise<StandardImportPreviewView> {
    const read = readOrRefuse(raw);
    const pkg = read.package;
    const category = pkg.documentType.systemCategory;

    const tenantState = await this.tenant.withTenant(scopeOf(context), async (tx) => {
      const [standards, documentTypes, previous] = await Promise.all([
        tx.standard.findMany({
          orderBy: [{ code: 'asc' }],
          include: {
            documentType: { select: { systemCategory: true } },
            versions: { select: { versionLabel: true, status: true } },
          },
        }),
        tx.documentType.findMany({
          where: { status: 'ACTIVE' },
          orderBy: [{ name: 'asc' }],
          select: { id: true, name: true, systemCategory: true },
        }),
        tx.standardVersionImport.findMany({
          where: { packageHash: read.packageHash },
          orderBy: { importedAt: 'desc' },
          include: {
            standard: { select: { code: true } },
            version: { select: { versionLabel: true } },
          },
        }),
      ]);
      return { standards, documentTypes, previous };
    });

    const targets: StandardImportTargetView[] = tenantState.standards.map((standard) => ({
      id: standard.id,
      code: standard.code,
      nameEn: standard.nameEn,
      nameAr: standard.nameAr,
      documentTypeCategory: standard.documentType.systemCategory as DocumentSystemCategory,
      status: standard.status,
      compatible: standard.status === 'ACTIVE' && standard.documentType.systemCategory === category,
      versionLabels: standard.versions.map((version) => version.versionLabel),
      draftCount: standard.versions.filter((version) => version.status === 'DRAFT').length,
    }));
    const withCode = targets.find((target) => target.code === pkg.standard.code) ?? null;

    const rules = read.rules.map((rule) => ({
      ...rule.display,
      index: rule.index,
      valid: rule.definition !== null,
      issues: rule.issues,
    }));
    const invalid = rules.filter((rule) => !rule.valid).length;

    const warnings: StandardImportWarningView[] = [];
    if (pkg.schema.ruleSchemaVersion < read.importRuleSchemaVersion) {
      warnings.push({
        code: 'RULE_SCHEMA_UPGRADED',
        message:
          `This standard was exported using Rule Schema v${pkg.schema.ruleSchemaVersion}. ` +
          `PalCert will import it using Rule Schema v${read.importRuleSchemaVersion}.`,
      });
    }
    if (pkg.source.versionStatus === 'DRAFT') {
      warnings.push({
        code: 'SOURCE_WAS_DRAFT',
        message:
          'This package was exported from a draft. The source organization had not published it.',
      });
    }
    if (read.signatureCount > 0) {
      warnings.push({
        code: 'SIGNATURES_NOT_VERIFIED',
        message:
          `The file carries ${read.signatureCount} signature(s). This version of PalCert does ` +
          'not verify signatures; only the integrity hash was checked.',
      });
    }
    const latest = tenantState.previous[0];
    if (latest !== undefined) {
      warnings.push({
        code: 'ALREADY_IMPORTED',
        message: `This package was already imported on ${latest.importedAt.toISOString()}.`,
      });
    }
    if (withCode !== null) {
      warnings.push({
        code: 'CODE_TAKEN',
        message: `Your organization already has a standard with the code ${withCode.code}.`,
      });
    }
    if (!tenantState.documentTypes.some((type) => type.systemCategory === category)) {
      warnings.push({
        code: 'NO_MATCHING_DOCUMENT_TYPE',
        message: `Your organization has no active document type in the ${category} category.`,
      });
    }

    return {
      packageHash: read.packageHash,
      formatVersion: pkg.formatVersion,
      exportedAt: pkg.exportedAt,
      integrity: 'VERIFIED',
      signatureCount: read.signatureCount,
      source: pkg.source,
      standard: pkg.standard,
      documentType: pkg.documentType,
      version: pkg.version,
      schema: {
        sourceRuleSchemaVersion: pkg.schema.ruleSchemaVersion,
        importRuleSchemaVersion: read.importRuleSchemaVersion,
        upgraded: pkg.schema.ruleSchemaVersion < read.importRuleSchemaVersion,
        canonicalizationVersion: pkg.schema.canonicalizationVersion,
      },
      ruleCount: rules.length,
      validRuleCount: rules.length - invalid,
      invalidRuleCount: invalid,
      rules,
      destination: {
        existingStandardWithCode: withCode,
        documentTypes: tenantState.documentTypes.map((type) => ({
          id: type.id,
          name: type.name,
          systemCategory: type.systemCategory as DocumentSystemCategory,
          matchesCategory: type.systemCategory === category,
        })),
        standards: targets,
      },
      previousImports: tenantState.previous.map((entry) => ({
        importedAt: entry.importedAt.toISOString(),
        standardId: entry.standardId,
        standardCode: entry.standard.code,
        versionId: entry.standardVersionId,
        versionLabel: entry.version.versionLabel,
      })),
      warnings,
      canImport: invalid === 0,
    };
  }

  // -------------------------------------------------------------------------
  // Import
  // -------------------------------------------------------------------------

  async import(
    context: TenantContext,
    input: StandardImportInput,
    request: RequestContext,
  ): Promise<StandardImportResultView> {
    const read = readOrRefuse(input.package);
    if (read.packageHash !== input.packageHash) {
      throw new AppError(PalCertErrorCode.STANDARD_IMPORT_PACKAGE_CHANGED, {
        message: 'This is not the package that was previewed. Preview it again before importing.',
      });
    }
    const invalid = read.rules.filter((rule) => rule.definition === null);
    if (invalid.length > 0) {
      throw new AppError(PalCertErrorCode.STANDARD_IMPORT_RULES_INVALID, {
        message:
          `${invalid.length} rule(s) in this package need attention. Nothing was imported; ` +
          'correct the package at its source and try again.',
        details: {
          invalidRuleCount: invalid.length,
          rules: invalid.slice(0, 50).map((rule) => ({
            index: rule.index,
            ruleCode: rule.display.ruleCode,
            issues: rule.issues,
          })),
        },
      });
    }
    const pkg = read.package;
    const definitions = read.rules.map((rule) => rule.definition!) as PortableStandardRule[];

    const creating = input.mode === StandardImportMode.NEW_STANDARD;
    if (creating && !context.permissions.has(Permission.STANDARD_CREATE)) {
      throw new AppError(PalCertErrorCode.PERMISSION_DENIED, {
        message: 'Importing as a new standard requires permission to create standards.',
      });
    }

    const versionLabel = input.versionLabel.trim();
    if (versionLabel === '' || versionLabel.length > VERSION_LABEL_MAX_LENGTH) {
      throw validation(
        'versionLabel',
        `The version label must be 1 to ${VERSION_LABEL_MAX_LENGTH} characters.`,
      );
    }
    assertPlainText('versionLabel', versionLabel);

    const code = (input.code ?? pkg.standard.code).trim().toUpperCase();
    const nameEn = (input.nameEn ?? pkg.standard.nameEn).trim();
    const nameAr = (input.nameAr ?? pkg.standard.nameAr).trim();
    if (creating) {
      if (!isValidStandardCode(code)) {
        throw validation('code', 'That is not a valid standard code, e.g. IUG.THESIS.FORMAT.');
      }
      for (const [field, value] of [
        ['nameEn', nameEn],
        ['nameAr', nameAr],
      ] as const) {
        if (value === '' || value.length > 200) {
          throw validation(field, `${field} must be 1 to 200 characters.`);
        }
        assertPlainText(field, value);
      }
      if (input.documentTypeId === undefined) {
        throw validation('documentTypeId', 'Choose the document type the new standard is for.');
      }
    } else if (input.standardId === undefined) {
      throw validation('standardId', 'Choose the standard to add the imported draft to.');
    }

    const now = this.clock.now();
    const result = await this.tenant
      .withTenant(scopeOf(context), async (tx) => {
        const previous = await tx.standardVersionImport.findFirst({
          where: { packageHash: read.packageHash },
          orderBy: { importedAt: 'desc' },
          select: { importedAt: true },
        });
        if (previous !== null && input.acknowledgeDuplicate !== true) {
          throw new AppError(PalCertErrorCode.STANDARD_IMPORT_DUPLICATE, {
            message: `This package was already imported on ${previous.importedAt.toISOString()}.`,
            details: { previousImportedAt: previous.importedAt.toISOString() },
          });
        }

        const standard = creating
          ? await createStandard(tx, context, {
              documentTypeId: input.documentTypeId!,
              code,
              nameEn,
              nameAr,
              descriptionEn: pkg.standard.descriptionEn,
              descriptionAr: pkg.standard.descriptionAr,
              category: pkg.documentType.systemCategory,
            })
          : await existingStandard(tx, input.standardId!, pkg.documentType.systemCategory);

        const labelTaken = await tx.standardVersion.findFirst({
          where: { standardId: standard.id, versionLabel },
          select: { id: true },
        });
        if (labelTaken !== null) {
          throw new AppError(PalCertErrorCode.STANDARD_VERSION_LABEL_TAKEN, {
            message: `This standard already has a version labelled ${versionLabel}. Choose another label.`,
          });
        }

        const version = await tx.standardVersion.create({
          data: {
            organizationId: context.organizationId,
            standardId: standard.id,
            versionLabel,
            status: StandardVersionStatus.DRAFT,
            effectiveFrom:
              pkg.version.effectiveFrom === null ? null : new Date(pkg.version.effectiveFrom),
            effectiveUntil:
              pkg.version.effectiveUntil === null ? null : new Date(pkg.version.effectiveUntil),
            ruleSchemaVersion: RULE_SCHEMA_VERSION,
            createdByUserId: context.userId,
          },
        });

        await tx.standardRule.createMany({
          data: definitions.map((rule) => ({
            organizationId: context.organizationId,
            standardVersionId: version.id,
            ruleCode: rule.ruleCode,
            category: rule.category,
            evaluationMode: rule.evaluationMode,
            scope: rule.scope as object,
            operator: rule.operator,
            expectedValue: rule.expected as object,
            unit: rule.unit,
            tolerance: rule.tolerance,
            severity: rule.severity,
            blocking: rule.blocking,
            autofix: rule.autofix,
            // The rule says what it said. Whose policy it becomes is decided by
            // publishing, and the import record says where it came from.
            origin: rule.origin,
            originReference: rule.originReference,
            titleEn: rule.titleEn,
            titleAr: rule.titleAr,
            descriptionEn: rule.descriptionEn,
            descriptionAr: rule.descriptionAr,
            guidanceEn: rule.guidanceEn,
            guidanceAr: rule.guidanceAr,
            displayOrder: rule.displayOrder,
            ruleSchemaVersion: RULE_SCHEMA_VERSION,
          })),
        });

        const record = await tx.standardVersionImport.create({
          data: {
            organizationId: context.organizationId,
            standardId: standard.id,
            standardVersionId: version.id,
            importedByUserId: context.userId,
            importedAt: now,
            packageHash: read.packageHash,
            formatVersion: pkg.formatVersion,
            sourceOrganizationName: pkg.source.organizationName,
            sourceStandardCode: pkg.source.standardCode,
            sourceStandardNameEn: pkg.source.standardNameEn,
            sourceStandardNameAr: pkg.source.standardNameAr,
            sourceVersionLabel: pkg.source.versionLabel,
            sourceVersionStatus: pkg.source.versionStatus,
            sourceRuleSchemaVersion: pkg.schema.ruleSchemaVersion,
            importRuleSchemaVersion: RULE_SCHEMA_VERSION,
            ruleCount: definitions.length,
            createdStandard: creating,
          },
        });

        await this.events.auditWithin(tx, {
          action: 'STANDARD_IMPORTED',
          actorUserId: context.userId,
          targetType: 'StandardVersion',
          targetId: version.id,
          requestId: request.requestId,
          ipAddress: request.ipAddress,
          afterState: {
            standardId: standard.id,
            standardCode: standard.code,
            versionLabel,
            status: StandardVersionStatus.DRAFT,
            createdStandard: creating,
            ruleCount: definitions.length,
            formatVersion: pkg.formatVersion,
            packageSha256: read.packageHash,
            sourceOrganizationName: pkg.source.organizationName,
            sourceStandardCode: pkg.source.standardCode,
            sourceVersionLabel: pkg.source.versionLabel,
            sourceVersionStatus: pkg.source.versionStatus,
            duplicateAcknowledged: previous !== null,
          },
        });

        return { standard, version, record };
      })
      .catch(rethrowImportConflict);

    return {
      standardId: result.standard.id,
      versionId: result.version.id,
      versionLabel: result.version.versionLabel,
      createdStandard: creating,
      ruleCount: definitions.length,
      provenance: toProvenanceView(result.record),
    };
  }
}

// ---------------------------------------------------------------------------

function scopeOf(context: TenantContext): { organizationId: string; userId: string } {
  return { organizationId: context.organizationId, userId: context.userId };
}

function validation(field: string, message: string): AppError {
  return new AppError(PalCertErrorCode.VALIDATION_FAILED, { message, details: { field } });
}

/** Read a package or refuse it with the error a person can act on. */
function readOrRefuse(raw: string) {
  const read = readPortableStandardPackage(raw);
  if (!read.ok) throw refusal(read.error);
  return read;
}

function refusal(error: PortablePackageError): AppError {
  const details = { reason: error.code, path: error.path };
  switch (error.code) {
    case PortablePackageErrorCode.INTEGRITY_FAILED:
      return new AppError(PalCertErrorCode.STANDARD_IMPORT_INTEGRITY_FAILED, {
        message: error.message,
        details,
      });
    case PortablePackageErrorCode.TOO_LARGE:
      return new AppError(PalCertErrorCode.STANDARD_IMPORT_PACKAGE_TOO_LARGE, {
        message: error.message,
        details,
      });
    case PortablePackageErrorCode.UNSUPPORTED_FORMAT_VERSION:
    case PortablePackageErrorCode.UNSUPPORTED_RULE_SCHEMA:
    case PortablePackageErrorCode.UNSUPPORTED_CANONICALIZATION:
      return new AppError(PalCertErrorCode.STANDARD_IMPORT_UNSUPPORTED, {
        message: error.message,
        details,
      });
    default:
      return new AppError(PalCertErrorCode.STANDARD_IMPORT_PACKAGE_INVALID, {
        message: error.message,
        details,
      });
  }
}

async function createStandard(
  tx: TenantClient,
  context: TenantContext,
  params: {
    documentTypeId: string;
    code: string;
    nameEn: string;
    nameAr: string;
    descriptionEn: string | null;
    descriptionAr: string | null;
    category: DocumentSystemCategory;
  },
): Promise<{ id: string; code: string }> {
  const documentType = await tx.documentType.findUnique({ where: { id: params.documentTypeId } });
  if (documentType === null) {
    throw new AppError(PalCertErrorCode.DOCUMENT_TYPE_NOT_FOUND, {
      message: 'That document type does not exist.',
    });
  }
  if (documentType.status === 'ARCHIVED') {
    throw new AppError(PalCertErrorCode.DOCUMENT_TYPE_ARCHIVED, {
      message: 'That document type is archived and cannot take new standards.',
    });
  }
  if (documentType.systemCategory !== params.category) {
    throw new AppError(PalCertErrorCode.STANDARD_IMPORT_INCOMPATIBLE, {
      message: `The package is for the ${params.category} category; choose a document type in that category.`,
    });
  }
  const taken = await tx.standard.findFirst({ where: { code: params.code }, select: { id: true } });
  if (taken !== null) {
    throw new AppError(PalCertErrorCode.STANDARD_CODE_TAKEN, {
      message: `Your organization already has a standard with the code ${params.code}.`,
      details: { existingStandardId: taken.id },
    });
  }
  return tx.standard.create({
    data: {
      organizationId: context.organizationId,
      documentTypeId: params.documentTypeId,
      code: params.code,
      nameEn: params.nameEn,
      nameAr: params.nameAr,
      descriptionEn: params.descriptionEn,
      descriptionAr: params.descriptionAr,
      createdByUserId: context.userId,
    },
    select: { id: true, code: true },
  });
}

async function existingStandard(
  tx: TenantClient,
  standardId: string,
  category: DocumentSystemCategory,
): Promise<{ id: string; code: string }> {
  const standard = await tx.standard.findUnique({
    where: { id: standardId },
    include: { documentType: { select: { systemCategory: true } } },
  });
  if (standard === null) {
    throw new AppError(PalCertErrorCode.STANDARD_NOT_FOUND, {
      message: 'That standard does not exist.',
    });
  }
  if (standard.status === 'ARCHIVED') {
    throw new AppError(PalCertErrorCode.STANDARD_ARCHIVED, {
      message: 'That standard is archived. Restore it before importing a version into it.',
    });
  }
  if (standard.documentType.systemCategory !== category) {
    throw new AppError(PalCertErrorCode.STANDARD_IMPORT_INCOMPATIBLE, {
      message:
        `${standard.code} is for ${standard.documentType.systemCategory} documents and the ` +
        `package is for ${category}. Import it as a new standard instead.`,
    });
  }
  return { id: standard.id, code: standard.code };
}

/**
 * A code or label taken between the pre-check and the insert. Under the
 * least-privileged role `meta.target` is null, so the model name decides.
 */
function rethrowImportConflict(error: unknown): never {
  const code = (error as { code?: string }).code;
  const model = (error as { meta?: { modelName?: string } }).meta?.modelName;
  if (code === 'P2002' && model === 'Standard') {
    throw new AppError(PalCertErrorCode.STANDARD_CODE_TAKEN, {
      message: 'Your organization already has a standard with that code.',
    });
  }
  if (code === 'P2002' && model === 'StandardVersion') {
    throw new AppError(PalCertErrorCode.STANDARD_VERSION_LABEL_TAKEN, {
      message: 'This standard already has a version with that label.',
    });
  }
  throw error as Error;
}

export function toProvenanceView(record: StandardVersionImport): StandardImportProvenanceView {
  return {
    importId: record.id,
    importedAt: record.importedAt.toISOString(),
    importedByUserId: record.importedByUserId,
    packageHash: record.packageHash,
    formatVersion: record.formatVersion,
    sourceOrganizationName: record.sourceOrganizationName,
    sourceStandardCode: record.sourceStandardCode,
    sourceStandardNameEn: record.sourceStandardNameEn,
    sourceStandardNameAr: record.sourceStandardNameAr,
    sourceVersionLabel: record.sourceVersionLabel,
    sourceVersionStatus: record.sourceVersionStatus as StandardVersionStatus,
    sourceRuleSchemaVersion: record.sourceRuleSchemaVersion,
    importRuleSchemaVersion: record.importRuleSchemaVersion,
    ruleCount: record.ruleCount,
    createdStandard: record.createdStandard,
  };
}
