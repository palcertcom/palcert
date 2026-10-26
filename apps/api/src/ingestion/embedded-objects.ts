import {
  CompoundFileError,
  EntryType,
  parseCompoundFile,
  type CompoundFile,
} from './compound-file';
import { ContentRejectedError } from './errors';

/**
 * Embedded objects in a DOCX: a narrow, structural exception for scientific
 * equations written with the legacy equation editors, and rejection for
 * everything else.
 *
 * An academic thesis often carries equations as OLE objects (MathType's
 * `Equation.DSMT4`, Microsoft Equation 3.0's `Equation.3`). Word stores each
 * one as a compound file under `word/embeddings/` plus a rendered preview
 * image, and places an `<o:OLEObject ProgID="…">` in the text where the
 * equation sits. Rejecting every such thesis would make PalCert unusable for
 * the documents it exists to check.
 *
 * The exception is granted per object and only when *every* structural signal
 * agrees, so a file cannot be let in by one claim alone:
 *
 * 1. a part's relationship of type `oleObject` targets it, internally;
 * 2. that relationship is used by an `<o:OLEObject>` in the part's own XML,
 *    embedded (`Type="Embed"`), with a ProgID on the allow-list;
 * 3. the embedded bytes are a well-formed compound file whose root class id
 *    is the one registered for that ProgID;
 * 4. its `CompObj` stream names the same ProgID;
 * 5. it holds an `Equation Native` stream with a valid equation header;
 * 6. it holds nothing else: no storages, and only the streams an equation
 *    object has (never `Ole10Native`, which is how an arbitrary file is
 *    packaged).
 *
 * Nothing here executes, renders or converts anything. The compound file is
 * read as untrusted bytes by a bounded parser; no class id or ProgID is ever
 * resolved to a program; the preview image is noted, not decoded. Anything
 * that fails a check — an unknown class, an extra stream, a malformed
 * container, an orphaned embedding — is rejected exactly as before.
 */

export interface LegacyEquationClass {
  readonly progId: string;
  /** The class id Windows registers for this ProgID. */
  readonly clsid: string;
  readonly description: string;
}

/** The allow-list. Adding to it is a security decision, not a convenience. */
export const LEGACY_EQUATION_CLASSES: readonly LegacyEquationClass[] = [
  {
    progId: 'Equation.DSMT4',
    clsid: '{0002CE03-0000-0000-C000-000000000046}',
    description: 'MathType equation',
  },
  {
    progId: 'Equation.3',
    clsid: '{0002CE02-0000-0000-C000-000000000046}',
    description: 'Microsoft Equation 3.0',
  },
];

/**
 * The streams an equation object may hold. `CompObj`, `Ole` and `ObjInfo` are
 * the OLE bookkeeping every embedded object has; `Equation Native` is the
 * equation itself (MTEF); the `OlePres` and `EPRINT` streams are cached
 * pictures. `Ole10Native` — the wrapper for an arbitrary embedded file — is
 * deliberately absent.
 */
const EQUATION_STREAMS: ReadonlySet<string> = new Set([
  '\u0001CompObj',
  '\u0001Ole',
  '\u0003ObjInfo',
  'Equation Native',
  '\u0003EPRINT',
]);

/** `\u0002OlePres000` … `\u0002OlePres999`: cached presentation pictures. */
function isPresentationStream(name: string): boolean {
  return name.length === 11 && name.startsWith('\u0002OlePres') && /^\d{3}$/.test(name.slice(8));
}

const EQUATION_NATIVE_HEADER_BYTES = 28;

const REL_OLE_OBJECT = /\/relationships\/oleObject$/i;
const REL_PACKAGE = /\/relationships\/package$/i;
const REL_ACTIVEX = /\/relationships\/(control|activeXControlBinary)$/i;

export interface EmbeddedObjectReport {
  readonly legacyEquations: readonly {
    readonly part: string;
    readonly progId: string;
    readonly previewAvailable: boolean;
  }[];
}

export interface PackageReader {
  readonly names: ReadonlySet<string>;
  read(name: string): Promise<Buffer | null>;
}

function reject(detail: string): never {
  throw new ContentRejectedError('FILE_EMBEDDED_OBJECT_UNSUPPORTED', detail);
}

function attributes(tag: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const match of tag.matchAll(/([A-Za-z_:][\w:.-]*)\s*=\s*"([^"]*)"/g)) {
    result[match[1]!] = match[2]!;
  }
  return result;
}

