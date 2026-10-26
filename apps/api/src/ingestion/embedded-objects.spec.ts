import * as childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { embeddedObjectDocx, macroDocx } from '../../test/support/fixtures';
import {
  EQUATION3_CLSID,
  buildCompoundFile,
  compObjStream,
  embeddedWordDocumentObject,
  equationDocx,
  equationNativeStream,
  equationObject,
  mathTypeEquationDocx,
  packagedExecutableObject,
} from '../../test/support/ole-fixtures';
import {
  REAL_EQUATION_PARAGRAPH,
  REAL_OLE_OBJECT_SHA256,
  REAL_TEMPLATE_SHA256,
  realPhdEquationDocx,
  realPhdOleObject,
} from '../../test/support/real-phd-template';
import { CompoundFileError, parseCompoundFile } from './compound-file';
import { validateDocxPackage } from './docx-validator';
import { LEGACY_EQUATION_CLASSES, compObjProgId, resolveTarget } from './embedded-objects';
import { ContentRejectedError } from './errors';
import type { ArchiveLimits } from './zip-safety';

// Every way Node can start a program, wrapped so the test can see a call.
jest.mock('node:child_process', () => {
  const actual = jest.requireActual<typeof import('node:child_process')>('node:child_process');
  const wrap = <T extends (...args: never[]) => unknown>(fn: T) => jest.fn(fn);
  return {
    ...actual,
    spawn: wrap(actual.spawn),
    spawnSync: wrap(actual.spawnSync),
    exec: wrap(actual.exec),
    execSync: wrap(actual.execSync),
    execFile: wrap(actual.execFile),
    execFileSync: wrap(actual.execFileSync),
    fork: wrap(actual.fork),
  };
});

const LIMITS: ArchiveLimits = {
  maxEntries: 64,
  maxEntryBytes: 4 * 1024 * 1024,
  maxTotalBytes: 8 * 1024 * 1024,
  maxCompressionRatio: 50,
  maxInspectedPartBytes: 1024 * 1024,
};

let scratch: string;
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'palcert-embedded-spec-'));
});
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

let counter = 0;
async function file(bytes: Buffer): Promise<string> {
  counter += 1;
  const path = join(scratch, `fixture-${counter}.docx`);
  await writeFile(path, bytes);
  return path;
}

async function rejection(bytes: Buffer): Promise<ContentRejectedError> {
  try {
    await validateDocxPackage(await file(bytes), LIMITS);
  } catch (error) {
    if (error instanceof ContentRejectedError) return error;
    throw error;
  }
  throw new Error('expected a rejection');
}

const dsmt4 = () => equationObject('Equation.DSMT4');

describe('compound file reader', () => {
  it('reads the class id, the streams and a stream’s bytes', () => {
    const file = parseCompoundFile(dsmt4());
    expect(file.root.clsid).toBe('{0002CE03-0000-0000-C000-000000000046}');
    expect(file.entries.map((entry) => entry.name).sort()).toEqual(
      ['\u0001CompObj', '\u0001Ole', '\u0003ObjInfo', 'Equation Native'].sort(),
    );
    expect(file.readStream('Equation Native')).toEqual(equationNativeStream());
    expect(compObjProgId(file.readStream('\u0001CompObj')!)).toBe('Equation.DSMT4');
  });

  it('reads a stream stored in regular sectors', () => {
    const big = Buffer.alloc(9000, 7);
    const file = parseCompoundFile(
      buildCompoundFile({
        clsid: EQUATION3_CLSID,
        streams: [{ name: 'Equation Native', data: big }],
      }),
    );
    expect(file.readStream('Equation Native')).toEqual(big);
  });

  it('refuses what is not a compound file, a truncated one and a looping one', () => {
    expect(() => parseCompoundFile(Buffer.from('MZ this is not ole'))).toThrow(CompoundFileError);
    expect(() => parseCompoundFile(dsmt4().subarray(0, 700))).toThrow(CompoundFileError);

    const looping = Buffer.from(dsmt4());
    // FAT lives in sector 0 (file offset 512); the directory starts at sector
    // 1. Point sector 1 at itself.
    looping.writeUInt32LE(1, 512 + 4);
    expect(() => parseCompoundFile(looping)).toThrow(/loop/);
  });

  it('refuses a stream larger than the inspection limit', () => {
    const file = parseCompoundFile(
      buildCompoundFile({
        clsid: EQUATION3_CLSID,
        streams: [{ name: 'Equation Native', data: Buffer.alloc(9000) }],
      }),
      { maxDirectoryEntries: 64, maxStreamBytes: 4096 },
    );
    expect(() => file.readStream('Equation Native')).toThrow(/inspection limit/);
  });

  it('resolves relationship targets without letting them escape the package', () => {
    expect(resolveTarget('word/document.xml', 'embeddings/oleObject1.bin')).toBe(
      'word/embeddings/oleObject1.bin',
    );
    expect(resolveTarget('word/document.xml', '/word/embeddings/a.bin')).toBe(
      'word/embeddings/a.bin',
    );
    expect(resolveTarget('word/document.xml', '../../../etc/passwd')).toBeNull();
  });
});

