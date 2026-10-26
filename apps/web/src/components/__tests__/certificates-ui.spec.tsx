import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  CertificateCard,
  PublicCertificate,
  RevokeCertificate,
  SubmissionCertificateSection,
  type CertificateApi,
  type CertificateReviewApi,
} from '../certificate';
import { getCertificatesMessages } from '@/i18n/certificates-messages';
import type { CertificateResponse, PublicCertificateVerificationResponse } from '@/lib/api-client';

const en = getCertificatesMessages('en');
const ar = getCertificatesMessages('ar');

function label(map: Readonly<Record<string, string>>, key: string): string {
  const value = map[key];
  if (value === undefined) throw new Error(`missing message: ${key}`);
  return value;
}

const HASHES = {
  documentSha256: 'a'.repeat(64),
  reportHash: 'b'.repeat(64),
  standardContentHash: `sha256:${'c'.repeat(64)}`,
  submissionEvidenceHash: 'd'.repeat(64),
  certificateClaimHash: 'e'.repeat(64),
  certificateArtifactSha256: 'f'.repeat(64),
};

function publicResult(
  overrides: Partial<PublicCertificateVerificationResponse> = {},
): PublicCertificateVerificationResponse {
  return {
    certificateNumber: 'PC-ABCD2345-EFGH6789-JKLM0123-NPQR4567',
    verificationStatus: 'VALID',
    organizationName: 'Islamic University of Gaza',
    documentTypeName: 'Master’s thesis',
    documentFormat: 'DOCX',
    standardName: 'IUG Thesis Formatting',
    standardCode: 'IUG-THESIS',
    standardVersionLabel: 'v2.1',
    technicalResult: 'COMPLIANT',
    institutionDecision: 'APPROVED',
    issuedAt: '2026-03-04T10:00:00.000Z',
    validUntil: null,
    revokedAt: null,
    revocationReason: null,
    ...HASHES,
    ...overrides,
  };
}

function certificate(overrides: Partial<CertificateResponse> = {}): CertificateResponse {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    certificateNumber: 'PC-ABCD2345-EFGH6789-JKLM0123-NPQR4567',
    issuanceStatus: 'ISSUED',
    submissionId: '22222222-2222-4222-8222-222222222222',
    submissionRevisionId: '33333333-3333-4333-8333-333333333333',
    organizationId: '44444444-4444-4444-8444-444444444444',
    organizationName: 'Islamic University of Gaza',
    documentTypeName: 'Master’s thesis',
    documentFormat: 'DOCX',
    standardCode: 'IUG-THESIS',
    standardName: 'IUG Thesis Formatting',
    standardVersionLabel: 'v2.1',
    technicalResult: 'COMPLIANT',
    institutionDecision: 'APPROVED',
    issuedAt: '2026-03-04T10:00:00.000Z',
    validUntil: null,
    revokedAt: null,
    revocationReason: null,
    ...HASHES,
    verificationCode: 'ABCD2345EFGH6789JKLM0123NPQR4567',
    verificationUrl: 'https://palcert.test/verify/PC-ABCD2345-EFGH6789-JKLM0123-NPQR4567',
    ...overrides,
  };
}

describe('Public certificate verification', () => {
  it('states the two authorities separately, never as one verdict', () => {
    render(<PublicCertificate locale="en" result={publicResult()} />);
    expect(screen.getByText(en.technicalResult)).toBeInTheDocument();
    expect(screen.getByText(en.institutionDecision)).toBeInTheDocument();
    expect(screen.getByText(en.compliant)).toBeInTheDocument();
    expect(screen.getByText(en.approved)).toBeInTheDocument();
  });

  it('keeps the two authorities apart in Arabic too', () => {
    // §114: a single Arabic word covering both would erase in translation the
    // distinction the whole architecture exists to preserve.
    render(<PublicCertificate locale="ar" result={publicResult()} />);
    expect(screen.getByText(ar.technicalResult)).toBeInTheDocument();
    expect(screen.getByText(ar.institutionDecision)).toBeInTheDocument();
    expect(ar.technicalResult).not.toBe(ar.institutionDecision);
  });

  it('says revoked in words, and says why the claim did not change', () => {
    render(
      <PublicCertificate
        locale="en"
        result={publicResult({
          verificationStatus: 'REVOKED',
          revokedAt: '2026-05-01T09:00:00.000Z',
          revocationReason: 'ADMINISTRATIVE_CORRECTION',
        })}
      />,
    );
    expect(screen.getByText(label(en.statuses, 'REVOKED'))).toBeInTheDocument();
    expect(screen.getByText(label(en.statusHints, 'REVOKED'))).toBeInTheDocument();
    // §67: the category. Never the institution's private note.
    expect(screen.getByText(label(en.reasons, 'ADMINISTRATIVE_CORRECTION'))).toBeInTheDocument();
  });

  it('says expired without calling it revoked', () => {
    render(
      <PublicCertificate
        locale="en"
        result={publicResult({
          verificationStatus: 'EXPIRED',
          validUntil: '2026-04-01T00:00:00.000Z',
        })}
      />,
    );
    expect(screen.getByText(label(en.statuses, 'EXPIRED'))).toBeInTheDocument();
    expect(screen.queryByText(label(en.statuses, 'REVOKED'))).toBeNull();
  });

  it('shows every hash in full, because a truncated hash cannot be compared', () => {
    render(<PublicCertificate locale="en" result={publicResult()} />);
    for (const value of Object.values(HASHES)) {
      expect(screen.getByText(value)).toBeInTheDocument();
    }
  });

  it('shows nothing that identifies a person', () => {
    // §10, §11: document-bound, not person-bound. The component is given the
    // public response and has nothing else to render from — this asserts the
    // rendered page agrees.
    const { container } = render(<PublicCertificate locale="en" result={publicResult()} />);
    const text = container.textContent ?? '';
    for (const leak of ['@', 'student', 'Student']) {
      expect([leak, text.includes(leak)]).toEqual([leak, false]);
    }
  });

  it('never shows the verification code back to a verifier', () => {
    // The verifier typed the certificate number; the bare code is the holder's
    // to hand out, and the public response does not carry it at all.
    const { container } = render(<PublicCertificate locale="en" result={publicResult()} />);
    expect(container.textContent ?? '').not.toContain('ABCD2345EFGH6789JKLM0123NPQR4567');
  });
});

