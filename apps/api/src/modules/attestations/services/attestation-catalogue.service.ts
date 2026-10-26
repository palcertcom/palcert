import { Injectable } from '@nestjs/common';
import {
  AppError,
  PalCertErrorCode,
  money,
  type AttestationArtifactFormat,
  type AttestationCatalogueOrganizationView,
  type AttestationMetadataField,
  type AttestationTypePublicView,
} from '@palcert/contracts';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service';
import type { TenantClient } from '../../../infrastructure/tenant/tenant-prisma.service';

interface CatalogueTypeRow {
  id: string;
  organization_id: string;
  organization_name: string;
  name_en: string;
  name_ar: string;
  description_en: string | null;
  description_ar: string | null;
  instructions_en: string | null;
  instructions_ar: string | null;
  fee_minor: bigint;
  currency: string;
  default_validity_days: number | null;
  allow_no_expiry: boolean;
  reviewer_may_override_validity: boolean;
  required_fields: string[];
  allowed_formats: string[];
  max_file_bytes: number;
  reminder_days: number[];
}

/** What a user acting on their own request may know about a type. */
export interface TypeOffer {
  readonly id: string;
  readonly organizationId: string;
  readonly organizationName: string;
  readonly organizationEligible: boolean;
  readonly enabled: boolean;
  readonly nameEn: string;
  readonly nameAr: string;
  readonly feeMinor: bigint;
  readonly currency: string;
  readonly defaultValidityDays: number | null;
  readonly allowNoExpiry: boolean;
  readonly reviewerMayOverrideValidity: boolean;
  readonly requiredFields: readonly AttestationMetadataField[];
  readonly allowedFormats: readonly AttestationArtifactFormat[];
  readonly maxFileBytes: number;
  readonly reminderDays: readonly number[];
}

/**
 * Which institutions attest, and what they offer.
 *
 * A user never reads `attestation_types` directly — the table is the
 * institution's. These go through narrow SECURITY DEFINER functions that
 * return enabled types of active, PalCert-verified organizations and nothing
 * else: no creator, no history, no commission.
 */
@Injectable()
export class AttestationCatalogueService {
  constructor(private readonly prisma: PrismaService) {}

  async organizations(): Promise<AttestationCatalogueOrganizationView[]> {
    const rows = await this.prisma.$queryRaw<
      Array<{ organization_id: string; display_name: string; slug: string; type_count: bigint }>
    >`SELECT * FROM app_attestation_catalogue_organizations()`;
    return rows.map((row) => ({
      id: row.organization_id,
      displayName: row.display_name,
      slug: row.slug,
      verified: true,
      typeCount: Number(row.type_count),
    }));
  }

  async types(organizationId: string): Promise<AttestationTypePublicView[]> {
    const rows = await this.prisma.$queryRaw<CatalogueTypeRow[]>`
      SELECT * FROM app_attestation_catalogue_types(${organizationId}::uuid)`;
    return rows.map((row) => ({
      id: row.id,
      organizationId: row.organization_id,
      nameEn: row.name_en,
      nameAr: row.name_ar,
      descriptionEn: row.description_en,
      descriptionAr: row.description_ar,
      instructionsEn: row.instructions_en,
      instructionsAr: row.instructions_ar,
      fee: money(row.currency, row.fee_minor),
      defaultValidityDays: row.default_validity_days,
      requiredFields: row.required_fields as AttestationMetadataField[],
      allowedFormats: row.allowed_formats as AttestationArtifactFormat[],
      maxFileBytes: row.max_file_bytes,
    }));
  }

  /**
   * One type, read inside the caller's own transaction.
   *
   * Refuses an unknown type with the same not-found whatever the reason, so a
   * user cannot probe for another institution's disabled types.
   */
  async offer(tx: TenantClient, typeId: string): Promise<TypeOffer> {
    const rows = await tx.$queryRaw<
      Array<
        Omit<
          CatalogueTypeRow,
          'description_en' | 'description_ar' | 'instructions_en' | 'instructions_ar'
        > & {
          organization_eligible: boolean;
          enabled: boolean;
        }
      >
    >`SELECT * FROM app_attestation_type_offer(${typeId}::uuid)`;
    const row = rows[0];
    if (row === undefined) {
      throw new AppError(PalCertErrorCode.ATTESTATION_TYPE_NOT_FOUND, {
        message: 'No such attestation type.',
      });
    }
    return {
      id: row.id,
      organizationId: row.organization_id,
      organizationName: row.organization_name,
      organizationEligible: row.organization_eligible,
      enabled: row.enabled,
      nameEn: row.name_en,
      nameAr: row.name_ar,
      feeMinor: row.fee_minor,
      currency: row.currency,
      defaultValidityDays: row.default_validity_days,
      allowNoExpiry: row.allow_no_expiry,
      reviewerMayOverrideValidity: row.reviewer_may_override_validity,
      requiredFields: row.required_fields as AttestationMetadataField[],
      allowedFormats: row.allowed_formats as AttestationArtifactFormat[],
      maxFileBytes: row.max_file_bytes,
      reminderDays: row.reminder_days,
    };
  }

  /** The offer, or a precise refusal when a new request may not be made against it. */
  assertOpen(offer: TypeOffer): void {
    if (!offer.organizationEligible) {
      throw new AppError(PalCertErrorCode.ATTESTATION_ORGANIZATION_UNAVAILABLE, {
        message: 'This institution is not currently accepting attestation requests.',
      });
    }
    if (!offer.enabled) {
      throw new AppError(PalCertErrorCode.ATTESTATION_TYPE_DISABLED, {
        message: 'The institution is not accepting requests of this type right now.',
      });
    }
  }
}
