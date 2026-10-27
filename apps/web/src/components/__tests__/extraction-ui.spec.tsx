import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ExtractionProgressPanel } from '../extraction-progress';
import { formatExpected, isReadyToAccept, RuleProposalList } from '../rule-proposals';
import { RuleProvenancePanel } from '../rule-provenance';
import { StandardSourcesPanel } from '../standard-sources';
import { getExtractionMessages } from '@/i18n/extraction-messages';
import { getReviewConsoleMessages } from '@/i18n/review-console-messages';
import { DOCUMENT_REJECTION_CODES } from '@palcert/contracts';
import type * as ApiClient from '@/lib/api-client';
import type {
  ExtractionProgressResponse,
  ExtractionRunResponse,
  OrganizationAIConsentResponse,
  RuleProposalDetailResponse,
  RuleProposalResponse,
  SourceEvidenceResponse,
  StandardSourceResponse,
  TemplateObservationResponse,
} from '@/lib/api-client';

type ApiClientModule = typeof ApiClient;
const { ApiError } = await vi.importActual<ApiClientModule>('@/lib/api-client');

const en = getExtractionMessages('en');
const ar = getExtractionMessages('ar');
const console_en = getReviewConsoleMessages('en');
const console_ar = getReviewConsoleMessages('ar');

const ORG = '11111111-1111-4111-8111-111111111111';
const VERSION = '22222222-2222-4222-8222-222222222222';
const RUN = '33333333-3333-4333-8333-333333333333';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function consent(overrides: Partial<OrganizationAIConsentResponse> = {}) {
  return {
    granted: true,
    consentVersion: '1',
    providerCategory: 'EXTERNAL_LLM_API',
    acceptedAt: '2026-09-01T09:00:00.000Z',
    acceptedByUserId: 'user-1',
    renewalRequired: false,
    ...overrides,
  } satisfies OrganizationAIConsentResponse;
}

function source(overrides: Partial<StandardSourceResponse> = {}) {
  return {
    id: 'source-1',
    standardVersionId: VERSION,
    sourceKind: 'GUIDELINE_PDF',
    status: 'READY',
    authority: 'PRIMARY',
    originalFilename: 'thesis-guidelines.pdf',
    declaredMimeType: 'application/pdf',
    detectedMimeType: 'application/pdf',
    detectedFormat: 'PDF',
    sizeBytes: 1024,
    sha256: 'a'.repeat(64),
    pageCount: 12,
    rejectionCode: null,
    failureCode: null,
    retryable: false,
    retentionLocked: false,
    uploadExpiresAt: null,
    uploadedByUserId: 'user-1',
    createdAt: '2026-09-01T09:00:00.000Z',
    readyAt: '2026-09-01T09:01:00.000Z',
    rejectedAt: null,
    failedAt: null,
    ...overrides,
  } satisfies StandardSourceResponse;
}

function run(overrides: Partial<ExtractionRunResponse> = {}) {
  return {
    id: RUN,
    standardVersionId: VERSION,
    status: 'COMPLETED',
    failureKind: null,
    baseStandardRevision: 3,
    provider: 'fake',
    configuredModel: 'test-model',
    providerReturnedModel: 'test-model',
    promptVersion: '1',
    contextBuilderVersion: '1',
    proposalSchemaVersion: 1,
    sourceSetHash: 'b'.repeat(64),
    extractionRunHash: 'c'.repeat(64),
    sourceAssetIds: ['source-1'],
    summary: {
      sourcesProcessed: 1,
      evidenceBlocks: 4,
      templateObservations: 2,
      explicitRequirementProposals: 2,
      templateInferenceProposals: 1,
      ambiguousRequirements: 1,
      conflictingRequirements: 2,
      unrepresentableRequirements: 1,
      invalidProposals: 0,
    },
    usage: { inputTokens: 100, outputTokens: 20, invocationCount: 2 },
    createdByUserId: 'user-1',
    createdAt: '2026-09-01T09:00:00.000Z',
    startedAt: '2026-09-01T09:00:01.000Z',
    completedAt: '2026-09-01T09:00:30.000Z',
    failedAt: null,
    ...overrides,
  } satisfies ExtractionRunResponse;
}

function proposal(overrides: Partial<RuleProposalResponse> = {}) {
  return {
    id: 'proposal-1',
    extractionRunId: RUN,
    proposalKey: 'p-1',
    kind: 'EXPLICIT_REQUIREMENT',
    status: 'PENDING_REVIEW',
    validationStatus: 'VALID',
    validationIssues: [],
    automationSupport: 'SUPPORTED_DOCX',
    conflict: {
      status: 'NONE',
      existingRuleId: null,
      existingRuleCode: null,
      relatedProposalIds: [],
      detail: null,
    },
    suggestedRule: { ruleCode: 'PAGE.MARGIN.LEFT' },
    suggestedRuleCode: 'PAGE.MARGIN.LEFT',
    interpretationEn: 'The left margin must be 30 mm.',
    interpretationAr: 'يجب أن يكون الهامش الأيسر ٣٠ مم.',
    ambiguityNote: null,
    requiresClarification: false,
    evidenceIds: ['evidence-1'],
    observationIds: [],
    displayOrder: 0,
    decision: null,
    ...overrides,
  } satisfies RuleProposalResponse;
}

function evidence(overrides: Partial<SourceEvidenceResponse> = {}) {
  return {
    id: 'evidence-1',
    sourceAssetId: 'source-1',
    sourceKind: 'GUIDELINE_PDF',
    sourceFilename: 'thesis-guidelines.pdf',
    evidenceKind: 'EXPLICIT_TEXT',
    locatorType: 'PDF_PAGE',
    startPage: 7,
    endPage: 7,
    nodeIds: [],
    startCharIndex: null,
    endCharIndex: null,
    excerpt: 'The left margin must be 30 mm on every page of the thesis.',
    excerptHash: 'd'.repeat(64),
    ...overrides,
  } satisfies SourceEvidenceResponse;
}

function observation(overrides: Partial<TemplateObservationResponse> = {}) {
  return {
    id: 'observation-1',
    sourceAssetId: 'source-2',
    sourceFilename: 'thesis-template.docx',
    scopeKey: 'ELEMENT:PARAGRAPH:fontSize',
    property: 'fontSize',
    unit: 'POINT',
    modalValue: '12',
    occurrenceCount: 196,
    matchingCount: 187,
    distinctValueCount: 3,
    uniformity: 'MOSTLY_UNIFORM',
    distribution: [
      { value: '12', count: 187 },
      { value: '11', count: 5 },
      { value: '14', count: 4 },
    ],
    observationHash: 'e'.repeat(64),
    ...overrides,
  } satisfies TemplateObservationResponse;
}

function detail(overrides: Partial<RuleProposalDetailResponse> = {}): RuleProposalDetailResponse {
  return { ...proposal(), evidence: [evidence()], observations: [], ...overrides };
}

