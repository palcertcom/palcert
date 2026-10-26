import { Injectable } from '@nestjs/common';
import { computeCertificateClaimHash, type CertificateClaim } from '@palcert/contracts';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import PDFDocument from 'pdfkit';
import {
  CertificateRendererPort,
  type CertificateLabels,
  type RenderedCertificate,
} from './certificate-renderer.port';
import { encodeVerificationQr } from './verification-qr';

/**
 * The PalCert certificate, rendered (§37, §46, §48).
 *
 * Three things about this file are deliberate and worth stating, because each
 * is the sort of thing a later change could quietly undo.
 *
 * **Arabic is written as Arabic**, and getting there took two corrections that
 * are worth recording because both produced output that looked fine at a
 * glance.
 *
 * fontkit shapes an Arabic run correctly, joining forms and ordering glyphs
 * right-to-left. But pdfkit splits text on spaces to wrap it, and lays each
 * resulting word out left-to-right — so a three-word phrase came out with its
 * words in reverse order while every individual word looked perfect. Rendering
 * the same phrase through Chromium and comparing the two images side by side
 * is what settled it; reading the glyphs unaided is not reliable for anyone
 * who does not read Arabic fluently, and a single phrase inspected on its own
 * had already fooled this renderer's first draft.
 *
 * The fix is to stop pdfkit splitting the run at all: words are joined with
 * non-breaking spaces and drawn with `lineBreak: false`, so fontkit sees one
 * run and orders the whole line. Wrapping is therefore done here, by measuring.
 *
 * What is *not* done is reversing the string first. That was the other wrong
 * turn: pre-reordering with a bidi pass and then letting fontkit reorder again
 * double-reverses, and produces beautifully-shaped nonsense. The text goes in
 * in logical order, exactly as it is stored.
 *
 * **The output is byte-identical between runs.** Every source of variation is
 * removed: the PDF's creation and modification dates are pinned to the epoch
 * rather than the wall clock, the producer and creator strings are fixed, and
 * the QR is generated deterministically from the URL. A certificate's artifact
 * hash is shown to verifiers, so "the same claim renders to the same bytes"
 * has to be a fact rather than an aspiration.
 *
 * **Nothing is fetched.** Both fonts are read from local packages at startup.
 * A renderer that reached the network for a font would make certificate
 * issuance depend on somebody else's uptime, and would leak that PalCert was
 * issuing one.
 */

/** Bumped when the layout changes. Not the application version (§178). */
const CERTIFICATE_TEMPLATE_VERSION = '1.0.0';

/**
 * Identifies the rendering stack closely enough for determinism to mean
 * something (§177, and correction §6).
 *
 * Every dependency whose bytes reach the artifact is pinned exactly in
 * `package.json`, and named here. Changing any of them without bumping this
 * is what would make "same renderer version, same bytes" untrue.
 */
const RENDERER_NAME = 'palcert-pdfkit';
const RENDERER_VERSION = 'pdfkit@0.20.2+qrcode@1.5.4+noto@5.3.0';

/** Pinned so the PDF carries no wall clock. */
const FIXED_DATE = new Date(0);

const require_ = createRequire(__filename);

/**
 * Fonts, read once from local packages.
 *
 * Noto Sans and Noto Sans Arabic, both SIL Open Font License 1.1: freely
 * redistributable including inside a PDF, with no obligation reaching the
 * document that embeds them. Their licences ship in the packages, and the
 * packaging of the Arabic build is additionally MIT.
 */
function loadFont(specifier: string): Buffer {
  return readFileSync(require_.resolve(specifier));
}