/** Elements by local name, whatever prefix the producer chose. */
function elementsByLocalName(xml: string, localName: string): Record<string, string>[] {
  const pattern = new RegExp(`<(?:[A-Za-z_][\\w.-]*:)?${localName}\\b[^>]*?/?>`, 'g');
  return Array.from(xml.matchAll(pattern)).map((match) => attributes(match[0]));
}

/** An attribute by local name (`r:id`, `ns1:id` …). */
function attributeByLocalName(attrs: Record<string, string>, localName: string): string | null {
  for (const [key, value] of Object.entries(attrs)) {
    const local = key.includes(':') ? key.slice(key.indexOf(':') + 1) : key;
    if (local === localName && key.includes(':')) return value;
  }
  return null;
}

/** `word/_rels/document.xml.rels` → `word/document.xml`. */
function sourcePartOf(relsName: string): string | null {
  const match = /^(.*?)_rels\/([^/]+)\.rels$/.exec(relsName);
  return match === null ? null : `${match[1]}${match[2]}`;
}

/** Resolve a relationship target against its source part, refusing escapes. */
export function resolveTarget(sourcePart: string, target: string): string | null {
  if (target.startsWith('/')) return normalize(target.slice(1));
  const base = sourcePart.includes('/') ? sourcePart.slice(0, sourcePart.lastIndexOf('/') + 1) : '';
  return normalize(base + target);
}

function normalize(path: string): string | null {
  const out: string[] = [];
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return out.join('/');
}

/** The ProgID an OLE `CompObj` stream declares ([MS-OLEDS] 2.3.8), or null. */
export function compObjProgId(stream: Buffer): string | null {
  let offset = 28; // header
  const lengthPrefixed = (): string | null => {
    if (offset + 4 > stream.length) return null;
    const length = stream.readUInt32LE(offset);
    offset += 4;
    if (length === 0) return '';
    if (length > 256 || offset + length > stream.length) return null;
    const text = stream.subarray(offset, offset + length);
    offset += length;
    // Terminated by a NUL, and printable before it.
    if (text[text.length - 1] !== 0) return null;
    const value = text.subarray(0, text.length - 1).toString('latin1');
    return /^[\x20-\x7e]*$/.test(value) ? value : null;
  };
  if (lengthPrefixed() === null) return null; // AnsiUserType
  if (offset + 4 > stream.length) return null; // AnsiClipboardFormat
  const marker = stream.readUInt32LE(offset);
  if (marker === 0xffffffff || marker === 0xfffffffe) {
    offset += 8;
  } else if (lengthPrefixed() === null) {
    return null;
  }
  const progId = lengthPrefixed();
  return progId === null || progId === '' ? null : progId;
}

/** Why this compound file is not an allow-listed equation, or null when it is one. */
export function equationObjectProblem(
  file: CompoundFile,
  expected: LegacyEquationClass,
): string | null {
  if (file.root.clsid !== expected.clsid)
    return `class ${file.root.clsid} is not ${expected.progId}`;
  for (const entry of file.entries) {
    if (entry.type !== EntryType.Stream) return 'object contains a storage';
    if (!EQUATION_STREAMS.has(entry.name) && !isPresentationStream(entry.name)) {
      return `unexpected stream ${JSON.stringify(entry.name)}`;
    }
  }
  const compObj = file.readStream('\u0001CompObj');
  if (compObj === null) return 'no CompObj stream';
  const declared = compObjProgId(compObj);
  if (declared !== expected.progId) return `CompObj names ${JSON.stringify(declared)}`;

  const native = file.readStream('Equation Native');
  if (native === null) return 'no Equation Native stream';
  if (native.length < EQUATION_NATIVE_HEADER_BYTES) return 'equation header truncated';
  // EQNOLEFILEHDR: cbHdr (u16) = 28, then version, clipboard format, and the
  // size of the MTEF data that follows the header.
  if (native.readUInt16LE(0) !== EQUATION_NATIVE_HEADER_BYTES) return 'equation header size';
  const mtefBytes = native.readUInt32LE(8);
  if (mtefBytes === 0 || mtefBytes > native.length - EQUATION_NATIVE_HEADER_BYTES) {
    return 'equation data size';
  }
  return null;
}

/**
 * Classify every embedded object in the package. Returns what was accepted;
 * throws `FILE_EMBEDDED_OBJECT_UNSUPPORTED` for anything else.
 */
