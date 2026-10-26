import { ApiProperty } from '@nestjs/swagger';

/**
 * Response shapes for the standards surface.
 *
 * Notably absent: `organizationId`. Every one of these is reached through an
 * organization-scoped route, so echoing the tenant back adds nothing and
 * invites a client to start treating it as a parameter rather than as context.
 */

export class DocumentTypeDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() systemCategory!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ nullable: true, type: String }) nameAr!: string | null;
  @ApiProperty({ nullable: true, type: String }) description!: string | null;
  @ApiProperty({ nullable: true, type: String }) descriptionAr!: string | null;
  @ApiProperty() status!: string;
  @ApiProperty({ description: 'How many standards reference this type.' }) standardCount!: number;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class StandardDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) documentTypeId!: string;
  @ApiProperty() documentTypeName!: string;
  @ApiProperty() documentTypeCategory!: string;
  @ApiProperty() code!: string;
  @ApiProperty() nameEn!: string;
  @ApiProperty() nameAr!: string;
  @ApiProperty({ nullable: true, type: String }) descriptionEn!: string | null;
  @ApiProperty({ nullable: true, type: String }) descriptionAr!: string | null;
  @ApiProperty() status!: string;
  @ApiProperty() versionCount!: number;
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'The version currently in force, if any.',
  })
  publishedVersionId!: string | null;
  @ApiProperty({ nullable: true, type: String }) publishedVersionLabel!: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class StandardVersionDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) standardId!: string;
  @ApiProperty() versionLabel!: string;
  @ApiProperty({ enum: ['DRAFT', 'PUBLISHED', 'SUPERSEDED', 'ARCHIVED'] }) status!: string;
  @ApiProperty({ nullable: true, type: String }) effectiveFrom!: string | null;
  @ApiProperty({ nullable: true, type: String }) effectiveUntil!: string | null;
  @ApiProperty() ruleCount!: number;
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'sha256:<hex> over the canonical snapshot. Null until published.',
  })
  contentHash!: string | null;
  @ApiProperty({ nullable: true, type: Number }) canonicalizationVersion!: number | null;
  @ApiProperty() ruleSchemaVersion!: number;
  @ApiProperty({
    description: 'Optimistic-concurrency token. Sent back as the ETag; required as If-Match.',
  })
  revision!: number;
  @ApiProperty({ nullable: true, type: String }) publishedAt!: string | null;
  @ApiProperty({ nullable: true, type: String }) publishedByUserId!: string | null;
  @ApiProperty({ nullable: true, type: String }) archivedAt!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'When a newer published version replaced this one. Null unless SUPERSEDED.',
  })
  supersededAt!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    format: 'uuid',
    description: 'The version that replaced this one. Null unless SUPERSEDED.',
  })
  supersededByVersionId!: string | null;
  @ApiProperty({ nullable: true, type: String }) supersededByVersionLabel!: string | null;
  @ApiProperty({ nullable: true, type: String }) clonedFromVersionId!: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class StandardVersionUsageDto {
  @ApiProperty({ format: 'uuid' }) standardVersionId!: string;
  @ApiProperty({
    description: 'Submission revisions handed over for review that were checked against it.',
  })
  submissionCount!: number;
  @ApiProperty({ description: 'Certificates issued on those submissions, revoked ones included.' })
  certificateCount!: number;
}

export class RuleDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() ruleCode!: string;
  @ApiProperty() category!: string;
  @ApiProperty() evaluationMode!: string;
  @ApiProperty({ type: 'object', additionalProperties: true }) scope!: Record<string, unknown>;
  @ApiProperty() operator!: string;
  @ApiProperty({ type: 'object', additionalProperties: true }) expected!: Record<string, unknown>;
  @ApiProperty({ nullable: true, type: String }) unit!: string | null;
  @ApiProperty({ nullable: true, type: Number }) tolerance!: number | null;
  @ApiProperty() severity!: string;
  @ApiProperty() blocking!: boolean;
  @ApiProperty() autofix!: string;
  @ApiProperty() origin!: string;
  @ApiProperty({ nullable: true, type: String }) originReference!: string | null;
  @ApiProperty() titleEn!: string;
  @ApiProperty() titleAr!: string;
  @ApiProperty({ nullable: true, type: String }) descriptionEn!: string | null;
  @ApiProperty({ nullable: true, type: String }) descriptionAr!: string | null;
  @ApiProperty({ nullable: true, type: String }) guidanceEn!: string | null;
  @ApiProperty({ nullable: true, type: String }) guidanceAr!: string | null;
  @ApiProperty() displayOrder!: number;
  @ApiProperty() ruleSchemaVersion!: number;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class ValidationIssueDto {
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'The rule the issue belongs to, or null for a version-level issue.',
  })
  ruleCode!: string | null;
  @ApiProperty({ description: 'Dotted path into the payload, e.g. expected.min.' }) path!: string;
  @ApiProperty() code!: string;
  @ApiProperty() message!: string;
}