const LATIN_FONT = loadFont('@fontsource/noto-sans/files/noto-sans-latin-400-normal.woff');
const LATIN_BOLD = loadFont('@fontsource/noto-sans/files/noto-sans-latin-700-normal.woff');
// The *full* Noto Sans Arabic, not a subset.
//
// Fontsource splits its faces by Unicode range, so its `arabic` file contains
// the Arabic block and nothing else — no colon, no full stop, no digits. A
// line of Arabic prose drawn with it renders its punctuation as empty boxes,
// which is exactly the sort of defect that survives review by anyone who does
// not read the script. This build carries Arabic and Latin together, so one
// font can set a whole Arabic sentence.
const ARABIC_FONT = loadFont(
  '@expo-google-fonts/noto-sans-arabic/400Regular/NotoSansArabic_400Regular.ttf',
);
const ARABIC_BOLD = loadFont(
  '@expo-google-fonts/noto-sans-arabic/700Bold/NotoSansArabic_700Bold.ttf',
);

/**
 * The separator that keeps an Arabic line in one piece.
 *
 * A normal space invites pdfkit to split the line into independently
 * positioned words; a non-breaking space does not, so the shaper sees the
 * whole line and orders it.
 */
const NBSP = '\u00a0';

const PAGE_MARGIN = 54;
const INK = '#111827';
const MUTED = '#4b5563';
const RULE = '#d1d5db';

@Injectable()
export class PdfKitCertificateRenderer extends CertificateRendererPort {
  get rendererName(): string {
    return RENDERER_NAME;
  }

  get rendererVersion(): string {
    return RENDERER_VERSION;
  }

  get templateVersion(): string {
    return CERTIFICATE_TEMPLATE_VERSION;
  }

