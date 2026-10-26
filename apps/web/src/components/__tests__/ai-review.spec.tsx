import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AIReviewSection } from '../ai-review';
import { getAIMessages } from '@/i18n/ai-messages';
import { getChecksMessages } from '@/i18n/checks-messages';
import type * as ApiClient from '@/lib/api-client';
import type {
  AIConsentResponse,
  AIReviewResponse,
  AIRuleAssessmentResponseView,
  AISupplementResponse,
} from '@/lib/api-client';

type ApiClientModule = typeof ApiClient;

const api = vi.hoisted(() => ({
  consent: vi.fn(),
  grantConsent: vi.fn(),
  withdrawConsent: vi.fn(),
  reviews: vi.fn(),
  startReview: vi.fn(),
  review: vi.fn(),
  assessments: vi.fn(),
  supplement: vi.fn(),
  cancelReview: vi.fn(),
}));

const balance = vi.hoisted(() => ({ quote: vi.fn(), balance: vi.fn() }));

vi.mock('@/lib/api-client', async () => {
  const actual = await vi.importActual<ApiClientModule>('@/lib/api-client');
  return { ...actual, aiApi: api, balanceApi: { ...actual.balanceApi, ...balance } };
});

const { ApiError } = await vi.importActual<ApiClientModule>('@/lib/api-client');

const en = getAIMessages('en');
const ar = getAIMessages('ar');
const checksEn = getChecksMessages('en');

function consent(overrides: Partial<AIConsentResponse> = {}): AIConsentResponse {
  return {
    granted: true,
    consentVersion: '1',
    consentedAt: '2026-09-01T09:00:00.000Z',
    providerCategory: 'EXTERNAL_LLM_API',
    renewalRequired: false,
    ...overrides,
  };
}

function review(overrides: Partial<AIReviewResponse> = {}): AIReviewResponse {
  return {
    id: 'rev-1',
    checkId: 'chk-1',
    status: 'COMPLETED',
    failureKind: null,
    provider: 'anthropic',
    configuredModel: 'configured-model-name',
    providerReturnedModel: 'returned-model-name',
    promptVersion: '1',
    contextBuilderVersion: '1',
    aiReviewSchemaVersion: 1,
    aiReviewHash: 'f'.repeat(64),
    assessmentCount: 1,
    humanReviewRequiredCount: 1,
    insufficientEvidenceCount: 0,
    contextTruncated: false,
    usage: {
      inputTokens: 1200,
      outputTokens: 300,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      invocationCount: 1,
    },
    createdAt: '2026-09-10T10:00:00.000Z',
    startedAt: '2026-09-10T10:00:01.000Z',
    completedAt: '2026-09-10T10:00:09.000Z',
    failedAt: null,
    ...overrides,
  };
}

function assessment(
  overrides: Partial<AIRuleAssessmentResponseView> = {},
): AIRuleAssessmentResponseView {
  return {
    id: 'a-1',
    ruleCode: 'ETHICS.STATEMENT',
    titleEn: 'Research ethics statement',
    titleAr: 'إقرار أخلاقيات البحث',
    severity: 'MAJOR',
    blocking: true,
    assessment: 'SATISFIED',
    reasonCode: 'EXPLICIT_STATEMENT_FOUND',
    evidenceSufficiency: 'SUFFICIENT',
    uncertaintyReasons: [],
    evidenceNodeIds: ['main/body/p:17'],
    explanationEn: 'A declaration naming the ethics committee appears in the front matter.',
    explanationAr: 'يظهر إقرار يذكر لجنة الأخلاقيات في المقدمات.',
    requiresHumanReview: true,
    deterministicOutcome: 'INDETERMINATE',
    ...overrides,
  };
}

const supplement: AISupplementResponse = {
  summaryEn: 'Two requirements need a person to read them before this is settled.',
  summaryAr: 'يحتاج متطلبان إلى قراءة بشرية قبل البتّ فيهما.',
  priorityRecommendations: [
    {
      priority: 'HIGH',
      relatedRuleCodes: ['ETHICS.STATEMENT'],
      textEn: 'Name the approving committee in the declaration.',
      textAr: 'اذكر اللجنة الموافِقة في الإقرار.',
    },
  ],
};

/** The common case: consent given, one completed review, one assessment. */
function completed(
  assessments: AIRuleAssessmentResponseView[] = [assessment()],
  overrides: Partial<AIReviewResponse> = {},
): void {
  api.consent.mockResolvedValue(consent());
  api.reviews.mockResolvedValue([review(overrides)]);
  api.assessments.mockResolvedValue(assessments);
  api.supplement.mockResolvedValue(supplement);
}

