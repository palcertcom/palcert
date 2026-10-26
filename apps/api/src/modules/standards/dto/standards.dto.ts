import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  DOCUMENT_SYSTEM_CATEGORIES,
  PAGINATION_MAX_LIMIT,
  PORTABLE_STANDARD_LIMITS,
  RULE_AUTOFIX_CAPABILITIES,
  RULE_CATEGORIES,
  RULE_CODE_MAX_LENGTH,
  RULE_DESCRIPTION_MAX_LENGTH,
  RULE_EVALUATION_MODES,
  RULE_GUIDANCE_MAX_LENGTH,
  RULE_OPERATORS,
  RULE_ORIGINS,
  RULE_SEVERITIES,
  RULE_TITLE_MAX_LENGTH,
  RULE_UNITS,
  STANDARD_CODE_MAX_LENGTH,
  STANDARD_VERSION_STATUSES,
  StandardImportMode,
  VERSION_LABEL_MAX_LENGTH,
  type DocumentSystemCategory,
  type RuleAutofixCapability,
  type RuleCategory,
  type RuleEvaluationMode,
  type RuleOperator,
  type RuleOrigin,
  type RuleSeverity,
  type RuleUnit,
} from '@palcert/contracts';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  ValidateIf,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/**
 * Request shapes for the standards surface.
 *
 * These decorators do the *structural* validation the framework is good at —
 * types, lengths, enum membership. The cross-field semantics of a rule
 * (operator against value type, unit, tolerance, blocking against evaluation
 * mode) are validated by `validateRuleDefinition` in `@palcert/contracts`,
 * which the browser runs too. Duplicating that logic here as decorators would
 * guarantee the two eventually disagree.
 *
 * `scope` and `expected` therefore arrive as plain objects: they are checked
 * against the versioned contract in the service, and a failure comes back as
 * `RULE_SCHEMA_INVALID` with a `path` per issue so the builder can show each
 * message beside its field.
 */

const Trimmed = (): PropertyDecorator =>
  Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value));

const Upper = (): PropertyDecorator =>
  Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  );

// ---------------------------------------------------------------------------
// Route parameters
// ---------------------------------------------------------------------------

export class OrganizationScopedParamDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  organizationId!: string;
}

export class DocumentTypeParamDto extends OrganizationScopedParamDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  documentTypeId!: string;
}

export class StandardParamDto extends OrganizationScopedParamDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  standardId!: string;
}

export class StandardVersionParamDto extends StandardParamDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  versionId!: string;
}

export class RuleParamDto extends StandardVersionParamDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  ruleId!: string;
}

// ---------------------------------------------------------------------------
// Pagination and filtering
// ---------------------------------------------------------------------------

export class CollectionQueryDto {
  @ApiPropertyOptional({ description: 'Opaque cursor from a previous page.' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  cursor?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: PAGINATION_MAX_LIMIT, default: 25 })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? Number.parseInt(value, 10) : value,
  )
  @IsInt()
  @Min(1)
  @Max(PAGINATION_MAX_LIMIT)
  limit?: number;
}

export class DocumentTypeQueryDto extends CollectionQueryDto {
  @ApiPropertyOptional({ enum: ['ACTIVE', 'ARCHIVED'] })
  @IsOptional()
  @IsIn(['ACTIVE', 'ARCHIVED'])
  status?: 'ACTIVE' | 'ARCHIVED';
}

export class StandardQueryDto extends CollectionQueryDto {
  @ApiPropertyOptional({ enum: ['ACTIVE', 'ARCHIVED'] })
  @IsOptional()
  @IsIn(['ACTIVE', 'ARCHIVED'])
  status?: 'ACTIVE' | 'ARCHIVED';

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('4')
  documentTypeId?: string;

  @ApiPropertyOptional({
    description:
      'Case-insensitive substring of the code or either name. Always confined to the caller’s ' +
      'organization — this is not a cross-tenant directory.',
  })
  @IsOptional()
  @Trimmed()
  @IsString()
  @MaxLength(200)
  search?: string;
}