export class StandardVersionValidationDto {
  @ApiProperty() valid!: boolean;
  @ApiProperty() ruleCount!: number;
  @ApiProperty({ type: [ValidationIssueDto] }) issues!: ValidationIssueDto[];
}

export class StandardVersionSnapshotDto {
  @ApiProperty({ format: 'uuid' }) standardVersionId!: string;
  @ApiProperty() contentHash!: string;
  @ApiProperty() canonicalizationVersion!: number;
  @ApiProperty() ruleSchemaVersion!: number;
  @ApiProperty() ruleCount!: number;
  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description:
      'The exact object the hash was computed over. Re-serialize it canonically and hash it to ' +
      'verify the standard independently of PalCert.',
  })
  canonical!: Record<string, unknown>;
  @ApiProperty({
    description: 'Whether the stored snapshot still hashes to its recorded content hash.',
  })
  hashVerified!: boolean;
  @ApiProperty() createdAt!: string;
}

export class PageMetaDto {
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'Opaque token for the next page, or null when this is the last one.',
  })
  nextCursor!: string | null;
}

export class DocumentTypePageDto extends PageMetaDto {
  @ApiProperty({ type: [DocumentTypeDto] }) items!: DocumentTypeDto[];
}

export class StandardPageDto extends PageMetaDto {
  @ApiProperty({ type: [StandardDto] }) items!: StandardDto[];
}

export class StandardVersionPageDto extends PageMetaDto {
  @ApiProperty({ type: [StandardVersionDto] }) items!: StandardVersionDto[];
}

export class RulePageDto extends PageMetaDto {
  @ApiProperty({ type: [RuleDto] }) items!: RuleDto[];
}

export class RuleOperatorDescriptorDto {
  @ApiProperty() operator!: string;
  @ApiProperty({ type: [String] }) valueTypes!: string[];
  @ApiProperty() unary!: boolean;
  @ApiProperty() supportsTolerance!: boolean;
}

export class RulePatternDescriptorDto {
  @ApiProperty() name!: string;
  @ApiProperty() requiresArgument!: boolean;
}

export class RuleSchemaDto {
  @ApiProperty({ description: 'The version new drafts are written under.' })
  ruleSchemaVersion!: number;

  @ApiProperty({
    type: [Number],
    description: 'Every rule schema version this release can validate, oldest first.',
  })
  supportedRuleSchemaVersions!: number[];

  @ApiProperty({
    description:
      'The first schema version under which a rule may be blocking in any evaluation mode. ' +
      'Below it, only a DETERMINISTIC rule may be blocking.',
  })
  blockingAnyModeFromSchemaVersion!: number;

  @ApiProperty({ type: [String] }) categories!: string[];
  @ApiProperty({ type: [String] }) evaluationModes!: string[];
  @ApiProperty({ type: [String] }) severities!: string[];
  @ApiProperty({ type: [String] }) autofixCapabilities!: string[];
  @ApiProperty({ type: [String] }) origins!: string[];
  @ApiProperty({ type: [String] }) units!: string[];
  @ApiProperty({ type: [String] }) valueTypes!: string[];
  @ApiProperty({ type: [String] }) scopeKinds!: string[];
  @ApiProperty({ type: [String] }) elementTypes!: string[];
  @ApiProperty({ type: [String] }) pageSelectors!: string[];
  @ApiProperty({ type: [RulePatternDescriptorDto] }) patterns!: RulePatternDescriptorDto[];
  @ApiProperty({ type: [RuleOperatorDescriptorDto] }) operators!: RuleOperatorDescriptorDto[];
  @ApiProperty({ type: [String] }) unitRequiredFor!: string[];
}
