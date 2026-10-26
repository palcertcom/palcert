import { buildZip, contentTypesXml, ROOT_RELS, type ZipEntrySpec } from './fixtures';

/**
 * Generated OLE compound files and the DOCX packages that carry them.
 *
 * Like the rest of the fixtures, nothing here is a binary checked into the
 * repository and nothing is actually executable: an "executable payload" is a
 * few bytes that start with `MZ`, which is all a structural check can see.
 * The equation objects are laid out the way Word and MathType lay them out —
 * a root class id, `CompObj`, `Ole`, `ObjInfo` and an `Equation Native` stream
 * holding an MTEF header — so the classifier is tested against the real shape.
 */

const SECTOR = 512;
const MINI = 64;
const MINI_CUTOFF = 4096;
const END_OF_CHAIN = 0xfffffffe;
const FREE = 0xffffffff;
const FAT_SECTOR = 0xfffffffd;

export const MATHTYPE_CLSID = '{0002CE03-0000-0000-C000-000000000046}';
export const EQUATION3_CLSID = '{0002CE02-0000-0000-C000-000000000046}';
/** A Word document's class id — an embedded Office file, not an equation. */
export const WORD_DOCUMENT_CLSID = '{00020906-0000-0000-C000-000000000046}';
/** The OLE Packager — how an arbitrary file is embedded. */
export const PACKAGER_CLSID = '{0003000C-0000-0000-C000-000000000046}';

export interface CompoundFileSpec {
  readonly clsid: string;
  readonly streams: readonly { readonly name: string; readonly data: Buffer }[];
  /** Extra storages (sub-directories) under the root. */
  readonly storages?: readonly string[];
}

function clsidBytes(clsid: string): Buffer {
  const hex = clsid.replace(/[{}-]/g, '');
  const bytes = Buffer.from(hex, 'hex');
  return Buffer.concat([
    Buffer.from(bytes.subarray(0, 4)).reverse(),
    Buffer.from(bytes.subarray(4, 6)).reverse(),
    Buffer.from(bytes.subarray(6, 8)).reverse(),
    bytes.subarray(8, 16),
  ]);
}

function compareNames(a: string, b: string): number {
  if (a.length !== b.length) return a.length - b.length;
  const ua = a.toUpperCase();
  const ub = b.toUpperCase();
  return ua < ub ? -1 : ua > ub ? 1 : 0;
}

