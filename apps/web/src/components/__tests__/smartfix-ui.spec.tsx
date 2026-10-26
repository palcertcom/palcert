import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  SmartFixManifestPanel,
  SmartFixPlanPanel,
  SmartFixPurchasePanel,
  SmartFixStatusPanel,
  type SmartFixApi,
} from '../smartfix';
import { getBillingMessages } from '@/i18n/billing-messages';
import { getSmartFixMessages } from '@/i18n/smartfix-messages';
import { formatMoney } from '@/lib/money';
import type * as ApiClient from '@/lib/api-client';
import type {
  SmartFixManifestResponse,
  SmartFixPlanResponse,
  SmartFixRequestResponse,
} from '@/lib/api-client';

type ApiClientModule = typeof ApiClient;
const { ApiError } = await vi.importActual<ApiClientModule>('@/lib/api-client');

const en = getSmartFixMessages('en');
const ar = getSmartFixMessages('ar');
const billingEn = getBillingMessages('en');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function plan(overrides: Partial<SmartFixPlanResponse> = {}): SmartFixPlanResponse {
  return {
    id: 'plan-1',
    checkId: 'check-1',
    documentVersionId: 'version-1',
    createdAt: '2026-09-14T10:00:00.000Z',
    expiresAt: '2026-09-14T11:00:00.000Z',
    fixEngineVersion: '1.0.0',
    refusalCode: null,
    ruleCount: 3,
    fixableRuleCount: 1,
    actionCount: 4,
    rules: [
      {
        ruleCode: 'BODY_FONT_SIZE',
        fixability: 'FIXABLE',
        reasonCode: null,
        targetCount: 4,
        fixableTargetCount: 4,
      },
      {
        ruleCode: 'FONT_SET',
        fixability: 'AMBIGUOUS_TARGET',
        reasonCode: 'SMARTFIX_OPERATOR_AMBIGUOUS',
        targetCount: 2,
        fixableTargetCount: 0,
      },
      {
        ruleCode: 'WORD_COUNT',
        fixability: 'NOT_SUPPORTED',
        reasonCode: 'SMARTFIX_COUNT_NOT_EDITABLE',
        targetCount: 1,
        fixableTargetCount: 0,
      },
    ],
    ...overrides,
  };
}

function request(overrides: Partial<SmartFixRequestResponse> = {}): SmartFixRequestResponse {
  return {
    id: 'request-1',
    planId: 'plan-1',
    checkId: 'check-1',
    status: 'PROCESSING',
    failureCode: null,
    correctedDocumentVersionId: null,
    recheckCheckId: null,
    createdAt: '2026-09-14T10:05:00.000Z',
    deliveredAt: null,
    ...overrides,
  };
}

function manifest(overrides: Partial<SmartFixManifestResponse> = {}): SmartFixManifestResponse {
  return {
    requestId: 'request-1',
    fixEngineVersion: '1.0.0',
    entryCount: 1,
    changedParts: ['word/document.xml'],
    textUnchanged: true,
    mediaUnchanged: true,
    fieldsUnchanged: true,
    relationshipsUnchanged: true,
    entries: [
      {
        actionId: 'a-0001',
        ruleCode: 'BODY_FONT_SIZE',
        actionType: 'SET_RUN_FONT_SIZE',
        nodeId: 'main/body/p:17/r:2',
        scriptChannel: 'LATIN',
        before: { kind: 'NUMBER', number: '11', unit: 'POINT' },
        after: { kind: 'NUMBER', number: '12', unit: 'POINT' },
        partName: 'word/document.xml',
      },
    ],
    ...overrides,
  };
}

function balanceOf(minorUnits: string) {
  const zero = { currency: 'USD', minorUnits: '0' };
  const amount = { currency: 'USD', minorUnits };
  return {
    currency: 'USD',
    available: amount,
    reserved: zero,
    cash: amount,
    promotional: zero,
    accounts: [],
  };
}

