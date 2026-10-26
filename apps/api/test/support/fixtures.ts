import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';

/**
 * Self-contained file fixtures for the upload pipeline.
 *
 * Everything is generated in code: no binary fixtures in the repository, and
 * nothing that is actually malicious (§38). The ZIP writer is the minimum
 * needed to build both well-formed packages and the hostile shapes the
 * security matrix requires (traversal names, bombs, nested archives).
 */

export interface ZipEntrySpec {
  readonly name: string;
  readonly data: Buffer | string;
  /** Store rather than deflate — needed to control declared sizes precisely. */
  readonly store?: boolean;
  /** Lie about the uncompressed size in the headers (bomb / size-lie shapes). */
  readonly declaredUncompressedSize?: number;
}

function crc32(buffer: Buffer): number {
  let crc = ~0;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

/** A minimal, valid ZIP (PKZIP 2.0, no data descriptors, no ZIP64). */
export function buildZip(entries: readonly ZipEntrySpec[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8');
    const method = entry.store ? 0 : 8;
    const payload = entry.store ? raw : deflateRawSync(raw, { level: 9 });
    const crc = crc32(raw);
    const declared = entry.declaredUncompressedSize ?? raw.length;

    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(declared, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(declared, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);

    locals.push(local, payload);
    centrals.push(central);
    offset += local.length + payload.length;
  }

  const centralDirectory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralDirectory, end]);
}

const MAIN_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml';
const MACRO_MAIN_TYPE = 'application/vnd.ms-word.document.macroEnabled.main+xml';

export function contentTypesXml(mainType = MAIN_TYPE, extra = ''): string {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    `<Override PartName="/word/document.xml" ContentType="${mainType}"/>` +
    extra +
    '</Types>'
  );
}

export const ROOT_RELS =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
  '</Relationships>';

export const DOCUMENT_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
  '<w:body><w:p><w:r><w:t>PalCert fixture</w:t></w:r></w:p></w:body></w:document>';

/** A minimal, valid DOCX package. */
export function minimalDocx(
  options: { readonly extraEntries?: readonly ZipEntrySpec[]; readonly padTo?: number } = {},
): Buffer {
  const entries: ZipEntrySpec[] = [
    { name: '[Content_Types].xml', data: contentTypesXml() },
    { name: '_rels/.rels', data: ROOT_RELS },
    { name: 'word/document.xml', data: DOCUMENT_XML },
    ...(options.extraEntries ?? []),
  ];
  if (options.padTo !== undefined) {
    // Incompressible padding, so the package reaches a target size honestly.
    entries.push({ name: 'word/media/image1.bin', data: randomBytes(options.padTo), store: true });
  }
  return buildZip(entries);
}

/** A DOCM in DOCX clothing: macro-enabled main part plus a VBA project. */
export function macroDocx(): Buffer {
  return buildZip([
    {
      name: '[Content_Types].xml',
      data: contentTypesXml(
        MACRO_MAIN_TYPE,
        '<Override PartName="/word/vbaProject.bin" ContentType="application/vnd.ms-office.vbaProject"/>',
      ),
    },
    { name: '_rels/.rels', data: ROOT_RELS },
    { name: 'word/document.xml', data: DOCUMENT_XML },
    { name: 'word/vbaProject.bin', data: Buffer.from('not really vba') },
  ]);
}

/** A well-formed DOCX carrying an OLE embedding. */
export function embeddedObjectDocx(): Buffer {
  return minimalDocx({
    extraEntries: [{ name: 'word/embeddings/oleObject1.bin', data: Buffer.from('ole') }],
  });
}

/** A DOCX whose document relationships pull an external image. */
export function externalImageDocx(): Buffer {
  const rels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="http://evil.example/track.png" TargetMode="External"/>' +
    '</Relationships>';
  return minimalDocx({ extraEntries: [{ name: 'word/_rels/document.xml.rels', data: rels }] });
}

