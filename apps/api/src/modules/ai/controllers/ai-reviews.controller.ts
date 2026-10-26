import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import { ApiCookieAuth, ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import {
  AppError,
  PalCertErrorCode,
  Permission,
  type AIConsentView,
  type AIReportSupplementView,
  type AIReviewView,
  type AIRuleAssessmentView,
} from '@palcert/contracts';
import {
  requestIdOf,
  type AuthenticatedRequest,
  type RequestPrincipal,
} from '../../auth/authenticated-request';
import { CurrentUser, RequirePermissions } from '../../auth/decorators/auth.decorators';
import { AIConsentService } from '../services/ai-consent.service';
import { AIReviewReadService } from '../services/ai-review-read.service';
import { AIReviewService } from '../services/ai-review.service';
import { AIReviewParamDto, CheckParamDto, CreateAIReviewDto } from '../dto/ai.dto';

const IDEMPOTENCY_KEY_MAX_LENGTH = 128;

/**
 * AI review of a completed check (§82, §83).
 *
 * Every route is scoped to the caller and to one of their own checks. There is
 * deliberately no general-purpose AI endpoint: each task here has a named
 * PalCert purpose, a fixed prompt, a schema-constrained output and its own
 * validation. An endpoint that simply forwarded text to a model would be a
 * prompt-injection surface with no product behind it (§83).
 *
 * The deterministic report is unaffected by anything in this controller. If
 * the provider is unavailable, these routes say so and the Phase 7 report
 * keeps working exactly as before (§105).
 */
@ApiTags('ai')
@ApiCookieAuth()
@Controller()
export class AIReviewsController {
  constructor(
    private readonly reviews: AIReviewService,
    private readonly reads: AIReviewReadService,
    private readonly consent: AIConsentService,
  ) {}

  @Get('ai/consent')
  @RequirePermissions(Permission.AI_REVIEW_READ_SELF)
  @ApiOperation({
    summary: 'Whether you have agreed to external AI processing',
    description:
      'AI review sends selected parts of your document to an external AI provider configured by ' +
      'PalCert. It runs only after you agree, and the version of the notice you agreed to is ' +
      'recorded — a changed notice needs a fresh agreement.',
  })
  @ApiResponse({ status: 200 })
  consentStatus(@CurrentUser() principal: RequestPrincipal): Promise<AIConsentView> {
    return this.consent.view(principal.userId);
  }

  @Post('ai/consent')
  @RequirePermissions(Permission.AI_REVIEW_CREATE_SELF)
  @ApiOperation({
    summary: 'Agree to external AI processing',
    description:
      'Records your agreement, its version, and the category of provider. An organization can ' +
      'never grant this on your behalf.',
  })
  @ApiResponse({ status: 200 })
  grantConsent(
    @CurrentUser() principal: RequestPrincipal,
    @Req() request: AuthenticatedRequest,
  ): Promise<AIConsentView> {
    return this.consent.grant(principal.userId, contextOf(request));
  }

  @Delete('ai/consent')
  @RequirePermissions(Permission.AI_REVIEW_CREATE_SELF)
  @ApiOperation({
    summary: 'Withdraw your agreement to external AI processing',
    description: 'New AI reviews stop. Reviews already produced remain readable.',
  })
  @ApiResponse({ status: 200 })
  withdrawConsent(
    @CurrentUser() principal: RequestPrincipal,
    @Req() request: AuthenticatedRequest,
  ): Promise<AIConsentView> {
    return this.consent.withdraw(principal.userId, contextOf(request));
  }

  @Post('checks/:checkId/ai-reviews')
  @RequirePermissions(Permission.AI_REVIEW_CREATE_SELF)
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiHeader({
    name: 'Idempotency-Key',
    required: false,
    description:
      'Optional client-chosen key (at most 128 characters). Repeating the request with the same ' +
      'key returns the same review instead of calling the provider again. Two deliberate ' +
      'reviews — a different model or a later prompt — are legitimate and are never deduplicated.',
  })
  @ApiOperation({
    summary: 'Start an AI review of a completed check',
    description:
      'Binds the review to the exact report, analysis, document version and standard version the ' +
      'check recorded, reserves the quoted AI_REVIEW fee from your PalCert Balance (charged ' +
      'only when the review COMPLETES, released if it fails or is cancelled), and queues the ' +
      'work. Returns 202: the assessment is not ready yet. ' +
      'The deterministic report is never modified by this or any later step.',
  })
  @ApiResponse({ status: 202 })
  @ApiResponse({
    status: 402,
    description: 'INSUFFICIENT_BALANCE — nothing was reserved or queued',
  })
  @ApiResponse({ status: 403, description: 'AI_CONSENT_REQUIRED' })
  @ApiResponse({
    status: 409,
    description:
      'AI_REVIEW_CHECK_NOT_COMPLETED, AI_REVIEW_NO_ASSESSABLE_RULES, QUOTE_EXPIRED, ' +
      'QUOTE_ALREADY_USED or QUOTE_PRODUCT_MISMATCH',
  })
  @ApiResponse({ status: 503, description: 'AI_DISABLED' })
  async create(
    @Param() params: CheckParamDto,
    @Body() body: CreateAIReviewDto,
    @CurrentUser() principal: RequestPrincipal,
    @Req() request: AuthenticatedRequest,
  ): Promise<AIReviewView> {
    const header = request.headers['idempotency-key'];
    const review = await this.reviews.create(
      principal.userId,
      {
        checkId: params.checkId,
        priceQuoteId: body.priceQuoteId,
        idempotencyKey: idempotencyKeyOf(typeof header === 'string' ? header : undefined),
      },
      contextOf(request),
    );
    return this.reads.get(principal.userId, params.checkId, review.id);
  }

  @Get('checks/:checkId/ai-reviews')
  @RequirePermissions(Permission.AI_REVIEW_READ_SELF)
  @ApiOperation({
    summary: 'List the AI reviews of a check',
    description:
      'Newest first. A check may have several: a different model or prompt version produces a ' +
      'new review rather than replacing the old one, so earlier output stays identifiable.',
  })
  @ApiResponse({ status: 200 })
  list(
    @Param() params: CheckParamDto,
    @CurrentUser() principal: RequestPrincipal,
  ): Promise<AIReviewView[]> {
    return this.reads.list(principal.userId, params.checkId);
  }

  @Get('checks/:checkId/ai-reviews/:reviewId')
  @RequirePermissions(Permission.AI_REVIEW_READ_SELF)
  @ApiOperation({ summary: 'One AI review' })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 404, description: 'AI_REVIEW_NOT_FOUND' })
  get(
    @Param() params: AIReviewParamDto,
    @CurrentUser() principal: RequestPrincipal,
  ): Promise<AIReviewView> {
    return this.reads.get(principal.userId, params.checkId, params.reviewId);
  }

  @Get('checks/:checkId/ai-reviews/:reviewId/assessments')
  @RequirePermissions(Permission.AI_REVIEW_READ_SELF)
  @ApiOperation({
    summary: 'Advisory per-rule AI assessments',
    description:
      'Each assessment carries the deterministic outcome for the same rule beside it, and its own ' +
      '`requiresHumanReview` flag. A blocking AI-assisted requirement always requires a person, ' +
      'whatever the AI concluded — the AI never decides compliance.',
  })
  @ApiResponse({ status: 200 })
  assessments(
    @Param() params: AIReviewParamDto,
    @CurrentUser() principal: RequestPrincipal,
  ): Promise<AIRuleAssessmentView[]> {
    return this.reads.assessments(principal.userId, params.checkId, params.reviewId);
  }

  @Get('checks/:checkId/ai-reviews/:reviewId/supplement')
  @RequirePermissions(Permission.AI_REVIEW_READ_SELF)
  @ApiOperation({
    summary: 'The AI explanation and recommendations',
    description:
      'A plain-language summary of the technical report and what to do next. It contains no ' +
      'score, no determination and no statement of approval, acceptance or certification.',
  })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 404, description: 'AI_REVIEW_NOT_FOUND' })
  supplement(
    @Param() params: AIReviewParamDto,
    @CurrentUser() principal: RequestPrincipal,
  ): Promise<AIReportSupplementView> {
    return this.reads.supplement(principal.userId, params.checkId, params.reviewId);
  }

  @Post('checks/:checkId/ai-reviews/:reviewId/cancel')
  @RequirePermissions(Permission.AI_REVIEW_CREATE_SELF)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Cancel a queued AI review',
    description:
      'Only before the work reaches the provider. PalCert does not claim to recall a request ' +
      'already being processed.',
  })
  @ApiResponse({ status: 200 })
  @ApiResponse({ status: 409, description: 'AI_REVIEW_NOT_CANCELLABLE' })
  async cancel(
    @Param() params: AIReviewParamDto,
    @CurrentUser() principal: RequestPrincipal,
    @Req() request: AuthenticatedRequest,
  ): Promise<AIReviewView> {
    await this.reviews.cancel(principal.userId, params.reviewId, contextOf(request));
    return this.reads.get(principal.userId, params.checkId, params.reviewId);
  }

  // Deliberately absent: any route that forwards arbitrary text to the model.
  // Every AI task in PalCert has a defined purpose and contract (§83).
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