/** A version-3 compound file (512-byte sectors), small streams in the mini stream. */
export function buildCompoundFile(spec: CompoundFileSpec): Buffer {
  interface Child {
    name: string;
    type: 1 | 2;
    data: Buffer;
    start: number;
  }
  const children: Child[] = [
    ...(spec.storages ?? []).map((name) => ({
      name,
      type: 1 as const,
      data: Buffer.alloc(0),
      start: 0,
    })),
    ...spec.streams.map((stream) => ({
      name: stream.name,
      type: 2 as const,
      data: stream.data,
      start: 0,
    })),
  ].sort((a, b) => compareNames(a.name, b.name));

  // Mini stream: every small stream, each padded to 64-byte mini sectors.
  const miniFat: number[] = [];
  const miniParts: Buffer[] = [];
  const big: Child[] = [];
  for (const child of children) {
    if (child.type !== 2 || child.data.length === 0) {
      child.start = END_OF_CHAIN;
      continue;
    }
    if (child.data.length >= MINI_CUTOFF) {
      big.push(child);
      continue;
    }
    const count = Math.ceil(child.data.length / MINI);
    child.start = miniFat.length;
    for (let i = 0; i < count; i += 1) {
      miniFat.push(i === count - 1 ? END_OF_CHAIN : miniFat.length + 1);
    }
    const padded = Buffer.alloc(count * MINI);
    child.data.copy(padded);
    miniParts.push(padded);
  }
  const miniStream = Buffer.concat(miniParts);

  // Regular sectors: [FAT] [directory] [mini FAT] [mini stream] [big streams].
  const entryCount = 1 + children.length;
  const directorySectors = Math.ceil((entryCount * 128) / SECTOR);
  const miniFatSectors = Math.ceil((miniFat.length * 4) / SECTOR);
  const miniStreamSectors = Math.ceil(miniStream.length / SECTOR);
  const bigSectors = big.map((child) => Math.ceil(child.data.length / SECTOR));
  const dataSectors =
    directorySectors + miniFatSectors + miniStreamSectors + bigSectors.reduce((a, b) => a + b, 0);
  let fatSectors = 1;
  while (fatSectors * (SECTOR / 4) < fatSectors + dataSectors) fatSectors += 1;
  if (fatSectors > 109) throw new Error('fixture too large');

  const fat: number[] = [];
  const allocate = (count: number): number => {
    if (count === 0) return END_OF_CHAIN;
    const start = fat.length;
    for (let i = 0; i < count; i += 1) fat.push(i === count - 1 ? END_OF_CHAIN : fat.length + 1);
    return start;
  };
  for (let i = 0; i < fatSectors; i += 1) fat.push(FAT_SECTOR);
  const directoryStart = allocate(directorySectors);
  const miniFatStart = allocate(miniFatSectors);
  const miniStreamStart = allocate(miniStreamSectors);
  for (const [index, child] of big.entries()) child.start = allocate(bigSectors[index]!);
  while (fat.length < fatSectors * (SECTOR / 4)) fat.push(FREE);

  const header = Buffer.alloc(SECTOR);
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(header, 0);
  header.writeUInt16LE(0x003e, 24);
  header.writeUInt16LE(3, 26);
  header.writeUInt16LE(0xfffe, 28);
  header.writeUInt16LE(9, 30);
  header.writeUInt16LE(6, 32);
  header.writeUInt32LE(fatSectors, 44);
  header.writeUInt32LE(directoryStart, 48);
  header.writeUInt32LE(MINI_CUTOFF, 56);
  header.writeUInt32LE(miniFatSectors === 0 ? END_OF_CHAIN : miniFatStart, 60);
  header.writeUInt32LE(miniFatSectors, 64);
  header.writeUInt32LE(END_OF_CHAIN, 68);
  header.writeUInt32LE(0, 72);
  for (let i = 0; i < 109; i += 1) header.writeUInt32LE(i < fatSectors ? i : FREE, 76 + i * 4);

  const entry = (name: string, type: number, clsid: string | null, start: number, size: number) => {
    const buffer = Buffer.alloc(128);
    const encoded = Buffer.from(name, 'utf16le');
    encoded.copy(buffer, 0);
    buffer.writeUInt16LE(encoded.length + 2, 64);
    buffer.writeUInt8(type, 66);
    buffer.writeUInt8(1, 67); // black
    buffer.writeUInt32LE(FREE, 68); // left
    buffer.writeUInt32LE(FREE, 72); // right
    buffer.writeUInt32LE(FREE, 76); // child
    if (clsid !== null) clsidBytes(clsid).copy(buffer, 80);
    buffer.writeUInt32LE(start, 116);
    buffer.writeUInt32LE(size, 120);
    return buffer;
  };
  const entries: Buffer[] = [
    entry(
      'Root Entry',
      5,
      spec.clsid,
      miniStream.length === 0 ? END_OF_CHAIN : miniStreamStart,
      miniStream.length,
    ),
  ];
  // A right-leaning chain of siblings in sorted order is a valid (if
  // unbalanced) directory tree; the root's child is the first.
  for (const [index, child] of children.entries()) {
    const buffer = entry(child.name, child.type, null, child.start, child.data.length);
    if (index + 1 < children.length) buffer.writeUInt32LE(index + 2, 72);
    entries.push(buffer);
  }
  if (children.length > 0) entries[0]!.writeUInt32LE(1, 76);
  const directory = Buffer.alloc(directorySectors * SECTOR);
  Buffer.concat(entries).copy(directory);
  // Unused slots must say "no siblings, no child".
  for (let slot = entryCount; slot < directorySectors * 4; slot += 1) {
    directory.writeUInt32LE(FREE, slot * 128 + 68);
    directory.writeUInt32LE(FREE, slot * 128 + 72);
    directory.writeUInt32LE(FREE, slot * 128 + 76);
  }

  const fatBytes = Buffer.alloc(fatSectors * SECTOR);
  fat.forEach((value, index) => fatBytes.writeUInt32LE(value >>> 0, index * 4));
  const miniFatBytes = Buffer.alloc(miniFatSectors * SECTOR, 0xff);
  miniFat.forEach((value, index) => miniFatBytes.writeUInt32LE(value >>> 0, index * 4));
  const miniStreamBytes = Buffer.alloc(miniStreamSectors * SECTOR);
  miniStream.copy(miniStreamBytes);
  const bigBytes = big.map((child, index) => {
    const buffer = Buffer.alloc(bigSectors[index]! * SECTOR);
    child.data.copy(buffer);
    return buffer;
  });

  return Buffer.concat([header, fatBytes, directory, miniFatBytes, miniStreamBytes, ...bigBytes]);
}