function sourcesApi(overrides: Record<string, unknown> = {}) {
  return {
    consent: vi.fn().mockResolvedValue(consent()),
    grantConsent: vi.fn().mockResolvedValue(consent()),
    revokeConsent: vi.fn().mockResolvedValue(consent({ granted: false })),
    sources: vi.fn().mockResolvedValue([source()]),
    createSource: vi.fn(),
    finalizeSource: vi.fn(),
    source: vi.fn(),
    deleteSource: vi.fn().mockResolvedValue(undefined),
    sourceDownload: vi.fn(),
    runs: vi.fn().mockResolvedValue([]),
    startRun: vi.fn().mockResolvedValue(run({ status: 'QUEUED', summary: null })),
    run: vi.fn(),
    cancelRun: vi.fn(),
    ...overrides,
  } as unknown as NonNullable<Parameters<typeof StandardSourcesPanel>[0]['api']>;
}

function proposalsApi(overrides: Record<string, unknown> = {}) {
  return {
    proposals: vi.fn().mockResolvedValue([proposal()]),
    proposal: vi.fn().mockResolvedValue(detail()),
    acceptProposal: vi
      .fn()
      .mockResolvedValue({ data: proposal({ status: 'ACCEPTED' }), etag: '"4"' }),
    rejectProposal: vi.fn().mockResolvedValue(proposal({ status: 'REJECTED' })),
    acceptSelected: vi.fn().mockResolvedValue({ data: { accepted: [], skipped: [] }, etag: '"4"' }),
    rejectSelected: vi.fn().mockResolvedValue({ rejected: [], skipped: [] }),
    ...overrides,
  } as unknown as NonNullable<Parameters<typeof RuleProposalList>[0]['api']>;
}

/** ADR-0149: the AI fee and the member's balance; $2.00 against $20 unless a test says otherwise. */
function feeApi(available = '2000', price = '200') {
  return {
    quote: vi.fn().mockResolvedValue({
      id: 'quote-x',
      productCode: 'AI_RULE_EXTRACTION',
      amount: { currency: 'USD', minorUnits: price },
      createdAt: '2026-09-01T09:00:00.000Z',
      expiresAt: '2026-09-01T09:30:00.000Z',
      expired: false,
    }),
    balance: vi.fn().mockResolvedValue({
      currency: 'USD',
      available: { currency: 'USD', minorUnits: available },
    }),
  } as never;
}

function renderSources(props: Partial<Parameters<typeof StandardSourcesPanel>[0]> = {}) {
  return render(
    <StandardSourcesPanel
      organizationId={ORG}
      versionId={VERSION}
      locale="en"
      isDraft
      canManageSources
      canRunExtraction
      canManageConsent
      api={sourcesApi()}
      feeApi={feeApi()}
      {...props}
    />,
  );
}

function renderProposals(props: Partial<Parameters<typeof RuleProposalList>[0]> = {}) {
  return render(
    <RuleProposalList
      organizationId={ORG}
      versionId={VERSION}
      runId={RUN}
      locale="en"
      revision={3}
      canDecide
      api={proposalsApi()}
      {...props}
    />,
  );
}

// ---------------------------------------------------------------------------

describe('the source documents panel', () => {
  it('asks the institution to agree before anything is read', async () => {
    renderSources({
      api: sourcesApi({ consent: vi.fn().mockResolvedValue(consent({ granted: false })) }),
    });

    expect(await screen.findByText(en.consentTitle)).toBeInTheDocument();
    expect(screen.getByText(en.consentExplanation)).toBeInTheDocument();
    // §15: the institution agrees for the institution, and the notice says so.
    expect(screen.getByText(en.consentOrganizationScope)).toBeInTheDocument();
    // §17: not agreeing blocks reading, and nothing else.
    expect(screen.getByText(en.manualAlternative)).toBeInTheDocument();
    // Nothing to press that would start a reading.
    expect(screen.queryByRole('button', { name: en.startExtraction })).not.toBeInTheDocument();
  });

  it('does not offer the agreement to someone who cannot give it', async () => {
    // §16: a template manager does the work without being able to commit the
    // institution to external processing.
    const api = sourcesApi({ consent: vi.fn().mockResolvedValue(consent({ granted: false })) });
    renderSources({ api, canManageConsent: false });

    expect(await screen.findByText(en.consentNotPermitted)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: en.consentAgree })).not.toBeInTheDocument();
  });

  it('says a template shows formatting rather than stating a requirement', async () => {
    renderSources();
    await screen.findByText('thesis-guidelines.pdf');

    fireEvent.change(screen.getByLabelText(en.sourceKindLabel), {
      target: { value: 'TEMPLATE_DOCX' },
    });
    // The §4 distinction, at the moment the reviewer classifies the upload.
    expect(screen.getByText(en.sourceKindHints.TEMPLATE_DOCX!)).toBeInTheDocument();
  });

  it('will not offer to remove a source an accepted rule depends on', async () => {
    // §101: provenance would be broken, so the control is absent rather than
    // present and failing.
    const api = sourcesApi({
      sources: vi.fn().mockResolvedValue([source({ retentionLocked: true })]),
    });
    renderSources({ api });

    expect(await screen.findByText(en.retentionLocked)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: en.removeSource })).not.toBeInTheDocument();
  });

  it('offers no source controls at all once the version is published', async () => {
    // §7: sources attach to a draft. A published standard is frozen.
    renderSources({ isDraft: false });

    expect(await screen.findByText(en.draftOnlyNotice)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: en.addSource })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: en.startExtraction })).not.toBeInTheDocument();
  });

  it('reports what a reading produced without claiming it found everything', async () => {
    const api = sourcesApi({ runs: vi.fn().mockResolvedValue([run()]) });
    renderSources({ api });

    expect(await screen.findByText(en.summaryTitle)).toBeInTheDocument();
    expect(screen.getByText(en.summaryLabels.explicitRequirementProposals!)).toBeInTheDocument();
    // §93: the honest caveat, next to the numbers it qualifies.
    expect(screen.getByText(en.notExhaustive)).toBeInTheDocument();
  });

  it('explains a failed reading and says nothing was changed', async () => {
    const api = sourcesApi({
      runs: vi
        .fn()
        .mockResolvedValue([
          run({ status: 'FAILED', failureKind: 'PROVIDER_UNAVAILABLE', summary: null }),
        ]),
    });
    renderSources({ api });

    expect(await screen.findByText(/PalCert could not finish reading/)).toBeInTheDocument();
    expect(screen.getByText(new RegExp(en.runFailureKinds.PROVIDER_UNAVAILABLE!))).toBeTruthy();
  });

  it('reports an unavailable AI layer in place, without breaking the page', async () => {
    const api = sourcesApi({
      sources: vi.fn().mockRejectedValue(new ApiError('AI_DISABLED', 'disabled', 403)),
    });
    renderSources({ api });

    expect(await screen.findByText(en.errors.AI_DISABLED!)).toBeInTheDocument();
  });

  it('shows live progress for a reading in flight, and reloads when it finishes', async () => {
    const runs = vi
      .fn()
      .mockResolvedValueOnce([run({ status: 'GENERATING_PROPOSALS', summary: null })])
      .mockResolvedValue([run()]);
    const runProgress = vi
      .fn()
      .mockResolvedValueOnce({
        runId: RUN,
        status: 'GENERATING_PROPOSALS',
        stage: 'GENERATING_PROPOSALS',
        failureKind: null,
        completedBatches: 2,
        totalBatches: 5,
        successfulBatches: 2,
        failedBatches: 0,
        evidenceCount: 6,
        observationCount: 4,
        proposalCount: null,
        elapsedSeconds: 40,
        cancellable: false,
        startedAt: '2026-09-01T09:00:01.000Z',
        finishedAt: null,
      })
      .mockResolvedValue({
        runId: RUN,
        status: 'COMPLETED',
        stage: 'COMPLETED',
        failureKind: null,
        completedBatches: 5,
        totalBatches: 5,
        successfulBatches: 5,
        failedBatches: 0,
        evidenceCount: 6,
        observationCount: 4,
        proposalCount: 9,
        elapsedSeconds: 90,
        cancellable: false,
        startedAt: '2026-09-01T09:00:01.000Z',
        finishedAt: '2026-09-01T09:01:31.000Z',
      });
    const onRunCompleted = vi.fn();
    renderSources({ api: sourcesApi({ runs, runProgress }), onRunCompleted });

    expect(await screen.findByText('2 of 5 batches')).toBeInTheDocument();
    // Finished: the panel says so, and the page reloads the run to show its proposals.
    expect(await screen.findByText('5 of 5 batches', {}, { timeout: 5_000 })).toBeInTheDocument();
    await waitFor(() => expect(onRunCompleted).toHaveBeenCalled());
  });

  it('renders in Arabic for an Arabic reader', async () => {
    renderSources({ locale: 'ar' });
    expect(await screen.findByText(ar.sourcesTitle)).toBeInTheDocument();
  });
});

