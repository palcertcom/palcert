import type { PublicAttestationView } from '@palcert/contracts';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PublicAttestationVerification,
  shortFingerprint,
  validityTone,
  type CompareFile,
} from '../attestation-verification';
import { getAttestationsMessages } from '@/i18n/attestations-messages';

const en = getAttestationsMessages('en');
const ar = getAttestationsMessages('ar');
const SHA = 'ab'.repeat(32);
const OTHER = 'ef'.repeat(32);

function view(overrides: Partial<PublicAttestationView> = {}): PublicAttestationView {
  return {
    verifiedBy: 'PalCert',
    reference: 'PC-ATT-2026-ABCDEFGH',
    verificationStatus: 'VALID',
    organization: { name: 'University A', verified: true },
    attestationType: { en: 'Degree certificate', ar: 'شهادة درجة علمية' },
    certificate: {
      title: 'Bachelor of Science',
      type: null,
      holderName: 'Sara Haddad',
      issuingOrganization: 'Example University',
      issueDate: '2024-06-30',
      referenceNumber: 'BSC-1',
    },
    validFrom: '2026-06-01T12:00:00.000Z',
    validUntil: '2027-06-01T12:00:00.000Z',
    attestedAt: '2026-06-01T12:00:00.000Z',
    revokedAt: null,
    artifactSha256: SHA,
    artifactMimeType: 'application/pdf',
    attestationHash: 'cd'.repeat(32),
    ...overrides,
  };
}

const EXPIRED = { verificationStatus: 'EXPIRED', validUntil: '2026-07-01T12:00:00.000Z' } as const;
const REVOKED = { verificationStatus: 'REVOKED', revokedAt: '2026-07-01T00:00:00.000Z' } as const;

/** A comparison that answers as the real one would for these two digests. */
const compareAs =
  (outcome: 'match' | 'differs' | 'other'): CompareFile =>
  async () => ({ digest: outcome === 'match' ? SHA : OTHER, outcome });

function renderPage(
  overrides: Partial<PublicAttestationView> = {},
  compare: CompareFile = compareAs('match'),
  locale: 'en' | 'ar' = 'en',
) {
  return render(
    <PublicAttestationVerification
      view={view(overrides)}
      messages={locale === 'en' ? en : ar}
      locale={locale}
      compare={compare}
    />,
  );
}

async function pick(file: File) {
  fireEvent.change(screen.getByTestId('verify-file-input'), { target: { files: [file] } });
  await waitFor(() =>
    expect(screen.getByTestId('verify-file-result').querySelector('[data-outcome]')).not.toBeNull(),
  );
}

const png = () =>
  new File([new Uint8Array([137, 80, 78, 71])], 'diploma.png', { type: 'image/png' });
const pdf = () => new File(['%PDF-1.7'], 'diploma.pdf', { type: 'application/pdf' });
const docx = () =>
  new File(['PK'], 'diploma.docx', {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  });

