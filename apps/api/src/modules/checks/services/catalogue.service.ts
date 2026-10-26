import { Injectable } from '@nestjs/common';
import {
  AppError,
  PalCertErrorCode,
  type CatalogueStandardView,
  type ReportOrganization,
  type ReportStandard,
} from '@palcert/contracts';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';

/**
 * The public checkable-standard catalogue (§16–§22).
 *
 * A student is not a member of the university whose standard they want to
 * check against, so the Phase 2 tenant policies correctly hide it. Loosening
 * those policies to make a catalogue work would trade a real guarantee for a
 * convenience; instead every query here goes through a narrow SECURITY
 * DEFINER function that returns catalogue fields and nothing else.
 *
 * The functions are the authorization boundary, not this class: eligibility
 * (organization active and verified, document type active, standard active and
 * PUBLIC_CHECKABLE, a published version) lives in their WHERE clauses so
 * listing and check creation can never disagree about what is checkable.
 */
@Injectable()
export class CatalogueService {
  constructor(private readonly prisma: PrismaService) {}

  async organizations(): Promise<
    Array<{
      id: string;
      displayName: string;
      slug: string;
      verificationStatus: 'VERIFIED';
      standardCount: number;
    }>
  > {
    const rows = await this.prisma.$queryRaw<
      Array<{
        organization_id: string;
        display_name: string;
        slug: string;
        verification_status: string;
        standard_count: bigint;
      }>
    >`SELECT * FROM app_catalogue_organizations()`;

    return rows.map((row) => ({
      id: row.organization_id,
      displayName: row.display_name,
      slug: row.slug,
      verificationStatus: 'VERIFIED' as const,
      standardCount: Number(row.standard_count),
    }));
  }

  async documentTypes(organizationId: string): Promise<
    Array<{
      id: string;
      organizationId: string;
      name: string;
      nameAr: string | null;
      systemCategory: string;
      standardCount: number;
    }>
  > {
    const rows = await this.prisma.$queryRaw<
      Array<{
        document_type_id: string;
        organization_id: string;
        name: string;
        name_ar: string | null;
        system_category: string;
        standard_count: bigint;
      }>
    >`SELECT * FROM app_catalogue_document_types(${organizationId}::uuid)`;

    return rows.map((row) => ({
      id: row.document_type_id,
      organizationId: row.organization_id,
      name: row.name,
      nameAr: row.name_ar,
      systemCategory: row.system_category,
      standardCount: Number(row.standard_count),
    }));
  }

  async standards(documentTypeId: string): Promise<CatalogueStandardView[]> {
    const rows = await this.prisma.$queryRaw<
      Array<{
        standard_id: string;
        organization_id: string;
        organization_name: string;
        document_type_id: string;
        document_type_name: string;
        code: string;
        name_en: string;
        name_ar: string;
        description_en: string | null;
        description_ar: string | null;
        standard_version_id: string;
        version_label: string;
        rule_count: number | null;
        effective_from: Date | null;
      }>
    >`SELECT * FROM app_catalogue_standards(${documentTypeId}::uuid)`;

    return rows.map((row) => ({
      id: row.standard_id,
      organizationId: row.organization_id,
      organizationName: row.organization_name,
      documentTypeId: row.document_type_id,
      documentTypeName: row.document_type_name,
      code: row.code,
      nameEn: row.name_en,
      nameAr: row.name_ar,
      descriptionEn: row.description_en,
      descriptionAr: row.description_ar,
      standardVersionId: row.standard_version_id,
      versionLabel: row.version_label,
      ruleCount: row.rule_count ?? 0,
      effectiveFrom: row.effective_from?.toISOString() ?? null,
    }));
  }