describe('what the panel says about how a source was processed', () => {
  it('says legacy equations were processed in safe mode, as information rather than an error', async () => {
    renderSources({
      api: sourcesApi({ sources: vi.fn().mockResolvedValue([source({ legacyEquationCount: 2 })]) }),
    });
    const notice = await screen.findByTestId('legacy-equations-notice');
    expect(notice).toHaveTextContent(en.legacyEquationsNotice);
    expect(notice).toHaveAttribute('role', 'note');
    expect(screen.queryByText(en.sourceRejected)).toBeNull();
  });

  it('says nothing about equations when there were none', async () => {
    renderSources({
      api: sourcesApi({ sources: vi.fn().mockResolvedValue([source({ legacyEquationCount: 0 })]) }),
    });
    await screen.findByText('thesis-guidelines.pdf');
    expect(screen.queryByTestId('legacy-equations-notice')).toBeNull();
  });

  it('gives the real reason when an embedded object is refused, in English and Arabic', async () => {
    const rejected = source({
      status: 'REJECTED',
      rejectionCode: 'FILE_EMBEDDED_OBJECT_UNSUPPORTED',
      legacyEquationCount: 0,
    });
    const { unmount } = renderSources({
      api: sourcesApi({ sources: vi.fn().mockResolvedValue([rejected]) }),
    });
    expect(
      await screen.findByText(
        'PalCert did not accept this file. This Word document contains an embedded object that PalCert cannot safely process.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('legacy-equations-notice')).toBeNull();
    unmount();

    renderSources({
      locale: 'ar',
      api: sourcesApi({ sources: vi.fn().mockResolvedValue([rejected]) }),
    });
    expect(
      await screen.findByText((text) =>
        text.includes('يحتوي مستند Word على عنصر مضمّن لا يستطيع PalCert معالجته بأمان.'),
      ),
    ).toBeInTheDocument();
  });

  it('has a reason, in both languages, for every code ingestion can reject with', () => {
    for (const code of DOCUMENT_REJECTION_CODES) {
      expect(en.sourceRejectionReasons[code]).toBeTruthy();
      expect(ar.sourceRejectionReasons[code]).toBeTruthy();
    }
    expect(Object.keys(ar.sourceRejectionReasons).sort()).toEqual(
      Object.keys(en.sourceRejectionReasons).sort(),
    );
    expect(ar.legacyEquationsNotice).toBe(
      'تم اكتشاف معادلات قديمة مضمّنة. عالجها PalCert في الوضع الآمن دون تشغيل أي محتوى مضمّن.',
    );
    expect(en.legacyEquationsNotice).toBe(
      'Legacy equation objects were detected. PalCert processed them in safe mode without executing embedded content.',
    );
  });
});

describe('downloading a source and tracing a rule', () => {
  it('downloads a ready source through a short-lived link it never shows', async () => {
    const sourceDownload = vi.fn().mockResolvedValue({
      method: 'GET',
      url: 'https://storage.test/source-signed',
      expiresAt: '2026-09-01T09:05:00.000Z',
      filename: 'thesis-guidelines.pdf',
    });
    const assign = vi.fn();
    const original = window.location;
    Object.defineProperty(window, 'location', { value: { assign }, writable: true });
    try {
      renderSources({ isDraft: false, api: sourcesApi({ sourceDownload }) });
      fireEvent.click(
        await screen.findByRole('button', {
          name: `${en.downloadSource}: thesis-guidelines.pdf`,
        }),
      );
      await waitFor(() => {
        expect(sourceDownload).toHaveBeenCalledWith(ORG, VERSION, 'source-1');
      });
      await waitFor(() => {
        expect(assign).toHaveBeenCalledWith('https://storage.test/source-signed');
      });
      expect(screen.queryByText('https://storage.test/source-signed')).toBeNull();
    } finally {
      Object.defineProperty(window, 'location', { value: original, writable: true });
    }
  });

  it('offers no download for a source that is not ready', async () => {
    renderSources({
      api: sourcesApi({ sources: vi.fn().mockResolvedValue([source({ status: 'SCANNING' })]) }),
    });
    await screen.findByText('thesis-guidelines.pdf');
    expect(screen.queryByText(en.downloadSource)).toBeNull();
  });

  const RULES = [
    { id: 'rule-1', ruleCode: 'MARGIN.LEFT', titleEn: 'Left margin', titleAr: 'الهامش الأيسر' },
    { id: 'rule-2', ruleCode: 'FONT.BODY', titleEn: 'Body font', titleAr: 'خط المتن' },
  ] as unknown as Parameters<typeof RuleProvenancePanel>[0]['rules'];

  it('shows the source and pages a rule was read from, only when asked', async () => {
    const provenance = vi.fn().mockResolvedValue([
      {
        standardRuleId: 'rule-1',
        extractionRunId: RUN,
        proposalId: 'proposal-1',
        sourceAssetId: 'source-1',
        sourceFilename: 'thesis-guidelines.pdf',
        sourceKind: 'GUIDELINE_PDF',
        sourceSha256: 'a'.repeat(64),
        evidenceKind: 'TEXT',
        locatorType: 'PAGE',
        startPage: 4,
        endPage: 5,
        nodeIds: [],
        createdAt: '2026-09-01T09:00:00.000Z',
      },
    ]);
    render(
      <RuleProvenancePanel
        organizationId={ORG}
        versionId={VERSION}
        locale="en"
        rules={RULES}
        api={{ provenance }}
      />,
    );
    expect(provenance).not.toHaveBeenCalled();
    expect(screen.getByText(en.provenanceNotPartOfStandard)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(en.provenanceRuleLabel), {
      target: { value: 'rule-1' },
    });
    const list = await screen.findByTestId('rule-provenance');
    expect(provenance).toHaveBeenCalledWith(ORG, VERSION, 'rule-1');
    expect(list.textContent).toContain('thesis-guidelines.pdf');
    expect(list.textContent).toContain(`${en.provenancePages} 4–5`);
  });

  it('says a hand-written rule has no provenance', async () => {
    render(
      <RuleProvenancePanel
        organizationId={ORG}
        versionId={VERSION}
        locale="ar"
        rules={RULES}
        api={{ provenance: vi.fn().mockResolvedValue([]) }}
      />,
    );
    fireEvent.change(screen.getByLabelText(ar.provenanceRuleLabel), {
      target: { value: 'rule-2' },
    });
    expect(await screen.findByText(ar.provenanceNone)).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'FONT.BODY — خط المتن' })).toBeInTheDocument();
  });
});