export class StandardVersionQueryDto extends CollectionQueryDto {
  @ApiPropertyOptional({ enum: STANDARD_VERSION_STATUSES })
  @IsOptional()
  @IsIn(STANDARD_VERSION_STATUSES)
  status?: (typeof STANDARD_VERSION_STATUSES)[number];
}

export class RuleQueryDto extends CollectionQueryDto {
  @ApiPropertyOptional({ enum: RULE_CATEGORIES })
  @IsOptional()
  @IsIn(RULE_CATEGORIES)
  category?: RuleCategory;
}

// ---------------------------------------------------------------------------
// Document types
// ---------------------------------------------------------------------------

export class CreateDocumentTypeDto {
  @ApiProperty({ enum: DOCUMENT_SYSTEM_CATEGORIES })
  @IsIn(DOCUMENT_SYSTEM_CATEGORIES)
  systemCategory!: DocumentSystemCategory;

  @ApiProperty({ example: "Master's Thesis" })
  @Trimmed()
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;

  @ApiPropertyOptional({ example: 'رسالة ماجستير' })
  @IsOptional()
  @Trimmed()
  @IsString()
  @MaxLength(120)
  nameAr?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Trimmed()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Trimmed()
  @IsString()
  @MaxLength(1000)
  descriptionAr?: string;
}

export class UpdateDocumentTypeDto {
  @ApiPropertyOptional({ enum: DOCUMENT_SYSTEM_CATEGORIES })
  @IsOptional()
  @IsIn(DOCUMENT_SYSTEM_CATEGORIES)
  systemCategory?: DocumentSystemCategory;

  @ApiPropertyOptional()
  @IsOptional()
  @Trimmed()
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @Trimmed()
  @IsString()
  @MaxLength(120)
  nameAr?: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @Trimmed()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @Trimmed()
  @IsString()
  @MaxLength(1000)
  descriptionAr?: string;
}

// ---------------------------------------------------------------------------
// Standards
// ---------------------------------------------------------------------------

export class CreateStandardDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  documentTypeId!: string;

  @ApiProperty({
    example: 'IUG.THESIS.FORMAT',
    description: 'Stable handle, UPPERCASE with dots, underscores or hyphens between segments.',
  })
  @Upper()
  @IsString()
  @MinLength(2)
  @MaxLength(STANDARD_CODE_MAX_LENGTH)
  code!: string;

  @ApiProperty({ example: 'IUG Thesis Formatting' })
  @Trimmed()
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  nameEn!: string;

  @ApiProperty({ example: 'تنسيق رسائل الجامعة الإسلامية' })
  @Trimmed()
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  nameAr!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Trimmed()
  @IsString()
  @MaxLength(2000)
  descriptionEn?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Trimmed()
  @IsString()
  @MaxLength(2000)
  descriptionAr?: string;
}

export class UpdateStandardDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('4')
  documentTypeId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Trimmed()
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  nameEn?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Trimmed()
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  nameAr?: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @Trimmed()
  @IsString()
  @MaxLength(2000)
  descriptionEn?: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @Trimmed()
  @IsString()
  @MaxLength(2000)
  descriptionAr?: string;
}

// ---------------------------------------------------------------------------
// Standard versions
// ---------------------------------------------------------------------------

export class CreateStandardVersionDto {
  @ApiProperty({ example: '1.0', description: 'Unique within the standard. A label, not an id.' })
  @Trimmed()
  @IsString()
  @MinLength(1)
  @MaxLength(VERSION_LABEL_MAX_LENGTH)
  versionLabel!: string;

  @ApiPropertyOptional({ format: 'date-time' })
  @IsOptional()
  @IsISO8601({ strict: true })
  effectiveFrom?: string;

  @ApiPropertyOptional({ format: 'date-time' })
  @IsOptional()
  @IsISO8601({ strict: true })
  effectiveUntil?: string;
}

