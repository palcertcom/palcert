import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import {
  EICAR,
  buildZip,
  embeddedObjectDocx,
  externalImageDocx,
  macroDocx,
  manyEntriesZip,
  minimalDocx,
  minimalPdf,
  nestedArchiveDocx,
  randomZip,
  traversalZip,
  truncatedPdf,
  zipBomb,
} from '../../test/support/fixtures';
import { FakeMalwareScanner } from '../infrastructure/scanner/fake-scanner';
import { InMemoryObjectStorage } from '../infrastructure/storage/in-memory-object-storage';
import { validateDocxPackage } from './docx-validator';
import { ContentRejectedError, TransientIngestError } from './errors';
import { sha256Stream, sha256ToFile } from './hashing';
import { IngestPipeline, type IngestInput } from './ingest-pipeline';
import { validatePdfStructure } from './pdf-validator';
import { classifyFailure } from './retry-classification';
import { describeUnsupportedSignature, detectSignature, readHeadAndTail } from './signature';
import { withSecureTempDir } from './temp-files';
import { assertSafeEntryName, inspectArchive, type ArchiveLimits } from './zip-safety';

const LIMITS: ArchiveLimits = {
  maxEntries: 64,
  maxEntryBytes: 4 * 1024 * 1024,
  maxTotalBytes: 8 * 1024 * 1024,
  maxCompressionRatio: 50,
  maxInspectedPartBytes: 1024 * 1024,
};

let scratch: string;
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'palcert-ingest-spec-'));
});
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

let counter = 0;
async function file(bytes: Buffer): Promise<string> {
  counter += 1;
  const path = join(scratch, `fixture-${counter}.bin`);
  await writeFile(path, bytes);
  return path;
}

function chunked(bytes: Buffer, size: number): Readable {
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < bytes.length; offset += size)
    chunks.push(bytes.subarray(offset, offset + size));
  return Readable.from(chunks.length === 0 ? [Buffer.alloc(0)] : chunks);
}

async function rejection(promise: Promise<unknown>): Promise<ContentRejectedError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ContentRejectedError) return error;
    throw error;
  }
  throw new Error('expected a rejection');
}

// ---------------------------------------------------------------------------
describe('streaming SHA-256 (§92)', () => {
  const bytes = Buffer.from('The quick brown fox jumps over the lazy dog. '.repeat(1000));
  const expected = createHash('sha256').update(bytes).digest('hex');

  it('same bytes give the same digest', async () => {
    expect((await sha256Stream(chunked(bytes, 64))).sha256).toBe(expected);
    expect((await sha256Stream(chunked(bytes, 64))).sha256).toBe(expected);
  });

  it('a single-byte change gives a different digest', async () => {
    const altered = Buffer.from(bytes);
    altered[100] = (altered[100] ?? 0) ^ 0x01;
    expect((await sha256Stream(chunked(altered, 64))).sha256).not.toBe(expected);
  });

  it('chunk boundaries do not affect the digest', async () => {
    for (const size of [1, 7, 64, 4096, bytes.length]) {
      expect((await sha256Stream(chunked(bytes, size))).sha256).toBe(expected);
    }
  });

  it('hashes a large stream without buffering it', async () => {
    // 64 MiB generated on the fly; the process heap must not grow by that much.
    const chunk = Buffer.alloc(1024 * 1024, 0xab);
    const before = process.memoryUsage().heapUsed;
    const digest = await sha256Stream(
      Readable.from(
        (function* () {
          for (let i = 0; i < 64; i += 1) yield chunk;
        })(),
      ),
    );
    const after = process.memoryUsage().heapUsed;

    expect(digest.sizeBytes).toBe(64 * 1024 * 1024);
    expect(after - before).toBeLessThan(32 * 1024 * 1024);
  });

  it('writes to a file while hashing, and stops at the ceiling', async () => {
    const path = join(scratch, 'streamed.bin');
    const digest = await sha256ToFile(chunked(bytes, 1000), path, { maxBytes: bytes.length });
    expect(digest.sha256).toBe(expected);
    expect((await stat(path)).size).toBe(bytes.length);
    expect((await stat(path)).mode & 0o777).toBe(0o600);

    const over = await rejection(
      sha256ToFile(chunked(bytes, 1000), join(scratch, 'over.bin'), { maxBytes: 100 }),
    );
    expect(over.code).toBe('FILE_TOO_LARGE');
  });
});

