import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  PROPOSAL_REJECTION_REASONS,
  STANDARD_SOURCE_AUTHORITIES,
  STANDARD_SOURCE_KINDS,
} from '@palcert/contracts';

/**
 * Request shapes for Phase 9 (§131).
 *
 * Validated before a service sees them, as everywhere else in the codebase.
 * Two things are deliberately *not* accepted from a client anywhere here: a
 * provider file identifier (§20) and a rule's display order, which is an
 * editorial decision about the standard rather than something a reviewer sets
 * while accepting one proposal.
 */

export class StandardVersionScopedParamDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  organizationId!: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  versionId!: string;
}

export class SourceParamDto extends StandardVersionScopedParamDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  sourceId!: string;
}

export class ExtractionParamDto extends StandardVersionScopedParamDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  runId!: string;
}

export class ProposalParamDto extends ExtractionParamDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  proposalId!: string;
}

export class RuleProvenanceParamDto extends StandardVersionScopedParamDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  ruleId!: string;
}

export class CreateStandardSourceDto {
  @ApiProperty({
    enum: STANDARD_SOURCE_KINDS,
    description:
      'A guideline states requirements; a template merely demonstrates formatting. The two are ' +
      'read completely differently and are never treated as equivalent.',
  })
  @IsIn(STANDARD_SOURCE_KINDS)
  sourceKind!: string;

  @ApiProperty({ maxLength: 255 })
  @IsString()
  @Length(1, 255)
  originalFilename!: string;

  @ApiPropertyOptional({ maxLength: 255 })
  @IsOptional()
  @IsString()
  @Length(1, 255)
  declaredMimeType?: string;

  @ApiProperty({ minimum: 1 })
  @IsInt()
  @Min(1)
  sizeBytes!: number;

  @ApiPropertyOptional({ description: 'Client-computed SHA-256, verified against the bytes.' })
  @IsOptional()
  @IsString()
  @Length(64, 64)
  sha256?: string;

  @ApiPropertyOptional({
    enum: STANDARD_SOURCE_AUTHORITIES,
    description:
      'How much authority the institution gives this source. Never inferred from upload order, ' +
      'format or recency: a conflict between two sources is a question for a person.',
  })
  @IsOptional()
  @IsIn(STANDARD_SOURCE_AUTHORITIES)
  authority?: string;
}

export class CreateExtractionDto {
  @ApiPropertyOptional({
    type: [String],
    description: 'Which ready sources to read. Omitted means every ready source on the draft.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsUUID('4', { each: true })
  sourceAssetIds?: string[];

  @ApiProperty({
    format: 'uuid',
    description:
      'ADR-0149: an AI_RULE_EXTRACTION price quote of your own, unexpired and unused. The fee ' +
      'is reserved from YOUR PalCert Balance — not the organization’s — charged when the ' +
      'extraction completes and released if it fails or is cancelled.',
  })
  @IsUUID('4')
  priceQuoteId!: string;
}

export class AcceptProposalDto {
  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    description:
      'A rule the reviewer edited before accepting. Validated exactly as a hand-written rule is, ' +
      'and stored on the decision rather than over the AI proposal.',
  })
  @IsOptional()
  @IsObject()
  rule?: Record<string, unknown>;

  @ApiPropertyOptional({
    description:
      'The normative source category. The reviewer may correct what the model guessed: AI is the ' +
      'extraction mechanism, never the authority.',
  })
  @IsOptional()
  @IsString()
  @Length(1, 64)
  origin?: string;

  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @IsString()
  @Length(1, 2000)
  reviewNotes?: string;
}

export class RejectProposalDto {
  @ApiPropertyOptional({
    enum: PROPOSAL_REJECTION_REASONS,
    description: 'Kept inside PalCert for product improvement; never sent to a provider.',
  })
  @IsOptional()
  @IsIn(PROPOSAL_REJECTION_REASONS)
  reason?: string;

  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @IsString()
  @Length(1, 2000)
  reviewNotes?: string;
}

export class AcceptManyProposalsDto {
  @ApiProperty({ type: [String], maxItems: 200 })
  @IsArray()
  @ArrayMaxSize(200)
  @IsUUID('4', { each: true })
  proposalIds!: string[];
}

export class RejectManyProposalsDto {
  @ApiProperty({ type: [String], maxItems: 200 })
  @IsArray()
  @ArrayMaxSize(200)
  @IsUUID('4', { each: true })
  proposalIds!: string[];

  @ApiPropertyOptional({
    enum: PROPOSAL_REJECTION_REASONS,
    description:
      'Applied to every proposal rejected. Kept inside PalCert; never sent to a provider.',
  })
  @IsOptional()
  @IsIn(PROPOSAL_REJECTION_REASONS)
  reason?: string;

  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @IsString()
  @Length(1, 2000)
  reviewNotes?: string;
}

export class RevisionQueryDto {
  @ApiPropertyOptional({
    description: 'The draft revision the reviewer was looking at. Also accepted as If-Match.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(2_147_483_647)
  expectedRevision?: number;
}