describe('the proposal review screen', () => {
  /** Open the first row's detail panel, where the evidence and decisions live. */
  async function openDetails(index = 0): Promise<void> {
    const buttons = await screen.findAllByRole('button', { name: console_en.details });
    fireEvent.click(buttons[index]!);
  }

  it('shows the source’s own words beside the proposal, once its row is opened', async () => {
    // §96: the question a reviewer is answering is "does the source say this?".
    const api = proposalsApi();
    renderProposals({ api });

    expect(await screen.findByText('PAGE.MARGIN.LEFT')).toBeInTheDocument();
    // One request for the list; no request per proposal until one is opened.
    expect(api.proposal).not.toHaveBeenCalled();

    await openDetails();
    expect(
      await screen.findByText('The left margin must be 30 mm on every page of the thesis.'),
    ).toBeInTheDocument();
    expect(api.proposal).toHaveBeenCalledTimes(1);
    expect(screen.getByText(en.interpretation)).toBeInTheDocument();
    expect(screen.getAllByText(/thesis-guidelines\.pdf/).length).toBeGreaterThan(0);
  });

  it('opens the detail panel from a click on the row itself', async () => {
    renderProposals();
    const code = await screen.findByText('PAGE.MARGIN.LEFT');
    fireEvent.click(code.closest('tr')!);
    expect(
      await screen.findByText('The left margin must be 30 mm on every page of the thesis.'),
    ).toBeInTheDocument();
  });

  it('labels a template observation as observed, never as required', async () => {
    const api = proposalsApi({
      proposals: vi.fn().mockResolvedValue([proposal({ kind: 'TEMPLATE_INFERENCE' })]),
      proposal: vi
        .fn()
        .mockResolvedValue(
          detail({ kind: 'TEMPLATE_INFERENCE', evidence: [], observations: [observation()] }),
        ),
    });
    renderProposals({ api });
    await openDetails();

    expect(await screen.findByText(en.observationNotARequirement)).toBeInTheDocument();
    expect(screen.getAllByText(en.proposalKinds.TEMPLATE_INFERENCE!).length).toBeGreaterThan(0);
    // The counts behind it, with no percentage anywhere (§33, §34, §147).
    expect(screen.getByText(/187\s+of\s+196/)).toBeInTheDocument();
    expect(screen.queryByText(/%/)).not.toBeInTheDocument();
    expect(screen.queryByText(/confidence/i)).not.toBeInTheDocument();
  });

  it('offers no accept button for an ambiguous requirement', async () => {
    const api = proposalsApi({
      proposals: vi.fn().mockResolvedValue([
        proposal({
          kind: 'AMBIGUOUS_REQUIREMENT',
          requiresClarification: true,
          ambiguityNote: 'The source does not say what spacing is required.',
          suggestedRule: null,
          suggestedRuleCode: null,
        }),
      ]),
      proposal: vi.fn().mockResolvedValue(detail({ kind: 'AMBIGUOUS_REQUIREMENT' })),
    });
    renderProposals({ api });
    await openDetails();

    expect(await screen.findByText(new RegExp(en.clarificationNeeded))).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: en.accept })).not.toBeInTheDocument();
    // Rejecting it is still available: it is a real finding to dispose of.
    expect(screen.getByRole('button', { name: en.reject })).toBeInTheDocument();
  });

  it('presents a conflict as a question, with neither side preselected', async () => {
    const api = proposalsApi({
      proposals: vi
        .fn()
        .mockResolvedValue([
          proposal({ id: 'a', kind: 'CONFLICTING_REQUIREMENT', suggestedRule: null }),
          proposal({ id: 'b', kind: 'CONFLICTING_REQUIREMENT', suggestedRule: null }),
        ]),
      proposal: vi.fn().mockResolvedValue(detail({ kind: 'CONFLICTING_REQUIREMENT' })),
    });
    renderProposals({ api });
    await openDetails();

    expect(await screen.findByText(en.conflictTitle)).toBeInTheDocument();
    expect(screen.getByText(en.conflictExplanation)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: en.accept })).not.toBeInTheDocument();
    for (const box of screen.queryAllByRole('checkbox')) {
      expect(box).not.toBeChecked();
    }
  });

  it('shows a proposal PalCert refused, unchanged, with the reasons', async () => {
    const api = proposalsApi({
      proposals: vi.fn().mockResolvedValue([
        proposal({
          validationStatus: 'INVALID',
          validationIssues: [{ path: '/expected', message: 'BETWEEN requires a range' }],
        }),
      ]),
      proposal: vi.fn().mockResolvedValue(detail({ validationStatus: 'INVALID' })),
    });
    renderProposals({ api });

    // Flagged in the row, before anyone opens it.
    expect(await screen.findByText(console_en.invalidBadge)).toBeInTheDocument();
    await openDetails();
    expect(screen.getByText(en.invalidProposalTitle)).toBeInTheDocument();
    expect(screen.getByText(/BETWEEN requires a range/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: en.accept })).not.toBeInTheDocument();
  });

  it('accepts a proposal only when a person presses accept', async () => {
    const api = proposalsApi();
    const onDecided = vi.fn();
    renderProposals({ api, onDecided });

    await screen.findByText('PAGE.MARGIN.LEFT');
    expect(api.acceptProposal).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: en.accept }));
    await waitFor(() => expect(api.acceptProposal).toHaveBeenCalledTimes(1));
    expect(api.acceptProposal).toHaveBeenCalledWith(ORG, VERSION, RUN, 'proposal-1', 3);
    await waitFor(() => expect(onDecided).toHaveBeenCalledWith(4));
  });

  it('tells a reviewer plainly when the draft moved under them', async () => {
    const api = proposalsApi({
      acceptProposal: vi
        .fn()
        .mockRejectedValue(new ApiError('STALE_STANDARD_REVISION', 'stale', 409)),
    });
    renderProposals({ api });

    await screen.findByText('PAGE.MARGIN.LEFT');
    fireEvent.click(screen.getByRole('button', { name: en.accept }));
    expect(await screen.findByRole('alert')).toHaveTextContent(en.errors.STALE_STANDARD_REVISION!);
  });

  it('says a rejection reason is never sent to the provider', async () => {
    renderProposals();
    await openDetails();
    expect(await screen.findByText(en.reviewNotesHint)).toBeInTheDocument();
  });

  it('records a rejection with its reason', async () => {
    const api = proposalsApi();
    renderProposals({ api });
    await openDetails();

    fireEvent.change(await screen.findByLabelText(en.rejectionReasonLabel), {
      target: { value: 'ALREADY_COVERED' },
    });
    fireEvent.click(screen.getByRole('button', { name: en.reject }));

    await waitFor(() =>
      expect(api.rejectProposal).toHaveBeenCalledWith(ORG, VERSION, RUN, 'proposal-1', {
        reason: 'ALREADY_COVERED',
      }),
    );
  });

  it('shows a decided proposal as decided, and offers no second decision', async () => {
    const api = proposalsApi({
      proposals: vi.fn().mockResolvedValue([
        proposal({
          status: 'MODIFIED_AND_ACCEPTED',
          decision: {
            decision: 'MODIFIED_AND_ACCEPTED',
            reviewedByUserId: 'user-1',
            reviewedAt: '2026-09-02T10:00:00.000Z',
            resultingRuleId: 'rule-1',
            rejectionReason: null,
            reviewNotes: null,
            acceptedRule: { ruleCode: 'PAGE.MARGIN.LEFT' },
          },
        }),
      ]),
    });
    renderProposals({ api });
    await openDetails();

    expect(
      (await screen.findAllByText(console_en.statusLabels.MODIFIED_AND_ACCEPTED!)).length,
    ).toBeGreaterThan(0);
    // §66: both what was proposed and what was accepted are kept.
    expect(screen.getByText(en.acceptedAsEdited)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: en.accept })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: en.reject })).not.toBeInTheDocument();
  });

  it('shows a reader without the decide permission no decision controls', async () => {
    renderProposals({ canDecide: false });
    await openDetails();

    expect(await screen.findByText(en.interpretation)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: en.accept })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: en.reject })).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Accept all valid/ })).not.toBeInTheDocument();
  });

  it('renders the review screen in Arabic', async () => {
    renderProposals({ locale: 'ar' });
    await screen.findByText('PAGE.MARGIN.LEFT');
    expect(screen.getByText(ar.proposalsTitle)).toBeInTheDocument();
    expect(screen.getAllByText(console_ar.chips.waiting).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: console_ar.details }));
    expect(await screen.findByText('يجب أن يكون الهامش الأيسر ٣٠ مم.')).toBeInTheDocument();
    // The source's own words stay in the source's own language (§127).
    expect(
      screen.getByText('The left margin must be 30 mm on every page of the thesis.'),
    ).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// The review console at the size a real reading produces
