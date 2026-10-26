import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  DecisionHistory,
  Digest,
  InstitutionComments,
  SubmitSection,
  TechnicalSummary,
  type SubmissionApi,
} from '../submission';
import { getSubmissionsMessages } from '@/i18n/submissions-messages';
import type * as ApiClient from '@/lib/api-client';
import type {
  SubmissionDisclosureResponse,
  SubmissionRevisionResponse,
  SubmissionTechnicalSummaryResponse,
} from '@/lib/api-client';

type ApiClientModule = typeof ApiClient;
const { ApiError } = await vi.importActual<ApiClientModule>('@/lib/api-client');

const en = getSubmissionsMessages('en');
const ar = getSubmissionsMessages('ar');

/**
 * A catalogue entry that must exist.
 *
 * The catalogue's own parity test guarantees these keys; this narrows the
 * type so a matcher never receives `undefined` and silently matches nothing.
 */
function label(map: Readonly<Record<string, string>>, key: string): string {
  const value = map[key];
  if (value === undefined) throw new Error(`missing message: ${key}`);
  return value;
}

function technical(
  overrides: Partial<SubmissionTechnicalSummaryResponse> = {},
): SubmissionTechnicalSummaryResponse {
  return {
    determination: 'NON_COMPLIANT',
    score: '72.50',
    scoreCoverage: '1',
    scoreComplete: true,
    totalRules: 8,
    passedRules: 6,
    failedRules: 2,
    reviewRequiredRules: 0,
    indeterminateRules: 0,
    notApplicableRules: 0,
    ...overrides,
  };
}

function disclosure(
  overrides: Partial<SubmissionDisclosureResponse> = {},
): SubmissionDisclosureResponse {
  return {
    organizationId: 'org-1',
    organizationName: 'Islamic University of Gaza',
    documentTypeName: "Master's thesis",
    documentVersionNumber: 3,
    documentFormat: 'DOCX',
    standard: {
      standardId: 'standard-1',
      standardVersionId: 'version-1',
      standardCode: 'IUG.THESIS.FORMAT',
      standardName: 'IUG Thesis Formatting',
      standardVersionLabel: '1.0',
      standardContentHash: `sha256:${'a'.repeat(64)}`,
    },
    technical: technical(),
    submitter: { userId: 'user-1', displayName: 'Layla', email: 'layla@example.com' },
    shared: ['SUBMITTED_DOCUMENT_VERSION', 'TECHNICAL_REPORT', 'SUBMITTER_IDENTITY'],
    notShared: ['AI_REVIEW', 'SMARTFIX_PLAN_AND_MANIFEST', 'BALANCE_AND_PAYMENTS'],
    ...overrides,
  };
}

function revision(overrides: Partial<SubmissionRevisionResponse> = {}): SubmissionRevisionResponse {
  return {
    id: 'revision-1',
    submissionId: 'submission-1',
    revisionNumber: 1,
    processingStatus: 'PREPARING',
    failureCode: null,
    retryable: false,
    institutionDecisionStatus: null,
    documentVersionId: 'version-1',
    documentVersionNumber: 3,
    documentSha256: 'b'.repeat(64),
    documentFormat: 'DOCX',
    checkId: 'check-1',
    reportId: 'report-1',
    reportHash: 'c'.repeat(64),
    evaluationHash: 'd'.repeat(64),
    standard: disclosure().standard,
    technical: technical(),
    evidenceHash: null,
    createdAt: '2026-09-15T10:00:00.000Z',
    submittedAt: null,
    reviewStartedAt: null,
    decidedAt: null,
    ...overrides,
  };
}

function api(overrides: Partial<SubmissionApi> = {}): SubmissionApi {
  return {
    disclosure: vi.fn().mockResolvedValue(disclosure()),
    submit: vi.fn().mockResolvedValue(revision()),
    ...overrides,
  };
}