  async render(params: {
    readonly claim: CertificateClaim;
    readonly verificationUrl: string;
    readonly labels: CertificateLabels;
  }): Promise<RenderedCertificate> {
    const { claim, labels } = params;

    // One argument, and it is the URL the server built. The encoder owns the
    // deterministic options, so nothing here can add a second thing to the QR.
    const qr = await encodeVerificationQr(params.verificationUrl);

    const doc = new PDFDocument({
      size: 'A4',
      margin: PAGE_MARGIN,
      // §49: safe certificate fields only. No email, no user id, no comment,
      // no document title — a PDF's metadata travels with it.
      info: {
        Title: `PalCert Technical Compliance Certificate ${claim.certificateNumber}`,
        Author: 'PalCert',
        Subject: 'PalCert technical compliance certificate',
        Keywords: claim.certificateNumber,
        Producer: 'PalCert',
        Creator: 'PalCert',
        CreationDate: FIXED_DATE,
        ModDate: FIXED_DATE,
      },
    });

    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    const finished = new Promise<void>((resolve) => doc.on('end', () => resolve()));

    doc.registerFont('latin', LATIN_FONT);
    doc.registerFont('latin-bold', LATIN_BOLD);
    doc.registerFont('arabic', ARABIC_FONT);
    doc.registerFont('arabic-bold', ARABIC_BOLD);

    const right = doc.page.width - PAGE_MARGIN;
    const width = right - PAGE_MARGIN;

    // --- Heading, in both languages ----------------------------------------
    doc.font('latin-bold').fontSize(20).fillColor(INK);
    doc.text(labels.title, PAGE_MARGIN, PAGE_MARGIN, { width, align: 'left' });

    doc.font('arabic-bold').fontSize(18);
    this.arabicBlock(doc, labels.titleAr, PAGE_MARGIN, doc.y + 4, width, 22);

    doc
      .moveTo(PAGE_MARGIN, doc.y + 12)
      .lineTo(right, doc.y + 12)
      .strokeColor(RULE)
      .stroke();
    doc.moveDown(1.2);

    // --- The certificate number --------------------------------------------
    doc.font('latin-bold').fontSize(14).fillColor(INK);
    doc.text(claim.certificateNumber, PAGE_MARGIN, doc.y, { width, align: 'left' });
    doc.moveDown(0.8);

    // --- What PalCert actually asserts (§38) --------------------------------
    doc.font('latin').fontSize(10).fillColor(MUTED);
    doc.text(labels.statement, PAGE_MARGIN, doc.y, { width, align: 'left' });
    doc.moveDown(0.4);
    doc.font('arabic').fontSize(10);
    this.arabicBlock(doc, labels.statementAr, PAGE_MARGIN, doc.y, width, 14);
    doc.moveDown(1);

    // --- The two results, side by side and never merged ---------------------
    const fieldsTop = doc.y;
    this.field(doc, labels.fields.technicalResult, 'Compliant', PAGE_MARGIN, fieldsTop, width / 2);
    this.field(
      doc,
      labels.fields.institutionDecision,
      'Approved',
      PAGE_MARGIN + width / 2,
      fieldsTop,
      width / 2,
    );
    doc.y = fieldsTop + 40;

    // --- Everything the certificate is about --------------------------------
    const rows: [string, string][] = [
      [labels.fields.organization, claim.organizationName],
      [labels.fields.documentType, claim.documentTypeName],
      [labels.fields.documentFormat, claim.documentFormat],
      [labels.fields.standard, claim.standardName],
      // Separate row: the code and version are always Latin, and a line has
      // one font. Mixing scripts in a single run renders the other script as
      // empty boxes, which is how a certificate ends up with tofu on it.
      [labels.fields.standardVersion, `${claim.standardCode} · ${claim.standardVersionLabel}`],
      [labels.fields.issued, claim.issuedAt.slice(0, 10)],
      [labels.fields.validity, claim.validUntil === null ? '—' : claim.validUntil.slice(0, 10)],
    ];

    for (const [label, value] of rows) {
      this.row(doc, label, value, PAGE_MARGIN, width);
    }

    doc.moveDown(0.6);
    doc.moveTo(PAGE_MARGIN, doc.y).lineTo(right, doc.y).strokeColor(RULE).stroke();
    doc.moveDown(0.8);

    // --- Digests a verifier can check themselves (§103–§107) ----------------
    const digests: [string, string][] = [
      [labels.fields.documentHash, claim.documentSha256],
      [labels.fields.reportHash, claim.reportHash],
      [labels.fields.standardHash, claim.standardContentHash],
      [labels.fields.evidenceHash, claim.submissionEvidenceHash],
      // The claim hash comes from the contracts' own function, so the digest
      // printed here cannot drift from the one that was stored. The PDF's own
      // hash is deliberately absent: a document cannot contain its own digest
      // (§36), and public verification exposes it separately.
      [labels.fields.claimHash, computeCertificateClaimHash(claim)],
    ];
    for (const [label, value] of digests) {
      this.digest(doc, label, value, PAGE_MARGIN, width);
    }

    // --- Verification -------------------------------------------------------
    const qrSize = 108;
    const qrX = right - qrSize;
    const qrY = doc.page.height - PAGE_MARGIN - qrSize - 46;
    doc.image(qr, qrX, qrY, { width: qrSize, height: qrSize });

    doc.font('latin').fontSize(8).fillColor(MUTED);
    doc.text(labels.fields.verify, PAGE_MARGIN, qrY + 8, { width: width - qrSize - 16 });
    doc.font('latin').fontSize(8).fillColor(INK);
    doc.text(params.verificationUrl, PAGE_MARGIN, doc.y + 2, { width: width - qrSize - 16 });

    // --- The disclaimer that keeps PalCert honest (§39) ---------------------
    const footY = doc.page.height - PAGE_MARGIN - 34;
    doc.font('latin').fontSize(7.5).fillColor(MUTED);
    doc.text(labels.disclaimer, PAGE_MARGIN, footY, { width, align: 'left' });
    doc.font('arabic').fontSize(7.5);
    this.arabicBlock(doc, labels.disclaimerAr, PAGE_MARGIN, doc.y + 2, width, 10);

    doc.end();
    await finished;

    const bytes = Buffer.concat(chunks);
    return {
      bytes,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      rendererName: RENDERER_NAME,
      rendererVersion: RENDERER_VERSION,
      templateVersion: CERTIFICATE_TEMPLATE_VERSION,
    };
  }

