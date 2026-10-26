import { classifyEmbeddedObjects, type EmbeddedObjectReport } from './embedded-objects';
import { ContentRejectedError } from './errors';
import { inspectArchive, readArchivePart, type ArchiveLimits } from './zip-safety';

export const DOCX_MAIN_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml';

const REQUIRED_PARTS = ['[Content_Types].xml', '_rels/.rels', 'word/document.xml'] as const;

const MACRO_CONTENT_TYPE = /vnd\.ms-office\.vbaProject|macroEnabled/i;
const MACRO_PART = /(^|\/)vbaProject\.bin$|(^|\/)vbaData\.xml$|\/vba\//i;
/** Never allowed in any form. */
const FORBIDDEN_CONTENT_TYPE = /x-msdownload|vnd\.ms-excel\.sheet\.binary|activeX/i;
/** Allowed only on a part the embedded-object classifier verified. */
const OLE_CONTENT_TYPE = /oleObject/i;
const ALLOWED_EXTERNAL_RELATIONSHIP = /\/relationships\/hyperlink$/i;
const OFFICE_DOCUMENT_RELATIONSHIP = /\/relationships\/officeDocument$/i;

/** Sufficient for OOXML rels and content-type parts, which are flat, attribute-only XML. */
function attributes(tag: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const match of tag.matchAll(/([A-Za-z_:][\w:.-]*)\s*=\s*"([^"]*)"/g)) {
    result[match[1]!] = match[2]!;
  }
  return result;
}

function elements(xml: string, name: string): Record<string, string>[] {
  const pattern = new RegExp(`<${name}\\b[^>]*?/?>`, 'g');
  return Array.from(xml.matchAll(pattern)).map((match) => attributes(match[0]));
}

export interface DocxInspection {
  readonly partCount: number;
  readonly mainContentType: string;
  /** Legacy equation objects accepted in safe mode (never executed). */
  readonly legacyEquations: EmbeddedObjectReport['legacyEquations'];
}

/**
 * The DOCX container policy (§15-§17), conservative for the MVP:
 *
 * - the three parts every WordprocessingML package must have are present;
 * - the main part is declared as a *document*, not a macro-enabled one;
 * - no VBA parts, no macro content types;
 * - no embedded OLE objects or packages (`word/embeddings/`), with one narrow
 *   exception: a legacy scientific-equation object that passes every check in
 *   `embedded-objects.ts`. It is accepted as data and never executed;
 * - external relationships are allowed for hyperlinks only.
 *
 * Nothing in the package is executed or rendered. Parts are read by name
 * into bounded memory; the archive-safety checks ran first.
 */
export async function validateDocxPackage(
  path: string,
  limits: ArchiveLimits,
): Promise<DocxInspection> {
  const archive = await inspectArchive(path, limits);
  const names = new Set(archive.entries.map((entry) => entry.name));

  for (const required of REQUIRED_PARTS) {
    if (!names.has(required)) {
      throw new ContentRejectedError('FILE_CONTAINER_INVALID', `missing ${required}`);
    }
  }
  for (const name of names) {
    if (MACRO_PART.test(name))
      throw new ContentRejectedError('FILE_MACRO_UNSUPPORTED', 'vba part present');
  }

  const contentTypesXml =
    (await readArchivePart(path, '[Content_Types].xml', limits))?.toString('utf8') ?? '';
  const overrides = elements(contentTypesXml, 'Override');
  const defaults = elements(contentTypesXml, 'Default');
  for (const declared of [...overrides, ...defaults]) {
    const contentType = declared['ContentType'] ?? '';
    if (MACRO_CONTENT_TYPE.test(contentType)) {
      throw new ContentRejectedError('FILE_MACRO_UNSUPPORTED', 'macro content type declared');
    }
    if (FORBIDDEN_CONTENT_TYPE.test(contentType)) {
      throw new ContentRejectedError(
        'FILE_EMBEDDED_OBJECT_UNSUPPORTED',
        'embedded object content type declared',
      );
    }
  }
  const main = overrides.find((entry) => entry['PartName'] === '/word/document.xml');
  const mainContentType =
    main?.['ContentType'] ??
    defaults.find((entry) => entry['Extension'] === 'xml')?.['ContentType'] ??
    '';
  if (mainContentType !== DOCX_MAIN_CONTENT_TYPE) {
    throw new ContentRejectedError(
      'FILE_CONTAINER_INVALID',
      'main part is not a wordprocessing document',
    );
  }

  const rootRels = (await readArchivePart(path, '_rels/.rels', limits))?.toString('utf8') ?? '';
  const officeDocument = elements(rootRels, 'Relationship').find((rel) =>
    OFFICE_DOCUMENT_RELATIONSHIP.test(rel['Type'] ?? ''),
  );
  const target = (officeDocument?.['Target'] ?? '').replace(/^\//, '');
  if (target !== 'word/document.xml') {
    throw new ContentRejectedError(
      'FILE_CONTAINER_INVALID',
      'root relationship does not point at the document',
    );
  }

  for (const name of names) {
    if (!name.endsWith('.rels')) continue;
    const rels = (await readArchivePart(path, name, limits))?.toString('utf8') ?? '';
    for (const rel of elements(rels, 'Relationship')) {
      if ((rel['TargetMode'] ?? '').toLowerCase() !== 'external') continue;
      if (!ALLOWED_EXTERNAL_RELATIONSHIP.test(rel['Type'] ?? '')) {
        throw new ContentRejectedError(
          'FILE_EXTERNAL_CONTENT_UNSUPPORTED',
          'external relationship other than a hyperlink',
        );
      }
    }
  }

  const report = await classifyEmbeddedObjects({
    names,
    read: (name) => readArchivePart(path, name, limits),
  });

  // The content type a part actually has: its override, else its extension's
  // default. An OLE-typed part must be one of the objects just verified.
  const verified = new Set(report.legacyEquations.map((entry) => entry.part));
  for (const name of names) {
    const override = overrides.find((entry) => entry['PartName'] === `/${name}`);
    const extension = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
    const effective =
      override?.['ContentType'] ??
      defaults.find((entry) => (entry['Extension'] ?? '').toLowerCase() === extension)?.[
        'ContentType'
      ] ??
      '';
    if (OLE_CONTENT_TYPE.test(effective) && !verified.has(name)) {
      throw new ContentRejectedError(
        'FILE_EMBEDDED_OBJECT_UNSUPPORTED',
        'embedded object content type on an unverified part',
      );
    }
  }

  return {
    partCount: archive.entries.length,
    mainContentType,
    legacyEquations: report.legacyEquations,
  };
}
