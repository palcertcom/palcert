import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import { ApiCookieAuth, ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import {
  Permission,
  type CreateStandardSourceResponse,
  type DownloadAuthorizationView,
  type ExtractionProgressView,
  type OrganizationAIConsentView,
  type ProposalRejectionReason,
  type RuleExtractionRunView,
  type RuleProposalDetailView,
  type RuleProposalView,
  type RuleProvenanceView,
  type StandardSourceAuthority,
  type StandardSourceKind,
  type StandardSourceView,
  type StandardVersionExtractionCountersView,
} from '@palcert/contracts';
import { requestIdOf, type AuthenticatedRequest } from '../auth/authenticated-request';
import {
  OrganizationScoped,
  RequireOrganizationPermissions,
  Tenant,
} from '../organizations/decorators/tenant.decorators';
import type { TenantContext } from '../organizations/tenant-context';
import { IF_MATCH_HEADER, parseIfMatch } from '../standards/concurrency';
import {
  AcceptManyProposalsDto,
  AcceptProposalDto,
  CreateExtractionDto,
  CreateStandardSourceDto,
  ExtractionParamDto,
  ProposalParamDto,
  RejectManyProposalsDto,
  RejectProposalDto,
  RuleProvenanceParamDto,
  SourceParamDto,
  StandardVersionScopedParamDto,
} from './dto/extraction.dto';
import { OrganizationAIConsentService } from './services/organization-ai-consent.service';
import { RuleExtractionService } from './services/rule-extraction.service';
import { RuleProposalService } from './services/rule-proposal.service';
import { StandardSourceService } from './services/standard-source.service';

/**
 * Guideline sources, extraction and proposal review (§131, §132, §133).
 *
 * Every route names one task with one authorization. There is deliberately no
 * `POST /extract-anything` and no `POST /ask-claude`: a general-purpose model
 * endpoint would be a prompt-injection surface with no product behind it, and
 * an institution's guidelines are exactly the wrong thing to put behind one.
 *
 * Nothing here publishes. Publication remains the Phase 3 human action, behind
 * its own permission, and no route below leads to it.
 */
@ApiTags('rule-extraction')
@ApiCookieAuth()
@Controller('organizations/:organizationId')
export class ExtractionController {
  constructor(
    private readonly sources: StandardSourceService,
    private readonly consentService: OrganizationAIConsentService,
    private readonly extraction: RuleExtractionService,
    private readonly proposals: RuleProposalService,
  ) {}

  // -------------------------------------------------------------------------
  // Organization AI consent
  // -------------------------------------------------------------------------

  @Get('ai-consent')
  @OrganizationScoped()
  @RequireOrganizationPermissions(Permission.STANDARD_EXTRACTION_READ)
  @ApiOperation({
    summary: 'Whether the organization has agreed to external AI processing',
    description:
      'Rule extraction sends selected parts of the organization’s own guideline documents to an ' +
      'external AI provider. It is a separate agreement from any personal one a student gives ' +
      'about their own thesis, and neither implies the other.',
  })
  @ApiResponse({ status: 200 })
  consent(@Tenant() tenant: TenantContext): Promise<OrganizationAIConsentView> {
    return this.consentService.view(tenant);
  }

  @Post('ai-consent')
  @OrganizationScoped()
  @RequireOrganizationPermissions(Permission.ORGANIZATION_AI_CONSENT_MANAGE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Agree, for the organization, to external AI processing',
    description:
      'Held by owners and administrators. A template manager doing their job should not be able ' +
      'to accept external data-processing terms on the institution’s behalf.',
  })
  @ApiResponse({ status: 200 })
  acceptConsent(
    @Body() _body: Record<string, never>,
    @Tenant() tenant: TenantContext,
    @Req() request: AuthenticatedRequest,
  ): Promise<OrganizationAIConsentView> {
    return this.consentService.accept(tenant, contextOf(request));
  }

  @Delete('ai-consent')
  @OrganizationScoped()
  @RequireOrganizationPermissions(Permission.ORGANIZATION_AI_CONSENT_MANAGE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Withdraw the organization’s agreement',
    description: 'New extractions stop. Proposals already produced remain readable.',
  })
  @ApiResponse({ status: 200 })
  revokeConsent(
    @Tenant() tenant: TenantContext,
    @Req() request: AuthenticatedRequest,
  ): Promise<OrganizationAIConsentView> {
    return this.consentService.revoke(tenant, contextOf(request));
  }

  // -------------------------------------------------------------------------
  // Sources
  // -------------------------------------------------------------------------

  @Get('standard-versions/:versionId/sources')
  @OrganizationScoped()
  @RequireOrganizationPermissions(Permission.STANDARD_SOURCE_READ)
  @ApiOperation({ summary: 'The guideline and template sources of a standard version' })
  @ApiResponse({ status: 200 })
  listSources(
    @Param() params: StandardVersionScopedParamDto,
    @Tenant() tenant: TenantContext,
  ): Promise<StandardSourceView[]> {
    return this.sources.list(tenant, params.versionId);
  }

  @Post('standard-versions/:versionId/sources')
  @OrganizationScoped()
  @RequireOrganizationPermissions(Permission.STANDARD_SOURCE_CREATE)
  @HttpCode(HttpStatus.CREATED)
  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description: 'Repeating the request with the same key returns the same source.',
  })
  @ApiOperation({
    summary: 'Create a source and authorize its upload',
    description:
      'Returns a short-lived signed PUT. The file is validated, scanned and promoted by the same ' +
      'pipeline a student document goes through — an organization upload is not a weaker path.',
  })
  @ApiResponse({ status: 201 })
  @ApiResponse({ status: 409, description: 'STANDARD_SOURCE_VERSION_NOT_DRAFT' })
  @ApiResponse({ status: 422, description: 'STANDARD_SOURCE_LIMIT_EXCEEDED' })
  createSource(
    @Param() params: StandardVersionScopedParamDto,
    @Body() body: CreateStandardSourceDto,
    @Tenant() tenant: TenantContext,
    @Req() request: AuthenticatedRequest,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<CreateStandardSourceResponse> {
    return this.sources.create(
      tenant,
      params.versionId,
      {
        sourceKind: body.sourceKind as StandardSourceKind,
        originalFilename: body.originalFilename,
        declaredMimeType: body.declaredMimeType,
        sizeBytes: body.sizeBytes,
        sha256: body.sha256,
        authority: body.authority as StandardSourceAuthority | undefined,
        idempotencyKey: idempotencyKey?.slice(0, 128),
      },
      contextOf(request),
    );
  }

  @Get('standard-versions/:versionId/sources/:sourceId')
  @OrganizationScoped()
  @RequireOrganizationPermissions(Permission.STANDARD_SOURCE_READ)
  @ApiOperation({ summary: 'One source' })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 404, description: 'STANDARD_SOURCE_NOT_FOUND' })
  getSource(
    @Param() params: SourceParamDto,
    @Tenant() tenant: TenantContext,
  ): Promise<StandardSourceView> {
    return this.sources.get(tenant, params.versionId, params.sourceId);
  }

  @Post('standard-versions/:versionId/sources/:sourceId/finalize')
  @OrganizationScoped()
  @RequireOrganizationPermissions(Permission.STANDARD_SOURCE_CREATE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Finalize an upload and queue validation and scanning',
    description: 'Idempotent: a second call returns the current state and queues nothing.',
  })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 409, description: 'UPLOAD_OBJECT_NOT_FOUND' })
  finalizeSource(
    @Param() params: SourceParamDto,
    @Body() _body: Record<string, never>,
    @Tenant() tenant: TenantContext,
    @Req() request: AuthenticatedRequest,
  ): Promise<StandardSourceView> {
    return this.sources.finalize(tenant, params.versionId, params.sourceId, contextOf(request));
  }

  @Post('standard-versions/:versionId/sources/:sourceId/download-authorization')
  @OrganizationScoped()
  @RequireOrganizationPermissions(Permission.STANDARD_SOURCE_READ)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'A short-lived signed download for an authorized member',
    description:
      'Bound to the exact stored object version. Sources are never public and never served from ' +
      'a public URL.',
  })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 409, description: 'STANDARD_SOURCE_NOT_READY' })
  downloadSource(
    @Param() params: SourceParamDto,
    @Body() _body: Record<string, never>,
    @Tenant() tenant: TenantContext,
  ): Promise<DownloadAuthorizationView> {
    return this.sources.downloadAuthorization(tenant, params.versionId, params.sourceId);
  }

  @Delete('standard-versions/:versionId/sources/:sourceId')
  @OrganizationScoped()
  @RequireOrganizationPermissions(Permission.STANDARD_SOURCE_DELETE)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Remove a source nothing depends on',
    description:
      'Refused once an accepted rule cites it: an explanation pointing at a missing file is not ' +
      'an explanation.',
  })
  @ApiResponse({ status: 204 })
  @ApiResponse({ status: 409, description: 'STANDARD_SOURCE_RETENTION_LOCKED' })
  async deleteSource(
    @Param() params: SourceParamDto,
    @Tenant() tenant: TenantContext,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    await this.sources.remove(tenant, params.versionId, params.sourceId, contextOf(request));
  }

  // -------------------------------------------------------------------------
  // Extraction runs
  // -------------------------------------------------------------------------

  @Post('standard-versions/:versionId/extractions')
  @OrganizationScoped()
  @RequireOrganizationPermissions(Permission.STANDARD_EXTRACTION_RUN)
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  @ApiOperation({
    summary: 'Read the sources and propose rules',
    description:
      'Binds the exact sources and their digests, reserves the quoted AI_RULE_EXTRACTION fee ' +
      'from the CALLER’S own PalCert Balance (never the organization’s; no role is exempt), ' +
      'then queues the work. Returns 202: the ' +
      'proposals do not exist yet. Nothing it produces changes the standard — every proposal ' +
      'waits for a person to accept or reject it.',
  })
  @ApiResponse({ status: 202 })
  @ApiResponse({
    status: 402,
    description: 'INSUFFICIENT_BALANCE — nothing was reserved or queued',
  })
  @ApiResponse({ status: 403, description: 'ORGANIZATION_AI_CONSENT_REQUIRED' })
  @ApiResponse({
    status: 409,
    description:
      'EXTRACTION_NO_USABLE_SOURCES, EXTRACTION_ALREADY_RUNNING, QUOTE_EXPIRED, ' +
      'QUOTE_ALREADY_USED or QUOTE_PRODUCT_MISMATCH',
  })
  @ApiResponse({ status: 503, description: 'AI_DISABLED' })
  createExtraction(
    @Param() params: StandardVersionScopedParamDto,
    @Body() body: CreateExtractionDto,
    @Tenant() tenant: TenantContext,
    @Req() request: AuthenticatedRequest,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<RuleExtractionRunView> {
    return this.extraction.create(
      tenant,
      params.versionId,
      {
        sourceAssetIds: body.sourceAssetIds,
        priceQuoteId: body.priceQuoteId,
        idempotencyKey: idempotencyKey?.slice(0, 128),
      },
      contextOf(request),
    );
  }

  @Get('standard-versions/:versionId/extractions')
  @OrganizationScoped()
  @RequireOrganizationPermissions(Permission.STANDARD_EXTRACTION_READ)
  @ApiOperation({
    summary: 'The extraction history of a standard version',
    description: 'Newest first. A later run never rewrites an earlier one.',
  })
  @ApiResponse({ status: 200 })
  listExtractions(
    @Param() params: StandardVersionScopedParamDto,
    @Tenant() tenant: TenantContext,
  ): Promise<RuleExtractionRunView[]> {
    return this.proposals.listRuns(tenant, params.versionId);
  }

  @Get('standard-versions/:versionId/extractions/:runId')
  @OrganizationScoped()
  @RequireOrganizationPermissions(Permission.STANDARD_EXTRACTION_READ)
  @ApiOperation({ summary: 'One extraction run' })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 404, description: 'EXTRACTION_RUN_NOT_FOUND' })
  getExtraction(
    @Param() params: ExtractionParamDto,
    @Tenant() tenant: TenantContext,
  ): Promise<RuleExtractionRunView> {
    return this.proposals.getRun(tenant, params.versionId, params.runId);
  }

  @Get('standard-versions/:versionId/extractions/:runId/progress')
  @OrganizationScoped()
  @RequireOrganizationPermissions(Permission.STANDARD_EXTRACTION_READ)
  @ApiOperation({
    summary: 'Where a running extraction has got to',
    description:
      'Small enough to poll. Derived entirely from what the run has stored — its status, the ' +
      'provider calls it has made and the evidence it has saved — so a reload reads the same ' +
      'answer, and a total that is not known yet is null rather than estimated.',
  })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 404, description: 'EXTRACTION_RUN_NOT_FOUND' })
  extractionProgress(
    @Param() params: ExtractionParamDto,
    @Tenant() tenant: TenantContext,
  ): Promise<ExtractionProgressView> {
    return this.proposals.progress(tenant, params.versionId, params.runId);
  }

  @Post('standard-versions/:versionId/extractions/:runId/cancel')
  @OrganizationScoped()
  @RequireOrganizationPermissions(Permission.STANDARD_EXTRACTION_RUN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Cancel a queued extraction',
    description:
      'Only before the work reaches the provider. PalCert does not claim to recall a request it ' +
      'has already sent.',
  })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 409, description: 'EXTRACTION_NOT_CANCELLABLE' })
  cancelExtraction(
    @Param() params: ExtractionParamDto,
    @Body() _body: Record<string, never>,
    @Tenant() tenant: TenantContext,
    @Req() request: AuthenticatedRequest,
  ): Promise<RuleExtractionRunView> {
    return this.extraction.cancel(tenant, params.versionId, params.runId, contextOf(request));
  }

  // -------------------------------------------------------------------------
  // Proposals
  // -------------------------------------------------------------------------

  @Get('standard-versions/:versionId/extractions/:runId/proposals')
  @OrganizationScoped()
  @RequireOrganizationPermissions(Permission.STANDARD_PROPOSAL_REVIEW)
  @ApiOperation({
    summary: 'The proposals an extraction produced',
    description:
      'Each carries its kind, PalCert’s own validation verdict, whether PalCert can measure it ' +
      'today, and any conflict — so a reviewer can see what they are deciding about.',
  })
  @ApiResponse({ status: 200 })
  listProposals(
    @Param() params: ExtractionParamDto,
    @Tenant() tenant: TenantContext,
  ): Promise<RuleProposalView[]> {
    return this.proposals.listProposals(tenant, params.versionId, params.runId);
  }

  @Get('standard-versions/:versionId/extractions/:runId/proposals/:proposalId')
  @OrganizationScoped()
  @RequireOrganizationPermissions(Permission.STANDARD_PROPOSAL_REVIEW)
  @ApiOperation({
    summary: 'One proposal with the evidence it rests on',
    description: 'The cited excerpt and its location, beside the suggested rule.',
  })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 404, description: 'RULE_PROPOSAL_NOT_FOUND' })
  getProposal(
    @Param() params: ProposalParamDto,
    @Tenant() tenant: TenantContext,
  ): Promise<RuleProposalDetailView> {
    return this.proposals.getProposal(tenant, params.versionId, params.runId, params.proposalId);
  }

  @Post('standard-versions/:versionId/extractions/:runId/proposals/:proposalId/accept')
  @OrganizationScoped()
  @RequireOrganizationPermissions(Permission.STANDARD_PROPOSAL_DECIDE)
  @HttpCode(HttpStatus.OK)
  @ApiHeader({
    name: IF_MATCH_HEADER,
    required: true,
    description:
      'The draft revision the reviewer was looking at. A draft that moved under them is refused ' +
      'rather than silently decided against a view nobody saw.',
  })
  @ApiOperation({
    summary: 'Accept a proposal, as proposed or as edited',
    description:
      'Creates an ordinary draft rule through the ordinary Phase 3 path, with the ordinary ' +
      'validation. An edit is recorded on the decision; the AI proposal is never rewritten.',
  })
  @ApiResponse({ status: 200 })
  @ApiResponse({
    status: 409,
    description: 'STALE_STANDARD_REVISION or RULE_PROPOSAL_ALREADY_DECIDED',
  })
  accept(
    @Param() params: ProposalParamDto,
    @Body() body: AcceptProposalDto,
    @Tenant() tenant: TenantContext,
    @Req() request: AuthenticatedRequest,
    @Headers(IF_MATCH_HEADER) ifMatch?: string,
  ): Promise<RuleProposalView> {
    return this.proposals.accept(
      tenant,
      params.versionId,
      params.runId,
      params.proposalId,
      {
        expectedRevision: parseIfMatch(ifMatch),
        rule: body.rule,
        origin: body.origin,
        reviewNotes: body.reviewNotes,
      },
      contextOf(request),
    );
  }

  @Post('standard-versions/:versionId/extractions/:runId/proposals/:proposalId/reject')
  @OrganizationScoped()
  @RequireOrganizationPermissions(Permission.STANDARD_PROPOSAL_DECIDE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Reject a proposal',
    description:
      'The reason is kept inside PalCert for product improvement. Nothing is sent back to the ' +
      'provider, and no model is trained on it.',
  })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 409, description: 'RULE_PROPOSAL_ALREADY_DECIDED' })
  reject(
    @Param() params: ProposalParamDto,
    @Body() body: RejectProposalDto,
    @Tenant() tenant: TenantContext,
    @Req() request: AuthenticatedRequest,
  ): Promise<RuleProposalView> {
    return this.proposals.reject(
      tenant,
      params.versionId,
      params.runId,
      params.proposalId,
      {
        reason: body.reason as ProposalRejectionReason | undefined,
        reviewNotes: body.reviewNotes,
      },
      contextOf(request),
    );
  }

  @Post('standard-versions/:versionId/extractions/:runId/proposals/accept-selected')
  @OrganizationScoped()
  @RequireOrganizationPermissions(Permission.STANDARD_PROPOSAL_DECIDE)
  @HttpCode(HttpStatus.OK)
  @ApiHeader({ name: IF_MATCH_HEADER, required: true })
  @ApiOperation({
    summary: 'Accept several named proposals',
    description:
      'An explicit human action over an explicit list; nothing is ever accepted automatically. ' +
      'Each is accepted through the same path and audited separately, and anything that would ' +
      'have been refused individually is skipped with its reason.',
  })
  @ApiResponse({ status: 200 })
  acceptSelected(
    @Param() params: ExtractionParamDto,
    @Body() body: AcceptManyProposalsDto,
    @Tenant() tenant: TenantContext,
    @Req() request: AuthenticatedRequest,
    @Headers(IF_MATCH_HEADER) ifMatch?: string,
  ): Promise<{ accepted: string[]; skipped: { id: string; reason: string }[] }> {
    return this.proposals.acceptMany(
      tenant,
      params.versionId,
      params.runId,
      body.proposalIds,
      parseIfMatch(ifMatch),
      contextOf(request),
    );
  }

  @Post('standard-versions/:versionId/extractions/:runId/proposals/reject-selected')
  @OrganizationScoped()
  @RequireOrganizationPermissions(Permission.STANDARD_PROPOSAL_DECIDE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Reject several named proposals',
    description:
      'One transaction over an explicit list. Each rejection gets its own decision and audit ' +
      'event, as an individual one would. Anything already decided is skipped, so repeating the ' +
      'request changes nothing.',
  })
  @ApiResponse({ status: 200 })
  rejectSelected(
    @Param() params: ExtractionParamDto,
    @Body() body: RejectManyProposalsDto,
    @Tenant() tenant: TenantContext,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ rejected: string[]; skipped: { id: string; reason: string }[] }> {
    return this.proposals.rejectMany(
      tenant,
      params.versionId,
      params.runId,
      body.proposalIds,
      {
        reason: body.reason as ProposalRejectionReason | undefined,
        reviewNotes: body.reviewNotes,
      },
      contextOf(request),
    );
  }

  // -------------------------------------------------------------------------
  // Provenance and counters
  // -------------------------------------------------------------------------

  @Get('standard-versions/:versionId/rules/:ruleId/provenance')
  @OrganizationScoped()
  @RequireOrganizationPermissions(Permission.STANDARD_EXTRACTION_READ)
  @ApiOperation({
    summary: 'Where an accepted rule came from',
    description:
      'The source, its digest, and the page or node the requirement was quoted from. Provenance ' +
      'metadata only: it is not part of the standard’s canonical content and changes no hash.',
  })
  @ApiResponse({ status: 200 })
  provenance(
    @Param() params: RuleProvenanceParamDto,
    @Tenant() tenant: TenantContext,
  ): Promise<RuleProvenanceView[]> {
    return this.proposals.provenanceForRule(tenant, params.versionId, params.ruleId);
  }

  @Get('standard-versions/:versionId/extraction-counters')
  @OrganizationScoped()
  @RequireOrganizationPermissions(Permission.STANDARD_EXTRACTION_READ)
  @ApiOperation({ summary: 'Source, run and proposal counts for a standard version' })
  @ApiResponse({ status: 200 })
  counters(
    @Param() params: StandardVersionScopedParamDto,
    @Tenant() tenant: TenantContext,
  ): Promise<StandardVersionExtractionCountersView> {
    return this.proposals.counters(tenant, params.versionId);
  }
}

function contextOf(request: AuthenticatedRequest): {
  requestId: string | null;
  ipAddress: string | null;
} {
  return { requestId: requestIdOf(request), ipAddress: request.ip ?? null };
}