describe('scientific equations are accepted', () => {
  it('a MathType (Equation.DSMT4) equation numbered (3.1), with its preview', async () => {
    const inspection = await validateDocxPackage(await file(mathTypeEquationDocx()), LIMITS);
    expect(inspection.legacyEquations).toEqual([
      { part: 'word/embeddings/oleObject1.bin', progId: 'Equation.DSMT4', previewAvailable: true },
    ]);
  });

  it('a Microsoft Equation 3.0 (Equation.3) equation', async () => {
    const inspection = await validateDocxPackage(
      await file(
        equationDocx({ objects: [{ progId: 'Equation.3', bytes: equationObject('Equation.3') }] }),
      ),
      LIMITS,
    );
    expect(inspection.legacyEquations.map((entry) => entry.progId)).toEqual(['Equation.3']);
  });

  it('several legacy equations', async () => {
    const inspection = await validateDocxPackage(
      await file(
        equationDocx({
          objects: ['3.1', '3.2', '3.3'].map((number) => ({
            progId: 'Equation.DSMT4',
            bytes: dsmt4(),
            number,
          })),
        }),
      ),
      LIMITS,
    );
    expect(inspection.legacyEquations).toHaveLength(3);
  });

  it('modern Office Math (OMML) alone, with nothing embedded', async () => {
    const inspection = await validateDocxPackage(await file(equationDocx({ omml: true })), LIMITS);
    expect(inspection.legacyEquations).toEqual([]);
  });

  it('OMML and legacy equations in the same document', async () => {
    const inspection = await validateDocxPackage(
      await file(
        equationDocx({
          omml: true,
          objects: [{ progId: 'Equation.DSMT4', bytes: dsmt4(), number: '3.1' }],
        }),
      ),
      LIMITS,
    );
    expect(inspection.legacyEquations).toHaveLength(1);
  });

  it('an equation carrying cached presentation pictures (OlePres, EPRINT)', async () => {
    const withPictures = equationObject('Equation.DSMT4', {
      extraStreams: [
        { name: '\u0002OlePres000', data: Buffer.alloc(40, 1) },
        { name: '\u0003EPRINT', data: Buffer.alloc(40, 2) },
      ],
    });
    const inspection = await validateDocxPackage(
      await file(equationDocx({ objects: [{ progId: 'Equation.DSMT4', bytes: withPictures }] })),
      LIMITS,
    );
    expect(inspection.legacyEquations).toHaveLength(1);
  });

  it('a legacy equation without a preview picture is still an equation', async () => {
    const inspection = await validateDocxPackage(
      await file(
        equationDocx({ objects: [{ progId: 'Equation.DSMT4', bytes: dsmt4(), preview: false }] }),
      ),
      LIMITS,
    );
    expect(inspection.legacyEquations[0]?.previewAvailable).toBe(false);
  });
});