// ---------------------------------------------------------------------------

/**
 * 111 proposals, shaped like the real 8443 reading: mostly rules a reviewer
 * can accept, some findings with no rule, a few invalid or conflicting.
 */
function realisticRun(): RuleProposalResponse[] {
  return Array.from({ length: 111 }, (_, index) => {
    const n = index + 1;
    const id = `p-${String(n).padStart(3, '0')}`;
    if (n % 37 === 0) {
      return proposal({
        id,
        displayOrder: index,
        kind: 'UNREPRESENTABLE_REQUIREMENT',
        suggestedRule: null,
        suggestedRuleCode: null,
        automationSupport: 'NOT_CURRENTLY_MEASURABLE',
      });
    }
    if (n % 25 === 0) {
      return proposal({
        id,
        displayOrder: index,
        kind: 'AMBIGUOUS_REQUIREMENT',
        suggestedRule: null,
        suggestedRuleCode: null,
        requiresClarification: true,
      });
    }
    const template = n % 2 === 0;
    const rule = {
      ruleCode: `${template ? 'TEMPLATE' : 'GUIDELINE'}.RULE.${n}`,
      category: n % 3 === 0 ? 'TYPOGRAPHY' : 'MARGINS',
      scope: { kind: 'PAGE', property: n % 3 === 0 ? 'fontSize' : 'marginLeft' },
      operator: 'EQUALS',
      expected: { type: 'NUMBER', number: n },
      unit: n % 3 === 0 ? 'POINT' : 'MILLIMETRE',
      titleEn: `Rule number ${n}`,
      titleAr: `القاعدة رقم ${n}`,
    };
    return proposal({
      id,
      displayOrder: index,
      kind: template ? 'TEMPLATE_INFERENCE' : 'EXPLICIT_REQUIREMENT',
      suggestedRule: rule,
      suggestedRuleCode: rule.ruleCode,
      validationStatus: n % 41 === 0 ? 'INVALID' : 'VALID',
      conflict: {
        status: n % 43 === 0 ? 'EXISTING_RULE' : 'NONE',
        existingRuleId: null,
        existingRuleCode: null,
        relatedProposalIds: [],
        detail: null,
      },
      evidenceIds: template ? [] : ['evidence-1'],
      observationIds: template ? ['observation-1'] : [],
      summary: {
        sources: [
          {
            sourceAssetId: template ? 'source-2' : 'source-1',
            sourceFilename: template ? 'PhD_Template_00.docx' : 'thesis-guidelines.pdf',
            sourceKind: template ? 'TEMPLATE_DOCX' : 'GUIDELINE_PDF',
          },
        ],
        evidenceCount: template ? 0 : 1,
        observationCount: template ? 1 : 0,
        observation: template
          ? {
              property: rule.scope.property,
              unit: rule.unit,
              modalValue: String(n),
              occurrenceCount: 40,
              matchingCount: n % 4 === 0 ? 40 : 31,
              uniformity: n % 4 === 0 ? 'UNIFORM' : 'MOSTLY_UNIFORM',
            }
          : null,
      },
    });
  });
}

const REAL = realisticRun();
const VALID_IDS = REAL.filter(isReadyToAccept).map((p) => p.id);
const NO_RULE_IDS = REAL.filter((p) => p.suggestedRule === null).map((p) => p.id);

function rows(): HTMLElement[] {
  return screen.getAllByRole('row').filter((row) => row.classList.contains('review-row'));
}

