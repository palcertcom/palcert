import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Response shapes.
 *
 * Notably absent everywhere: invitation tokens, reviewer internal notes,
 * organization suspension reasons and any field classified PALCERT_INTERNAL.
 */

export class OrganizationSummaryDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() slug!: string;
  @ApiProperty() displayName!: string;
  @ApiProperty() type!: string;
  @ApiProperty() status!: string;
  @ApiProperty() verificationStatus!: string;
  @ApiProperty() countryCode!: string;
}

export class OrganizationProfileDto extends OrganizationSummaryDto {
  @ApiProperty() legalName!: string;
  @ApiProperty({ nullable: true, type: String }) website!: string | null;
  @ApiProperty() defaultLocale!: string;
  @ApiProperty() timezone!: string;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
  @ApiProperty() memberCount!: number;
}

export class UserOrganizationDto {
  @ApiProperty({ type: OrganizationSummaryDto }) organization!: OrganizationSummaryDto;
  @ApiProperty({ format: 'uuid' }) membershipId!: string;
  @ApiProperty() membershipStatus!: string;
  @ApiProperty({ type: [String] }) roles!: string[];
  @ApiProperty() joinedAt!: string;
}

export class OrganizationMemberDto {
  @ApiProperty({ format: 'uuid' }) membershipId!: string;
  @ApiProperty({ format: 'uuid' }) userId!: string;
  @ApiProperty() email!: string;
  @ApiProperty({ nullable: true, type: String }) displayName!: string | null;
  @ApiProperty() status!: string;
  @ApiProperty({ type: [String] }) roles!: string[];
  @ApiProperty() joinedAt!: string;
  @ApiProperty({ nullable: true, type: String }) suspendedAt!: string | null;
}

export class OrganizationInvitationDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() email!: string;
  @ApiProperty() roleCode!: string;
  @ApiProperty() status!: string;
  @ApiProperty({ format: 'uuid' }) invitedByUserId!: string;
  @ApiProperty() expiresAt!: string;
  @ApiProperty() createdAt!: string;
}

export class InvitationPreviewDto {
  @ApiProperty() organizationDisplayName!: string;
  @ApiProperty() roleCode!: string;
  @ApiProperty() expiresAt!: string;
  @ApiProperty({ description: 'True when the invited address has no PalCert account yet.' })
  requiresRegistration!: boolean;
}

export class OrganizationVerificationDto {
  @ApiProperty() status!: string;
  @ApiProperty({ nullable: true, type: String }) requestedAt!: string | null;
  @ApiProperty({ nullable: true, type: String }) reviewedAt!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'Applicant-facing reason only. Reviewer notes are never exposed.',
  })
  decisionReason!: string | null;
  @ApiProperty() canRequest!: boolean;
}

export class MemberPageDto {
  @ApiProperty({ type: [OrganizationMemberDto] }) items!: OrganizationMemberDto[];
  @ApiProperty({ nullable: true, type: String, description: 'Null on the last page.' })
  nextCursor!: string | null;
}

export class InvitationPageDto {
  @ApiProperty({ type: [OrganizationInvitationDto] }) items!: OrganizationInvitationDto[];
  @ApiProperty({ nullable: true, type: String }) nextCursor!: string | null;
}

export class OrganizationPageDto {
  @ApiProperty({ type: [OrganizationProfileDto] }) items!: OrganizationProfileDto[];
  @ApiProperty({ nullable: true, type: String }) nextCursor!: string | null;
}

export class AcceptInvitationResultDto {
  @ApiProperty({ format: 'uuid' }) organizationId!: string;
  @ApiProperty() roleCode!: string;
}

export class OwnershipTransferResultDto {
  @ApiProperty({ format: 'uuid' }) newOwnerUserId!: string;
  @ApiProperty() previousOwnerRetainedOwnership!: boolean;
}

export class PendingVerificationDto {
  @ApiProperty({ format: 'uuid' }) requestId!: string;
  @ApiProperty({ format: 'uuid' }) organizationId!: string;
  @ApiProperty() organizationName!: string;
  @ApiProperty() requestedAt!: string;
  @ApiPropertyOptional({ nullable: true, type: String }) submissionNote!: string | null;
}