const created: string[] = [];
beforeEach(() => {
  created.length = 0;
  let next = 0;
  URL.createObjectURL = vi.fn(() => {
    const url = `blob:https://palcert.test/${(next += 1)}`;
    created.push(url);
    return url;
  });
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => vi.restoreAllMocks());

const validity = () => screen.getByTestId('attestation-validity');
const result = () => screen.getByTestId('verify-file-result');

describe('attestation validity', () => {
  it('valid attestation: green, with a check icon and the words', () => {
    renderPage();
    expect(validity().getAttribute('data-tone')).toBe('success');
    expect(screen.getByTestId('public-attestation-status').textContent).toBe('Valid attestation');
    expect(within(validity()).getByText(en.public.validityExplanations['VALID']!)).toBeTruthy();
    expect(validity().querySelector('svg')).not.toBeNull();
  });

  it('expired attestation: red, and says when it expired', () => {
    renderPage(EXPIRED);
    expect(validity().getAttribute('data-tone')).toBe('danger');
    expect(screen.getByTestId('public-attestation-status').textContent).toBe('Expired attestation');
    expect(within(validity()).getByText(en.public.expiredOn)).toBeTruthy();
    expect(screen.getByTestId('public-expired-on').textContent).toMatch(/2026/);
  });

  it('revoked attestation: red, in words', () => {
    renderPage(REVOKED);
    expect(validity().getAttribute('data-tone')).toBe('danger');
    expect(screen.getByTestId('public-attestation-status').textContent).toBe('Revoked attestation');
    expect(within(validity()).getByText(en.public.revokedOn)).toBeTruthy();
  });

  it('maps every status to a tone, and never treats an unknown one as in force', () => {
    expect(validityTone('VALID')).toBe('success');
    expect(validityTone('EXPIRED')).toBe('danger');
    expect(validityTone('REVOKED')).toBe('danger');
    expect(validityTone('SOMETHING_NEW')).toBe('danger');
  });
});

describe('attested document card', () => {
  it('shows facts about the file, never the file', () => {
    renderPage();
    const card = screen.getByTestId('attested-document');
    expect(within(card).getByText('Attested document')).toBeTruthy();
    expect(within(card).getByText('Bachelor of Science')).toBeTruthy();
    expect(within(card).getByText('University A')).toBeTruthy();
    expect(screen.getByTestId('attested-document-type').textContent).toBe('PDF document');
    expect(screen.getByTestId('attested-document-fingerprint').textContent).toBe(
      shortFingerprint(SHA),
    );
    expect(within(card).getByText('PC-ATT-2026-ABCDEFGH')).toBeTruthy();
    expect(screen.getByTestId('attested-document-validity').textContent).toBe('Valid');
    expect(screen.getByTestId('attested-document-privacy').textContent).toBe(
      'The attested file is not published. Ask the holder for the file, then check it below.',
    );
    // Nothing that could fetch or offer the attested file.
    expect(card.querySelector('img, object, embed, iframe, a')).toBeNull();
    expect(
      document.querySelector('a[download], a[href*="artifact"], object, embed, iframe'),
    ).toBeNull();
  });

  it('carries the validity on its own badge: red when expired', () => {
    renderPage(EXPIRED);
    const badge = screen.getByTestId('attested-document-validity');
    expect(badge.getAttribute('data-tone')).toBe('danger');
    expect(badge.textContent).toBe('Expired');
  });

  it('shortens the fingerprint to its head and tail', () => {
    expect(shortFingerprint(SHA)).toBe(`${SHA.slice(0, 10)}…${SHA.slice(-8)}`);
  });
});

describe('file comparison', () => {
  it('starts empty, with both panels side by side and nothing decided', () => {
    renderPage();
    expect(screen.getByTestId('verify-compare').getAttribute('data-outcome')).toBe('none');
    expect(screen.getByTestId('visitor-file-empty')).toBeTruthy();
    expect(screen.getByText('File you selected')).toBeTruthy();
  });

  it('exact file: green Match confirmed, green frames on both panels', async () => {
    renderPage({}, compareAs('match'));
    await pick(png());
    const block = result().querySelector('.pc-verify-result')!;
    expect(block.getAttribute('data-tone')).toBe('success');
    expect(within(result()).getByText('Match confirmed')).toBeTruthy();
    expect(within(result()).getByText(en.public.matchText)).toBeTruthy();
    expect(screen.getByTestId('attested-document').getAttribute('data-frame')).toBe('success');
    expect(screen.getByTestId('visitor-file').getAttribute('data-frame')).toBe('success');
  });

  it('different file: red Not a match, red frame on the visitor’s file only', async () => {
    renderPage({}, compareAs('differs'));
    await pick(png());
    expect(result().querySelector('.pc-verify-result')!.getAttribute('data-tone')).toBe('danger');
    expect(within(result()).getByText('Not a match')).toBeTruthy();
    expect(within(result()).getByText(en.public.mismatchText)).toBeTruthy();
    expect(screen.getByTestId('visitor-file').getAttribute('data-frame')).toBe('danger');
    expect(screen.getByTestId('attested-document').getAttribute('data-frame')).toBe('neutral');
  });

  it('a file of another attestation is still not a match for this one', async () => {
    renderPage({}, compareAs('other'));
    await pick(png());
    expect(within(result()).getByText('Not a match')).toBeTruthy();
    expect(within(result()).getByText(en.public.fileMatchesOther)).toBeTruthy();
  });

  it('decides by the comparison result, never by the file name', async () => {
    renderPage({}, compareAs('differs'));
    await pick(new File(['x'], 'PC-ATT-2026-ABCDEFGH.pdf', { type: 'application/pdf' }));
    expect(within(result()).getByText('Not a match')).toBeTruthy();
  });
});

describe('two independent answers', () => {
  it('expired + matching file: red validity AND green match, at the same time', async () => {
    renderPage(EXPIRED, compareAs('match'));
    await pick(png());
    expect(validity().getAttribute('data-tone')).toBe('danger');
    expect(screen.getByTestId('public-attestation-status').textContent).toBe('Expired attestation');
    expect(result().querySelector('.pc-verify-result')!.getAttribute('data-tone')).toBe('success');
    expect(within(result()).getByText('Match confirmed')).toBeTruthy();
    expect(screen.getByTestId('attested-document-validity').getAttribute('data-tone')).toBe(
      'danger',
    );
  });

  it('valid + different file: green validity AND red mismatch, at the same time', async () => {
    renderPage({}, compareAs('differs'));
    await pick(png());
    expect(validity().getAttribute('data-tone')).toBe('success');
    expect(result().querySelector('.pc-verify-result')!.getAttribute('data-tone')).toBe('danger');
    expect(within(result()).getByText('Not a match')).toBeTruthy();
  });
});

describe('local preview of the visitor’s file', () => {
  it('previews an image from a local object URL', async () => {
    renderPage();
    await pick(png());
    const image = screen.getByTestId('visitor-file-image');
    expect(image.getAttribute('src')).toBe(created[0]);
    expect(image.getAttribute('src')!.startsWith('blob:')).toBe(true);
    expect(image.getAttribute('alt')).toBe(en.public.imagePreviewAlt);
    expect(screen.getByTestId('visitor-file-name').textContent).toBe('diploma.png');
  });

  it('does not embed a PDF, and offers a local preview in a new tab instead', async () => {
    renderPage();
    await pick(pdf());
    expect(document.querySelector('object, embed, iframe')).toBeNull();
    expect(screen.getByText(en.public.pdfNotEmbedded)).toBeTruthy();
    const open = screen.getByTestId('visitor-file-open');
    expect(open.getAttribute('href')!.startsWith('blob:')).toBe(true);
    expect(open.getAttribute('target')).toBe('_blank');
    expect(open.getAttribute('rel')).toContain('noopener');
  });

  it('shows a file card for a format it cannot preview, and creates no URL for it', async () => {
    renderPage();
    await pick(docx());
    expect(screen.getByTestId('visitor-file-no-preview')).toBeTruthy();
    expect(screen.getByTestId('visitor-file-name').textContent).toBe('diploma.docx');
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it('releases the previous local URL when another file is chosen', async () => {
    renderPage();
    await pick(png());
    await pick(new File([new Uint8Array([1])], 'second.png', { type: 'image/png' }));
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(created[0]);
  });

  it('hands the file to the comparison only — nothing else sees it', async () => {
    const compare = vi.fn(compareAs('match'));
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    renderPage({}, compare);
    const file = png();
    await pick(file);
    expect(compare).toHaveBeenCalledWith(file);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('technical details', () => {
  it('keeps the full fingerprints, reference, dates and format, lower down', () => {
    renderPage();
    const technical = screen.getByTestId('technical-details');
    expect(within(technical).getByText('Technical details')).toBeTruthy();
    expect(screen.getByTestId('public-sha256').textContent).toBe(SHA);
    expect(within(technical).getByText('cd'.repeat(32))).toBeTruthy();
    expect(within(technical).getByText('application/pdf')).toBeTruthy();
    expect(screen.getByTestId('public-valid-until').textContent).toMatch(/2027/);
    // Order on the page: validity, comparison, details, technical.
    const order = [
      'attestation-validity',
      'verify-compare',
      'attestation-details',
      'technical-details',
    ];
    const nodes = order.map((id) => screen.getByTestId(id));
    for (let i = 1; i < nodes.length; i += 1) {
      expect(
        nodes[i - 1]!.compareDocumentPosition(nodes[i]!) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }
    expect(screen.getByTestId('attestation-disclaimer').textContent).toBe(en.disclaimer);
  });

  it('omits what the institution chose not to publish', () => {
    renderPage({
      certificate: { ...view().certificate, holderName: null, referenceNumber: null },
    });
    expect(screen.queryByText('Sara Haddad')).toBeNull();
    expect(screen.queryByText(en.public.holder)).toBeNull();
  });
});

describe('Arabic', () => {
  it('says every state in Arabic, with technical strings left-to-right', async () => {
    renderPage({}, compareAs('match'), 'ar');
    expect(screen.getByTestId('public-attestation-status').textContent).toBe('مصادقة سارية');
    expect(screen.getByText('المستند المصدق')).toBeTruthy();
    expect(screen.getByTestId('attested-document-privacy').textContent).toBe(
      'لا يتم نشر المستند المصدق. اطلب الملف من صاحبه، ثم تحقّق منه أدناه.',
    );
    expect(screen.getByText('التفاصيل التقنية')).toBeTruthy();
    expect(screen.getByTestId('attested-document-fingerprint').getAttribute('dir')).toBe('ltr');
    await pick(png());
    expect(within(result()).getByText('تم تأكيد التطابق')).toBeTruthy();
    expect(within(result()).getByText(ar.public.matchText)).toBeTruthy();
    expect(screen.getByText('الملف الذي اخترته')).toBeTruthy();
  });

  it('expired and revoked, and a mismatch, in Arabic', async () => {
    const { unmount } = renderPage(EXPIRED, compareAs('differs'), 'ar');
    expect(screen.getByTestId('public-attestation-status').textContent).toBe('مصادقة منتهية');
    await pick(png());
    expect(within(result()).getByText('غير مطابق')).toBeTruthy();
    expect(within(result()).getByText(ar.public.mismatchText)).toBeTruthy();
    unmount();
    renderPage(REVOKED, compareAs('match'), 'ar');
    expect(screen.getByTestId('public-attestation-status').textContent).toBe('مصادقة ملغاة');
    expect(screen.getByTestId('attestation-disclaimer').textContent).toBe(ar.disclaimer);
  });
});