describe('the review console with a 111-proposal reading', () => {
  function renderReal(overrides: Record<string, unknown> = {}, props = {}) {
    const api = proposalsApi({ proposals: vi.fn().mockResolvedValue(REAL), ...overrides });
    renderProposals({ api, ...props });
    return api;
  }

  it('shows the summary with exact counts', async () => {
    renderReal();
    await screen.findByText('GUIDELINE.RULE.1');
    const summary = screen.getByRole('group', { name: console_en.summaryLabel });
    const chip = (label: string) =>
      Array.from(summary.querySelectorAll('button')).find((b) => b.textContent!.startsWith(label))!;
    expect(chip(console_en.chips.all)).toHaveTextContent('111');
    expect(chip(console_en.chips.waiting)).toHaveTextContent('111');
    expect(chip(console_en.chips.valid)).toHaveTextContent(String(VALID_IDS.length));
    expect(chip(console_en.chips.cannotExpress)).toHaveTextContent(String(NO_RULE_IDS.length));
    expect(chip(console_en.chips.accepted)).toHaveTextContent('0');
    expect(
      screen.getByRole('button', { name: `Accept all valid (${VALID_IDS.length})` }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reject all pending (111)' })).toBeInTheDocument();
  });

  it('pages 25 at a time by default, and 50 or 100 on request', async () => {
    renderReal();
    await screen.findByText('GUIDELINE.RULE.1');
    expect(rows()).toHaveLength(25);
    expect(screen.getByText(/1–25 of 111/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: console_en.nextPage }));
    expect(screen.getByText('GUIDELINE.RULE.27')).toBeInTheDocument();
    expect(screen.getByText(/26–50 of 111/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(console_en.rowsPerPage), { target: { value: '100' } });
    expect(rows()).toHaveLength(100);
    fireEvent.click(screen.getByRole('button', { name: console_en.nextPage }));
    expect(rows()).toHaveLength(11);
    expect(screen.getByText(/101–111 of 111/)).toBeInTheDocument();
  });

  it('searches by rule code, title and property', async () => {
    renderReal();
    await screen.findByText('GUIDELINE.RULE.1');
    const search = screen.getByLabelText(console_en.searchLabel);

    fireEvent.change(search, { target: { value: 'template.rule.10' } });
    expect(rows().map((row) => row.textContent)).toEqual(
      expect.arrayContaining([expect.stringContaining('TEMPLATE.RULE.10')]),
    );
    expect(rows().every((row) => /TEMPLATE\.RULE\.10\d*/.test(row.textContent!))).toBe(true);

    fireEvent.change(search, { target: { value: 'Rule number 33' } });
    expect(rows()).toHaveLength(1);

    fireEvent.change(search, { target: { value: 'fontSize' } });
    expect(screen.getByText(/of 3[0-9]\b/)).toBeInTheDocument();
  });

  it('filters by kind, status, category and consistency', async () => {
    renderReal();
    await screen.findByText('GUIDELINE.RULE.1');

    fireEvent.change(screen.getByLabelText(console_en.filterKind), {
      target: { value: 'UNREPRESENTABLE_REQUIREMENT' },
    });
    expect(rows()).toHaveLength(
      REAL.filter((p) => p.kind === 'UNREPRESENTABLE_REQUIREMENT').length,
    );

    fireEvent.change(screen.getByLabelText(console_en.filterKind), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText(console_en.filterCategory), {
      target: { value: 'TYPOGRAPHY' },
    });
    fireEvent.change(screen.getByLabelText(console_en.filterUniformity), {
      target: { value: 'UNIFORM' },
    });
    const expected = REAL.filter(
      (p) =>
        (p.suggestedRule as { category?: string } | null)?.category === 'TYPOGRAPHY' &&
        p.summary?.observation?.uniformity === 'UNIFORM',
    );
    expect(rows()).toHaveLength(expected.length);

    fireEvent.click(screen.getByRole('button', { name: console_en.clearFilters }));
    expect(screen.getByText(/1–25 of 111/)).toBeInTheDocument();
  });

  it('sorts by a column, and says which way', async () => {
    renderReal();
    await screen.findByText('GUIDELINE.RULE.1');
    const header = screen.getByRole('button', { name: new RegExp(console_en.columns.ruleCode) });

    fireEvent.click(header);
    expect(header.closest('th')).toHaveAttribute('aria-sort', 'ascending');
    fireEvent.click(header);
    expect(header.closest('th')).toHaveAttribute('aria-sort', 'descending');
    // Findings with no rule code sort together at one end.
    expect(rows()[0]!.textContent).toContain('TEMPLATE.RULE.');
  });

  it('selects a page, keeps the selection across pages, and selects everything matching', async () => {
    renderReal();
    await screen.findByText('GUIDELINE.RULE.1');

    fireEvent.click(screen.getByRole('checkbox', { name: console_en.selectPage }));
    expect(screen.getByText('25 selected')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: console_en.nextPage }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select GUIDELINE.RULE.27' }));
    expect(screen.getByText('26 selected')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: console_en.previousPage }));
    expect(screen.getByRole('checkbox', { name: console_en.selectPage })).toBeChecked();

    fireEvent.change(screen.getByLabelText(console_en.filterKind), {
      target: { value: 'EXPLICIT_REQUIREMENT' },
    });
    const explicit = REAL.filter((p) => p.kind === 'EXPLICIT_REQUIREMENT');
    fireEvent.click(screen.getByRole('button', { name: `Select all ${explicit.length} matching` }));
    // The page already selected plus every explicit requirement.
    const union = new Set([
      ...REAL.slice(0, 25).map((p) => p.id),
      'p-027',
      ...explicit.map((p) => p.id),
    ]);
    expect(screen.getByText(`${union.size} selected`)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: console_en.clearSelection }));
    expect(screen.queryByText(/selected$/)).not.toBeInTheDocument();
  });

  it('accepts the selected ones in one request, sending only those with a valid rule', async () => {
    const acceptSelected = vi.fn().mockResolvedValue({
      data: { accepted: ['p-001', 'p-002'], skipped: [] },
      etag: null,
    });
    const api = renderReal({ acceptSelected });
    await screen.findByText('GUIDELINE.RULE.1');

    for (const code of ['GUIDELINE.RULE.1', 'TEMPLATE.RULE.2']) {
      fireEvent.click(screen.getByRole('checkbox', { name: `Select ${code}` }));
    }
    fireEvent.change(screen.getByLabelText(console_en.filterKind), {
      target: { value: 'AMBIGUOUS_REQUIREMENT' },
    });
    fireEvent.click(screen.getAllByRole('checkbox', { name: /^Select / })[1]!);
    fireEvent.click(screen.getByRole('button', { name: console_en.acceptSelected }));

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Accept 2 valid proposals into this draft?');
    expect(dialog).toHaveTextContent(/1 of the selected proposals have no valid rule/);
    fireEvent.click(screen.getByRole('button', { name: 'Accept 2' }));

    await waitFor(() => expect(api.acceptSelected).toHaveBeenCalledTimes(1));
    expect(api.acceptSelected).toHaveBeenCalledWith(ORG, VERSION, RUN, ['p-001', 'p-002'], 3);
    expect(await screen.findByText('2 accepted.')).toBeInTheDocument();
  });

  it('rejects the selected ones in one request, with the reason chosen', async () => {
    const rejectSelected = vi.fn().mockResolvedValue({ rejected: ['p-003', 'p-004'], skipped: [] });
    const api = renderReal({ rejectSelected });
    await screen.findByText('GUIDELINE.RULE.1');

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select GUIDELINE.RULE.3' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select TEMPLATE.RULE.4' }));
    fireEvent.click(screen.getByRole('button', { name: console_en.rejectSelected }));

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Reject 2 pending proposals?');
    fireEvent.change(screen.getByLabelText(en.rejectionReasonLabel), {
      target: { value: 'ALREADY_COVERED' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Reject 2' }));

    await waitFor(() => expect(api.rejectSelected).toHaveBeenCalledTimes(1));
    expect(api.rejectSelected).toHaveBeenCalledWith(ORG, VERSION, RUN, ['p-003', 'p-004'], {
      reason: 'ALREADY_COVERED',
    });
    expect(api.rejectProposal).not.toHaveBeenCalled();
    expect(await screen.findByText('2 rejected.')).toBeInTheDocument();
  });

  it('Accept all valid never sends a proposal without a valid rule', async () => {
    const acceptSelected = vi.fn().mockResolvedValue({
      data: { accepted: VALID_IDS, skipped: [] },
      etag: null,
    });
    const api = renderReal({ acceptSelected });
    await screen.findByText('GUIDELINE.RULE.1');

    fireEvent.click(screen.getByRole('button', { name: `Accept all valid (${VALID_IDS.length})` }));
    expect(await screen.findByRole('dialog')).toHaveTextContent(
      `Accept ${VALID_IDS.length} valid proposals into this draft?`,
    );
    fireEvent.click(screen.getByRole('button', { name: `Accept ${VALID_IDS.length}` }));

    await waitFor(() => expect(api.acceptSelected).toHaveBeenCalledTimes(1));
    const sent = (api.acceptSelected as ReturnType<typeof vi.fn>).mock.calls[0]![3] as string[];
    expect([...sent].sort()).toEqual([...VALID_IDS].sort());
    for (const id of NO_RULE_IDS) expect(sent).not.toContain(id);
    for (const id of sent) {
      const sentProposal = REAL.find((p) => p.id === id)!;
      expect(sentProposal.suggestedRule).not.toBeNull();
      expect(sentProposal.validationStatus).toBe('VALID');
    }
  });

  it('Reject all pending asks with the exact count, then sends one request', async () => {
    const rejectSelected = vi.fn().mockResolvedValue({
      rejected: REAL.map((p) => p.id),
      skipped: [],
    });
    const api = renderReal({ rejectSelected });
    await screen.findByText('GUIDELINE.RULE.1');

    fireEvent.click(screen.getByRole('button', { name: 'Reject all pending (111)' }));
    expect(await screen.findByRole('dialog')).toHaveTextContent('Reject 111 pending proposals?');
    // Nothing happens before confirmation.
    expect(api.rejectSelected).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Reject 111' }));

    await waitFor(() => expect(api.rejectSelected).toHaveBeenCalledTimes(1));
    expect((api.rejectSelected as ReturnType<typeof vi.fn>).mock.calls[0]![3]).toHaveLength(111);
    expect(api.rejectProposal).not.toHaveBeenCalled();
  });

  it('cancelling the confirmation decides nothing', async () => {
    const api = renderReal();
    await screen.findByText('GUIDELINE.RULE.1');
    fireEvent.click(screen.getByRole('button', { name: 'Reject all pending (111)' }));
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: console_en.cancel }));
    expect(api.rejectSelected).not.toHaveBeenCalled();
    expect(api.acceptSelected).not.toHaveBeenCalled();
  });

  it('reports what a bulk action left unchanged, with the reason', async () => {
    const acceptSelected = vi.fn().mockResolvedValue({
      data: {
        accepted: ['p-001'],
        skipped: [{ id: 'p-003', reason: 'RULE_PROPOSAL_NOT_ACCEPTABLE' }],
      },
      etag: '"5"',
    });
    renderReal({ acceptSelected });
    await screen.findByText('GUIDELINE.RULE.1');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select GUIDELINE.RULE.1' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select GUIDELINE.RULE.3' }));
    fireEvent.click(screen.getByRole('button', { name: console_en.acceptSelected }));
    fireEvent.click(await screen.findByRole('button', { name: 'Accept 2' }));

    expect(await screen.findByText('1 left unchanged:')).toBeInTheDocument();
    expect(
      screen.getByText(new RegExp(en.errors.RULE_PROPOSAL_NOT_ACCEPTABLE!.slice(0, 30))),
    ).toBeInTheDocument();
  });

  it('works in Arabic', async () => {
    renderReal({}, { locale: 'ar' });
    await screen.findByText('GUIDELINE.RULE.1');
    expect(screen.getByText(console_ar.chips.valid)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'رفض كل المعلّقة (111)' }));
    expect(await screen.findByRole('dialog')).toHaveTextContent('رفض 111 من المقترحات المعلّقة؟');
  });
});

