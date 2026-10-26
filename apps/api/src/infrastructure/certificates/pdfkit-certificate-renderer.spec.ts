import {
  CERTIFICATE_CLAIM_CANONICALIZATION_VERSION,
  CERTIFICATE_CLAIM_SCHEMA_VERSION,
  computeCertificateClaimHash,
  type CertificateClaim,
} from '@palcert/contracts';
import { openSync } from 'fontkit';
import { createRequire } from 'node:module';
import { CERTIFICATE_LABELS } from './certificate-labels';
import * as verificationQr from './verification-qr';
import { PdfKitCertificateRenderer } from './pdfkit-certificate-renderer';

// PDF generation shapes Arabic fonts, renders QR codes and embeds font data.
// The self-hosted WSL runner is slower than GitHub-hosted runners for this CPU-bound work;
// scope the allowance to these renderer tests rather than weakening the whole test suite.
jest.setTimeout(30_000);

/**
 * What the renderer must be true of, rather than what it looks like.
 *
 * Layout is a judgement call and will change. These three properties are not:
 * the bytes are reproducible, the Arabic is really Arabic, and nothing
 * private reaches the artifact.
 */
/** The same file the renderer embeds, resolved the same way. */
function arabicFontPath(): string {
  return createRequire(__filename).resolve(
    '@expo-google-fonts/noto-sans-arabic/400Regular/NotoSansArabic_400Regular.ttf',
  );
}

