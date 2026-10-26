import { Injectable } from '@nestjs/common';
import {
  ABSOLUTE_ATTESTATION_MAX_FILE_BYTES,
  AppError,
  CONFIGURABLE_REQUIRED_FIELDS,
  DEFAULT_ATTESTATION_MAX_FILE_BYTES,
  DEFAULT_REMINDER_DAYS,
  MAX_ATTESTATION_VALIDITY_DAYS,
  PalCertErrorCode,
  Permission,
  isAttestationArtifactFormat,
  isKnownCurrency,
  isValidReminderSchedule,
  money,
  parseMinorUnits,
  type AttestationArtifactFormat,
  type AttestationMetadataField,
  type AttestationTypeView,
} from '@palcert/contracts';
import type { AttestationType } from '@palcert/database';
import { ApiConfigService } from '../../../config/api-config.service';
import { TenantPrismaService } from '../../../infrastructure/tenant/tenant-prisma.service';
import { ClockPort } from '../../auth/ports/clock.port';
import { SecurityEventService } from '../../auth/services/security-event.service';
import type { TenantContext } from '../../organizations/tenant-context';

export interface AttestationTypeInput {
  readonly nameEn?: string;
  readonly nameAr?: string;
  readonly descriptionEn?: string | null;
  readonly descriptionAr?: string | null;
  readonly instructionsEn?: string | null;
  readonly instructionsAr?: string | null;
  readonly enabled?: boolean;
  readonly currency?: string;
  readonly feeMinorUnits?: string;
  readonly defaultValidityDays?: number | null;
  readonly allowNoExpiry?: boolean;
  readonly reviewerMayOverrideValidity?: boolean;
  readonly requiredFields?: readonly string[];
  readonly allowedFormats?: readonly string[];
  readonly maxFileBytes?: number;
  readonly reminderDays?: readonly number[];
}

