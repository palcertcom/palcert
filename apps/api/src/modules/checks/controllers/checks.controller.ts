import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { ApiCookieAuth, ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import {
  AppError,
  PalCertErrorCode,
  Permission,
  type CheckReportMetadataView,
  type CheckRuleResultView,
  type DocumentCheckView,
  type Page,
} from '@palcert/contracts';
import type { Response } from 'express';
import {
  requestIdOf,
  type AuthenticatedRequest,
  type RequestPrincipal,
} from '../../auth/authenticated-request';
import { CurrentUser, RequirePermissions } from '../../auth/decorators/auth.decorators';
import { CheckReadService } from '../services/check-read.service';
import { DocumentCheckService } from '../services/document-check.service';
import { PaidCheckSettlementService } from '../services/paid-check-settlement.service';
import {
  CheckCollectionQueryDto,
  CheckParamDto,
  CheckResultQueryDto,
  CreateCheckDto,
} from '../dto/checks.dto';

const IDEMPOTENCY_KEY_MAX_LENGTH = 128;

const IDEMPOTENCY_DOC = {
  name: 'Idempotency-Key',
  required: false,
  description:
    'Optional client-chosen key (at most 128 characters). Repeating the request with the same ' +
    'key returns the same check instead of starting another. Two deliberate checks of the same ' +
    'document against the same standard are legitimate and are never deduplicated.',
};

/**
 * A person's own compliance checks (§72–§80).
 *
 * Every route is scoped to the caller. No organization appears in any of them:
 * an institution publishing a standard gains no sight of who checked against
 * it, what they checked, or how it went (§57).
 *
 * Nothing here evaluates anything. Creating a check queues work and returns
 * immediately; the client follows the check's status rather than holding a
 * request open while a document is analyzed and hundreds of rules are run
 * (§29, §123).
 */
@ApiTags('checks')
@ApiCookieAuth()
@Controller('checks')
export class ChecksController {
  constructor(
    private readonly checks: DocumentCheckService,
    private readonly reads: CheckReadService,
    private readonly settlement: PaidCheckSettlementService,
  ) {}

  @Post()
  @RequirePermissions(Permission.CHECK_CREATE_SELF)
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiHeader(IDEMPOTENCY_DOC)
  @ApiOperation({
    summary: 'Start a check',
    description:
      'Reserves the quoted price from your PalCert Balance and queues the work, in one ' +
      'transaction. Binds the check to the exact document version and the standard version ' +
      'published at this moment. Returns 202 with the check in its initial state — the result ' +
      'is not ready yet. You are charged only when the report is successfully delivered; if ' +
      'PalCert cannot complete the check the reservation is released and nothing is charged.',
  })
  @ApiResponse({ status: 202 })
  @ApiResponse({ status: 402, description: 'INSUFFICIENT_BALANCE. Nothing was created.' })
  @ApiResponse({ status: 404, description: 'CHECK_STANDARD_NOT_AVAILABLE or QUOTE_NOT_FOUND' })
  @ApiResponse({
    status: 409,
    description: 'CHECK_DOCUMENT_NOT_READY, QUOTE_EXPIRED or QUOTE_ALREADY_USED',
  })
  @ApiResponse({ status: 415, description: 'CHECK_DOCUMENT_FORMAT_UNSUPPORTED' })
  @ApiResponse({
    status: 422,
    description:
      'IDEMPOTENCY_KEY_REUSED, QUOTE_PRODUCT_MISMATCH, or ' +
      'CHECK_STANDARD_NOT_SUPPORTED_FOR_FORMAT when none of the standard’s rules can be ' +
      'answered from this document’s format. Refused before the reservation, so nothing is ' +
      'reserved and nothing is charged — see the compatibility preview.',
  })
  async create(
    @Body() body: CreateCheckDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @CurrentUser() principal: RequestPrincipal,
    @Req() request: AuthenticatedRequest,
  ): Promise<DocumentCheckView> {
    const check = await this.checks.create(
      principal.userId,
      {
        documentVersionId: body.documentVersionId,
        standardId: body.standardId,
        priceQuoteId: body.priceQuoteId,
        idempotencyKey: idempotencyKeyOf(idempotencyKey),
      },
      contextOf(request),
    );
    return this.reads.get(principal.userId, check.id);
  }

  @Get()
  @RequirePermissions(Permission.CHECK_READ_SELF)
  @ApiOperation({
    summary: 'List your checks',
    description:
      'Newest first, cursor-paginated. `status` is processing state; `determination` is the ' +
      'compliance verdict. They are separate fields because a failed check has no verdict at ' +
      'all — it is not a failure to comply.',
  })
  @ApiResponse({ status: 200 })
  list(
    @Query() query: CheckCollectionQueryDto,
    @CurrentUser() principal: RequestPrincipal,
  ): Promise<Page<DocumentCheckView>> {
    return this.reads.list(principal.userId, query);
  }

  @Get(':checkId')
  @RequirePermissions(Permission.CHECK_READ_SELF)
  @ApiOperation({
    summary: 'One check',
    description:
      'Another person’s check id is not found, never forbidden: the difference would confirm ' +
      'the id exists.',
  })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 404, description: 'CHECK_NOT_FOUND' })
  get(
    @Param() params: CheckParamDto,
    @CurrentUser() principal: RequestPrincipal,
  ): Promise<DocumentCheckView> {
    return this.reads.get(principal.userId, params.checkId);
  }

  @Get(':checkId/results')
  @RequirePermissions(Permission.CHECK_READ_SELF)
  @ApiOperation({
    summary: 'Rule results for a completed check',
    description:
      'Worst first: blocking failures, then by severity, then the standard’s own order. Each ' +
      'result carries a bounded sample of its violations and the true total, so a page never ' +
      'pretends a truncated list is the whole story.',
  })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 404, description: 'REPORT_NOT_FOUND when no run has completed' })
  results(
    @Param() params: CheckParamDto,
    @Query() query: CheckResultQueryDto,
    @CurrentUser() principal: RequestPrincipal,
  ): Promise<Page<CheckRuleResultView>> {
    return this.reads.results(principal.userId, params.checkId, query);
  }

  @Get(':checkId/report')
  @RequirePermissions(Permission.CHECK_READ_SELF)
  @ApiOperation({
    summary: 'Report metadata and integrity hashes',
    description:
      'The identity of the stored machine report. No object key and no URL: the artifact is ' +
      'served through this API, never from a public bucket.',
  })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 404, description: 'REPORT_NOT_FOUND' })
  report(
    @Param() params: CheckParamDto,
    @CurrentUser() principal: RequestPrincipal,
  ): Promise<CheckReportMetadataView> {
    return this.reads.reportMetadata(principal.userId, params.checkId);
  }

  @Get(':checkId/report/artifact')
  @RequirePermissions(Permission.CHECK_READ_SELF)
  @Header('content-type', 'application/json')
  @Header('cache-control', 'private, no-store')
  @ApiOperation({
    summary: 'The immutable machine report',
    description:
      'The exact canonical bytes that were hashed, so anyone holding the report hash can verify ' +
      'it independently. Reading it never re-runs the rule engine.',
  })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 404, description: 'REPORT_NOT_FOUND' })
  async artifact(
    @Param() params: CheckParamDto,
    @CurrentUser() principal: RequestPrincipal,
    @Res() response: Response,
  ): Promise<void> {
    const { content } = await this.reads.reportArtifact(principal.userId, params.checkId);
    response.send(content);
  }

  @Post(':checkId/cancel')
  @RequirePermissions(Permission.CHECK_CREATE_SELF)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Cancel a check you no longer want',
    description:
      'Stops a check that has not yet produced a report and releases its reservation. Nothing ' +
      'is charged. A check that has already produced a report cannot be cancelled: the service ' +
      'was delivered.',
  })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 404, description: 'CHECK_NOT_FOUND' })
  @ApiResponse({ status: 409, description: 'SERVICE_ALREADY_DELIVERED' })
  async cancel(
    @Param() params: CheckParamDto,
    @CurrentUser() principal: RequestPrincipal,
    @Req() request: AuthenticatedRequest,
  ): Promise<DocumentCheckView> {
    await this.settlement.cancel(principal.userId, params.checkId, contextOf(request));
    return this.reads.get(principal.userId, params.checkId);
  }

  @Post(':checkId/retry')
  @RequirePermissions(Permission.CHECK_CREATE_SELF)
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Retry a failed check',
    description:
      'Starts a new run against the same captured document version and standard version. A ' +
      'completed check cannot be retried: its report is immutable, and a second opinion is a ' +
      'new check.',
  })
  @ApiResponse({ status: 202 })
  @ApiResponse({
    status: 409,
    description:
      'CHECK_ALREADY_COMPLETED, CHECK_NOT_RETRYABLE, or CHECK_RETRY_REQUIRES_NEW_PURCHASE for a ' +
      'paid check — no charge was made, and running it again is a new check at the current price.',
  })
  async retry(
    @Param() params: CheckParamDto,
    @CurrentUser() principal: RequestPrincipal,
    @Req() request: AuthenticatedRequest,
  ): Promise<DocumentCheckView> {
    await this.checks.retry(principal.userId, params.checkId, contextOf(request));
    return this.reads.get(principal.userId, params.checkId);
  }
}

function contextOf(request: AuthenticatedRequest): {
  requestId: string | null;
  ipAddress: string | null;
} {
  return { requestId: requestIdOf(request), ipAddress: request.ip ?? null };
}

function idempotencyKeyOf(header: string | undefined): string | undefined {
  if (header === undefined) return undefined;
  const key = header.trim();
  if (key.length === 0) return undefined;
  if (key.length > IDEMPOTENCY_KEY_MAX_LENGTH || !/^[\x21-\x7e]+$/.test(key)) {
    throw new AppError(PalCertErrorCode.VALIDATION_FAILED, {
      message: 'Idempotency-Key must be 1 to 128 printable ASCII characters.',
      details: { field: 'Idempotency-Key' },
    });
  }
  return key;
}