  /**
   * Draw an Arabic block: wrapped by measurement, each line one shaped run.
   *
   * Right-aligned, because that is where an Arabic reader's eye starts.
   */
  private arabicBlock(
    doc: PDFKit.PDFDocument,
    text: string,
    x: number,
    y: number,
    width: number,
    lineHeight: number,
  ): void {
    let cursor = y;
    for (const line of wrapArabic(doc, text, width)) {
      doc.text(line, x, cursor, { width, align: 'right', lineBreak: false });
      cursor += lineHeight;
    }
    doc.y = cursor;
  }

  /** One of the two headline results. */
  private field(
    doc: PDFKit.PDFDocument,
    label: string,
    value: string,
    x: number,
    y: number,
    width: number,
  ): void {
    doc.font('latin').fontSize(8).fillColor(MUTED);
    doc.text(label, x, y, { width });
    doc.font('latin-bold').fontSize(13).fillColor(INK);
    doc.text(value, x, y + 12, { width });
  }

  /** A labelled value. Arabic values shape themselves; nothing is reordered. */
  private row(
    doc: PDFKit.PDFDocument,
    label: string,
    value: string,
    x: number,
    width: number,
  ): void {
    const labelWidth = 150;
    const y = doc.y;
    doc.font('latin').fontSize(9).fillColor(MUTED);
    doc.text(label, x, y, { width: labelWidth });
    if (hasArabic(value)) {
      // One run, right-aligned, wrapped by measurement. Never split by pdfkit.
      doc.font('arabic').fontSize(10).fillColor(INK);
      this.arabicBlock(doc, value, x + labelWidth, y, width - labelWidth, 14);
    } else {
      doc.font('latin').fontSize(10).fillColor(INK);
      doc.text(value, x + labelWidth, y, { width: width - labelWidth });
    }
    doc.y = Math.max(doc.y, y) + 4;
  }

  /** A digest, printed in full so it can be compared by eye or copied (§103). */
  private digest(
    doc: PDFKit.PDFDocument,
    label: string,
    value: string,
    x: number,
    width: number,
  ): void {
    const labelWidth = 150;
    const y = doc.y;
    doc.font('latin').fontSize(8).fillColor(MUTED);
    doc.text(label, x, y, { width: labelWidth });
    doc.font('latin').fontSize(7).fillColor(INK);
    doc.text(value, x + labelWidth, y, { width: width - labelWidth });
    doc.y = Math.max(doc.y, y) + 3;
  }
}

/**
 * Wrap Arabic by measuring, because pdfkit's own wrapping cannot be used.
 *
 * Returns lines in logical order, each already joined into a single run.
 */
function wrapArabic(doc: PDFKit.PDFDocument, text: string, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter((word) => word !== '');
  const lines: string[] = [];
  let current: string[] = [];

  for (const word of words) {
    const candidate = [...current, word];
    if (
      current.length > 0 &&
      doc.widthOfString(candidate.join(NBSP), { lineBreak: false }) > maxWidth
    ) {
      lines.push(current.join(NBSP));
      current = [word];
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) lines.push(current.join(NBSP));
  return lines;
}

/**
 * Any Arabic-script character means the line needs the Arabic face.
 *
 * Built from an escaped string rather than a regex literal: the ranges end at
 * U+FEFF, and written literally a formatter turns that into a byte-order mark
 * sitting in the source, which lint rightly rejects as irregular whitespace.
 */
const ARABIC_RANGES = new RegExp('[\\u0600-\\u06ff\\u0750-\\u077f\\ufb50-\\ufdff\\ufe70-\\ufeff]');

function hasArabic(value: string): boolean {
  return ARABIC_RANGES.test(value);
}