export function typeView(row: AttestationType): AttestationTypeView {
  return {
    id: row.id,
    organizationId: row.organizationId,
    nameEn: row.nameEn,
    nameAr: row.nameAr,
    descriptionEn: row.descriptionEn,
    descriptionAr: row.descriptionAr,
    instructionsEn: row.instructionsEn,
    instructionsAr: row.instructionsAr,
    fee: money(row.currency, row.feeMinor),
    defaultValidityDays: row.defaultValidityDays,
    requiredFields: row.requiredFields as AttestationMetadataField[],
    allowedFormats: row.allowedFormats as AttestationArtifactFormat[],
    maxFileBytes: row.maxFileBytes,
    enabled: row.enabled,
    allowNoExpiry: row.allowNoExpiry,
    reviewerMayOverrideValidity: row.reviewerMayOverrideValidity,
    reminderDays: row.reminderDays,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function invalid(message: string, details?: Record<string, unknown>): AppError {
  return new AppError(PalCertErrorCode.ATTESTATION_TYPE_INVALID, {
    message,
    ...(details === undefined ? {} : { details }),
  });
}

/**
 * An institution's attestation types (§5, §17).
 *
 * Nothing is global: each institution defines its own "Degree certificate"
 * with its own fee, currency, validity and instructions. Changing a fee here
 * reaches only requests submitted afterwards — every submitted request carries
 * the price it was submitted under, and the database refuses to rewrite it.
 */
@Injectable()
export class AttestationTypeService {
  constructor(
    private readonly tenant: TenantPrismaService,
    private readonly events: SecurityEventService,
    private readonly config: ApiConfigService,
    private readonly clock: ClockPort,
  ) {}

  async list(context: TenantContext): Promise<AttestationTypeView[]> {
    const rows = await this.tenant.withTenant(scopeOf(context), (tx) =>
      tx.attestationType.findMany({
        where: { organizationId: context.organizationId },
        orderBy: [{ nameEn: 'asc' }, { id: 'asc' }],
      }),
    );
    return rows.map(typeView);
  }

  async get(context: TenantContext, typeId: string): Promise<AttestationTypeView> {
    const row = await this.tenant.withTenant(scopeOf(context), (tx) =>
      tx.attestationType.findFirst({
        where: { id: typeId, organizationId: context.organizationId },
      }),
    );
    if (row === null) throw notFound();
    return typeView(row);
  }

  async create(context: TenantContext, input: AttestationTypeInput): Promise<AttestationTypeView> {
    const fee = input.feeMinorUnits === undefined ? 0n : this.fee(input.feeMinorUnits);
    if (fee !== 0n && !context.permissions.has(Permission.ATTESTATION_FEE_MANAGE)) {
      throw new AppError(PalCertErrorCode.PERMISSION_DENIED, {
        message: 'Setting a fee requires the attestation fee permission.',
      });
    }
    const currency = this.currency(input.currency ?? this.config.payments.defaultCurrency);
    const nameEn = requiredName(input.nameEn, 'nameEn');
    const nameAr = requiredName(input.nameAr, 'nameAr');
    const policy = this.policy({
      defaultValidityDays: input.defaultValidityDays ?? 365,
      allowNoExpiry: input.allowNoExpiry ?? false,
      reviewerMayOverrideValidity: input.reviewerMayOverrideValidity ?? true,
    });
    const now = this.clock.now();

    const row = await this.tenant.withTenant(scopeOf(context), async (tx) => {
      const created = await tx.attestationType.create({
        data: {
          organizationId: context.organizationId,
          nameEn,
          nameAr,
          descriptionEn: optionalText(input.descriptionEn),
          descriptionAr: optionalText(input.descriptionAr),
          instructionsEn: optionalText(input.instructionsEn),
          instructionsAr: optionalText(input.instructionsAr),
          enabled: input.enabled ?? true,
          feeMinor: fee,
          currency,
          ...policy,
          requiredFields: this.requiredFields(input.requiredFields ?? []),
          allowedFormats: this.formats(input.allowedFormats ?? ['PDF', 'PNG', 'JPEG', 'WEBP']),
          maxFileBytes: this.maxFileBytes(input.maxFileBytes ?? DEFAULT_ATTESTATION_MAX_FILE_BYTES),
          reminderDays: this.reminders(input.reminderDays ?? DEFAULT_REMINDER_DAYS),
          createdByUserId: context.userId,
          updatedByUserId: context.userId,
          createdAt: now,
          updatedAt: now,
        },
      });
      await this.events.auditWithin(tx, {
        action: 'ATTESTATION_TYPE_CREATED',
        actorUserId: context.userId,
        targetType: 'AttestationType',
        targetId: created.id,
        requestId: context.requestId,
        afterState: {
          organizationId: context.organizationId,
          enabled: created.enabled,
          feeMinorUnits: created.feeMinor.toString(),
          currency: created.currency,
          defaultValidityDays: created.defaultValidityDays,
        },
      });
      return created;
    });
    return typeView(row);
  }

  /** Everything but the fee. */
  async update(
    context: TenantContext,
    typeId: string,
    input: AttestationTypeInput,
  ): Promise<AttestationTypeView> {
    if (input.feeMinorUnits !== undefined || input.currency !== undefined) {
      throw invalid('The fee is changed through its own endpoint and permission.');
    }
    return this.tenant.withTenant(scopeOf(context), async (tx) => {
      const current = await tx.attestationType.findFirst({
        where: { id: typeId, organizationId: context.organizationId },
      });
      if (current === null) throw notFound();

      const policy = this.policy({
        defaultValidityDays:
          input.defaultValidityDays === undefined
            ? current.defaultValidityDays
            : input.defaultValidityDays,
        allowNoExpiry: input.allowNoExpiry ?? current.allowNoExpiry,
        reviewerMayOverrideValidity:
          input.reviewerMayOverrideValidity ?? current.reviewerMayOverrideValidity,
      });

      const updated = await tx.attestationType.update({
        where: { id: current.id },
        data: {
          ...(input.nameEn !== undefined ? { nameEn: requiredName(input.nameEn, 'nameEn') } : {}),
          ...(input.nameAr !== undefined ? { nameAr: requiredName(input.nameAr, 'nameAr') } : {}),
          ...(input.descriptionEn !== undefined
            ? { descriptionEn: optionalText(input.descriptionEn) }
            : {}),
          ...(input.descriptionAr !== undefined
            ? { descriptionAr: optionalText(input.descriptionAr) }
            : {}),
          ...(input.instructionsEn !== undefined
            ? { instructionsEn: optionalText(input.instructionsEn) }
            : {}),
          ...(input.instructionsAr !== undefined
            ? { instructionsAr: optionalText(input.instructionsAr) }
            : {}),
          ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
          ...policy,
          ...(input.requiredFields !== undefined
            ? { requiredFields: this.requiredFields(input.requiredFields) }
            : {}),
          ...(input.allowedFormats !== undefined
            ? { allowedFormats: this.formats(input.allowedFormats) }
            : {}),
          ...(input.maxFileBytes !== undefined
            ? { maxFileBytes: this.maxFileBytes(input.maxFileBytes) }
            : {}),
          ...(input.reminderDays !== undefined
            ? { reminderDays: this.reminders(input.reminderDays) }
            : {}),
          updatedByUserId: context.userId,
          updatedAt: this.clock.now(),
        },
      });
      await this.events.auditWithin(tx, {
        action: 'ATTESTATION_TYPE_UPDATED',
        actorUserId: context.userId,
        targetType: 'AttestationType',
        targetId: updated.id,
        requestId: context.requestId,
        beforeState: {
          enabled: current.enabled,
          defaultValidityDays: current.defaultValidityDays,
          allowNoExpiry: current.allowNoExpiry,
        },
        afterState: {
          enabled: updated.enabled,
          defaultValidityDays: updated.defaultValidityDays,
          allowNoExpiry: updated.allowNoExpiry,
        },
      });
      return typeView(updated);
    });
  }

  /**
   * Change a fee. Only future submissions are affected: a submitted request
   * keeps the price it was submitted under.
   */
  async setFee(
    context: TenantContext,
    typeId: string,
    input: { readonly currency: string; readonly feeMinorUnits: string },
  ): Promise<AttestationTypeView> {
    const fee = this.fee(input.feeMinorUnits);
    const currency = this.currency(input.currency);
    return this.tenant.withTenant(scopeOf(context), async (tx) => {
      const current = await tx.attestationType.findFirst({
        where: { id: typeId, organizationId: context.organizationId },
      });
      if (current === null) throw notFound();
      const updated = await tx.attestationType.update({
        where: { id: current.id },
        data: {
          feeMinor: fee,
          currency,
          updatedByUserId: context.userId,
          updatedAt: this.clock.now(),
        },
      });
      await this.events.auditWithin(tx, {
        action: 'ATTESTATION_TYPE_UPDATED',
        actorUserId: context.userId,
        targetType: 'AttestationType',
        targetId: updated.id,
        requestId: context.requestId,
        beforeState: { feeMinorUnits: current.feeMinor.toString(), currency: current.currency },
        afterState: { feeMinorUnits: updated.feeMinor.toString(), currency: updated.currency },
      });
      return typeView(updated);
    });
  }

  // -------------------------------------------------------------------------

  private fee(value: string): bigint {
    let parsed: bigint;
    try {
      parsed = parseMinorUnits(value);
    } catch {
      throw invalid('A fee must be a whole number of minor units.');
    }
    if (parsed < 0n || parsed > 1_000_000_000_000n) {
      throw invalid('A fee must be zero or a positive amount.');
    }
    return parsed;
  }

  private currency(code: string): string {
    const upper = code.trim().toUpperCase();
    if (!isKnownCurrency(upper) || !this.config.payments.enabledCurrencies.includes(upper)) {
      throw invalid('That currency is not enabled on this PalCert deployment.', {
        currency: upper,
      });
    }
    return upper;
  }

  private policy(input: {
    defaultValidityDays: number | null;
    allowNoExpiry: boolean;
    reviewerMayOverrideValidity: boolean;
  }): {
    defaultValidityDays: number | null;
    allowNoExpiry: boolean;
    reviewerMayOverrideValidity: boolean;
  } {
    if (
      input.defaultValidityDays !== null &&
      (!Number.isInteger(input.defaultValidityDays) ||
        input.defaultValidityDays < 1 ||
        input.defaultValidityDays > MAX_ATTESTATION_VALIDITY_DAYS)
    ) {
      throw invalid(
        `The default validity must be between 1 and ${MAX_ATTESTATION_VALIDITY_DAYS} days.`,
      );
    }
    if (
      !input.reviewerMayOverrideValidity &&
      input.defaultValidityDays === null &&
      !input.allowNoExpiry
    ) {
      throw invalid(
        'Either give a default validity, allow no expiration, or let reviewers choose the validity.',
      );
    }
    return input;
  }

  private requiredFields(fields: readonly string[]): string[] {
    const unique = [...new Set(fields)];
    for (const field of unique) {
      if (!(CONFIGURABLE_REQUIRED_FIELDS as readonly string[]).includes(field)) {
        throw invalid(`Unknown certificate field ${JSON.stringify(field)}.`);
      }
    }
    return unique;
  }

  private formats(formats: readonly string[]): AttestationArtifactFormat[] {
    const unique = [...new Set(formats)];
    if (unique.length === 0) throw invalid('Allow at least one file type.');
    for (const format of unique) {
      if (!isAttestationArtifactFormat(format))
        throw invalid(`Unsupported file type ${JSON.stringify(format)}.`);
    }
    return unique as AttestationArtifactFormat[];
  }

  private maxFileBytes(value: number): number {
    if (!Number.isInteger(value) || value < 1024 || value > ABSOLUTE_ATTESTATION_MAX_FILE_BYTES) {
      throw invalid(
        `The file size limit must be between 1 KB and ${ABSOLUTE_ATTESTATION_MAX_FILE_BYTES} bytes.`,
      );
    }
    return value;
  }

  private reminders(days: readonly number[]): number[] {
    if (!isValidReminderSchedule(days)) {
      throw invalid('Reminders are up to eight distinct whole days between 1 and 365.');
    }
    return [...days].sort((a, b) => b - a);
  }
}

function notFound(): AppError {
  return new AppError(PalCertErrorCode.ATTESTATION_TYPE_NOT_FOUND, {
    message: 'No such attestation type in this organization.',
  });
}

function requiredName(value: string | undefined, field: string): string {
  const trimmed = (value ?? '').normalize('NFC').trim();
  if (trimmed.length === 0 || trimmed.length > 200) {
    throw invalid(`${field} is required and at most 200 characters.`);
  }
  return trimmed;
}

function optionalText(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.normalize('NFC').trim();
  return trimmed.length === 0 ? null : trimmed;
}

export function scopeOf(context: TenantContext): { organizationId: string; userId: string } {
  return { organizationId: context.organizationId, userId: context.userId };
}