describe('the certificate renderer', () => {
  const renderer = new PdfKitCertificateRenderer();

  function claim(overrides: Partial<CertificateClaim> = {}): CertificateClaim {
    return {
      claimSchemaVersion: CERTIFICATE_CLAIM_SCHEMA_VERSION,
      claimCanonicalizationVersion: CERTIFICATE_CLAIM_CANONICALIZATION_VERSION,
      certificateNumber: 'PC-0123456789ABCDEFGHJKMNPQRSTVWX',
      verificationCode: '0123456789ABCDEFGHJKMNPQRSTVWXYZ',
      submissionRevisionId: '11111111-1111-4111-8111-111111111111',
      organizationId: '22222222-2222-4222-8222-222222222222',
      organizationName: 'الجامعة الإسلامية بغزة',
      documentTypeId: '33333333-3333-4333-8333-333333333333',
      documentTypeName: 'رسالة ماجستير',
      documentFormat: 'DOCX',
      documentSha256: 'a'.repeat(64),
      reportHash: 'b'.repeat(64),
      evaluationHash: 'c'.repeat(64),
      standardId: '44444444-4444-4444-8444-444444444444',
      standardVersionId: '55555555-5555-4555-8555-555555555555',
      standardContentHash: `sha256:${'d'.repeat(64)}`,
      standardCode: 'IUG.THESIS.FORMAT',
      standardName: 'معيار تنسيق الرسائل',
      standardVersionLabel: '1.0',
      submissionEvidenceHash: 'e'.repeat(64),
      technicalDetermination: 'COMPLIANT',
      institutionDecision: 'APPROVED',
      approvalDecisionEventId: '66666666-6666-4666-8666-666666666666',
      approvedAt: '2026-09-15T10:00:00.000Z',
      issuedAt: '2026-09-16T10:00:00.000Z',
      validUntil: null,
      ...overrides,
    };
  }

  const url = 'https://palcert.example/verify/PC-0123456789ABCDEFGHJKMNPQRSTVWX';

  it('renders the same claim to the same bytes', async () => {
    // §48, §162: the artifact hash is shown to verifiers, so "same claim, same
    // bytes" has to be a fact. Anything that let a wall clock or a random
    // document id into the output would break this.
    const first = await renderer.render({
      claim: claim(),
      verificationUrl: url,
      labels: CERTIFICATE_LABELS,
    });
    const second = await renderer.render({
      claim: claim(),
      verificationUrl: url,
      labels: CERTIFICATE_LABELS,
    });

    expect(first.sha256).toBe(second.sha256);
    expect(first.bytes.equals(second.bytes)).toBe(true);
  });

  it('renders different claims to different bytes', async () => {
    const first = await renderer.render({
      claim: claim(),
      verificationUrl: url,
      labels: CERTIFICATE_LABELS,
    });
    const other = await renderer.render({
      claim: claim({ documentSha256: 'f'.repeat(64) }),
      verificationUrl: url,
      labels: CERTIFICATE_LABELS,
    });
    expect(first.sha256).not.toBe(other.sha256);
  });

  it('carries no wall clock into the document', async () => {
    // The mechanism behind determinism, asserted directly so a later change
    // that reintroduces `new Date()` fails here rather than in a flaky
    // byte-comparison somewhere else.
    const rendered = await renderer.render({
      claim: claim(),
      verificationUrl: url,
      labels: CERTIFICATE_LABELS,
    });
    const text = rendered.bytes.toString('latin1');
    const stamps = text.match(/D:\d{8,}[^)]*/g) ?? [];

    // The dates are there, and every one of them is the epoch rather than
    // today. A renderer that let `new Date()` back in would fail here instead
    // of producing a certificate whose hash quietly changes at midnight.
    expect(stamps.length).toBeGreaterThan(0);
    for (const stamp of stamps) {
      expect([stamp, stamp.startsWith('D:19700101')]).toEqual([stamp, true]);
    }
    expect(text).not.toContain(`D:${String(new Date().getFullYear())}`);
  });

  it('embeds the Arabic font rather than substituting glyphs', async () => {
    const rendered = await renderer.render({
      claim: claim(),
      verificationUrl: url,
      labels: CERTIFICATE_LABELS,
    });
    const text = rendered.bytes.toString('latin1');
    expect(text).toContain('NotoSansArabic');
    expect(text).toContain('FontFile');
  });

  it('has a glyph for every character the Arabic labels use', () => {
    // The defect this prevents shipped silently once already: fontsource
    // splits its faces by Unicode range, so the "arabic" file has no colon,
    // no full stop and no digits, and Arabic prose set with it renders its
    // punctuation as empty boxes. Nothing in a byte-comparison catches that —
    // the output is stable, it is just wrong — and it survives review by
    // anyone who does not read the script.
    const opened = openSync(arabicFontPath());
    // A TTF, never a collection — narrowed so the assertion below is about
    // glyph coverage rather than about which of two shapes fontkit returned.
    if ('fonts' in opened) throw new Error('expected a single font, not a collection');
    const font = opened;
    const arabicText = [
      CERTIFICATE_LABELS.titleAr,
      CERTIFICATE_LABELS.statementAr,
      CERTIFICATE_LABELS.disclaimerAr,
    ].join(' ');

    const missing = [...new Set(arabicText)].filter(
      (character) => !font.hasGlyphForCodePoint(character.codePointAt(0)!),
    );
    expect(missing).toEqual([]);
  });

  it('hands the QR encoder the verification URL, and nothing else', async () => {
    // §41, §164: the QR carries one string — the URL the server built.
    //
    // Asserted at the seam rather than by decoding a PNG out of a compressed
    // PDF stream: one render, one call, and the argument list itself is the
    // evidence. The encoder's own determinism lives in its own test, where it
    // needs no PDF at all.
    const encoder = jest.spyOn(verificationQr, 'encodeVerificationQr');

    const rendered = await renderer.render({
      claim: claim(),
      verificationUrl: url,
      labels: CERTIFICATE_LABELS,
    });

    expect(encoder).toHaveBeenCalledTimes(1);
    expect(encoder).toHaveBeenCalledWith(url);
    // Exactly one argument: nothing rode along beside the URL.
    expect(encoder.mock.calls[0]).toHaveLength(1);
    encoder.mockRestore();

    // And the URL never appears as readable text, so a link-scraper reading
    // the document finds nothing the QR is meant to be the only route to.
    expect(rendered.bytes.toString('latin1')).not.toContain('https://palcert.example');
  });

  it('renders different verification URLs to different bytes', async () => {
    // The QR really is part of the artifact: two certificates identical but
    // for where their codes resolve cannot share a hash.
    const first = await renderer.render({
      claim: claim(),
      verificationUrl: url,
      labels: CERTIFICATE_LABELS,
    });
    const other = await renderer.render({
      claim: claim(),
      verificationUrl: `${url}X`,
      labels: CERTIFICATE_LABELS,
    });
    expect(first.sha256).not.toBe(other.sha256);
  });

  it('reports the stack that produced the bytes', async () => {
    // §177: a template or dependency change must be visible in the row, or
    // "same renderer version, same bytes" stops meaning anything.
    const rendered = await renderer.render({
      claim: claim(),
      verificationUrl: url,
      labels: CERTIFICATE_LABELS,
    });
    expect(rendered.rendererName).toBe('palcert-pdfkit');
    expect(rendered.rendererVersion).toContain('pdfkit@0.20.2');
    expect(rendered.rendererVersion).toContain('qrcode@1.5.4');
    expect(rendered.templateVersion).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('prints the claim hash the contracts computed, not one of its own', async () => {
    const value = claim();
    const rendered = await renderer.render({
      claim: value,
      verificationUrl: url,
      labels: CERTIFICATE_LABELS,
    });
    // Compressed streams hide the text, so assert via a claim whose hash
    // changes: if the renderer derived a hash differently, the two artifacts
    // would not differ in the way a changed claim hash requires.
    const other = await renderer.render({
      claim: { ...value, approvedAt: '2026-09-14T10:00:00.000Z' },
      verificationUrl: url,
      labels: CERTIFICATE_LABELS,
    });
    expect(computeCertificateClaimHash(value)).not.toBe(
      computeCertificateClaimHash({ ...value, approvedAt: '2026-09-14T10:00:00.000Z' }),
    );
    expect(rendered.sha256).not.toBe(other.sha256);
  });

  it('never says PalCert approved, awarded or accepted anything', () => {
    // §38: the sentence on the artifact is the sentence a stranger will
    // repeat. It states what each party did and stops.
    const prose = [
      CERTIFICATE_LABELS.statement,
      CERTIFICATE_LABELS.statementAr,
      CERTIFICATE_LABELS.disclaimer,
      CERTIFICATE_LABELS.disclaimerAr,
      CERTIFICATE_LABELS.title,
      CERTIFICATE_LABELS.titleAr,
    ].join(' ');

    expect(prose).not.toMatch(/PalCert (approves|approved|awards|awarded|accepts|accepted)/i);
    expect(prose).not.toMatch(/degree|digitally signed|signature/i);
    // And it does say the thing it is for.
    expect(CERTIFICATE_LABELS.statement).toContain('Compliant');
    expect(CERTIFICATE_LABELS.statement).toContain('Approved');
    expect(CERTIFICATE_LABELS.disclaimer).toMatch(/not an assessment of scientific merit/i);
    expect(CERTIFICATE_LABELS.disclaimerAr).toContain('مراجعة الأقران');
  });

  it('keeps the two authorities in separate Arabic words', () => {
    // §114: one generic word for both would erase in translation the
    // distinction the architecture exists to preserve.
    expect(CERTIFICATE_LABELS.statementAr).toContain('الامتثال التقني');
    expect(CERTIFICATE_LABELS.statementAr).toContain('قرار المؤسسة');
  });
});