function api(overrides: Partial<SmartFixApi> = {}): SmartFixApi {
  return {
    plan: vi.fn(async () => plan()),
    start: vi.fn(async () => request({ status: 'RESERVED' })),
    cancel: vi.fn(async () =>
      request({ status: 'CANCELLED', failureCode: 'CANCELLED_BY_CUSTOMER' }),
    ),
    quote: vi.fn(async () => ({
      id: 'quote-1',
      productCode: 'SMARTFIX',
      amount: { currency: 'USD', minorUnits: '700' },
      createdAt: '2026-09-14T10:00:00.000Z',
      expiresAt: '2026-09-14T10:30:00.000Z',
      expired: false,
    })),
    balance: vi.fn(async () => balanceOf('2000')),
    ...overrides,
  } as SmartFixApi;
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

describe('SmartFixPlanPanel', () => {
  it('promises the original is untouched before anything else', async () => {
    render(<SmartFixPlanPanel checkId="check-1" locale="en" api={api()} />);
    expect(screen.getByText(en.originalSafe)).toBeInTheDocument();
    expect(screen.getByText(en.planFree)).toBeInTheDocument();
  });

  it('lists what it would fix and what it would not, with reasons', async () => {
    render(<SmartFixPlanPanel checkId="check-1" locale="en" api={api()} />);
    fireEvent.click(screen.getByRole('button', { name: en.planTitle }));

    await waitFor(() => expect(screen.getByText('BODY_FONT_SIZE')).toBeInTheDocument());
    // The whole picture, not just the good half: a user who saw only the
    // fixable rules could buy a correction believing it addressed everything.
    expect(screen.getByText('FONT_SET')).toBeInTheDocument();
    expect(screen.getByText('WORD_COUNT')).toBeInTheDocument();
    expect(screen.getByText(en.reasons.SMARTFIX_OPERATOR_AMBIGUOUS!)).toBeInTheDocument();
    expect(screen.getByText(en.reasons.SMARTFIX_COUNT_NOT_EDITABLE!)).toBeInTheDocument();
  });

  it('tells the user how to act on a refusal', async () => {
    const refused = plan({ refusalCode: 'SMARTFIX_TRACKED_CHANGES_UNSUPPORTED', actionCount: 0 });
    render(
      <SmartFixPlanPanel
        checkId="check-1"
        locale="en"
        api={api({ plan: vi.fn(async () => refused) })}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: en.planTitle }));
    await waitFor(() =>
      expect(
        screen.getByText(en.refusals.SMARTFIX_TRACKED_CHANGES_UNSUPPORTED!),
      ).toBeInTheDocument(),
    );
  });

  it('says so plainly when there is nothing to correct', async () => {
    const empty = plan({ actionCount: 0, rules: [] });
    render(
      <SmartFixPlanPanel
        checkId="check-1"
        locale="en"
        api={api({ plan: vi.fn(async () => empty) })}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: en.planTitle }));
    await waitFor(() => expect(screen.getByText(en.nothingToCorrect)).toBeInTheDocument());
  });

  it('shows a failure in the reader’s language', async () => {
    const failing = vi.fn(async () => {
      throw new ApiError('SMARTFIX_NOT_AVAILABLE', 'nope', 409);
    });
    render(<SmartFixPlanPanel checkId="check-1" locale="ar" api={api({ plan: failing })} />);
    fireEvent.click(screen.getByRole('button', { name: ar.planTitle }));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(ar.errors.SMARTFIX_NOT_AVAILABLE!),
    );
  });
});

// ---------------------------------------------------------------------------
// Buying it
// ---------------------------------------------------------------------------

describe('SmartFixPurchasePanel', () => {
  it('says what is reserved, when it is charged, and what happens if it fails', async () => {
    render(<SmartFixPurchasePanel plan={plan()} locale="en" api={api()} />);
    const price = formatMoney({ currency: 'USD', minorUnits: '700' }, 'en');
    // All three sentences, always together: a price without them is an honest
    // number in a misleading place.
    await waitFor(() => expect(screen.getByText(billingEn.willReserve(price))).toBeInTheDocument());
    expect(screen.getByText(billingEn.chargedOnDelivery)).toBeInTheDocument();
    expect(screen.getByText(billingEn.releasedIfIncomplete)).toBeInTheDocument();
  });

  it('starts the correction against the plan the user read', async () => {
    const start = vi.fn(async () => request({ status: 'RESERVED' }));
    const onStarted = vi.fn();
    render(
      <SmartFixPurchasePanel
        plan={plan()}
        locale="en"
        api={api({ start })}
        onStarted={onStarted}
      />,
    );
    await waitFor(() => expect(screen.getByRole('button', { name: en.start })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: en.start }));

    // The plan id, never its contents: what runs is what was approved.
    await waitFor(() => expect(start).toHaveBeenCalledWith('plan-1', 'quote-1'));
    expect(onStarted).toHaveBeenCalled();
  });

  it('refuses to start when the balance is short, and says by how much', async () => {
    const poor = api({
      balance: vi.fn(async () => balanceOf('100')),
    });
    render(<SmartFixPurchasePanel plan={plan()} locale="en" api={poor} />);
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: en.start })).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent(
      formatMoney({ currency: 'USD', minorUnits: '100' }, 'en'),
    );
  });
});

// ---------------------------------------------------------------------------
// While it runs, and afterwards
// ---------------------------------------------------------------------------