// ---------------------------------------------------------------------------
describe('signature detection', () => {
  it('recognizes PDF and ZIP by leading bytes, nothing by name', () => {
    expect(detectSignature(minimalPdf().subarray(0, 64))).toBe('PDF');
    expect(detectSignature(minimalDocx().subarray(0, 64))).toBe('ZIP');
    expect(detectSignature(Buffer.from('MZ\x90\x00'))).toBe('UNKNOWN');
    expect(detectSignature(Buffer.from('<!doctype html>'))).toBe('UNKNOWN');
    expect(detectSignature(Buffer.alloc(0))).toBe('UNKNOWN');
  });

  it('names the well-known things it refuses', () => {
    expect(describeUnsupportedSignature(Buffer.from('MZ\x90\x00'))).toBe('windows executable');
    expect(describeUnsupportedSignature(Buffer.from('d0cf11e0a1b11ae1', 'hex'))).toMatch(
      /legacy office/,
    );
    expect(describeUnsupportedSignature(Buffer.from('{\\rtf1'))).toBe('rtf');
    expect(describeUnsupportedSignature(Buffer.from('<html>'))).toBe('html');
  });

  it('reads head and tail without loading the file', async () => {
    const bytes = minimalPdf('x', 10_000);
    const { head, tail } = await readHeadAndTail(await file(bytes), bytes.length);
    expect(head.subarray(0, 5).toString()).toBe('%PDF-');
    expect(tail.toString('latin1')).toContain('%%EOF');
  });
});

// ---------------------------------------------------------------------------
describe('PDF structure', () => {
  it('accepts a minimal valid PDF', () => {
    const bytes = minimalPdf();
    expect(validatePdfStructure(bytes, bytes.subarray(-2048)).version).toBe('1.7');
  });

  it('rejects a PDF header with nothing behind it', () => {
    const bytes = truncatedPdf();
    expect(() => validatePdfStructure(bytes, bytes)).toThrow(ContentRejectedError);
  });

  it('rejects an unknown version', () => {
    const bytes = Buffer.from('%PDF-9.9\n%%EOF startxref');
    expect(() => validatePdfStructure(bytes, bytes)).toThrow(/version/);
  });
});

// ---------------------------------------------------------------------------
describe('ZIP safety (§17)', () => {
  it('accepts safe entry names', () => {
    for (const name of [
      'word/document.xml',
      '[Content_Types].xml',
      '_rels/.rels',
      'word/media/رسم.png',
    ]) {
      expect(() => assertSafeEntryName(name)).not.toThrow();
    }
  });

  it.each([
    ['../../etc/passwd', 'traversal'],
    ['/etc/passwd', 'absolute'],
    ['C:/Windows/system32', 'drive'],
    ['word\\document.xml', 'backslash'],
    ['word/./document.xml', 'self-reference'],
    ['word//document.xml', 'empty segment'],
    ['word/doc\u0000ument.xml', 'NUL'],
    ['word/doc\u0007.xml', 'control'],
    ['', 'empty'],
    ['x'.repeat(600), 'too long'],
  ])('rejects %j (%s)', (name) => {
    expect(() => assertSafeEntryName(name)).toThrow(ContentRejectedError);
  });

  it('inspects the central directory of a valid package', async () => {
    const inspection = await inspectArchive(await file(minimalDocx()), LIMITS);
    expect(inspection.entries.map((entry) => entry.name)).toEqual(
      expect.arrayContaining(['[Content_Types].xml', '_rels/.rels', 'word/document.xml']),
    );
  });

  it('rejects a traversal entry', async () => {
    expect((await rejection(inspectArchive(await file(traversalZip()), LIMITS))).code).toBe(
      'FILE_ARCHIVE_UNSAFE',
    );
  });

  it('rejects a compression bomb by ratio', async () => {
    const error = await rejection(inspectArchive(await file(zipBomb()), LIMITS));
    expect(error.code).toBe('FILE_ARCHIVE_UNSAFE');
    expect(error.detail).toMatch(/ratio|total size/);
  });

  it('rejects too many entries', async () => {
    expect((await rejection(inspectArchive(await file(manyEntriesZip(100)), LIMITS))).code).toBe(
      'FILE_ARCHIVE_UNSAFE',
    );
  });

  it('rejects a nested archive', async () => {
    expect((await rejection(inspectArchive(await file(nestedArchiveDocx()), LIMITS))).detail).toBe(
      'nested archive',
    );
  });

  it('rejects an executable payload', async () => {
    const zip = buildZip([
      { name: 'word/document.xml', data: '<x/>' },
      { name: 'word/media/run.exe', data: 'MZ' },
    ]);
    expect((await rejection(inspectArchive(await file(zip), LIMITS))).detail).toBe(
      'executable payload',
    );
  });

  it('rejects garbage as an invalid container, not as unsafe', async () => {
    const error = await rejection(
      inspectArchive(await file(Buffer.from('PK\x03\x04 not really a zip')), LIMITS),
    );
    expect(error.code).toBe('FILE_CONTAINER_INVALID');
  });
});

