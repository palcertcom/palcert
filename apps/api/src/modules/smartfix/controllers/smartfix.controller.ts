import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Req } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Permission } from '@palcert/contracts';
import {
  requestIdOf,
  type AuthenticatedRequest,
  type RequestPrincipal,
} from '../../auth/authenticated-request';
import { CurrentUser, RequirePermissions } from '../../auth/decorators/auth.decorators';
import {
  CheckParamDto,
  PlanParamDto,
  SmartFixRequestParamDto,
  StartSmartFixDto,
} from '../dto/smartfix.dto';
import { SmartFixPlanService } from '../services/smartfix-plan.service';
import {
  SmartFixReadService,
  type SmartFixManifestView,
  type SmartFixPlanView,
  type SmartFixRequestView,
} from '../services/smartfix-read.service';
import { SmartFixRequestService } from '../services/smartfix-request.service';

/**
 * SmartFix (Phase 12).
 *
 * Every route is scoped to the caller, and no organization appears in any of
 * them: an institution publishing a standard gains no sight of whose documents
 * were corrected against it, and no ability to correct one.
 *
 * The shape of the API is the shape of the promise. `POST /plan` is free and
 * returns the complete list of changes. `POST /requests` is the only route
 * that costs anything, and it executes the plan the user just read — not a
 * fresh one computed at that moment.
 */
@ApiTags('smartfix')
@ApiCookieAuth()
@Controller('smartfix')
export class SmartFixController {
  constructor(
    private readonly plans: SmartFixPlanService,
    private readonly requests: SmartFixRequestService,
    private readonly reads: SmartFixReadService,
  ) {}

  @Post('checks/:checkId/plan')
  @RequirePermissions(Permission.SMARTFIX_CREATE_SELF)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Plan a correction',
    description:
      'Free. Reads the completed check and returns exactly what SmartFix would change, rule by ' +
      'rule, including every rule it will not touch and why. Nothing is reserved and nothing is ' +
      'charged. The plan is bound to this document and these rules and expires, because both ' +
      'move on.',
  })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 404, description: 'CHECK_NOT_FOUND' })
  @ApiResponse({
    status: 409,
    description: 'SMARTFIX_NOT_AVAILABLE — not finished, not a Word document, or no report',
  })
  async plan(
    @Param() params: CheckParamDto,
    @CurrentUser() principal: RequestPrincipal,
    @Req() request: AuthenticatedRequest,
  ): Promise<SmartFixPlanView> {
    const plan = await this.plans.plan(principal.userId, params.checkId, contextOf(request));
    const artifact = await this.plans.artifact(principal.userId, plan.id);
    return this.reads.plan(principal.userId, plan.id, artifact.plan);
  }

  @Get('plans/:planId')
  @RequirePermissions(Permission.SMARTFIX_READ_SELF)
  @ApiOperation({
    summary: 'One correction plan',
    description:
      'Another person’s plan id is not found, never forbidden: the difference would confirm ' +
      'the id exists.',
  })
  @ApiResponse({ status: 200 })
  async readPlan(
    @Param() params: PlanParamDto,
    @CurrentUser() principal: RequestPrincipal,
  ): Promise<SmartFixPlanView> {
    const artifact = await this.plans.artifact(principal.userId, params.planId);
    return this.reads.plan(principal.userId, params.planId, artifact.plan);
  }

  @Post('requests')
  @RequirePermissions(Permission.SMARTFIX_CREATE_SELF)
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Buy and start a correction',
    description:
      'Reserves the quoted price from your PalCert Balance and queues the work, in one ' +
      'transaction. PalCert corrects a *copy*: your original document is never modified. You ' +
      'are charged only when the corrected document, its change manifest and a successful ' +
      'recheck are all ready; if anything fails the reservation is released and nothing is ' +
      'charged.',
  })
  @ApiResponse({ status: 202 })
  @ApiResponse({ status: 402, description: 'INSUFFICIENT_BALANCE. Nothing was created.' })
  @ApiResponse({ status: 404, description: 'NOT_FOUND or QUOTE_NOT_FOUND' })
  @ApiResponse({
    status: 409,
    description: 'SMARTFIX_NOT_AVAILABLE, QUOTE_EXPIRED or QUOTE_ALREADY_USED',
  })
  async start(
    @Body() body: StartSmartFixDto,
    @CurrentUser() principal: RequestPrincipal,
    @Req() request: AuthenticatedRequest,
  ): Promise<SmartFixRequestView> {
    const created = await this.requests.start(
      principal.userId,
      { planId: body.planId, priceQuoteId: body.priceQuoteId },
      contextOf(request),
    );
    return this.reads.request(principal.userId, created.id);
  }

  @Get('requests/:smartFixRequestId')
  @RequirePermissions(Permission.SMARTFIX_READ_SELF)
  @ApiOperation({
    summary: 'One correction',
    description:
      'The corrected document appears only once the correction is delivered: before that it ' +
      'exists but is not yours to reach, because it has not been paid for or proved.',
  })
  @ApiResponse({ status: 200 })
  readRequest(
    @Param() params: SmartFixRequestParamDto,
    @CurrentUser() principal: RequestPrincipal,
  ): Promise<SmartFixRequestView> {
    return this.reads.request(principal.userId, params.smartFixRequestId);
  }

  @Get('checks/:checkId/requests')
  @RequirePermissions(Permission.SMARTFIX_READ_SELF)
  @ApiOperation({ summary: 'Corrections of one check', description: 'Newest first.' })
  @ApiResponse({ status: 200 })
  listForCheck(
    @Param() params: CheckParamDto,
    @CurrentUser() principal: RequestPrincipal,
  ): Promise<readonly SmartFixRequestView[]> {
    return this.reads.requestsForCheck(principal.userId, params.checkId);
  }

  @Get('requests/:smartFixRequestId/manifest')
  @RequirePermissions(Permission.SMARTFIX_READ_SELF)
  @ApiOperation({
    summary: 'What the correction changed',
    description:
      'Every applied change, and the proof that the visible text, the media, the field ' +
      'instructions and the relationships are identical to the original.',
  })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 404, description: 'NOT_FOUND — no correction was applied' })
  async manifest(
    @Param() params: SmartFixRequestParamDto,
    @CurrentUser() principal: RequestPrincipal,
  ): Promise<SmartFixManifestView> {
    const artifact = await this.plans.manifestArtifact(principal.userId, params.smartFixRequestId);
    const entries = Array.isArray(artifact.entries)
      ? (artifact.entries as Record<string, unknown>[])
      : [];
    return this.reads.manifest(principal.userId, params.smartFixRequestId, entries);
  }

  @Post('requests/:smartFixRequestId/cancel')
  @RequirePermissions(Permission.SMARTFIX_CREATE_SELF)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Cancel a correction',
    description:
      'Releases the reservation and charges nothing. Refused once the recheck has finished: ' +
      'at that point the only questions left are whether to deliver and whether to charge.',
  })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 409, description: 'SMARTFIX_NOT_AVAILABLE — past the point of no return' })
  async cancel(
    @Param() params: SmartFixRequestParamDto,
    @CurrentUser() principal: RequestPrincipal,
    @Req() request: AuthenticatedRequest,
  ): Promise<SmartFixRequestView> {
    await this.requests.cancel(principal.userId, params.smartFixRequestId, contextOf(request));
    return this.reads.request(principal.userId, params.smartFixRequestId);
  }
}

function contextOf(request: AuthenticatedRequest): {
  requestId: string | null;
  ipAddress: string | null;
} {
  return { requestId: requestIdOf(request), ipAddress: request.ip ?? null };
}