// ---------------------------------------------------------------------------
// Reading progress
// ---------------------------------------------------------------------------

function progress(overrides: Partial<ExtractionProgressResponse> = {}): ExtractionProgressResponse {
  return {
    runId: RUN,
    status: 'GENERATING_PROPOSALS',
    stage: 'GENERATING_PROPOSALS',
    failureKind: null,
    completedBatches: 4,
    totalBatches: 12,
    successfulBatches: 4,
    failedBatches: 0,
    evidenceCount: 18,
    observationCount: 42,
    proposalCount: null,
    elapsedSeconds: 125,
    cancellable: false,
    startedAt: '2026-09-01T09:00:00.000Z',
    finishedAt: null,
    ...overrides,
  };
}

describe('the reading progress panel', () => {
  function renderProgress(
    runProgress: ReturnType<typeof vi.fn>,
    props: Partial<Parameters<typeof ExtractionProgressPanel>[0]> = {},
  ) {
    return render(
      <ExtractionProgressPanel
        organizationId={ORG}
        versionId={VERSION}
        runId={RUN}
        locale="en"
        canCancel
        api={{ runProgress } as never}
        pollIntervalMs={20}
        {...props}
      />,
    );
  }

  it('advances with what the server reports, and stops polling when finished', async () => {
    const onSettled = vi.fn();
    const runProgress = vi
      .fn()
      .mockResolvedValueOnce(progress({ completedBatches: 4 }))
      .mockResolvedValueOnce(progress({ completedBatches: 9, successfulBatches: 9 }))
      .mockResolvedValue(
        progress({
          status: 'COMPLETED',
          stage: 'COMPLETED',
          completedBatches: 12,
          successfulBatches: 12,
          proposalCount: 111,
          elapsedSeconds: 310,
          finishedAt: '2026-09-01T09:05:10.000Z',
        }),
      );
    // Advance polling explicitly: a busy runner must not race past the
    // intermediate server response while the assertions are still reading it.
    vi.useFakeTimers();
    let view: ReturnType<typeof renderProgress> | undefined;
    try {
      await act(async () => {
        view = renderProgress(runProgress, { onSettled });
      });
      expect(screen.getByText('4 of 12 batches')).toBeInTheDocument();
      expect(screen.getByText(console_en.countedWhenSaved)).toBeInTheDocument();
      expect(screen.getByText('2 min 5 s')).toBeInTheDocument();
      const bar = screen.getByRole('progressbar', { name: console_en.progressBarLabel });
      expect(bar).toHaveAttribute('value', '4');
      expect(bar).toHaveAttribute('max', '12');
      expect(runProgress).toHaveBeenCalledTimes(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(20);
      });
      expect(screen.getByText('9 of 12 batches')).toBeInTheDocument();
      expect(bar).toHaveAttribute('value', '9');
      expect(runProgress).toHaveBeenCalledTimes(2);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(20);
      });
      expect(screen.getByText('12 of 12 batches')).toBeInTheDocument();
      expect(screen.getByText('111')).toBeInTheDocument();
      expect(screen.getAllByText(console_en.progressStates.COMPLETED!).length).toBeGreaterThan(0);
      expect(onSettled).toHaveBeenCalledTimes(1);
      expect(runProgress).toHaveBeenCalledTimes(3);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });
      expect(runProgress).toHaveBeenCalledTimes(3);
    } finally {
      view?.unmount();
      vi.useRealTimers();
    }
  });

  it('reads the same after a refresh, because it comes from the server', async () => {
    const runProgress = vi.fn().mockResolvedValue(progress({ completedBatches: 7 }));
    const first = renderProgress(runProgress);
    expect(await screen.findByText('7 of 12 batches')).toBeInTheDocument();
    first.unmount();

    // A new page load: no local state carried over.
    renderProgress(runProgress);
    expect(await screen.findByText('7 of 12 batches')).toBeInTheDocument();
    expect(screen.getByText(console_en.progressStages.GENERATING_PROPOSALS!)).toBeInTheDocument();
  });

  it('does not invent a total it does not know', async () => {
    renderProgress(
      vi.fn().mockResolvedValue(
        progress({
          status: 'DISCOVERING_EVIDENCE',
          stage: 'ANALYSING_SOURCE',
          completedBatches: 0,
          totalBatches: null,
          evidenceCount: null,
          observationCount: null,
        }),
      ),
    );
    expect(await screen.findByText(console_en.batchesNotYetKnown)).toBeInTheDocument();
    const bar = screen.getByRole('progressbar', { name: console_en.progressBarLabel });
    expect(bar).not.toHaveAttribute('value');
    expect(screen.queryByText(/%/)).not.toBeInTheDocument();
  });

  it('offers Cancel only while cancellation is still possible', async () => {
    const onCancel = vi.fn().mockResolvedValue(undefined);
    const { unmount } = renderProgress(
      vi.fn().mockResolvedValue(
        progress({
          status: 'QUEUED',
          stage: 'PREPARING_SOURCE',
          cancellable: true,
          totalBatches: null,
        }),
      ),
      { onCancel },
    );
    fireEvent.click(await screen.findByRole('button', { name: console_en.cancel }));
    await waitFor(() => expect(onCancel).toHaveBeenCalledTimes(1));
    unmount();

    renderProgress(vi.fn().mockResolvedValue(progress({ cancellable: false })), { onCancel });
    await screen.findByText('4 of 12 batches');
    expect(screen.queryByRole('button', { name: console_en.cancel })).not.toBeInTheDocument();
  });

  it('says a failed reading failed', async () => {
    renderProgress(
      vi
        .fn()
        .mockResolvedValue(
          progress({ status: 'FAILED', stage: 'FAILED', failureKind: 'PROVIDER_UNAVAILABLE' }),
        ),
    );
    expect(await screen.findByText(console_en.progressStates.FAILED!)).toBeInTheDocument();
  });

  it('works in Arabic', async () => {
    renderProgress(vi.fn().mockResolvedValue(progress()), { locale: 'ar' });
    expect(await screen.findByText('4 من 12 دفعات')).toBeInTheDocument();
    expect(screen.getByText(console_ar.progressTitle)).toBeInTheDocument();
  });
});

