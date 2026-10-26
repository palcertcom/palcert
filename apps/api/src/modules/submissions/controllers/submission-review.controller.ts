import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import {
  Permission,
  type DownloadAuthorizationView,
  type OrganizationSubmissionView,
  type SubmissionCommentView,
  type SubmissionDecisionEventView,
  type SubmissionQueueEntryView,
} from '@palcert/contracts';
import {
  OrganizationScoped,
  RequireOrganizationPermissions,
  Tenant,
} from '../../organizations/decorators/tenant.decorators';
import type { TenantContext } from '../../organizations/tenant-context';
import {
  AddCommentDto,
  OrganizationRevisionParamDto,
  OrganizationSubmissionParamDto,
  SubmissionQueueQueryDto,
  RecordDecisionDto,
} from '../dto/submission.dto';
import { SubmissionDownloadService } from '../services/submission-download.service';
import { SubmissionReviewService } from '../services/submission-review.service';

/**
 * The receiving institution's side (§56, §57, §58).
 *
 * Every route is organization-scoped, so the organization id in the path is a
 * selector that became a verified context by passing the guard — never an id
 * the caller asserted. Every permission is a permission, never a role name
 * (§53): an institution that wants a coordinator to triage a queue without
 * approving anything grants SUBMISSION_READ and withholds SUBMISSION_DECIDE,
 * and nothing in this file needs to know what they called that person.
 *
 * What is absent matters as much as what is here. There is no route to a
 * document, a document version, a check, a check run, a report row, an
 * analysis, an AI review, a SmartFix plan, a balance or a payment. The
 * organization's entire reach is the submission and its two snapshots, and the
 * policies on those other tables would refuse a reviewer's context anyway
 * (§25, §74, §77).
 */
@ApiTags('submission-review')
@ApiCookieAuth()
@Controller('organizations/:organizationId/submissions')
@OrganizationScoped()
export class SubmissionReviewController {
  constructor(
    private readonly review: SubmissionReviewService,
    private readonly downloads: SubmissionDownloadService,
  ) {}

  @Get()
  @RequireOrganizationPermissions(Permission.SUBMISSION_READ)
  @ApiOperation({
    summary: 'The review queue',
    description:
      'Only what was really handed over. A submission still being prepared, or one whose ' +
      'preparation failed, never appears: a storage failure is not something an institution ' +
      'decides about (§5, §35).',
  })
  @ApiResponse({ status: 200 })
  queue(
    @Tenant() tenant: TenantContext,
    @Query() query: SubmissionQueueQueryDto,
  ): Promise<SubmissionQueueEntryView[]> {
    return this.review.queue(tenant, { status: query.status });
  }

  @Get(':submissionId')
  @RequireOrganizationPermissions(Permission.SUBMISSION_READ)
  @ApiOperation({
    summary: 'One submission and every revision of it received',
    description:
      'The case, not the document. The technical determination, score and findings shown here ' +
      'are copies made at handoff and are read-only in every sense: there is no route, and no ' +
      'database permission, by which an institution could change them (§2, §3).',
  })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 404, description: 'SUBMISSION_NOT_FOUND' })
  get(
    @Tenant() tenant: TenantContext,
    @Param() params: OrganizationSubmissionParamDto,
  ): Promise<OrganizationSubmissionView> {
    return this.review.get(tenant, params.submissionId);
  }

  @Get('revisions/:revisionId/history')
  @RequireOrganizationPermissions(Permission.SUBMISSION_READ)
  @ApiOperation({ summary: 'The append-only decision history of one revision' })
  @ApiResponse({ status: 200 })
  history(
    @Tenant() tenant: TenantContext,
    @Param() params: OrganizationRevisionParamDto,
  ): Promise<SubmissionDecisionEventView[]> {
    return this.review.history(tenant, params.revisionId);
  }

  @Get('revisions/:revisionId/comments')
  @RequireOrganizationPermissions(Permission.SUBMISSION_READ)
  @ApiOperation({ summary: 'The comments written on one revision' })
  @ApiResponse({ status: 200 })
  comments(
    @Tenant() tenant: TenantContext,
    @Param() params: OrganizationRevisionParamDto,
  ): Promise<SubmissionCommentView[]> {
    return this.review.comments(tenant, params.revisionId);
  }

  @Post('revisions/:revisionId/decision')
  @RequireOrganizationPermissions(Permission.SUBMISSION_DECIDE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Record the institution’s decision',
    description:
      'Administrative, and independent of the technical result: APPROVED on a NON_COMPLIANT ' +
      'submission and REJECTED on a COMPLIANT one are both legitimate and both representable ' +
      '(§2, §3). The actor recorded is the authenticated reviewer, taken from the verified ' +
      'session — never from the request body.',
  })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 409, description: 'SUBMISSION_INVALID_TRANSITION' })
  @ApiResponse({ status: 409, description: 'SUBMISSION_ALREADY_DECIDED' })
  @ApiResponse({ status: 409, description: 'SUBMISSION_REVISION_CONFLICT' })
  @ApiResponse({ status: 422, description: 'SUBMISSION_COMMENT_REQUIRED' })
  decide(
    @Tenant() tenant: TenantContext,
    @Param() params: OrganizationRevisionParamDto,
    @Body() body: RecordDecisionDto,
  ): Promise<SubmissionDecisionEventView> {
    return this.review.decide(tenant, params.revisionId, {
      toStatus: body.toStatus,
      reasonCode: body.reasonCode,
      comment: body.comment,
      expectedStatus: body.expectedStatus,
    });
  }

  @Post('revisions/:revisionId/comments')
  @RequireOrganizationPermissions(Permission.SUBMISSION_COMMENT)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Write a comment the author will read',
    description:
      'Communication, not a decision. Writing one changes no status, and the author’s view of ' +
      'where their submission stands is exactly what it was (§65, §70).',
  })
  @ApiResponse({ status: 201 })
  comment(
    @Tenant() tenant: TenantContext,
    @Param() params: OrganizationRevisionParamDto,
    @Body() body: AddCommentDto,
  ): Promise<SubmissionCommentView> {
    return this.review.comment(tenant, params.revisionId, body.body);
  }

  @Post('revisions/:revisionId/document')
  @RequireOrganizationPermissions(Permission.SUBMISSION_EVIDENCE_READ)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Open the submitted document',
    description:
      'A short-lived signed GET of the snapshot the author handed over — never their original, ' +
      'and never any other version of it (§26, §79).',
  })
  @ApiResponse({ status: 200 })
  document(
    @Tenant() tenant: TenantContext,
    @Param() params: OrganizationRevisionParamDto,
  ): Promise<DownloadAuthorizationView> {
    return this.downloads.forOrganization(tenant, params.revisionId, 'document');
  }

  @Post('revisions/:revisionId/report')
  @RequireOrganizationPermissions(Permission.SUBMISSION_EVIDENCE_READ)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Open the submitted technical report',
    description:
      'The exact report artifact, byte for byte, with the hash the submission recorded. It is ' +
      'not regenerated from current tables, so a standard published since changes nothing ' +
      'about what this institution is reading (§29, §31).',
  })
  @ApiResponse({ status: 200 })
  report(
    @Tenant() tenant: TenantContext,
    @Param() params: OrganizationRevisionParamDto,
  ): Promise<DownloadAuthorizationView> {
    return this.downloads.forOrganization(tenant, params.revisionId, 'report');
  }
}