describe('A holder’s own certificate', () => {
  it('downloads the exact stored PDF', async () => {
    const download = vi.fn().mockResolvedValue({
      method: 'GET',
      url: 'https://storage.test/signed',
      expiresAt: '2026-03-04T10:05:00.000Z',
      filename: 'PC.pdf',
    });
    const api: CertificateApi = { download: download as unknown as CertificateApi['download'] };
    const assign = vi.fn();
    Object.defineProperty(window, 'location', {
      value: { assign },
      writable: true,
    });

    render(<CertificateCard locale="en" certificate={certificate()} api={api} />);
    fireEvent.click(screen.getByRole('button', { name: en.download }));

    await waitFor(() => expect(download).toHaveBeenCalledWith(certificate().id));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://storage.test/signed'));
  });

  it('offers no download while the certificate is still being prepared', () => {
    // And no number either: it lives in the claim, which does not exist yet.
    render(
      <CertificateCard
        locale="en"
        certificate={certificate({
          issuanceStatus: 'PENDING',
          issuedAt: null,
          certificateNumber: null,
          verificationCode: null,
          verificationUrl: null,
        })}
      />,
    );
    expect(screen.queryByRole('button', { name: en.download })).toBeNull();
    expect(screen.getByText(label(en.issuanceStatuses, 'PENDING'))).toBeInTheDocument();
  });

  it('still offers the download once revoked', () => {
    // §70: the artifact is the record of what was issued. Hiding it would not
    // unsay it, and the holder may well need to show what they were given.
    render(
      <CertificateCard
        locale="en"
        certificate={certificate({
          issuanceStatus: 'REVOKED',
          revokedAt: '2026-05-01T09:00:00.000Z',
        })}
      />,
    );
    expect(screen.getByRole('button', { name: en.download })).toBeInTheDocument();
    expect(screen.getByText(label(en.statuses, 'REVOKED'))).toBeInTheDocument();
  });
});

describe('A submission with no certificate', () => {
  it('blames PalCert’s measurement when PalCert’s measurement is the reason', () => {
    render(
      <SubmissionCertificateSection
        locale="en"
        status={{ eligible: false, reason: 'NOT_COMPLIANT', certificate: null }}
      />,
    );
    const text = screen.getByText(label(en.ineligible, 'NOT_COMPLIANT')).textContent ?? '';
    expect(text).toMatch(/PalCert/);
    expect(text).not.toMatch(/rejected/i);
  });

  it('says the institution has not decided when it has not', () => {
    render(
      <SubmissionCertificateSection
        locale="en"
        status={{ eligible: false, reason: 'AWAITING_INSTITUTION_DECISION', certificate: null }}
      />,
    );
    expect(
      screen.getByText(label(en.ineligible, 'AWAITING_INSTITUTION_DECISION')),
    ).toBeInTheDocument();
  });

  it('never offers a way to ask for one', () => {
    // §190, §191: there is no self-certification, so there is no button.
    const { container } = render(
      <SubmissionCertificateSection
        locale="en"
        status={{ eligible: false, reason: 'NOT_APPROVED', certificate: null }}
      />,
    );
    expect(container.querySelectorAll('button')).toHaveLength(0);
  });
});

describe('Revoking a certificate', () => {
  it('sends a closed reason code and a private comment', async () => {
    const revoke = vi.fn().mockResolvedValue(certificate({ issuanceStatus: 'REVOKED' }));
    const api: CertificateReviewApi = {
      revoke: revoke as unknown as CertificateReviewApi['revoke'],
    };

    render(
      <RevokeCertificate
        locale="en"
        organizationId="org"
        certificateId="cert"
        api={api}
        onRevoked={() => undefined}
      />,
    );

    fireEvent.change(screen.getByLabelText(en.revokeReasonLabel), {
      target: { value: 'SECURITY_INCIDENT' },
    });
    fireEvent.change(screen.getByLabelText(en.revokeCommentLabel), {
      target: { value: '  looked into by the registrar  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: en.revoke }));

    await waitFor(() =>
      expect(revoke).toHaveBeenCalledWith('org', 'cert', {
        reasonCode: 'SECURITY_INCIDENT',
        comment: 'looked into by the registrar',
      }),
    );
  });

  it('warns that it cannot be undone, and that the note stays private', () => {
    render(<RevokeCertificate locale="en" organizationId="org" certificateId="cert" />);
    expect(screen.getByText(en.revokeHint)).toBeInTheDocument();
    expect(screen.getByText(en.revokeCommentHint)).toBeInTheDocument();
  });

  it('offers only the closed list of reasons', () => {
    render(<RevokeCertificate locale="en" organizationId="org" certificateId="cert" />);
    const options = screen.getAllByRole('option').map((option) => option.textContent);
    expect(options).toEqual([
      label(en.reasons, 'ISSUED_IN_ERROR'),
      label(en.reasons, 'EVIDENCE_INTEGRITY_FAILURE'),
      label(en.reasons, 'ADMINISTRATIVE_CORRECTION'),
      label(en.reasons, 'SECURITY_INCIDENT'),
      label(en.reasons, 'OTHER'),
    ]);
  });
});