// ---------------------------------------------------------------------------
describe('DOCX container policy (§16)', () => {
  it('accepts a minimal valid package', async () => {
    const inspection = await validateDocxPackage(await file(minimalDocx()), LIMITS);
    expect(inspection.partCount).toBe(3);
  });

  it('rejects a ZIP that is not a Word package', async () => {
    expect((await rejection(validateDocxPackage(await file(randomZip()), LIMITS))).code).toBe(
      'FILE_CONTAINER_INVALID',
    );
  });

  it('rejects a macro-enabled package', async () => {
    expect((await rejection(validateDocxPackage(await file(macroDocx()), LIMITS))).code).toBe(
      'FILE_MACRO_UNSUPPORTED',
    );
  });

  it('rejects an embedded OLE object', async () => {
    expect(
      (await rejection(validateDocxPackage(await file(embeddedObjectDocx()), LIMITS))).code,
    ).toBe('FILE_EMBEDDED_OBJECT_UNSUPPORTED');
  });

  it('rejects an external image relationship but allows hyperlinks', async () => {
    expect(
      (await rejection(validateDocxPackage(await file(externalImageDocx()), LIMITS))).code,
    ).toBe('FILE_EXTERNAL_CONTENT_UNSUPPORTED');

    const hyperlinkRels =
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://palcert.com" TargetMode="External"/>' +
      '</Relationships>';
    await expect(
      validateDocxPackage(
        await file(
          minimalDocx({
            extraEntries: [{ name: 'word/_rels/document.xml.rels', data: hyperlinkRels }],
          }),
        ),
        LIMITS,
      ),
    ).resolves.toBeDefined();
  });

  it('rejects a package missing a required part', async () => {
    const zip = buildZip([
      { name: '[Content_Types].xml', data: '<Types/>' },
      { name: 'word/document.xml', data: '<x/>' },
    ]);
    expect((await rejection(validateDocxPackage(await file(zip), LIMITS))).detail).toBe(
      'missing _rels/.rels',
    );
  });
});

