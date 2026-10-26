import { open } from 'node:fs/promises';

/**
 * What the leading bytes say a file is (§15).
 *
 * The extension and the browser's content type are advisory; this is the
 * first authoritative signal. A ZIP is only a *candidate* DOCX — the package
 * check decides — and anything else is unsupported, however it was named.
 */
export type DetectedSignature = 'PDF' | 'ZIP' | 'UNKNOWN';

export const HEAD_BYTES = 1024;
export const TAIL_BYTES = 2048;

const PDF_MAGIC = Buffer.from('%PDF-', 'latin1');
const ZIP_LOCAL_HEADER = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const ZIP_EMPTY_ARCHIVE = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
const OLE_COMPOUND = Buffer.from('d0cf11e0a1b11ae1', 'hex');

function startsWith(head: Buffer, magic: Buffer): boolean {
  return head.length >= magic.length && head.subarray(0, magic.length).equals(magic);
}

export function detectSignature(head: Buffer): DetectedSignature {
  if (startsWith(head, PDF_MAGIC)) return 'PDF';
  if (startsWith(head, ZIP_LOCAL_HEADER)) return 'ZIP';
  return 'UNKNOWN';
}

/** Well-known signatures PalCert deliberately refuses, named for diagnostics. */
export function describeUnsupportedSignature(head: Buffer): string {
  const latin = head.subarray(0, 64).toString('latin1');
  if (latin.startsWith('MZ')) return 'windows executable';
  if (head.length >= 4 && head[0] === 0x7f && latin.slice(1, 4) === 'ELF') return 'elf executable';
  if (startsWith(head, OLE_COMPOUND)) return 'ole compound document (legacy office)';
  if (latin.startsWith('{\\rtf')) return 'rtf';
  if (/^\s*<(!doctype|html)/i.test(latin)) return 'html';
  if (startsWith(head, ZIP_EMPTY_ARCHIVE)) return 'empty zip archive';
  return 'unrecognized';
}

export async function readHeadAndTail(
  path: string,
  sizeBytes: number,
): Promise<{ head: Buffer; tail: Buffer }> {
  const handle = await open(path, 'r');
  try {
    const head = Buffer.alloc(Math.min(HEAD_BYTES, sizeBytes));
    if (head.length > 0) await handle.read(head, 0, head.length, 0);
    const tailLength = Math.min(TAIL_BYTES, sizeBytes);
    const tail = Buffer.alloc(tailLength);
    if (tailLength > 0) await handle.read(tail, 0, tailLength, sizeBytes - tailLength);
    return { head, tail };
  } finally {
    await handle.close();
  }
}