function priceOf(minorUnits: string) {
  return {
    id: 'quote-1',
    productCode: 'AI_REVIEW',
    amount: { currency: 'USD', minorUnits },
    createdAt: '2026-09-01T09:00:00.000Z',
    expiresAt: '2026-09-01T09:30:00.000Z',
    expired: false,
  };
}

function balanceOf(minorUnits: string) {
  const money = { currency: 'USD', minorUnits };
  return { currency: 'USD', available: money, reserved: money, cash: money, promotional: money };
}

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  api.supplement.mockResolvedValue(supplement);
  // ADR-0149: an AI review costs $0.50 here, and the balance covers it.
  balance.quote.mockReset().mockResolvedValue(priceOf('50'));
  balance.balance.mockReset().mockResolvedValue(balanceOf('1000'));
});

describe('AIReviewSection — consent (§14, §68)', () => {
  it('asks before anything is sent, and offers no review until it is given', async () => {
    api.consent.mockResolvedValue(consent({ granted: false, consentedAt: null }));
    api.reviews.mockResolvedValue([]);

    render(<AIReviewSection checkId="chk-1" locale="en" />);

    expect(await screen.findByText(en.consentTitle)).toBeInTheDocument();
    expect(screen.getByText(en.consentExplanation)).toBeInTheDocument();
    expect(screen.getByText(en.consentProviderNote)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: en.startReview })).not.toBeInTheDocument();
    expect(api.startReview).not.toHaveBeenCalled();
  });

  it('records agreement and then offers the review', async () => {
    api.consent.mockResolvedValue(consent({ granted: false, consentedAt: null }));
    api.reviews.mockResolvedValue([]);
    api.grantConsent.mockResolvedValue(consent());

    render(<AIReviewSection checkId="chk-1" locale="en" />);
    fireEvent.click(await screen.findByRole('button', { name: en.consentAgree }));

    await waitFor(() => expect(api.grantConsent).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole('button', { name: en.startReview })).toBeInTheDocument();
  });

  it('asks again when what PalCert sends has changed since the last agreement', async () => {
    // A consent version is only worth storing if a later version re-asks (§14).
    api.consent.mockResolvedValue(consent({ renewalRequired: true }));
    api.reviews.mockResolvedValue([]);

    render(<AIReviewSection checkId="chk-1" locale="en" />);

    expect(await screen.findByText(en.consentRenewalRequired)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: en.startReview })).not.toBeInTheDocument();
  });

  it('sends an idempotency key when starting, so a double click is one review', async () => {
    api.consent.mockResolvedValue(consent());
    api.reviews.mockResolvedValue([]);
    api.startReview.mockResolvedValue(review({ status: 'QUEUED', completedAt: null }));

    render(<AIReviewSection checkId="chk-1" locale="en" />);
    fireEvent.click(await screen.findByRole('button', { name: en.startReview }));

    await waitFor(() => expect(api.startReview).toHaveBeenCalledTimes(1));
    const [checkId, quoteId, key] = api.startReview.mock.calls[0]!;
    expect(checkId).toBe('chk-1');
    // The server's quote, never a client-stated price.
    expect(quoteId).toBe('quote-1');
    expect(key).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('AIReviewSection — the AI fee (ADR-0149)', () => {
  it('shows the fee and that it is charged only when the review completes', async () => {
    api.consent.mockResolvedValue(consent());
    api.reviews.mockResolvedValue([]);
    render(<AIReviewSection checkId="chk-1" locale="en" />);
    expect(await screen.findByText('AI service fee')).toBeInTheDocument();
    expect(screen.getByTestId('ai-fee-amount').textContent).toMatch(/0\.50/);
    expect(
      screen.getByText('Your balance will be charged when the AI service completes successfully.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: en.startReview })).toBeEnabled();
    // No internal product code leaks into the page.
    expect(document.body.textContent).not.toContain('AI_REVIEW');
  });

  it('blocks the start and offers Add balance when the balance is short', async () => {
    balance.balance.mockResolvedValue(balanceOf('10'));
    api.consent.mockResolvedValue(consent());
    api.reviews.mockResolvedValue([]);
    render(<AIReviewSection checkId="chk-1" locale="en" />);
    expect(await screen.findByText('Insufficient balance')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Add balance' })).toHaveAttribute(
      'href',
      '/en/balance/add',
    );
    expect(screen.getByRole('button', { name: en.startReview })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: en.startReview }));
    expect(api.startReview).not.toHaveBeenCalled();
  });

  it('says the service is unavailable when there is no active price', async () => {
    const { ApiError: Err } = await vi.importActual<ApiClientModule>('@/lib/api-client');
    balance.quote.mockRejectedValue(new Err('PRICE_NOT_AVAILABLE', 'no price', 409));
    api.consent.mockResolvedValue(consent());
    api.reviews.mockResolvedValue([]);
    render(<AIReviewSection checkId="chk-1" locale="en" />);
    expect(
      await screen.findByText(
        'This AI service is not currently available in your balance currency.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: en.startReview })).toBeDisabled();
  });

  it('says it all in Arabic', async () => {
    balance.balance.mockResolvedValue(balanceOf('10'));
    api.consent.mockResolvedValue(consent());
    api.reviews.mockResolvedValue([]);
    render(<AIReviewSection checkId="chk-1" locale="ar" />);
    expect(await screen.findByText('رسوم خدمة الذكاء الاصطناعي')).toBeInTheDocument();
    expect(
      screen.getByText('سيتم خصم الرسوم من رصيدك عند اكتمال خدمة الذكاء الاصطناعي بنجاح.'),
    ).toBeInTheDocument();
    expect(screen.getByText('الرصيد غير كافٍ')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'إضافة رصيد' })).toHaveAttribute(
      'href',
      '/ar/balance/add',
    );
  });
});

describe('AIReviewSection — an assessment is never a verdict (§26, §66)', () => {
  it('shows the machine status, the AI assessment and the final status as three lines', async () => {
    completed();
    render(<AIReviewSection checkId="chk-1" locale="en" />);

    expect(await screen.findByText(en.machineStatus)).toBeInTheDocument();
    expect(screen.getByText(en.aiAssessment)).toBeInTheDocument();
    expect(screen.getByText(en.finalStatus)).toBeInTheDocument();

    // The measured result is shown in Phase 7's own words, unchanged.
    expect(screen.getByText(checksEn.outcomes.INDETERMINATE!)).toBeInTheDocument();
    expect(screen.getByText(en.assessmentLabels.SATISFIED!)).toBeInTheDocument();
  });

  it('still requires human review for a blocking rule the AI thought was satisfied', async () => {
    // The whole point of the phase: an advisory SATISFIED does not clear a
    // blocking requirement, and the UI has to make that visible (§30).
    completed([assessment({ assessment: 'SATISFIED', blocking: true, requiresHumanReview: true })]);
    render(<AIReviewSection checkId="chk-1" locale="en" />);

    expect(await screen.findByText(en.humanReviewRequired)).toBeInTheDocument();
    expect(screen.queryByText(en.humanReviewNotRequired)).not.toBeInTheDocument();
  });

  it('renders assessments in words, never as raw enum values', async () => {
    completed([assessment({ assessment: 'NOT_SATISFIED', requiresHumanReview: false })]);
    render(<AIReviewSection checkId="chk-1" locale="en" />);

    expect(await screen.findByText(en.assessmentLabels.NOT_SATISFIED!)).toBeInTheDocument();
    expect(screen.queryByText('NOT_SATISFIED')).not.toBeInTheDocument();
  });

  it('does not carry the verdict in colour alone', async () => {
    // The class is styling; the label beside it is the actual signal (§80).
    completed([assessment({ assessment: 'NOT_SATISFIED' })]);
    render(<AIReviewSection checkId="chk-1" locale="en" />);

    const verdict = await screen.findByText(en.assessmentLabels.NOT_SATISFIED!);
    expect(verdict).toHaveClass('ai-verdict-not_satisfied');
    expect(verdict.textContent?.trim().length).toBeGreaterThan(0);
  });

  it('says when the supplied evidence could not settle the question', async () => {
    completed([
      assessment({
        assessment: 'INSUFFICIENT_EVIDENCE',
        evidenceSufficiency: 'INSUFFICIENT',
        evidenceNodeIds: [],
      }),
    ]);
    render(<AIReviewSection checkId="chk-1" locale="en" />);

    expect(await screen.findByText(en.assessmentLabels.INSUFFICIENT_EVIDENCE!)).toBeInTheDocument();
    expect(screen.getByText(en.evidenceInsufficient)).toBeInTheDocument();
  });

  it('cites the evidence the assessment was based on', async () => {
    completed();
    render(<AIReviewSection checkId="chk-1" locale="en" />);

    expect(
      await screen.findByText(`${en.evidence}: main/body/p:17`, { exact: false }),
    ).toBeInTheDocument();
  });

  it('says so when only part of the document was sent', async () => {
    completed([assessment()], { contextTruncated: true });
    render(<AIReviewSection checkId="chk-1" locale="en" />);

    expect(await screen.findByText(en.contextTruncated)).toBeInTheDocument();
  });
});

describe('AIReviewSection — disclosure and provenance (§67, §68)', () => {
  it('always shows the disclaimer and the not-an-approval note on a completed review', async () => {
    completed();
    render(<AIReviewSection checkId="chk-1" locale="en" />);

    expect(await screen.findByText(en.disclaimer)).toBeInTheDocument();
    expect(screen.getByText(en.notAnApproval)).toBeInTheDocument();
  });

  it('names the model that actually answered, not the configured one', async () => {
    // Provenance is the value the provider returned; a configured name can
    // drift from what served the request (§7).
    completed();
    render(<AIReviewSection checkId="chk-1" locale="en" />);

    expect(await screen.findByText('returned-model-name')).toBeInTheDocument();
    expect(screen.queryByText('configured-model-name')).not.toBeInTheDocument();
  });

  it('falls back to the configured model when the provider returned none', async () => {
    completed([assessment()], { providerReturnedModel: null });
    render(<AIReviewSection checkId="chk-1" locale="en" />);

    expect(await screen.findByText('configured-model-name')).toBeInTheDocument();
  });

  it('shows the AI review fingerprint, separately from any report hash', async () => {
    completed();
    render(<AIReviewSection checkId="chk-1" locale="en" />);

    expect(await screen.findByText('f'.repeat(64))).toBeInTheDocument();
    expect(screen.getByText(en.integrityLabel)).toBeInTheDocument();
  });

  it('shows the summary and prioritized recommendations when one was generated', async () => {
    completed();
    render(<AIReviewSection checkId="chk-1" locale="en" />);

    expect(await screen.findByText(supplement.summaryEn)).toBeInTheDocument();
    expect(screen.getByText(en.priorities.HIGH!)).toBeInTheDocument();
    expect(screen.getByText(supplement.priorityRecommendations[0]!.textEn)).toBeInTheDocument();
  });

  it('renders the assessments even when no supplement was produced', async () => {
    // Supplement generation is best-effort: losing it must not lose the
    // review it was summarizing (§39).
    completed();
    api.supplement.mockRejectedValue(new ApiError('AI_REVIEW_NOT_FOUND', 'none', 404));
    render(<AIReviewSection checkId="chk-1" locale="en" />);

    expect(await screen.findByText(en.assessmentLabels.SATISFIED!)).toBeInTheDocument();
    expect(screen.queryByText(en.summary)).not.toBeInTheDocument();
  });
});

describe('AIReviewSection — failure never touches the technical report (§57, §105)', () => {
  it('reports an unavailable AI layer in place, and asks for nothing', async () => {
    api.consent.mockRejectedValue(new ApiError('AI_DISABLED', 'disabled', 403));
    api.reviews.mockRejectedValue(new ApiError('AI_DISABLED', 'disabled', 403));

    render(<AIReviewSection checkId="chk-1" locale="en" />);

    expect(await screen.findByText(en.unavailable)).toBeInTheDocument();
    expect(screen.getByText(en.unavailableHint)).toBeInTheDocument();
    expect(screen.queryByText(en.consentTitle)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: en.startReview })).not.toBeInTheDocument();
  });

  it('offers a retry after a failed review, and says the report is unaffected', async () => {
    api.consent.mockResolvedValue(consent());
    api.reviews.mockResolvedValue([
      review({ status: 'FAILED', failureKind: 'OVERLOADED', completedAt: null }),
    ]);

    render(<AIReviewSection checkId="chk-1" locale="en" />);

    expect(await screen.findByText(en.reviewFailed)).toBeInTheDocument();
    expect(screen.getByText(en.reviewFailedHint)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: en.retry })).toBeInTheDocument();
    // A failure kind is operational vocabulary and stays out of the page.
    expect(screen.queryByText(/OVERLOADED/)).not.toBeInTheDocument();
  });

  it('translates a known error code and never shows a raw one', async () => {
    api.consent.mockResolvedValue(consent());
    api.reviews.mockResolvedValue([]);
    api.startReview.mockRejectedValue(
      new ApiError('AI_REVIEW_NO_ASSESSABLE_RULES', 'nothing to assess', 422),
    );

    render(<AIReviewSection checkId="chk-1" locale="en" />);
    fireEvent.click(await screen.findByRole('button', { name: en.startReview }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(en.errors.AI_REVIEW_NO_ASSESSABLE_RULES!);
    expect(alert.textContent).not.toMatch(/AI_REVIEW_NO_ASSESSABLE_RULES/);
  });

  it('announces a running review politely rather than blocking the page', async () => {
    api.consent.mockResolvedValue(consent());
    api.reviews.mockResolvedValue([review({ status: 'RUNNING', completedAt: null })]);
    api.review.mockResolvedValue(review({ status: 'RUNNING', completedAt: null }));

    render(<AIReviewSection checkId="chk-1" locale="en" />);

    const running = await screen.findByText(en.reviewRunning);
    expect(running).toHaveAttribute('aria-live', 'polite');
  });

  it('offers no cancel once the review has reached the provider', async () => {
    api.consent.mockResolvedValue(consent());
    api.reviews.mockResolvedValue([review({ status: 'RUNNING', completedAt: null })]);
    api.review.mockResolvedValue(review({ status: 'RUNNING', completedAt: null }));

    render(<AIReviewSection checkId="chk-1" locale="en" />);
    await screen.findByText(en.reviewRunning);
    expect(screen.queryByText(en.cancelReview)).toBeNull();
  });

  it('cancels a queued review and says nothing was sent', async () => {
    api.consent.mockResolvedValue(consent());
    api.reviews.mockResolvedValue([review({ status: 'QUEUED', completedAt: null })]);
    api.review.mockResolvedValue(review({ status: 'QUEUED', completedAt: null }));
    api.cancelReview.mockResolvedValue(review({ status: 'CANCELLED', completedAt: null }));

    render(<AIReviewSection checkId="chk-1" locale="en" />);
    fireEvent.click(await screen.findByText(en.cancelReview));
    await waitFor(() => {
      expect(api.cancelReview).toHaveBeenCalledWith('chk-1', 'rev-1');
    });
    expect(await screen.findByText(en.reviewCancelled)).toBeTruthy();
    expect(screen.queryByText(en.reviewRunning)).toBeNull();
    // A new review can be asked for after a cancellation.
    expect(screen.getByText(en.startReview)).toBeTruthy();
  });

  it('shows where the review really is when cancelling came too late', async () => {
    api.consent.mockResolvedValue(consent());
    api.reviews.mockResolvedValue([review({ status: 'QUEUED', completedAt: null })]);
    api.review.mockResolvedValue(review({ status: 'RUNNING', completedAt: null }));
    api.cancelReview.mockRejectedValue(
      new ApiError('AI_REVIEW_NOT_CANCELLABLE', 'not cancellable', 409),
    );

    render(<AIReviewSection checkId="chk-1" locale="en" />);
    fireEvent.click(await screen.findByText(en.cancelReview));
    expect(await screen.findByText(en.errors['AI_REVIEW_NOT_CANCELLABLE']!)).toBeTruthy();
    await waitFor(() => {
      expect(screen.queryByText(en.cancelReview)).toBeNull();
    });
  });

  it('points to the profile to change the AI agreement', async () => {
    completed();
    render(<AIReviewSection checkId="chk-1" locale="en" />);
    const link = await screen.findByRole('link', { name: en.manageConsent });
    expect(link).toHaveAttribute('href', '/en/profile#ai-consent');
  });
});

describe('AIReviewSection — Arabic (§89)', () => {
  it('renders the Arabic catalogue and the Arabic explanation, not a translated English one', async () => {
    completed();
    render(<AIReviewSection checkId="chk-1" locale="ar" />);

    expect(await screen.findByText(ar.sectionTitle)).toBeInTheDocument();
    expect(screen.getByText(ar.assessmentLabels.SATISFIED!)).toBeInTheDocument();
    expect(screen.getByText(ar.humanReviewRequired)).toBeInTheDocument();
    // The model wrote both languages; the page picks one, it does not machine
    // translate the other (§89).
    expect(screen.getByText(assessment().explanationAr)).toBeInTheDocument();
    expect(screen.queryByText(assessment().explanationEn)).not.toBeInTheDocument();
    expect(screen.getByText(supplement.summaryAr)).toBeInTheDocument();
  });
});
