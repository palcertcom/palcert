import type { AttestationArtifactFormat } from '@palcert/contracts';
import { ContentRejectedError } from './errors';
import { validatePdfStructure } from './pdf-validator';

/**
 * What a submitted certificate's bytes are, and whether they are plausibly
 * that (certificate attestation).
 *
 * Signature first, extension never: a file named `degree.pdf` whose bytes are
 * a PNG is refused as a mismatch rather than reclassified, and a file whose
 * bytes are none of the four accepted formats — an executable, an office
 * document with macros, HTML — is refused however it was named.
 *
 * Structural checks only. PalCert never decodes an image or renders a PDF
 * server-side, so there is no decoder here to exploit; what is checked is that
 * the container is well-formed enough that the reviewer's browser receives a
 * real image, and that its declared dimensions are not a decompression bomb
 * aimed at that browser.
 */

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);
const PDF_MAGIC = Buffer.from('%PDF-', 'latin1');

/** Larger than any scanned certificate; smaller than a browser-freezing bomb. */
export const MAX_IMAGE_DIMENSION = 20_000;
export const MAX_IMAGE_PIXELS = 150_000_000;

function startsWith(head: Buffer, magic: Buffer, offset = 0): boolean {
  return (
    head.length >= offset + magic.length &&
    head.subarray(offset, offset + magic.length).equals(magic)
  );
}

export function detectArtifactSignature(head: Buffer): AttestationArtifactFormat | null {
  if (startsWith(head, PDF_MAGIC)) return 'PDF';
  if (startsWith(head, PNG_MAGIC)) return 'PNG';
  if (startsWith(head, JPEG_MAGIC)) return 'JPEG';
  if (
    head.length >= 12 &&
    head.subarray(0, 4).toString('latin1') === 'RIFF' &&
    head.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'WEBP';
  }
  return null;
}

function assertDimensions(width: number, height: number, format: string): void {
  if (width < 1 || height < 1) {
    throw new ContentRejectedError('FILE_CONTAINER_INVALID', `${format} has no pixels`);
  }
  if (
    width > MAX_IMAGE_DIMENSION ||
    height > MAX_IMAGE_DIMENSION ||
    width * height > MAX_IMAGE_PIXELS
  ) {
    throw new ContentRejectedError(
      'FILE_CONTAINER_INVALID',
      `${format} dimensions ${width}x${height} exceed the image limit`,
    );
  }
}

function validatePng(head: Buffer, tail: Buffer): void {
  // The IHDR chunk must come first, with length 13.
  if (
    head.length < 33 ||
    head.readUInt32BE(8) !== 13 ||
    head.subarray(12, 16).toString('latin1') !== 'IHDR'
  ) {
    throw new ContentRejectedError('FILE_CONTAINER_INVALID', 'png without a leading IHDR chunk');
  }
  assertDimensions(head.readUInt32BE(16), head.readUInt32BE(20), 'png');
  // IEND closes every complete PNG. A truncated upload would lack it.
  if (!tail.includes(Buffer.from('IEND', 'latin1'))) {
    throw new ContentRejectedError('FILE_CONTAINER_INVALID', 'png without an IEND chunk');
  }
}

function validateJpeg(head: Buffer, tail: Buffer): void {
  // End-of-image marker, allowing a little trailing padding some encoders add.
  const end = tail.subarray(Math.max(0, tail.length - 64));
  if (!end.includes(Buffer.from([0xff, 0xd9]))) {
    throw new ContentRejectedError('FILE_CONTAINER_INVALID', 'jpeg without an end-of-image marker');
  }
  // Walk the markers the head covers looking for the frame header. A large
  // EXIF block can push it past the head; that is not a defect, so absence is
  // tolerated and presence is checked.
  let at = 2;
  while (at + 9 < head.length) {
    if (head[at] !== 0xff) break;
    const marker = head[at + 1]!;
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2;
      continue;
    }
    const length = head.readUInt16BE(at + 2);
    const isFrame =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) {
      assertDimensions(head.readUInt16BE(at + 7), head.readUInt16BE(at + 5), 'jpeg');
      return;
    }
    if (length < 2) {
      throw new ContentRejectedError(
        'FILE_CONTAINER_INVALID',
        'jpeg marker with an impossible length',
      );
    }
    at += 2 + length;
  }
}

function validateWebp(head: Buffer, sizeBytes: number): void {
  const riffSize = head.readUInt32LE(4);
  // RIFF's size excludes its own eight-byte header, and odd chunks are padded.
  if (riffSize + 8 !== sizeBytes && riffSize + 9 !== sizeBytes) {
    throw new ContentRejectedError(
      'FILE_CONTAINER_INVALID',
      'webp RIFF size does not match the file',
    );
  }
  const chunk = head.subarray(12, 16).toString('latin1');
  if (chunk === 'VP8X' && head.length >= 30) {
    const width = 1 + head.readUIntLE(24, 3);
    const height = 1 + head.readUIntLE(27, 3);
    assertDimensions(width, height, 'webp');
    return;
  }
  if (chunk === 'VP8L' && head.length >= 25) {
    const bits = head.readUInt32LE(21);
    assertDimensions((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1, 'webp');
    return;
  }
  if (chunk === 'VP8 ' && head.length >= 30) {
    assertDimensions(head.readUInt16LE(26) & 0x3fff, head.readUInt16LE(28) & 0x3fff, 'webp');
    return;
  }
  throw new ContentRejectedError(
    'FILE_CONTAINER_INVALID',
    `webp with unknown first chunk ${JSON.stringify(chunk)}`,
  );
}

/**
 * Detect and validate. Returns the format the bytes are; throws a
 * `ContentRejectedError` for anything PalCert will not accept.
 */
export function validateArtifact(params: {
  readonly head: Buffer;
  readonly tail: Buffer;
  readonly sizeBytes: number;
  readonly expectedFormat: AttestationArtifactFormat;
  readonly allowedFormats: readonly AttestationArtifactFormat[];
}): AttestationArtifactFormat {
  const detected = detectArtifactSignature(params.head);
  if (detected === null) {
    throw new ContentRejectedError('FILE_TYPE_UNSUPPORTED', 'not a PDF, PNG, JPEG or WebP');
  }
  if (detected !== params.expectedFormat) {
    throw new ContentRejectedError(
      'FILE_TYPE_MISMATCH',
      `content is ${detected}, extension says ${params.expectedFormat}`,
    );
  }
  if (!params.allowedFormats.includes(detected)) {
    throw new ContentRejectedError(
      'FILE_TYPE_UNSUPPORTED',
      `${detected} is not accepted for this type`,
    );
  }
  switch (detected) {
    case 'PDF':
      validatePdfStructure(params.head, params.tail);
      break;
    case 'PNG':
      validatePng(params.head, params.tail);
      break;
    case 'JPEG':
      validateJpeg(params.head, params.tail);
      break;
    case 'WEBP':
      validateWebp(params.head, params.sizeBytes);
      break;
  }
  return detected;
}