export async function classifyEmbeddedObjects(pkg: PackageReader): Promise<EmbeddedObjectReport> {
  const embedded = [...pkg.names].filter((name) => /^word\/embeddings\//i.test(name));
  for (const name of pkg.names) {
    if (/^word\/activeX\//i.test(name)) reject('ActiveX control present');
  }

  const verified = new Map<string, { progId: string; previewAvailable: boolean }>();
  const relsParts = [...pkg.names].filter((name) => name.endsWith('.rels'));

  for (const relsName of relsParts) {
    const relsXml = (await pkg.read(relsName))?.toString('utf8') ?? '';
    const relationships = elementsByLocalName(relsXml, 'Relationship');
    const sourcePart = sourcePartOf(relsName);

    const oleRelationships = new Map<string, string>();
    for (const rel of relationships) {
      const type = rel['Type'] ?? '';
      if (REL_PACKAGE.test(type)) reject('embedded package relationship');
      if (REL_ACTIVEX.test(type)) reject('ActiveX relationship');
      if (!REL_OLE_OBJECT.test(type)) continue;
      if ((rel['TargetMode'] ?? '').toLowerCase() === 'external') reject('linked OLE object');
      if (sourcePart === null) reject('OLE relationship outside a part');
      const target = resolveTarget(sourcePart, rel['Target'] ?? '');
      if (target === null || !/^word\/embeddings\/[^/]+\.bin$/i.test(target)) {
        reject('OLE relationship target outside word/embeddings');
      }
      if (!pkg.names.has(target)) reject('OLE relationship target missing');
      oleRelationships.set(rel['Id'] ?? '', target);
    }
    if (oleRelationships.size === 0 || sourcePart === null) continue;

    const partXml = (await pkg.read(sourcePart))?.toString('utf8');
    if (partXml === undefined) reject('part with OLE relationships is missing');
    const imageRelationships = new Set(
      relationships
        .filter((rel) => /\/relationships\/image$/i.test(rel['Type'] ?? ''))
        .map((rel) => rel['Id'] ?? ''),
    );

    for (const [relationshipId, target] of oleRelationships) {
      const uses = objectsUsing(partXml, relationshipId);
      if (uses.length === 0) reject('OLE relationship not used by any object');
      for (const use of uses) {
        if ((use.attrs['Type'] ?? '') !== 'Embed') reject('OLE object is not embedded');
        const progId = use.attrs['ProgID'] ?? '';
        const expected = LEGACY_EQUATION_CLASSES.find((entry) => entry.progId === progId);
        if (expected === undefined) reject(`OLE class ${JSON.stringify(progId)} is not allowed`);
        const previous = verified.get(target);
        if (previous !== undefined && previous.progId !== progId) reject('one object, two classes');

        if (previous === undefined) {
          const bytes = await pkg.read(target);
          if (bytes === null) reject('OLE object unreadable');
          let file: CompoundFile;
          try {
            file = parseCompoundFile(bytes);
          } catch (error) {
            if (error instanceof CompoundFileError)
              reject(`malformed OLE container: ${error.message}`);
            throw error;
          }
          const problem = equationObjectProblem(file, expected);
          if (problem !== null) reject(problem);
        }
        verified.set(target, {
          progId,
          previewAvailable:
            (previous?.previewAvailable ?? false) ||
            use.previewIds.some((id) => imageRelationships.has(id)),
        });
      }
    }
  }

  // An embedding nobody verified is an arbitrary file in the package.
  for (const name of embedded) {
    if (!verified.has(name)) reject('embedded object part present');
  }

  return {
    legacyEquations: [...verified].map(([part, info]) => ({ part, ...info })),
  };
}

/**
 * The `<o:OLEObject>` elements using a relationship, each with the image
 * relationship ids of the `<w:object>` around it (its preview).
 */
function objectsUsing(
  xml: string,
  relationshipId: string,
): { attrs: Record<string, string>; previewIds: string[] }[] {
  const result: { attrs: Record<string, string>; previewIds: string[] }[] = [];
  // Only inside a <w:object>: an OLEObject anywhere else is not how Word
  // places an equation, so its relationship counts as unused and is refused.
  const containers = xml.split(/<(?:[A-Za-z_][\w.-]*:)?object\b/).slice(1);
  for (const segment of containers) {
    const end = segment.search(/<\/(?:[A-Za-z_][\w.-]*:)?object>/);
    const body = end === -1 ? segment : segment.slice(0, end);
    for (const attrs of elementsByLocalName(body, 'OLEObject')) {
      if (attributeByLocalName(attrs, 'id') !== relationshipId) continue;
      const previewIds = elementsByLocalName(body, 'imagedata')
        .map((image) => attributeByLocalName(image, 'id'))
        .filter((id): id is string => id !== null);
      result.push({ attrs, previewIds });
    }
  }
  return result;
}
