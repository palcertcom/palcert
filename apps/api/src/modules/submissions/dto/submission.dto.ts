import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  INSTITUTION_DECISION_STATUSES,
  SUBMISSION_COMMENT_MAX_LENGTH,
  SUBMISSION_DECISION_REASONS,
  type InstitutionDecisionStatus,
  type SubmissionDecisionReason,
} from '@palcert/contracts';
import { IsIn, IsOptional, IsString, IsUUID, Length, MaxLength } from 'class-validator';

export class CheckParamDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  checkId!: string;
}

export class SubmissionParamDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  submissionId!: string;
}

export class RevisionParamDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  revisionId!: string;
}

export class OrganizationRevisionParamDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  organizationId!: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  revisionId!: string;
}

export class OrganizationSubmissionParamDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  organizationId!: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  submissionId!: string;
}

export class OrganizationParamDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID('4')
  organizationId!: string;
}

export class SubmitCheckDto {
  @ApiProperty({
    format: 'uuid',
    description:
      'The exact completed check to hand over. Bound here and never looked up again: no ' +
      '“latest check” is resolved at any later point.',
  })
  @IsUUID('4')
  checkId!: string;
}

export class SubmissionQueueQueryDto {
  @ApiPropertyOptional({ enum: INSTITUTION_DECISION_STATUSES })
  @IsOptional()
  @IsIn(INSTITUTION_DECISION_STATUSES)
  status?: InstitutionDecisionStatus;
}

export class RecordDecisionDto {
  @ApiProperty({
    enum: INSTITUTION_DECISION_STATUSES,
    description:
      'The institution’s own vocabulary. This is an administrative decision about the ' +
      'submission and never a restatement of the technical determination: APPROVED on a ' +
      'NON_COMPLIANT submission, and REJECTED on a COMPLIANT one, are both valid.',
  })
  @IsIn(INSTITUTION_DECISION_STATUSES)
  toStatus!: InstitutionDecisionStatus;

  @ApiPropertyOptional({
    enum: SUBMISSION_DECISION_REASONS,
    description: 'Administrative reason codes only. There is no scientific merit scoring here.',
  })
  @IsOptional()
  @IsIn(SUBMISSION_DECISION_REASONS)
  reasonCode?: SubmissionDecisionReason;

  @ApiPropertyOptional({
    description:
      'Required for REJECTED and REVISION_REQUESTED: the author has to act on those, and a ' +
      'bare status change tells them nothing. Stored immutably.',
    maxLength: SUBMISSION_COMMENT_MAX_LENGTH,
  })
  @IsOptional()
  @IsString()
  @MaxLength(SUBMISSION_COMMENT_MAX_LENGTH)
  comment?: string;

  @ApiPropertyOptional({
    enum: INSTITUTION_DECISION_STATUSES,
    description:
      'The status you were looking at. Supplied, the decision is refused with a conflict if ' +
      'somebody else moved the submission in the meantime.',
  })
  @IsOptional()
  @IsIn(INSTITUTION_DECISION_STATUSES)
  expectedStatus?: InstitutionDecisionStatus;
}

export class AddCommentDto {
  @ApiProperty({ maxLength: SUBMISSION_COMMENT_MAX_LENGTH })
  @IsString()
  @Length(1, SUBMISSION_COMMENT_MAX_LENGTH)
  body!: string;
}