/** A ZIP that is not a DOCX at all. */
export function randomZip(): Buffer {
  return buildZip([
    { name: 'readme.txt', data: 'not a word document' },
    { name: 'data/x.csv', data: 'a,b\n1,2' },
  ]);
}

/** A package with a traversal entry name. */
export function traversalZip(): Buffer {
  return buildZip([
    { name: '[Content_Types].xml', data: contentTypesXml() },
    { name: '_rels/.rels', data: ROOT_RELS },
    { name: 'word/document.xml', data: DOCUMENT_XML },
    { name: '../../etc/passwd', data: 'root:x:0:0' },
  ]);
}

/** Highly compressible entries whose combined ratio is far past any limit. */
export function zipBomb(): Buffer {
  const zeros = Buffer.alloc(3 * 1024 * 1024, 0);
  return buildZip([
    { name: '[Content_Types].xml', data: contentTypesXml() },
    { name: '_rels/.rels', data: ROOT_RELS },
    { name: 'word/document.xml', data: DOCUMENT_XML },
    { name: 'word/a.xml', data: zeros },
    { name: 'word/b.xml', data: zeros },
    { name: 'word/c.xml', data: zeros },
  ]);
}

/** More entries than the test limit allows. */
export function manyEntriesZip(count: number): Buffer {
  const entries: ZipEntrySpec[] = [
    { name: '[Content_Types].xml', data: contentTypesXml() },
    { name: '_rels/.rels', data: ROOT_RELS },
    { name: 'word/document.xml', data: DOCUMENT_XML },
  ];
  for (let index = 0; index < count; index += 1)
    entries.push({ name: `word/part${index}.xml`, data: '<x/>' });
  return buildZip(entries);
}

/** A DOCX that smuggles another archive. */
export function nestedArchiveDocx(): Buffer {
  return minimalDocx({
    extraEntries: [{ name: 'word/media/inner.zip', data: randomZip(), store: true }],
  });
}

/** A minimal, structurally valid PDF. */
export function minimalPdf(text = 'PalCert fixture', padTo?: number): Buffer {
  const objects = [
    '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n',
    '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n',
    '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R >> endobj\n',
  ];
  const stream = `BT /F1 12 Tf 72 770 Td (${text}) Tj ET`;
  objects.push(`4 0 obj << /Length ${stream.length} >> stream\n${stream}\nendstream endobj\n`);
  let body = '%PDF-1.7\n%âãÏÓ\n';
  const offsets: number[] = [];
  for (const object of objects) {
    offsets.push(Buffer.byteLength(body, 'latin1'));
    body += object;
  }
  if (padTo !== undefined) {
    const padding = Math.max(0, padTo - Buffer.byteLength(body, 'latin1') - 200);
    body += `% ${'x'.repeat(padding)}\n`;
  }
  const xref = Buffer.byteLength(body, 'latin1');
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  body += `trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

/** Right header, no structure: not a document anyone could open. */
export function truncatedPdf(): Buffer {
  return Buffer.from('%PDF-1.7\n1 0 obj << >> endobj\n', 'latin1');
}

/** The harmless antivirus test string, inside an otherwise valid PDF. */
export const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

export function eicarPdf(): Buffer {
  return minimalPdf(EICAR);
}

export function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function randomBytes(length: number): Buffer {
  const out = Buffer.alloc(length);
  let seed = 0x2545f491;
  for (let index = 0; index < length; index += 1) {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    out[index] = seed & 0xff;
  }
  return out;
}

/**
 * A corrected DOCX, as SmartFix would have produced it.
 *
 * Deterministic in the plan hash, so the same correction produces the same
 * bytes twice — and different from `minimalDocx()`, because a correction that
 * returned the source unchanged would let a test pass while proving nothing.
 */
export function correctedDocx(planHash: string): Buffer {
  return minimalDocx({
    extraEntries: [
      {
        name: 'word/settings.xml',
        data:
          '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
          `<w:rsids><w:rsid w:val="${planHash.slice(0, 8)}"/></w:rsids></w:settings>`,
      },
    ],
  });
}