describe('everything else embedded is still rejected', () => {
  const rejectedAsEmbedded = async (bytes: Buffer) =>
    expect((await rejection(bytes)).code).toBe('FILE_EMBEDDED_OBJECT_UNSUPPORTED');

  it('a bare embedding nothing refers to (the existing fixture)', async () => {
    await rejectedAsEmbedded(embeddedObjectDocx());
  });

  it('a packaged executable, whatever the XML claims it is', async () => {
    await rejectedAsEmbedded(
      equationDocx({ objects: [{ progId: 'Package', bytes: packagedExecutableObject() }] }),
    );
    // Claiming to be an equation does not help: the bytes are a Packager object.
    const error = await rejection(
      equationDocx({ objects: [{ progId: 'Equation.DSMT4', bytes: packagedExecutableObject() }] }),
    );
    expect(error.code).toBe('FILE_EMBEDDED_OBJECT_UNSUPPORTED');
    expect(error.detail).toMatch(/class/);
  });

  it('an embedded Office document', async () => {
    await rejectedAsEmbedded(
      equationDocx({
        objects: [{ progId: 'Word.Document.12', bytes: embeddedWordDocumentObject() }],
      }),
    );
  });

  it('an unknown OLE class, even with genuine equation bytes and a preview', async () => {
    const error = await rejection(
      equationDocx({ objects: [{ progId: 'Equation.Unknown', bytes: dsmt4() }] }),
    );
    expect(error.detail).toMatch(/not allowed/);
  });

  it('an equation class id carrying an extra Ole10Native payload', async () => {
    const smuggled = equationObject('Equation.DSMT4', {
      extraStreams: [{ name: '\u0001Ole10Native', data: Buffer.from('MZ payload') }],
    });
    const error = await rejection(
      equationDocx({ objects: [{ progId: 'Equation.DSMT4', bytes: smuggled }] }),
    );
    expect(error.detail).toMatch(/unexpected stream/);
  });

  it('an equation object with a storage inside it', async () => {
    const nested = buildCompoundFile({
      clsid: '{0002CE03-0000-0000-C000-000000000046}',
      streams: [
        { name: '\u0001CompObj', data: compObjStream('MathType 6.0 Equation', 'Equation.DSMT4') },
        { name: 'Equation Native', data: equationNativeStream() },
      ],
      storages: ['Hidden'],
    });
    await rejectedAsEmbedded(
      equationDocx({ objects: [{ progId: 'Equation.DSMT4', bytes: nested }] }),
    );
  });

  it('a class id that does not match the ProgID', async () => {
    const wrong = equationObject('Equation.DSMT4', { clsid: EQUATION3_CLSID });
    await rejectedAsEmbedded(
      equationDocx({ objects: [{ progId: 'Equation.DSMT4', bytes: wrong }] }),
    );
  });

  it('a CompObj that names a different program', async () => {
    const lying = buildCompoundFile({
      clsid: '{0002CE03-0000-0000-C000-000000000046}',
      streams: [
        { name: '\u0001CompObj', data: compObjStream('MathType 6.0 Equation', 'Excel.Sheet.12') },
        { name: 'Equation Native', data: equationNativeStream() },
      ],
    });
    await rejectedAsEmbedded(
      equationDocx({ objects: [{ progId: 'Equation.DSMT4', bytes: lying }] }),
    );
  });

  it('no equation data, or an equation header that does not add up', async () => {
    const noNative = buildCompoundFile({
      clsid: '{0002CE03-0000-0000-C000-000000000046}',
      streams: [
        { name: '\u0001CompObj', data: compObjStream('MathType 6.0 Equation', 'Equation.DSMT4') },
      ],
    });
    await rejectedAsEmbedded(
      equationDocx({ objects: [{ progId: 'Equation.DSMT4', bytes: noNative }] }),
    );

    const badHeader = Buffer.from(equationNativeStream());
    badHeader.writeUInt32LE(100_000, 8);
    const oversized = buildCompoundFile({
      clsid: '{0002CE03-0000-0000-C000-000000000046}',
      streams: [
        { name: '\u0001CompObj', data: compObjStream('MathType 6.0 Equation', 'Equation.DSMT4') },
        { name: 'Equation Native', data: badHeader },
      ],
    });
    await rejectedAsEmbedded(
      equationDocx({ objects: [{ progId: 'Equation.DSMT4', bytes: oversized }] }),
    );
  });

  it('a malformed OLE container', async () => {
    for (const bytes of [Buffer.from('not ole at all'), dsmt4().subarray(0, 700)]) {
      const error = await rejection(
        equationDocx({ objects: [{ progId: 'Equation.DSMT4', bytes }] }),
      );
      expect(error.code).toBe('FILE_EMBEDDED_OBJECT_UNSUPPORTED');
      expect(error.detail).toMatch(/malformed OLE container/);
    }
  });

  it('a linked (external) OLE object', async () => {
    const error = await rejection(
      equationDocx({ objects: [{ progId: 'Equation.DSMT4', bytes: dsmt4(), type: 'Link' }] }),
    );
    expect(error.code).toBe('FILE_EXTERNAL_CONTENT_UNSUPPORTED');
  });

  it('an OLE relationship whose target escapes word/embeddings', async () => {
    const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
    for (const target of ['../../evil.bin', 'media/image1.wmf']) {
      await rejectedAsEmbedded(
        equationDocx({
          objects: [{ progId: 'Equation.DSMT4', bytes: dsmt4() }],
          extraRels: `<Relationship Id="rIdX" Type="${REL}/oleObject" Target="${target}"/>`,
        }),
      );
    }
  });

  it('a verified equation next to an embedding no object refers to', async () => {
    await rejectedAsEmbedded(
      equationDocx({
        objects: [{ progId: 'Equation.DSMT4', bytes: dsmt4() }],
        extraEntries: [{ name: 'word/embeddings/oleObject9.bin', data: dsmt4() }],
      }),
    );
  });

  it('an OLE relationship nothing in the text uses', async () => {
    const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
    await rejectedAsEmbedded(
      equationDocx({
        objects: [{ progId: 'Equation.DSMT4', bytes: dsmt4() }],
        extraRels: `<Relationship Id="rIdUnused" Type="${REL}/oleObject" Target="embeddings/oleObject1.bin"/>`,
      }),
    );
  });

  it('ActiveX controls', async () => {
    await rejectedAsEmbedded(
      equationDocx({
        extraEntries: [
          {
            name: 'word/activeX/activeX1.xml',
            data: '<ax:ocx xmlns:ax="http://schemas.microsoft.com/office/2006/activeX"/>',
          },
          { name: 'word/activeX/activeX1.bin', data: Buffer.from('ocx') },
        ],
        extraContentTypes:
          '<Override PartName="/word/activeX/activeX1.xml" ContentType="application/vnd.ms-office.activeX+xml"/>',
      }),
    );
  });

  it('an embedded package (an Office file attached by relationship)', async () => {
    const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
    // As an .xlsx it is already refused as a nested archive…
    expect(
      (
        await rejection(
          equationDocx({
            extraRels: `<Relationship Id="rIdPkg" Type="${REL}/package" Target="embeddings/Sheet1.xlsx"/>`,
            extraEntries: [
              { name: 'word/embeddings/Sheet1.xlsx', data: Buffer.from('PK not really') },
            ],
          }),
        )
      ).code,
    ).toBe('FILE_ARCHIVE_UNSAFE');
    // …and under any other name, the package relationship itself is refused.
    await rejectedAsEmbedded(
      equationDocx({
        extraRels: `<Relationship Id="rIdPkg" Type="${REL}/package" Target="embeddings/blob.dat"/>`,
        extraEntries: [{ name: 'word/embeddings/blob.dat', data: Buffer.from('data') }],
      }),
    );
  });

  it('macros, even beside an accepted equation', async () => {
    expect((await rejection(macroDocx())).code).toBe('FILE_MACRO_UNSUPPORTED');
    const withVba = equationDocx({
      objects: [{ progId: 'Equation.DSMT4', bytes: dsmt4() }],
      extraEntries: [{ name: 'word/vbaProject.bin', data: Buffer.from('vba') }],
    });
    expect((await rejection(withVba)).code).toBe('FILE_MACRO_UNSUPPORTED');
  });
});