describe('SmartFixStatusPanel', () => {
  it('never says the document is corrected while it is still working', () => {
    for (const status of ['RESERVED', 'PROCESSING', 'RECHECKING', 'VALIDATING']) {
      const { unmount } = render(
        <SmartFixStatusPanel request={request({ status })} locale="en" api={api()} />,
      );
      expect(screen.getByRole('status')).toHaveTextContent(en.statuses[status]!);
      expect(screen.getByRole('status')).not.toHaveTextContent(en.statuses.DELIVERED!);
      expect(screen.queryByText(en.deliveredTitle)).not.toBeInTheDocument();
      unmount();
    }
  });

  it('never claims the document now complies once it is delivered', () => {
    render(
      <SmartFixStatusPanel
        request={request({
          status: 'DELIVERED',
          correctedDocumentVersionId: 'version-2',
          recheckCheckId: 'check-2',
          deliveredAt: '2026-09-14T10:20:00.000Z',
        })}
        locale="en"
        api={api()}
      />,
    );
    expect(screen.getByText(en.deliveredTitle)).toBeInTheDocument();
    // The sentence that stops a corrected document being mistaken for a
    // compliant one.
    expect(screen.getByText(en.stillFailing)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: en.openCorrected })).toHaveAttribute(
      'href',
      '/documents/versions/version-2',
    );
    expect(screen.getByRole('link', { name: en.openRecheck })).toHaveAttribute(
      'href',
      '/checks/check-2',
    );
  });

  it('says nothing was charged when the correction failed', () => {
    render(
      <SmartFixStatusPanel
        request={request({ status: 'FAILED', failureCode: 'SMARTFIX_REGRESSION_DETECTED' })}
        locale="en"
        api={api()}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent(/nothing was charged/i);
    expect(screen.getByText(en.statusHints.FAILED!)).toBeInTheDocument();
  });

  it('offers no corrected document before delivery', () => {
    render(
      <SmartFixStatusPanel request={request({ status: 'RECHECKING' })} locale="en" api={api()} />,
    );
    expect(screen.queryByRole('link', { name: en.openCorrected })).not.toBeInTheDocument();
  });

  it('cancels while it is still cancellable, and not afterwards', async () => {
    const cancel = vi.fn(async () =>
      request({ status: 'CANCELLED', failureCode: 'CANCELLED_BY_CUSTOMER' }),
    );
    const { unmount } = render(
      <SmartFixStatusPanel
        request={request({ status: 'RESERVED' })}
        locale="en"
        api={api({ cancel })}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: en.cancel }));
    await waitFor(() => expect(cancel).toHaveBeenCalledWith('request-1'));
    unmount();

    render(
      <SmartFixStatusPanel request={request({ status: 'VALIDATING' })} locale="en" api={api()} />,
    );
    // Past the point of no return: the only questions left are whether to
    // deliver and whether to charge.
    expect(screen.queryByRole('button', { name: en.cancel })).not.toBeInTheDocument();
  });

  it('reads in Arabic', () => {
    render(
      <SmartFixStatusPanel request={request({ status: 'DELIVERED' })} locale="ar" api={api()} />,
    );
    expect(screen.getByRole('status')).toHaveTextContent('تم التصحيح');
    expect(screen.getByText(ar.stillFailing)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// What changed
// ---------------------------------------------------------------------------

describe('SmartFixManifestPanel', () => {
  it('lists every applied change with its before and after', () => {
    render(<SmartFixManifestPanel manifest={manifest()} locale="en" />);
    expect(screen.getByText('BODY_FONT_SIZE')).toBeInTheDocument();
    expect(screen.getByText('11 POINT')).toBeInTheDocument();
    expect(screen.getByText('12 POINT')).toBeInTheDocument();
  });

  it('answers the question a person actually has about their writing', () => {
    render(<SmartFixManifestPanel manifest={manifest()} locale="en" />);
    const proofs = screen.getByRole('list', { name: en.proofTitle });
    expect(proofs).toHaveTextContent(en.proofText);
    expect(proofs).toHaveTextContent(en.proofMedia);
    expect(proofs.querySelectorAll('li')).toHaveLength(4);
    expect(screen.getAllByText(en.proofHeld)).toHaveLength(4);
  });

  it('shows a broken proof as broken rather than hiding it', () => {
    render(<SmartFixManifestPanel manifest={manifest({ textUnchanged: false })} locale="en" />);
    expect(screen.getByText(en.proofBroken)).toBeInTheDocument();
  });

  it('says so when nothing was recorded', () => {
    render(
      <SmartFixManifestPanel manifest={manifest({ entries: [], entryCount: 0 })} locale="en" />,
    );
    expect(screen.getByText(en.manifestEmpty)).toBeInTheDocument();
  });
});