function lengthPrefixed(text: string): Buffer {
  const body = Buffer.from(`${text}\0`, 'latin1');
  const length = Buffer.alloc(4);
  length.writeUInt32LE(body.length);
  return Buffer.concat([length, body]);
}

/** A `CompObj` stream ([MS-OLEDS] 2.3.8) naming a user type and a ProgID. */
export function compObjStream(userType: string, progId: string): Buffer {
  const header = Buffer.alloc(28);
  header.writeUInt32LE(0xfffe0001, 0);
  header.writeUInt32LE(0x00000a03, 4);
  header.writeInt32LE(-1, 8);
  return Buffer.concat([
    header,
    lengthPrefixed(userType),
    lengthPrefixed(userType.includes('MathType') ? 'MathType EF' : 'Equation Native'),
    lengthPrefixed(progId),
    Buffer.from([0xf4, 0x39, 0xb2, 0x71]),
    Buffer.alloc(12),
  ]);
}

/** `Equation Native`: a 28-byte EQNOLEFILEHDR, then MTEF bytes. */
export function equationNativeStream(
  mtef: Buffer = Buffer.from([5, 1, 0, 6, 9, 1, 1, 0, 0, 10]),
): Buffer {
  const header = Buffer.alloc(28);
  header.writeUInt16LE(28, 0);
  header.writeUInt32LE(0x00020000, 2);
  header.writeUInt16LE(0xc1b7, 6);
  header.writeUInt32LE(mtef.length, 8);
  return Buffer.concat([header, mtef]);
}

const OLE_STREAM = Buffer.from([1, 0, 0, 2, ...new Array<number>(16).fill(0)]);
const OBJ_INFO = Buffer.from([0x00, 0x00, 0x03, 0x00, 0x04, 0x00]);

/** An equation object as MathType (or Equation Editor 3.0) writes it. */
export function equationObject(
  progId: 'Equation.DSMT4' | 'Equation.3' = 'Equation.DSMT4',
  options: { readonly extraStreams?: CompoundFileSpec['streams']; readonly clsid?: string } = {},
): Buffer {
  const mathType = progId === 'Equation.DSMT4';
  return buildCompoundFile({
    clsid: options.clsid ?? (mathType ? MATHTYPE_CLSID : EQUATION3_CLSID),
    streams: [
      {
        name: '\u0001CompObj',
        data: compObjStream(mathType ? 'MathType 6.0 Equation' : 'Microsoft Equation 3.0', progId),
      },
      { name: '\u0001Ole', data: OLE_STREAM },
      { name: '\u0003ObjInfo', data: OBJ_INFO },
      { name: 'Equation Native', data: equationNativeStream() },
      ...(options.extraStreams ?? []),
    ],
  });
}

/** The OLE Packager wrapping "an executable": what an arbitrary embedded file looks like. */
export function packagedExecutableObject(): Buffer {
  const payload = Buffer.concat([
    Buffer.from('MZ'),
    Buffer.alloc(62),
    Buffer.from('not really code'),
  ]);
  return buildCompoundFile({
    clsid: PACKAGER_CLSID,
    streams: [
      { name: '\u0001CompObj', data: compObjStream('OLE Package', 'Package') },
      {
        name: '\u0001Ole10Native',
        data: Buffer.concat([Buffer.from([payload.length, 0, 0, 0]), payload]),
      },
    ],
  });
}

/** An embedded Word document: an Office file inside the Office file. */
export function embeddedWordDocumentObject(): Buffer {
  return buildCompoundFile({
    clsid: WORD_DOCUMENT_CLSID,
    streams: [
      { name: '\u0001CompObj', data: compObjStream('Microsoft Word Document', 'Word.Document.8') },
      { name: 'WordDocument', data: Buffer.alloc(200, 0x41) },
    ],
    storages: ['ObjectPool'],
  });
}

const NS =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:v="urn:schemas-microsoft-com:vml" ' +
  'xmlns:o="urn:schemas-microsoft-com:office:office" ' +
  'xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"';

const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