describe('how an expected value is written in the table', () => {
  it('writes each value shape the rule schema has, with readable operators and units', () => {
    const rule = (expected: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
      formatExpected({ operator: 'EQUALS', expected, ...extra });
    expect(rule({ type: 'NUMBER', number: 30 }, { unit: 'MILLIMETRE' })).toBe('= 30 mm');
    expect(rule({ type: 'STRING', text: 'Times New Roman' })).toBe('= "Times New Roman"');
    expect(rule({ type: 'BOOLEAN', boolean: true })).toBe('= true');
    expect(
      rule({ type: 'NUMBER', number: 25 }, { operator: 'GREATER_THAN_OR_EQUAL', unit: 'POINT' }),
    ).toBe('≥ 25 pt');
    expect(
      rule({ type: 'NUMBER_RANGE', min: 1, max: 2 }, { operator: 'BETWEEN', unit: 'LINES' }),
    ).toBe('BETWEEN 1–2 lines');
    expect(rule({ type: 'STRING_LIST', values: ['A', 'B'] }, { operator: 'IN' })).toBe('IN A, B');
    expect(
      rule(
        { type: 'PATTERN', pattern: 'STARTS_WITH', argument: 'Chapter' },
        { operator: 'MATCHES_PATTERN' },
      ),
    ).toBe('MATCHES_PATTERN STARTS_WITH Chapter');
    expect(formatExpected(null)).toBeNull();
  });
});

describe('AI rule extraction fee (ADR-0149)', () => {
  it('shows the fee and says it comes from the member’s own balance, not the organization’s', async () => {
    renderSources();
    expect(await screen.findByText('AI service fee')).toBeInTheDocument();
    expect(
      screen.getByText(
        'This AI service is billed to your PalCert Balance, even when used for an organization.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByTestId('ai-fee-amount').textContent).toMatch(/2\.00/);
    expect(document.body.textContent).not.toContain('AI_RULE_EXTRACTION');
  });

  it('starts with the server’s quote', async () => {
    const api = sourcesApi();
    renderSources({ api });
    const button = await screen.findByRole('button', { name: en.startExtraction });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    await waitFor(() => expect(api.startRun).toHaveBeenCalledTimes(1));
    const [organizationId, versionId, quoteId] = (api.startRun as ReturnType<typeof vi.fn>).mock
      .calls[0]!;
    expect([organizationId, versionId, quoteId]).toEqual([ORG, VERSION, 'quote-x']);
  });

  it('blocks the start when the member’s balance is short, with an Add balance link', async () => {
    const api = sourcesApi();
    renderSources({ api, feeApi: feeApi('50') });
    expect(await screen.findByText('Insufficient balance')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Add balance' })).toHaveAttribute(
      'href',
      '/en/balance/add',
    );
    expect(screen.getByRole('button', { name: en.startExtraction })).toBeDisabled();
    expect(api.startRun).not.toHaveBeenCalled();
  });

  it('says it in Arabic too', async () => {
    renderSources({ locale: 'ar' });
    expect(
      await screen.findByText(
        'يتم احتساب رسوم خدمة الذكاء الاصطناعي من رصيدك في PalCert حتى عند استخدامها لصالح مؤسسة.',
      ),
    ).toBeInTheDocument();
  });
});