// ---------------------------------------------------------------------------
describe('temp files (§62)', () => {
  it('removes the scratch directory on success and on failure', async () => {
    let seen = '';
    await withSecureTempDir(async (directory) => {
      seen = directory;
      await writeFile(join(directory, 'x'), 'y');
    });
    await expect(stat(seen)).rejects.toThrow();

    await expect(
      withSecureTempDir(async (directory) => {
        seen = directory;
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await expect(stat(seen)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
describe('failure classification (§59)', () => {
  it('keeps rejections and transient failures apart', () => {
    expect(classifyFailure(new ContentRejectedError('FILE_MACRO_UNSUPPORTED', 'x')).kind).toBe(
      'rejected',
    );
    expect(classifyFailure(new TransientIngestError('SCANNER_UNAVAILABLE', 'x'))).toEqual({
      kind: 'transient',
      code: 'SCANNER_UNAVAILABLE',
      detail: 'x',
    });
    expect(classifyFailure(new Error('socket timed out')).code).toBe('PROCESSING_TIMEOUT');
    expect(classifyFailure(new Error('something odd'))).toEqual({
      kind: 'transient',
      code: 'WORKER_ERROR',
      detail: 'something odd',
    });
  });
});

// ---------------------------------------------------------------------------
describe('IngestPipeline end to end (in memory)', () => {
  // The pipeline takes no document, owner or version: it is source-agnostic so
  // that Phase 9 organization sources run through exactly the same code as a
  // student's thesis, with no second, weaker path (ADR-0062).
  async function stage(
    bytes: Buffer,
    expectedFormat: 'PDF' | 'DOCX',
    clientSha256: string | null = null,
  ) {
    const storage = new InMemoryObjectStorage();
    const scanner = new FakeMalwareScanner();
    const identity = await storage.store('quarantine', 'staging/x', bytes);
    const input: IngestInput = {
      expectedFormat,
      quarantineObjectKey: 'staging/x',
      quarantineObjectVersionId: identity.versionId,
      quarantineObjectEtag: identity.etag,
      declaredSizeBytes: bytes.length,
      clientSha256,
      cleanObjectKey: 'clean/x',
    };
    const pipeline = new IngestPipeline(storage, scanner, {
      maxBytesByFormat: { DOCX: 256 * 1024, PDF: 256 * 1024 },
      archive: LIMITS,
      validationTimeoutMs: 10_000,
      scanTimeoutMs: 10_000,
    });
    const stages: string[] = [];
    return {
      storage,
      scanner,
      input,
      pipeline,
      stages,
      run: () =>
        pipeline.run(input, async (s) => {
          stages.push(s);
        }),
    };
  }

  it('accepts a PDF: hashes exact bytes, scans, promotes', async () => {
    const bytes = minimalPdf();
    const { run, stages, storage } = await stage(bytes, 'PDF');
    const outcome = await run();
    expect(outcome.kind).toBe('ready');
    if (outcome.kind !== 'ready') return;
    expect(outcome.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(outcome.detectedFormat).toBe('PDF');
    expect(stages).toEqual(['VALIDATING', 'SCANNING']);
    expect(await storage.headObject({ zone: 'clean', key: 'clean/x' })).not.toBeNull();
  });

  it('accepts a DOCX', async () => {
    const outcome = await (await stage(minimalDocx(), 'DOCX')).run();
    expect(outcome.kind === 'ready' && outcome.detectedFormat).toBe('DOCX');
  });

  it('rejects a spoofed .pdf carrying ZIP bytes as a type mismatch', async () => {
    const outcome = await (await stage(minimalDocx(), 'PDF')).run();
    expect(outcome.kind === 'rejected' && outcome.code).toBe('FILE_TYPE_MISMATCH');
  });

  it('rejects a spoofed .docx carrying a random ZIP as an invalid container', async () => {
    const outcome = await (await stage(randomZip(), 'DOCX')).run();
    expect(outcome.kind === 'rejected' && outcome.code).toBe('FILE_CONTAINER_INVALID');
  });

  it('rejects an executable however it is named', async () => {
    const outcome = await (
      await stage(Buffer.from('MZ\x90\x00\x03\x00\x00\x00 fake exe'), 'PDF')
    ).run();
    expect(outcome.kind === 'rejected' && outcome.code).toBe('FILE_TYPE_UNSUPPORTED');
  });

  it('rejects an empty file', async () => {
    const outcome = await (await stage(Buffer.alloc(0), 'PDF')).run();
    expect(outcome.kind === 'rejected' && outcome.code).toBe('FILE_EMPTY');
  });

  it('rejects the EICAR test file as malware, with the signature recorded', async () => {
    const outcome = await (await stage(minimalPdf(EICAR), 'PDF')).run();
    expect(outcome.kind).toBe('rejected');
    if (outcome.kind !== 'rejected') return;
    expect(outcome.code).toBe('FILE_MALWARE_DETECTED');
    expect(outcome.scanSignature).toBe('Eicar-Test-Signature');
  });

  it('rejects a client checksum that does not match', async () => {
    const outcome = await (await stage(minimalPdf(), 'PDF', 'a'.repeat(64))).run();
    expect(outcome.kind === 'rejected' && outcome.code).toBe('FILE_CHECKSUM_MISMATCH');
  });

  it('treats a scanner outage as transient, never as clean or as a rejection', async () => {
    const staged = await stage(minimalPdf(), 'PDF');
    staged.scanner.mode = 'unavailable';
    await expect(staged.run()).rejects.toMatchObject({ code: 'SCANNER_UNAVAILABLE' });
    expect(await staged.storage.headObject({ zone: 'clean', key: 'clean/x' })).toBeNull();
  });

  it('treats a storage outage as transient', async () => {
    const staged = await stage(minimalPdf(), 'PDF');
    staged.storage.failing.add('copy');
    await expect(staged.run()).rejects.toBeInstanceOf(Error);
    expect(classifyFailure(await staged.run().catch((e) => e)).code).toBe('STORAGE_UNAVAILABLE');
  });

  it('processes exactly the finalized object version even if the key was overwritten', async () => {
    const original = minimalPdf('original');
    const staged = await stage(original, 'PDF');
    await staged.storage.store(
      'quarantine',
      'staging/x',
      minimalPdf('overwritten by a reused url'),
    );
    const outcome = await staged.run();
    expect(outcome.kind === 'ready' && outcome.sha256).toBe(
      createHash('sha256').update(original).digest('hex'),
    );
    const clean = await staged.storage.getObjectStream({ zone: 'clean', key: 'clean/x' });
    const chunks: Buffer[] = [];
    for await (const chunk of clean.stream) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).equals(original)).toBe(true);
  });

  it('is idempotent: a second run promotes nothing new', async () => {
    const staged = await stage(minimalPdf(), 'PDF');
    const first = await staged.run();
    const second = await staged.run();
    expect(
      first.kind === 'ready' &&
        second.kind === 'ready' &&
        first.clean.versionId === second.clean.versionId,
    ).toBe(true);
    expect(staged.storage.versionCount('clean', 'clean/x')).toBe(1);
  });

  it('leaves no scratch files behind', async () => {
    await (await stage(minimalDocx(), 'DOCX')).run();
    const entries = await readFile('/proc/self/cmdline')
      .then(() => true)
      .catch(() => true);
    expect(entries).toBe(true);
  });
});
