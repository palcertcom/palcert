import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ScanSubject } from '../infrastructure/scanner/malware-scanner.port';

/**
 * A private scratch directory that is always removed (§62).
 *
 * Under the OS temp root, created with owner-only permissions, named by the
 * OS, and deleted on success *and* on failure. File names inside it are
 * random hex — never anything derived from the upload.
 */
export async function withSecureTempDir<T>(work: (directory: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), 'palcert-ingest-'));
  try {
    return await work(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** A fresh, unguessable path inside a scratch directory. */
export function tempFilePath(directory: string): string {
  return join(directory, `${randomBytes(16).toString('hex')}.bin`);
}

/** Something the scanner can stream, as many times as it needs. */
export function fileScanSubject(path: string, sizeBytes: number): ScanSubject {
  return { sizeBytes, open: () => createReadStream(path) };
}