  /**
   * One standard, if it is checkable *right now*.
   *
   * Used when a check is created, so creation is decided by exactly the rules
   * the catalogue listed by. A standard made private between listing and
   * creation simply returns nothing here, and the check is refused rather than
   * created against something whose eligibility was already revoked (§101).
   */
  async checkableStandard(standardId: string): Promise<CheckableStandard> {
    const rows = await this.prisma.$queryRaw<
      Array<{
        standard_id: string;
        organization_id: string;
        organization_name: string;
        organization_verification: string;
        document_type_id: string;
        document_type_name: string;
        code: string;
        name_en: string;
        name_ar: string;
        description_en: string | null;
        description_ar: string | null;
        standard_version_id: string;
        version_label: string;
        rule_count: number | null;
        content_hash: string | null;
        canonicalization_version: number | null;
        rule_schema_version: number;
        effective_from: Date | null;
      }>
    >`SELECT * FROM app_catalogue_standard(${standardId}::uuid)`;

    const row = rows[0];
    if (row === undefined) {
      // Deliberately the same answer for "no such standard" and "not available
      // to you": a probe must not be able to enumerate private standards.
      throw new AppError(PalCertErrorCode.CHECK_STANDARD_NOT_AVAILABLE, {
        message: 'No standard is available for checking under that identifier.',
      });
    }
    if (row.content_hash === null || row.canonicalization_version === null) {
      // A published version always has both; missing means the publish path
      // left something incomplete, which is ours to fix, not the user's.
      throw new AppError(PalCertErrorCode.CHECK_STANDARD_NOT_PUBLISHED, {
        message: 'That standard has no complete published version.',
        internalContext: { standardVersionId: row.standard_version_id },
      });
    }

    return {
      standardId: row.standard_id,
      organizationId: row.organization_id,
      organizationName: row.organization_name,
      organizationVerification: row.organization_verification,
      documentTypeId: row.document_type_id,
      documentTypeName: row.document_type_name,
      code: row.code,
      nameEn: row.name_en,
      nameAr: row.name_ar,
      standardVersionId: row.standard_version_id,
      versionLabel: row.version_label,
      ruleCount: row.rule_count ?? 0,
      contentHash: row.content_hash,
      canonicalizationVersion: row.canonicalization_version,
      ruleSchemaVersion: row.rule_schema_version,
    };
  }

  /**
   * The immutable published snapshot for a version a check already captured.
   *
   * Keyed on the version, not the standard: a check that captured a version
   * keeps evaluating against it even after the standard is made private or
   * archived (§24, §102).
   */
  async snapshotForVersion(standardVersionId: string): Promise<StandardSnapshot | null> {
    const rows = await this.prisma.$queryRaw<
      Array<{
        standard_version_id: string;
        canonical: unknown;
        content_hash: string;
        canonicalization_version: number;
        rule_schema_version: number;
        rule_count: number;
      }>
    >`SELECT * FROM app_check_standard_snapshot(${standardVersionId}::uuid)`;

    const row = rows[0];
    if (row === undefined) return null;
    return {
      standardVersionId: row.standard_version_id,
      canonical: row.canonical,
      contentHash: row.content_hash,
      canonicalizationVersion: row.canonicalization_version,
      ruleSchemaVersion: row.rule_schema_version,
      ruleCount: row.rule_count,
    };
  }

  /**
   * The identity a report records for a version the check already captured.
   *
   * Read through the same SECURITY DEFINER boundary as the catalogue, and
   * keyed on the version: a standard made private, or archived, after a check
   * completed must not erase the report that already cites it (§24, §46).
   */
  async reportStandard(
    standardVersionId: string,
  ): Promise<{ organization: ReportOrganization; standard: ReportStandard }> {
    const rows = await this.prisma.$queryRaw<
      Array<{
        organization_id: string;
        organization_name: string;
        organization_verification: string;
        document_type_id: string;
        document_type_name: string;
        standard_id: string;
        standard_code: string;
        standard_name_en: string;
        standard_name_ar: string;
        standard_version_id: string;
        version_label: string;
        content_hash: string;
        canonicalization_version: number;
        rule_schema_version: number;
      }>
    >`SELECT * FROM app_check_standard_identity(${standardVersionId}::uuid)`;

    const row = rows[0];
    if (row === undefined) {
      throw new AppError(PalCertErrorCode.STANDARD_SNAPSHOT_INTEGRITY_FAILED, {
        message: 'The standard version this check captured is no longer readable.',
        internalContext: { standardVersionId },
      });
    }

    return {
      organization: {
        organizationId: row.organization_id,
        displayName: row.organization_name,
        verificationStatus:
          row.organization_verification as ReportOrganization['verificationStatus'],
      },
      standard: {
        standardId: row.standard_id,
        standardVersionId: row.standard_version_id,
        code: row.standard_code,
        nameEn: row.standard_name_en,
        nameAr: row.standard_name_ar,
        versionLabel: row.version_label,
        contentHash: row.content_hash,
        canonicalizationVersion: row.canonicalization_version,
        ruleSchemaVersion: row.rule_schema_version,
        documentTypeId: row.document_type_id,
        documentTypeName: row.document_type_name,
      },
    };
  }
}

export interface CheckableStandard {
  readonly standardId: string;
  readonly organizationId: string;
  readonly organizationName: string;
  readonly organizationVerification: string;
  readonly documentTypeId: string;
  readonly documentTypeName: string;
  readonly code: string;
  readonly nameEn: string;
  readonly nameAr: string;
  readonly standardVersionId: string;
  readonly versionLabel: string;
  readonly ruleCount: number;
  readonly contentHash: string;
  readonly canonicalizationVersion: number;
  readonly ruleSchemaVersion: number;
}

export interface StandardSnapshot {
  readonly standardVersionId: string;
  readonly canonical: unknown;
  readonly contentHash: string;
  readonly canonicalizationVersion: number;
  readonly ruleSchemaVersion: number;
  readonly ruleCount: number;
}
