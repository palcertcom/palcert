import type {
  AttestationRequestReviewView,
  AttestationCatalogueOrganizationView,
  AttestationQuoteView,
  AttestationRecordView,
  AttestationRequestOwnerView,
  AttestationTypePublicView,
} from '@palcert/contracts';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AttestationRecordCard } from '../attestation';
import { ApproveDialog } from '../attestation-approve';
import { AttestationWizard } from '../attestation-wizard';
import { getAttestationsMessages } from '@/i18n/attestations-messages';
import { permissionsForRoles } from '@/lib/organization-permissions';
import { organizationSections } from '@/lib/organization-sections';
import { adminNavigation, buildNavigation } from '@/lib/shell-navigation';
import type { attestationsApi } from '@/lib/attestations-api';

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const en = getAttestationsMessages('en');
const SHA = 'ab'.repeat(32);
const USD = (minorUnits: string) => ({ currency: 'USD', minorUnits });

function record(overrides: Partial<AttestationRecordView> = {}): AttestationRecordView {
  return {
    id: 'att-1',
    reference: 'PC-ATT-2026-ABCDEFGH',
    verificationStatus: 'VALID',
    organizationName: 'University A',
    attestationTypeName: { en: 'Degree certificate', ar: 'شهادة درجة علمية' },
    confirmed: {
      certificateTitle: 'Bachelor of Science',
      certificateType: null,
      holderName: 'Sara Haddad',
      issuingOrganization: null,
      issueDate: null,
      referenceNumber: null,
      holderNamePublic: true,
      referenceNumberPublic: true,
    },
    artifactSha256: SHA,
    artifactSizeBytes: 516,
    artifactMimeType: 'application/pdf',
    attestationHash: 'cd'.repeat(32),
    validFrom: '2026-06-01T12:00:00.000Z',
    validUntil: '2027-06-01T12:00:00.000Z',
    approvedAt: '2026-06-01T12:00:00.000Z',
    revokedAt: null,
    revocationReason: null,
    institutionNote: null,
    verificationUrl: 'https://palcert.example/verify/attestation/TOKEN123',
    previousAttestationId: null,
    ...overrides,
  };
}

describe('attestation record card', () => {
  it('shows the reference, fingerprint, verification link and validity', () => {
    render(<AttestationRecordCard record={record()} messages={en} locale="en" qr={null} />);
    expect(screen.getByTestId('attestation-reference').textContent).toBe('PC-ATT-2026-ABCDEFGH');
    expect(screen.getByTestId('attestation-sha256').textContent).toBe(SHA);
    expect(screen.getByTestId('attestation-verification-url').getAttribute('href')).toBe(
      'https://palcert.example/verify/attestation/TOKEN123',
    );
    expect(screen.getByTestId('attestation-valid-until').textContent).not.toBe(en.noExpiry);
  });

  it('says "No expiry" when there is none', () => {
    render(
      <AttestationRecordCard
        record={record({ validUntil: null })}
        messages={en}
        locale="en"
        qr={null}
      />,
    );
    expect(screen.getByTestId('attestation-valid-until').textContent).toBe(en.noExpiry);
  });
});

// ---------------------------------------------------------------------------
// The wizard
// ---------------------------------------------------------------------------

const ORG: AttestationCatalogueOrganizationView = {
  id: 'org-1',
  displayName: 'University A',
  slug: 'university-a',
  verified: true,
  typeCount: 1,
};

const TYPE: AttestationTypePublicView = {
  id: 'type-1',
  organizationId: 'org-1',
  nameEn: 'Degree certificate',
  nameAr: 'شهادة درجة علمية',
  descriptionEn: null,
  descriptionAr: null,
  instructionsEn: 'Upload the whole certificate.',
  instructionsAr: null,
  fee: USD('1000'),
  defaultValidityDays: 365,
  requiredFields: [],
  allowedFormats: ['PDF', 'PNG'],
  maxFileBytes: 20 * 1024 * 1024,
};

function draft(overrides: Partial<AttestationRequestOwnerView> = {}): AttestationRequestOwnerView {
  return {
    id: 'req-1',
    status: 'DRAFT',
    organizationId: 'org-1',
    organizationName: 'University A',
    attestationTypeId: 'type-1',
    attestationTypeName: { en: 'Degree certificate', ar: 'شهادة درجة علمية' },
    submitted: {
      certificateTitle: 'Bachelor of Science',
      certificateType: null,
      issuingOrganization: null,
      issueDate: null,
      referenceNumber: null,
      recipientName: null,
      description: null,
    },
    notesForReviewer: null,
    artifact: {
      id: 'art-1',
      status: 'READY',
      originalFilename: 'degree.pdf',
      detectedFormat: 'PDF',
      detectedMimeType: 'application/pdf',
      sizeBytes: 516,
      sha256: SHA,
      rejectionCode: null,
      createdAt: '2026-06-01T12:00:00.000Z',
      readyAt: '2026-06-01T12:00:00.000Z',
    },
    previousAttestationId: null,
    createdAt: '2026-06-01T12:00:00.000Z',
    submittedAt: null,
    reviewStartedAt: null,
    decidedAt: null,
    cancelledAt: null,
    updatedAt: '2026-06-01T12:00:00.000Z',
    openInformationRequest: null,
    rejectionReason: null,
    history: [],
    attestation: null,
    fee: { fee: USD('1000'), paymentStatus: 'UNPAID' },
    canCancel: true,
    canRespond: false,
    canSubmit: true,
    ...overrides,
  };
}