describe('embedded content is never executed', () => {
  it('starts no process while classifying an equation or a hostile object', async () => {
    await validateDocxPackage(await file(mathTypeEquationDocx()), LIMITS);
    await rejection(
      equationDocx({ objects: [{ progId: 'Equation.DSMT4', bytes: packagedExecutableObject() }] }),
    );
    for (const name of [
      'spawn',
      'spawnSync',
      'exec',
      'execSync',
      'execFile',
      'execFileSync',
      'fork',
    ] as const) {
      expect(childProcess[name]).not.toHaveBeenCalled();
    }
  });

  it('has no way to: the classifier imports no process, VM or worker API', () => {
    for (const module of ['embedded-objects.ts', 'compound-file.ts', 'docx-validator.ts']) {
      const source = readFileSync(join(__dirname, module), 'utf8');
      expect(source).not.toMatch(/child_process|node:vm|worker_threads|\beval\(|new Function\(/);
    }
  });
});

describe('the real PhD_Template_00.docx equation', () => {
  const CLSID = '{0002CE03-0000-0000-C000-000000000046}';

  it('is exactly what MathType wrote: the values the allow-list is checked against', () => {
    const file = parseCompoundFile(realPhdOleObject());
    expect(file.root.clsid).toBe(CLSID);
    expect(file.entries.map((entry) => entry.name)).toEqual([
      '\u0001Ole',
      '\u0001CompObj',
      '\u0003ObjInfo',
      'Equation Native',
    ]);
    const compObj = file.readStream('\u0001CompObj')!;
    expect(compObj.toString('latin1')).toContain('MathType 6.0 Equation');
    expect(compObjProgId(compObj)).toBe('Equation.DSMT4');
    const native = file.readStream('Equation Native')!;
    expect(native.readUInt16LE(0)).toBe(28);
    expect(native.readUInt32LE(8)).toBe(465);
    expect(REAL_EQUATION_PARAGRAPH).toContain(
      '<o:OLEObject Type="Embed" ProgID="Equation.DSMT4" ShapeID="_x0000_i1025" DrawAspect="Content" ObjectID="_1851923692" r:id="rId15"/>',
    );
    expect(REAL_EQUATION_PARAGRAPH).toContain('<v:imagedata r:id="rId14" o:title=""/>');
  });

  it('maps to the allow-list entry it was built from, and the list stays two entries long', () => {
    expect(LEGACY_EQUATION_CLASSES.find((entry) => entry.progId === 'Equation.DSMT4')?.clsid).toBe(
      CLSID,
    );
    expect(LEGACY_EQUATION_CLASSES.map((entry) => entry.progId)).toEqual([
      'Equation.DSMT4',
      'Equation.3',
    ]);
  });

  it('is accepted with its preview, as it sits in the template', async () => {
    const inspection = await validateDocxPackage(await file(realPhdEquationDocx()), LIMITS);
    expect(inspection.legacyEquations).toEqual([
      { part: 'word/embeddings/oleObject1.bin', progId: 'Equation.DSMT4', previewAvailable: true },
    ]);
  });

  it('is refused the moment any structural signal stops agreeing', async () => {
    const real = realPhdOleObject();

    // A different class id in the root entry: the first CLSID byte of the
    // first directory entry (directory sector from the header, +80 into it).
    const otherClass = Buffer.from(real);
    const clsidAt = (real.readUInt32LE(48) + 1) * 512 + 80;
    otherClass.writeUInt8(real.readUInt8(clsidAt) ^ 0x01, clsidAt);
    expect(parseCompoundFile(otherClass).root.clsid).not.toBe(CLSID);

    // The XML claiming a neighbouring class that is not on the list.
    const otherProgId = REAL_EQUATION_PARAGRAPH.replace(
      'ProgID="Equation.DSMT4"',
      'ProgID="Equation.DSMT5"',
    );
    // Linked instead of embedded.
    const linked = REAL_EQUATION_PARAGRAPH.replace('Type="Embed"', 'Type="Link"');
    // The equation data renamed away.
    const renamed = Buffer.from(real);
    const native = Buffer.from('Equation Native', 'utf16le');
    const at = renamed.indexOf(native);
    Buffer.from('Equation Nativf', 'utf16le').copy(renamed, at);

    for (const bytes of [
      realPhdEquationDocx({ oleObject: otherClass }),
      realPhdEquationDocx({ paragraph: otherProgId }),
      realPhdEquationDocx({ paragraph: linked }),
      realPhdEquationDocx({ oleObject: renamed }),
      realPhdEquationDocx({ oleObject: packagedExecutableObject() }),
    ]) {
      expect((await rejection(bytes)).code).toBe('FILE_EMBEDDED_OBJECT_UNSUPPORTED');
    }
  });

  const realTemplate = process.env['PALCERT_REAL_TEMPLATE'];
  (realTemplate === undefined ? it.skip : it)(
    'accepts the whole, unmodified template (PALCERT_REAL_TEMPLATE)',
    async () => {
      const bytes = readFileSync(realTemplate!);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(REAL_TEMPLATE_SHA256);
      const inspection = await validateDocxPackage(realTemplate!, {
        ...LIMITS,
        maxEntryBytes: 64 * 1024 * 1024,
        maxTotalBytes: 256 * 1024 * 1024,
        maxInspectedPartBytes: 4 * 1024 * 1024,
      });
      expect(inspection.legacyEquations).toEqual([
        {
          part: 'word/embeddings/oleObject1.bin',
          progId: 'Equation.DSMT4',
          previewAvailable: true,
        },
      ]);
      // And it carries the very object the committed fixture holds.
      const zip = await file(bytes);
      const { readArchivePart } = await import('./zip-safety');
      const embedded = await readArchivePart(zip, 'word/embeddings/oleObject1.bin', {
        ...LIMITS,
        maxInspectedPartBytes: 4 * 1024 * 1024,
      });
      expect(createHash('sha256').update(embedded!).digest('hex')).toBe(REAL_OLE_OBJECT_SHA256);
    },
  );
});