describe('Submitting a check officially', () => {
  it('offers no submit button until the disclosure has been read', () => {
    // §20, §21: the button that shares somebody's thesis does not exist until
    // they have been shown what sharing means.
    render(<SubmitSection locale="en" checkId="check-1" api={api()} />);

    expect(screen.queryByRole('button', { name: en.submit })).toBeNull();
    expect(screen.getByRole('button', { name: en.disclosureTitle })).toBeTruthy();
  });

  it('lists what would be shared and what would not', async () => {
    render(<SubmitSection locale="en" checkId="check-1" api={api()} />);
    fireEvent.click(screen.getByRole('button', { name: en.disclosureTitle }));

    await waitFor(() => expect(screen.getByText(en.willShare)).toBeTruthy());

    expect(screen.getByText(en.willNotShare)).toBeTruthy();
    expect(screen.getByText(label(en.sharedItems, 'SUBMITTED_DOCUMENT_VERSION'))).toBeTruthy();
    // §22, §23, §24: named explicitly, so the promise is checkable.
    expect(screen.getByText(label(en.notSharedItems, 'AI_REVIEW'))).toBeTruthy();
    expect(screen.getByText(label(en.notSharedItems, 'SMARTFIX_PLAN_AND_MANIFEST'))).toBeTruthy();
    expect(screen.getByText(label(en.notSharedItems, 'BALANCE_AND_PAYMENTS'))).toBeTruthy();
  });

  it('shares nothing until the button is pressed', async () => {
    const client = api();
    render(<SubmitSection locale="en" checkId="check-1" api={client} />);
    fireEvent.click(screen.getByRole('button', { name: en.disclosureTitle }));
    await waitFor(() => expect(screen.getByText(en.willShare)).toBeTruthy());

    expect(client.submit).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: en.submit }));
    await waitFor(() => expect(client.submit).toHaveBeenCalledTimes(1));
    expect(client.submit).toHaveBeenCalledWith('check-1', expect.any(String));
  });

  it('sends one idempotency key however many times it is pressed', async () => {
    // §96: a double-click is one submission, not two handoffs of the same
    // bytes.
    const client = api();
    render(<SubmitSection locale="en" checkId="check-1" api={client} />);
    fireEvent.click(screen.getByRole('button', { name: en.disclosureTitle }));
    await waitFor(() => expect(screen.getByText(en.willShare)).toBeTruthy());

    const button = screen.getByRole('button', { name: en.submit });
    fireEvent.click(button);
    await waitFor(() => expect(client.submit).toHaveBeenCalled());

    const keys = (client.submit as ReturnType<typeof vi.fn>).mock.calls.map(
      (call: unknown[]) => call[1],
    );
    expect(new Set(keys).size).toBe(1);
  });

  it('says it is preparing, never that it was decided', async () => {
    // §5, §35: a person whose copy is still being made must not read anything
    // that sounds like a university's answer.
    render(<SubmitSection locale="en" checkId="check-1" api={api()} />);
    fireEvent.click(screen.getByRole('button', { name: en.disclosureTitle }));
    await waitFor(() => expect(screen.getByText(en.willShare)).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: en.submit }));

    await waitFor(() =>
      expect(screen.getByText(label(en.processingStatuses, 'PREPARING'))).toBeTruthy(),
    );
    expect(screen.getByText(label(en.processingHints, 'PREPARING'))).toBeTruthy();
    expect(screen.queryByText(label(en.displayStatuses, 'APPROVED'))).toBeNull();
    expect(screen.queryByText(label(en.displayStatuses, 'REJECTED'))).toBeNull();
  });

  it('explains a refusal in the reader’s own language', async () => {
    const client = api({
      disclosure: vi
        .fn()
        .mockRejectedValue(
          new ApiError('SUBMISSION_ORGANIZATION_NOT_ELIGIBLE', 'nope', 409, undefined),
        ),
    });
    render(<SubmitSection locale="ar" checkId="check-1" api={client} />);
    fireEvent.click(screen.getByRole('button', { name: ar.disclosureTitle }));

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe(
        label(ar.errors, 'SUBMISSION_ORGANIZATION_NOT_ELIGIBLE'),
      ),
    );
  });
});

describe('Reading a decision', () => {
  it('labels the technical result as PalCert’s, not as a decision', () => {
    // §2, §3, §82.
    render(<TechnicalSummary locale="en" technical={technical()} />);

    expect(screen.getByText(en.technicalTitle)).toBeTruthy();
    expect(screen.getByText(en.technicalHint)).toBeTruthy();
    expect(screen.getByText('NON_COMPLIANT')).toBeTruthy();
    expect(screen.queryByText(label(en.displayStatuses, 'REJECTED'))).toBeNull();
  });

  it('says who did each thing in the history', () => {
    // §43: an event with no actor could mean "nobody has looked at this" or
    // "the university decided". The source is shown rather than inferred.
    render(
      <DecisionHistory
        locale="en"
        events={[
          {
            id: 'event-1',
            eventSource: 'SYSTEM',
            fromStatus: null,
            toStatus: 'SUBMITTED',
            reasonCode: null,
            createdAt: '2026-09-15T10:00:00.000Z',
          },
          {
            id: 'event-2',
            eventSource: 'ORGANIZATION',
            fromStatus: 'SUBMITTED',
            toStatus: 'APPROVED',
            reasonCode: null,
            createdAt: '2026-09-15T12:00:00.000Z',
          },
        ]}
      />,
    );

    expect(screen.getByText(en.historyBySystem)).toBeTruthy();
    expect(screen.getByText(en.historyByInstitution)).toBeTruthy();
    expect(screen.getByText(label(en.displayStatuses, 'SUBMITTED'))).toBeTruthy();
    expect(screen.getByText(label(en.displayStatuses, 'APPROVED'))).toBeTruthy();
  });

  it('shows the institution’s comments verbatim', () => {
    render(
      <InstitutionComments
        locale="ar"
        comments={[
          { id: 'c1', body: 'يرجى تصحيح الهوامش.', createdAt: '2026-09-15T12:00:00.000Z' },
        ]}
      />,
    );
    expect(screen.getByText('يرجى تصحيح الهوامش.')).toBeTruthy();
  });

  it('says there are no comments rather than showing an empty box', () => {
    render(<InstitutionComments locale="en" comments={[]} />);
    expect(screen.getByText(en.commentsEmpty)).toBeTruthy();
  });

  it('keeps the whole digest available even when it shortens it', () => {
    const value = 'e'.repeat(64);
    const { container } = render(<Digest value={value} />);
    const code = container.querySelector('code');
    expect(code?.getAttribute('title')).toBe(value);
    expect(code?.textContent?.length).toBeLessThan(value.length);
  });
});