export class UpdateStandardVersionDto {
  @ApiPropertyOptional({ example: '1.1' })
  @IsOptional()
  @Trimmed()
  @IsString()
  @MinLength(1)
  @MaxLength(VERSION_LABEL_MAX_LENGTH)
  versionLabel?: string;

  @ApiPropertyOptional({ format: 'date-time', nullable: true })
  @IsOptional()
  @IsISO8601({ strict: true })
  effectiveFrom?: string;

  @ApiPropertyOptional({ format: 'date-time', nullable: true })
  @IsOptional()
  @IsISO8601({ strict: true })
  effectiveUntil?: string;
}

export class CloneStandardVersionDto {
  @ApiProperty({ example: '2.0', description: 'Label for the new draft.' })
  @Trimmed()
  @IsString()
  @MinLength(1)
  @MaxLength(VERSION_LABEL_MAX_LENGTH)
  versionLabel!: string;

  @ApiPropertyOptional({
    default: false,
    description:
      'Upgrade the new draft to the current rule schema version. Off by default: a clone is a ' +
      'faithful copy, and an upgrade changes which invariants the draft is judged by. The source ' +
      'version is never touched either way.',
  })
  @IsOptional()
  @IsBoolean()
  upgradeRuleSchema?: boolean;
}

export class PublishStandardVersionDto {
  @ApiPropertyOptional({
    format: 'uuid',
    nullable: true,
    type: String,
    description:
      'The version the caller expects to be in force, which this publish will supersede — ' +
      'null to expect none. When given and the standard has moved on (another version was ' +
      'published in the meantime), the request is refused with CONFLICT instead of replacing ' +
      'a version the caller never saw. Omit it to supersede whatever version is in force.',
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsUUID('4')
  replacesVersionId?: string | null;
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

export class RuleBodyDto {
  @ApiProperty({ example: 'MARGIN.TOP.MIN' })
  @Upper()
  @IsString()
  @MaxLength(RULE_CODE_MAX_LENGTH)
  ruleCode!: string;

  @ApiProperty({ enum: RULE_CATEGORIES })
  @IsIn(RULE_CATEGORIES)
  category!: RuleCategory;

  @ApiProperty({ enum: RULE_EVALUATION_MODES })
  @IsIn(RULE_EVALUATION_MODES)
  evaluationMode!: RuleEvaluationMode;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description:
      'Discriminated on `kind`: DOCUMENT | SECTION | ELEMENT | METADATA | PAGE. Validated ' +
      'against the versioned rule schema; never an expression.',
  })
  @IsObject()
  scope!: Record<string, unknown>;

  @ApiProperty({ enum: RULE_OPERATORS })
  @IsIn(RULE_OPERATORS)
  operator!: RuleOperator;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description:
      'Discriminated on `type`: NUMBER | STRING | BOOLEAN | NUMBER_RANGE | STRING_LIST | ' +
      'NUMBER_LIST | PATTERN | NONE. A PATTERN names a PalCert matcher — never a regular ' +
      'expression supplied by the caller.',
  })
  @IsObject()
  expected!: Record<string, unknown>;

  @ApiPropertyOptional({ enum: RULE_UNITS, nullable: true })
  @IsOptional()
  @IsIn(RULE_UNITS)
  unit?: RuleUnit;

  @ApiPropertyOptional({ nullable: true, minimum: 0 })
  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  tolerance?: number;

  @ApiProperty({ enum: RULE_SEVERITIES })
  @IsIn(RULE_SEVERITIES)
  severity!: RuleSeverity;

  @ApiProperty({ description: 'Only a DETERMINISTIC rule may block certification.' })
  @IsBoolean()
  blocking!: boolean;

  @ApiProperty({ enum: RULE_AUTOFIX_CAPABILITIES })
  @IsIn(RULE_AUTOFIX_CAPABILITIES)
  autofix!: RuleAutofixCapability;

  @ApiProperty({ enum: RULE_ORIGINS })
  @IsIn(RULE_ORIGINS)
  origin!: RuleOrigin;

  @ApiPropertyOptional({ nullable: true, example: 'Graduate Studies Handbook, s. 4.2' })
  @IsOptional()
  @Trimmed()
  @IsString()
  @MaxLength(RULE_DESCRIPTION_MAX_LENGTH)
  originReference?: string;

  @ApiProperty({ maxLength: RULE_TITLE_MAX_LENGTH })
  @Trimmed()
  @IsString()
  @MaxLength(RULE_TITLE_MAX_LENGTH)
  titleEn!: string;

  @ApiProperty({ maxLength: RULE_TITLE_MAX_LENGTH })
  @Trimmed()
  @IsString()
  @MaxLength(RULE_TITLE_MAX_LENGTH)
  titleAr!: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @Trimmed()
  @IsString()
  @MaxLength(RULE_DESCRIPTION_MAX_LENGTH)
  descriptionEn?: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @Trimmed()
  @IsString()
  @MaxLength(RULE_DESCRIPTION_MAX_LENGTH)
  descriptionAr?: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @Trimmed()
  @IsString()
  @MaxLength(RULE_GUIDANCE_MAX_LENGTH)
  guidanceEn?: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @Trimmed()
  @IsString()
  @MaxLength(RULE_GUIDANCE_MAX_LENGTH)
  guidanceAr?: string;

  @ApiPropertyOptional({
    minimum: 0,
    description: 'Report ordering. Appended at the end when omitted.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100000)
  displayOrder?: number;
}

export class ReorderRulesDto {
  @ApiProperty({
    type: [String],
    format: 'uuid',
    description:
      'Every rule id in the version, in the order they should appear. The full set is required ' +
      'so a partial list can never silently leave rules with a stale order.',
  })
  @IsUUID('4', { each: true })
  ruleIds!: string[];
}

// ---------------------------------------------------------------------------
// Portable standard packages
// ---------------------------------------------------------------------------

export class PreviewStandardImportDto {
  @ApiProperty({
    description:
      'The package file exactly as it was uploaded, as text. It is parsed on the server, ' +
      'never trusted as an object from the browser.',
  })
  @IsString()
  @MaxLength(PORTABLE_STANDARD_LIMITS.maxBytes)
  package!: string;
}

export class ImportStandardDto extends PreviewStandardImportDto {
  @ApiProperty({
    example: 'sha256:0e3a…',
    description:
      'The packageHash the preview returned. The import is refused unless the package sent ' +
      'now hashes to it, so what is imported is what was previewed.',
  })
  @Matches(/^sha256:[0-9a-f]{64}$/)
  packageHash!: string;

  @ApiProperty({ enum: Object.values(StandardImportMode) })
  @IsIn(Object.values(StandardImportMode))
  mode!: StandardImportMode;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'EXISTING_STANDARD: the standard to add a draft to.',
  })
  @IsOptional()
  @IsUUID('4')
  standardId?: string;

  @ApiPropertyOptional({ description: 'NEW_STANDARD: the code; defaults to the package code.' })
  @IsOptional()
  @Upper()
  @IsString()
  @MaxLength(STANDARD_CODE_MAX_LENGTH)
  code?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Trimmed()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  nameEn?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Trimmed()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  nameAr?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'NEW_STANDARD: a document type in the same category.',
  })
  @IsOptional()
  @IsUUID('4')
  documentTypeId?: string;

  @ApiProperty({ example: '1.4', description: 'Label for the new draft version.' })
  @Trimmed()
  @IsString()
  @MinLength(1)
  @MaxLength(VERSION_LABEL_MAX_LENGTH)
  versionLabel!: string;

  @ApiPropertyOptional({
    default: false,
    description: 'Required to import a package this organization has already imported.',
  })
  @IsOptional()
  @IsBoolean()
  acknowledgeDuplicate?: boolean;
}