export interface LegacyObjectSpec {
  /** ProgID written into the document XML. */
  readonly progId: string;
  /** The compound file stored under word/embeddings. */
  readonly bytes: Buffer;
  readonly number?: string;
  readonly preview?: boolean;
  readonly type?: 'Embed' | 'Link';
}

function para(text: string): string {
  return `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
}

function oleParagraph(index: number, spec: LegacyObjectSpec): string {
  const preview = spec.preview !== false;
  return (
    '<w:p><w:r><w:tab/></w:r><w:r><w:object w:dxaOrig="1200" w:dyaOrig="360">' +
    `<v:shape id="_x0000_i10${index}" type="#_x0000_t75" style="width:60pt;height:18pt" o:ole="">` +
    (preview ? `<v:imagedata r:id="rIdImg${index}" o:title=""/>` : '') +
    '</v:shape>' +
    `<o:OLEObject Type="${spec.type ?? 'Embed'}" ProgID="${spec.progId}" ShapeID="_x0000_i10${index}" ` +
    `DrawAspect="Content" ObjectID="_17000${index}" r:id="rIdOle${index}"/>` +
    '</w:object></w:r>' +
    (spec.number === undefined ? '' : `<w:r><w:tab/><w:t>(${spec.number})</w:t></w:r>`) +
    '</w:p>'
  );
}

const OMML_PARAGRAPH =
  '<w:p><m:oMathPara><m:oMath><m:r><m:t>E=m</m:t></m:r><m:sSup><m:e><m:r><m:t>c</m:t></m:r></m:e>' +
  '<m:sup><m:r><m:t>2</m:t></m:r></m:sup></m:sSup></m:oMath></m:oMathPara></w:p>';

/**
 * A thesis-like DOCX: a chapter heading, text, and equations — legacy OLE
 * objects with previews and numbers, and optionally a modern OMML one.
 */
export function equationDocx(
  options: {
    readonly objects?: readonly LegacyObjectSpec[];
    readonly omml?: boolean;
    readonly extraEntries?: readonly ZipEntrySpec[];
    readonly extraRels?: string;
    readonly extraContentTypes?: string;
  } = {},
): Buffer {
  const objects = options.objects ?? [];
  const body =
    para('Chapter 3 Methodology') +
    para('The relation between energy and mass is given by') +
    (options.omml === true ? OMML_PARAGRAPH : '') +
    objects.map((spec, index) => oleParagraph(index + 1, spec)).join('') +
    para('where E is energy. Equation (3.1) is used throughout this chapter.');
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${NS}><w:body>${body}</w:body></w:document>`;

  const rels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    objects
      .map(
        (spec, index) =>
          `<Relationship Id="rIdOle${index + 1}" Type="${REL}/oleObject" Target="embeddings/oleObject${index + 1}.bin"` +
          (spec.type === 'Link' ? ' TargetMode="External"' : '') +
          '/>' +
          (spec.preview === false
            ? ''
            : `<Relationship Id="rIdImg${index + 1}" Type="${REL}/image" Target="media/image${index + 1}.wmf"/>`),
      )
      .join('') +
    (options.extraRels ?? '') +
    '</Relationships>';

  const entries: ZipEntrySpec[] = [
    {
      name: '[Content_Types].xml',
      data: contentTypesXml(
        undefined,
        '<Default Extension="bin" ContentType="application/vnd.openxmlformats-officedocument.oleObject"/>' +
          '<Default Extension="wmf" ContentType="image/x-wmf"/>' +
          (options.extraContentTypes ?? ''),
      ),
    },
    { name: '_rels/.rels', data: ROOT_RELS },
    { name: 'word/document.xml', data: document },
    { name: 'word/_rels/document.xml.rels', data: rels },
    ...objects.flatMap((spec, index) => [
      { name: `word/embeddings/oleObject${index + 1}.bin`, data: spec.bytes },
      ...(spec.preview === false
        ? []
        : [
            {
              name: `word/media/image${index + 1}.wmf`,
              data: Buffer.from([0xd7, 0xcd, 0xc6, 0x9a, 0, 0]),
            },
          ]),
    ]),
    ...(options.extraEntries ?? []),
  ];
  return buildZip(entries);
}

/** The case from real use: one MathType equation, numbered (3.1), with its preview. */
export function mathTypeEquationDocx(): Buffer {
  return equationDocx({
    objects: [{ progId: 'Equation.DSMT4', bytes: equationObject('Equation.DSMT4'), number: '3.1' }],
  });
}
