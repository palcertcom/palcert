import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import {
  Permission,
  type DownloadAuthorizationView,
  type OfficialSubmissionView,
  type SubmissionCommentView,
  type SubmissionDecisionEventView,
  type SubmissionDisclosureView,
  type SubmissionRevisionView,
} from '@palcert/contracts';
import type { RequestPrincipal } from '../../auth/authenticated-request';
import { CurrentUser, RequirePermissions } from '../../auth/decorators/auth.decorators';
import {
  CheckParamDto,
  RevisionParamDto,
  SubmissionParamDto,
  SubmitCheckDto,
} from '../dto/submission.dto';
import { OfficialSubmissionService } from '../services/official-submission.service';
import { SubmissionDownloadService } from '../services/submission-download.service';
import { SubmissionReadService, revisionView } from '../services/submission-read.service';

/**
 * The author's side of an official submission (§20, §88).
 *
 * Nothing here happens on its own. A check completing, a SmartFix finishing, a
 * payment settling and an AI review returning all leave a submission exactly
 * where it was: not submitted. The only thing that creates one is `POST
 * /submissions`, and the only thing that calls that is a person who read the
 * disclosure and pressed a button.
 *
 * No route takes an organization id. The recipient is whoever owns the
 * standard the check was measured against, which is a fact about the check
 * rather than a choice made at submission time — so a submission cannot be
 * pointed at an institution the document was never checked for (§15).
 */
@ApiTags('submissions')
@ApiCookieAuth()
@Controller('submissions')
export class SubmissionsController {
  constructor(
    private readonly submissions: OfficialSubmissionService,
    private readonly reads: SubmissionReadService,
    private readonly downloads: SubmissionDownloadService,
  ) {}

  @Get('checks/:checkId/disclosure')
  @RequirePermissions(Permission.SUBMISSION_READ_SELF)
  @ApiOperation({
    summary: 'What submitting this check would share',
    description:
      'Shown before the act, not after it (§21, §86). Lists exactly what the organization ' +
      'receives — this document version, this report, this determination, this standard, your ' +
      'name and email — and, just as explicitly, what it does not: your other versions, your ' +
      'other checks, your AI review, your SmartFix plan, your balance and your payments.',
  })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 409, description: 'SUBMISSION_CHECK_NOT_COMPLETED' })
  disclosure(
    @Param() params: CheckParamDto,
    @CurrentUser() principal: RequestPrincipal,
  ): Promise<SubmissionDisclosureView> {
    return this.reads.disclosure(principal.userId, params.checkId);
  }

  @Post()
  @RequirePermissions(Permission.SUBMISSION_CREATE_SELF)
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Submit a check officially',
    description:
      'Accepted, not completed (§33). The exact bytes and the exact report are copied to ' +
      'immutable evidence by a worker, and the organization sees nothing until that copy is ' +
      'verified — a half-copied handoff is never an official submission. Re-sending the same ' +
      'Idempotency-Key returns the same revision rather than submitting twice.',
  })
  @ApiResponse({ status: 202 })
  @ApiResponse({ status: 409, description: 'SUBMISSION_CHECK_ALREADY_SUBMITTED' })
  @ApiResponse({ status: 409, description: 'SUBMISSION_ORGANIZATION_NOT_ELIGIBLE' })
  async submit(
    @Body() body: SubmitCheckDto,
    @CurrentUser() principal: RequestPrincipal,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<SubmissionRevisionView> {
    const result = await this.submissions.submit(principal.userId, {
      checkId: body.checkId,
      idempotencyKey: idempotencyKey === undefined ? undefined : idempotencyKey.trim(),
    });
    return revisionView(result.revision);
  }

  @Get()
  @RequirePermissions(Permission.SUBMISSION_READ_SELF)
  @ApiOperation({ summary: 'Your official submissions' })
  @ApiResponse({ status: 200 })
  list(@CurrentUser() principal: RequestPrincipal): Promise<OfficialSubmissionView[]> {
    return this.reads.list(principal.userId);
  }

  @Get(':submissionId')
  @RequirePermissions(Permission.SUBMISSION_READ_SELF)
  @ApiOperation({
    summary: 'One of your official submissions',
    description: 'Another person’s submission id is not found, never forbidden.',
  })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 404, description: 'SUBMISSION_NOT_FOUND' })
  get(
    @Param() params: SubmissionParamDto,
    @CurrentUser() principal: RequestPrincipal,
  ): Promise<OfficialSubmissionView> {
    return this.reads.get(principal.userId, params.submissionId);
  }

  @Get('revisions/:revisionId/history')
  @RequirePermissions(Permission.SUBMISSION_READ_SELF)
  @ApiOperation({
    summary: 'What the institution has done with one revision',
    description:
      'The append-only record (§42). The current status is a convenience; this is the ' +
      'authority, and it says who decided and when.',
  })
  @ApiResponse({ status: 200 })
  history(
    @Param() params: RevisionParamDto,
    @CurrentUser() principal: RequestPrincipal,
  ): Promise<SubmissionDecisionEventView[]> {
    return this.reads.history(principal.userId, params.revisionId);
  }

  @Get('revisions/:revisionId/comments')
  @RequirePermissions(Permission.SUBMISSION_READ_SELF)
  @ApiOperation({
    summary: 'The institution’s comments on one revision',
    description: 'Addressed to you, so you read them (§67). Immutable, so they cannot change.',
  })
  @ApiResponse({ status: 200 })
  comments(
    @Param() params: RevisionParamDto,
    @CurrentUser() principal: RequestPrincipal,
  ): Promise<SubmissionCommentView[]> {
    return this.reads.comments(principal.userId, params.revisionId);
  }

  @Post('revisions/:revisionId/document')
  @RequirePermissions(Permission.SUBMISSION_READ_SELF)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Download the exact bytes you submitted',
    description:
      'A short-lived signed GET of the snapshot — the copy, not your original. It is the ' +
      'record of what the institution received.',
  })
  @ApiResponse({ status: 200 })
  document(
    @Param() params: RevisionParamDto,
    @CurrentUser() principal: RequestPrincipal,
  ): Promise<DownloadAuthorizationView> {
    return this.downloads.forSubmitter(principal.userId, params.revisionId, 'document');
  }

  @Post('revisions/:revisionId/report')
  @RequirePermissions(Permission.SUBMISSION_READ_SELF)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Download the exact report you submitted' })
  @ApiResponse({ status: 200 })
  report(
    @Param() params: RevisionParamDto,
    @CurrentUser() principal: RequestPrincipal,
  ): Promise<DownloadAuthorizationView> {
    return this.downloads.forSubmitter(principal.userId, params.revisionId, 'report');
  }
}