function quote(available: string): AttestationQuoteView {
  const fee = 1000n;
  const have = BigInt(available);
  return {
    attestationTypeId: 'type-1',
    fee: USD('1000'),
    availableBalance: USD(available),
    sufficient: have >= fee,
    shortfall: USD(have >= fee ? '0' : String(fee - have)),
  };
}

function fakeApi(available: string) {
  const api = {
    catalogue: vi.fn(async () => [ORG]),
    catalogueTypes: vi.fn(async () => [TYPE]),
    get: vi.fn(async () => draft()),
    create: vi.fn(async (_input: Record<string, unknown>, _key: string) =>
      draft({ artifact: null }),
    ),
    update: vi.fn(async () => draft()),
    quote: vi.fn(async () => quote(available)),
    submit: vi.fn(async () => draft({ status: 'SUBMITTED' })),
    createArtifact: vi.fn(),
    finalizeArtifact: vi.fn(),
  };
  return api as unknown as typeof attestationsApi & typeof api;
}

describe('attestation wizard', () => {
  it('walks institution → type → details, creating the draft once', async () => {
    const api = fakeApi('2000');
    render(<AttestationWizard locale="en" messages={en} api={api} onSubmitted={vi.fn()} />);
    fireEvent.click(await screen.findByLabelText(/University A/));
    fireEvent.click(screen.getByRole('button', { name: en.wizard.next }));
    fireEvent.click(await screen.findByLabelText(/Degree certificate/));
    fireEvent.click(screen.getByRole('button', { name: en.wizard.next }));
    fireEvent.change(screen.getByLabelText(new RegExp(en.fields['certificateTitle']!)), {
      target: { value: 'Bachelor of Science' },
    });
    fireEvent.click(screen.getByRole('button', { name: en.wizard.createDraft }));
    await waitFor(() => expect(api.create).toHaveBeenCalledTimes(1));
    expect(api.create.mock.calls[0]![0]).toMatchObject({
      attestationTypeId: 'type-1',
      certificateTitle: 'Bachelor of Science',
    });
    // No file yet: the file step is next.
    expect(await screen.findByLabelText(en.wizard.chooseFile)).toBeTruthy();
  });

  it('refuses to submit when the balance is short, and offers a top-up', async () => {
    const api = fakeApi('500');
    render(
      <AttestationWizard
        locale="en"
        messages={en}
        api={api}
        draftId="req-1"
        onSubmitted={vi.fn()}
      />,
    );
    const alert = await screen.findByTestId('insufficient-balance');
    expect(alert.textContent).toContain('$5.00');
    expect(screen.getByRole('link', { name: en.wizard.topUp }).getAttribute('href')).toBe(
      '/en/balance',
    );
    expect((screen.getByTestId('submit-attestation') as HTMLButtonElement).disabled).toBe(true);
    expect(api.submit).not.toHaveBeenCalled();
  });

  it('shows the fee against the balance and submits once', async () => {
    const api = fakeApi('2000');
    const onSubmitted = vi.fn();
    render(
      <AttestationWizard
        locale="en"
        messages={en}
        api={api}
        draftId="req-1"
        onSubmitted={onSubmitted}
      />,
    );
    expect((await screen.findByTestId('quote-fee')).textContent).toBe('$10.00');
    expect(screen.getByTestId('quote-balance').textContent).toBe('$20.00');
    const submit = screen.getByTestId('submit-attestation') as HTMLButtonElement;
    await waitFor(() => expect(submit.disabled).toBe(false));
    fireEvent.click(submit);
    await waitFor(() => expect(onSubmitted).toHaveBeenCalledWith('req-1'));
    expect(api.submit).toHaveBeenCalledTimes(1);
  });

  it('explains a rejected file instead of offering to continue', async () => {
    const api = fakeApi('2000');
    api.get.mockResolvedValue(
      draft({
        artifact: {
          ...draft().artifact!,
          status: 'REJECTED',
          sha256: null,
          rejectionCode: 'FILE_TYPE_MISMATCH',
        },
      }),
    );
    render(
      <AttestationWizard
        locale="en"
        messages={en}
        api={api}
        draftId="req-1"
        onSubmitted={vi.fn()}
      />,
    );
    expect(await screen.findByText(en.rejections['FILE_TYPE_MISMATCH']!)).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: en.wizard.next }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Where the screens are offered
// ---------------------------------------------------------------------------

describe('attestation navigation', () => {
  const hrefs = (groups: ReturnType<typeof buildNavigation>) =>
    groups.flatMap((group) => group.items.map((item) => item.href));

  it('offers "Attestations" to anyone who may read their own', () => {
    const groups = buildNavigation({
      locale: 'en',
      globalPermissions: permissionsForRoles(['STUDENT']),
      organizationId: null,
      organizationPermissions: new Set(),
      unreadNotifications: null,
    });
    expect(hrefs(groups)).toContain('/en/attestations');
  });

  it('offers the queue to reviewers and the types to administrators only', () => {
    const keys = (role: string) =>
      organizationSections('en', 'org-1', permissionsForRoles([role])).map(
        (section) => section.key,
      );
    expect(keys('ORGANIZATION_OWNER')).toEqual(
      expect.arrayContaining(['attestations', 'attestation-types']),
    );
    expect(keys('ORGANIZATION_REVIEWER')).toContain('attestations');
    expect(keys('ORGANIZATION_REVIEWER')).not.toContain('attestation-types');
    expect(keys('TEMPLATE_MANAGER')).not.toContain('attestations');
  });

  it('offers PalCert attestation finance to finance roles and not to support', () => {
    expect(
      adminNavigation('en', permissionsForRoles(['PALCERT_FINANCE'])).map((item) => item.href),
    ).toContain('/en/admin/attestations');
    expect(
      adminNavigation('en', permissionsForRoles(['PALCERT_SUPPORT'])).map((item) => item.href),
    ).not.toContain('/en/admin/attestations');
  });
});

// ---------------------------------------------------------------------------
// Approval
// ---------------------------------------------------------------------------

function reviewView(
  policy: AttestationRequestReviewView['typePolicy'],
): AttestationRequestReviewView {
  const {
    fee: _fee,
    canCancel: _c,
    canRespond: _r,
    canSubmit: _s,
    ...base
  } = draft({ status: 'IN_REVIEW' });
  return {
    ...base,
    owner: { displayName: 'Sara Haddad', email: 'sara@example.test' },
    feeSnapshot: {
      gross: USD('1000'),
      platformFee: USD('150'),
      institutionNet: USD('850'),
      platformCommissionPercent: '15.00',
      institutionSharePercent: '85.00',
      pricedAt: '2026-06-01T12:00:00.000Z',
      paymentStatus: 'RESERVED',
    },
    assignedReviewer: null,
    sameArtifactRequests: [],
    typePolicy: policy,
  };
}

describe('approve dialog', () => {
  async function approveWith(policy: AttestationRequestReviewView['typePolicy'], days?: string) {
    const onApprove = vi.fn(async () => undefined);
    render(<ApproveDialog view={reviewView(policy)} messages={en} onApprove={onApprove} />);
    fireEvent.click(screen.getByTestId('approve-open'));
    if (days !== undefined)
      fireEvent.change(screen.getByLabelText(en.review.validityDaysLabel), {
        target: { value: days },
      });
    fireEvent.click(screen.getByTestId('approve-submit'));
    return onApprove;
  }

  it('refuses to approve without the reviewer’s confirmation', async () => {
    const onApprove = await approveWith({
      defaultValidityDays: 365,
      allowNoExpiry: false,
      reviewerMayOverrideValidity: true,
    });
    expect(await screen.findByText(en.errors['ATTESTATION_CONFIRMATION_REQUIRED']!)).toBeTruthy();
    expect(onApprove).not.toHaveBeenCalled();
  });

  it('sends the type default as "nothing chosen", so a fixed-validity type accepts it', async () => {
    const onApprove = vi.fn(async () => undefined);
    render(
      <ApproveDialog
        view={reviewView({
          defaultValidityDays: 365,
          allowNoExpiry: false,
          reviewerMayOverrideValidity: false,
        })}
        messages={en}
        onApprove={onApprove}
      />,
    );
    fireEvent.click(screen.getByTestId('approve-open'));
    fireEvent.click(screen.getByTestId('approve-confirm'));
    fireEvent.click(screen.getByTestId('approve-submit'));
    await waitFor(() => expect(onApprove).toHaveBeenCalledTimes(1));
    const input = (onApprove.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(input).toMatchObject({
      confirm: true,
      certificateTitle: 'Bachelor of Science',
      holderNamePublic: true,
    });
    expect(input).not.toHaveProperty('validityDays');
    expect(input).not.toHaveProperty('noExpiry');
  });

  it('sends an override only when the reviewer changed the period', async () => {
    const onApprove = vi.fn(async () => undefined);
    render(
      <ApproveDialog
        view={reviewView({
          defaultValidityDays: 365,
          allowNoExpiry: false,
          reviewerMayOverrideValidity: true,
        })}
        messages={en}
        onApprove={onApprove}
      />,
    );
    fireEvent.click(screen.getByTestId('approve-open'));
    fireEvent.change(screen.getByLabelText(en.review.validityDaysLabel), {
      target: { value: '730' },
    });
    fireEvent.click(screen.getByTestId('approve-confirm'));
    fireEvent.click(screen.getByTestId('approve-submit'));
    await waitFor(() => expect(onApprove).toHaveBeenCalledTimes(1));
    expect((onApprove.mock.calls[0] as unknown as [Record<string, unknown>])[0]).toMatchObject({
      validityDays: 730,
    });
  });
});
