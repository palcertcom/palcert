import yauzl from 'yauzl';
import { ContentRejectedError } from './errors';

export interface ArchiveLimits {
  readonly maxEntries: number;
  readonly maxEntryBytes: number;
  readonly maxTotalBytes: number;
  readonly maxCompressionRatio: number;
  readonly maxInspectedPartBytes: number;
}

export interface ArchiveEntry {
  readonly name: string;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly isDirectory: boolean;
}

export interface ArchiveInspection {
  readonly entries: readonly ArchiveEntry[];
  readonly totalCompressed: number;
  readonly totalUncompressed: number;
}

const NESTED_ARCHIVE = /\.(zip|jar|war|7z|rar|gz|tgz|bz2|xz|tar|docx|docm|xlsx|pptx|cab|iso)$/i;
const EXECUTABLE = /\.(exe|dll|com|bat|cmd|ps1|vbs|vbe|js|jse|wsf|wsh|scr|msi|hta|cpl|pif)$/i;
/** C0 controls and DEL. Built from code points so the source carries no control bytes. */
const CONTROL_CHARACTERS = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(31)}${String.fromCharCode(127)}]`,
);
const ZIP_OPTIONS = {
  lazyEntries: true,
  autoClose: true,
  decodeStrings: true,
  validateEntrySizes: true,
} as const;

/**
 * Is this entry name safe to treat as a path inside the package? (§17)
 *
 * Nothing here is ever *extracted* to disk — parts are read into bounded
 * memory by name — but a package that carries traversal or absolute names is
 * hostile by construction and is refused outright rather than tolerated.
 */
export function assertSafeEntryName(name: string): void {
  if (name.length === 0 || name.length > 512) {
    throw new ContentRejectedError('FILE_ARCHIVE_UNSAFE', 'entry name length');
  }
  if (CONTROL_CHARACTERS.test(name)) {
    throw new ContentRejectedError('FILE_ARCHIVE_UNSAFE', 'entry name contains control characters');
  }
  if (name.includes('\\')) {
    throw new ContentRejectedError('FILE_ARCHIVE_UNSAFE', 'entry name uses backslashes');
  }
  if (name.startsWith('/') || /^[a-zA-Z]:/.test(name)) {
    throw new ContentRejectedError('FILE_ARCHIVE_UNSAFE', 'absolute entry name');
  }
  const segments = name.split('/');
  if (segments.some((segment) => segment === '..')) {
    throw new ContentRejectedError('FILE_ARCHIVE_UNSAFE', 'entry name traverses upward');
  }
  if (segments.some((segment) => segment === '.')) {
    throw new ContentRejectedError('FILE_ARCHIVE_UNSAFE', 'entry name contains a self-reference');
  }
  if (segments.slice(0, -1).some((segment) => segment.length === 0)) {
    throw new ContentRejectedError('FILE_ARCHIVE_UNSAFE', 'entry name contains an empty segment');
  }
}

/**
 * Read the central directory and refuse anything a ZIP bomb or a hostile
 * package would need (§17, §63). No entry is decompressed here.
 */
export function inspectArchive(path: string, limits: ArchiveLimits): Promise<ArchiveInspection> {
  return new Promise((resolve, reject) => {
    yauzl.open(path, ZIP_OPTIONS, (openError, zip) => {
      if (openError || zip === undefined) {
        reject(new ContentRejectedError('FILE_CONTAINER_INVALID', 'not a readable zip archive'));
        return;
      }
      if (zip.entryCount > limits.maxEntries) {
        zip.close();
        reject(
          new ContentRejectedError(
            'FILE_ARCHIVE_UNSAFE',
            `entry count ${zip.entryCount} exceeds ${limits.maxEntries}`,
          ),
        );
        return;
      }

      const entries: ArchiveEntry[] = [];
      let totalCompressed = 0;
      let totalUncompressed = 0;
      let settled = false;
      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        zip.close();
        reject(error);
      };

      zip.on('error', (error: Error) => fail(classifyZipError(error)));
      zip.on('entry', (entry: yauzl.Entry) => {
        try {
          const name = entry.fileName;
          assertSafeEntryName(name);
          const isDirectory = name.endsWith('/');

          if ((entry.generalPurposeBitFlag & 0x1) !== 0) {
            throw new ContentRejectedError('FILE_CONTAINER_INVALID', 'encrypted entry');
          }
          if (!isDirectory && NESTED_ARCHIVE.test(name)) {
            throw new ContentRejectedError('FILE_ARCHIVE_UNSAFE', 'nested archive');
          }
          if (!isDirectory && EXECUTABLE.test(name)) {
            throw new ContentRejectedError('FILE_ARCHIVE_UNSAFE', 'executable payload');
          }
          if (entry.uncompressedSize > limits.maxEntryBytes) {
            throw new ContentRejectedError('FILE_ARCHIVE_UNSAFE', 'entry exceeds size limit');
          }
          totalCompressed += entry.compressedSize;
          totalUncompressed += entry.uncompressedSize;
          if (totalUncompressed > limits.maxTotalBytes) {
            throw new ContentRejectedError(
              'FILE_ARCHIVE_UNSAFE',
              'archive exceeds total size limit',
            );
          }
          // Ratio per entry: a 1 MiB part that inflates 100x is not XML.
          if (
            entry.compressedSize > 0 &&
            entry.uncompressedSize > 1024 * 1024 &&
            entry.uncompressedSize / entry.compressedSize > limits.maxCompressionRatio
          ) {
            throw new ContentRejectedError('FILE_ARCHIVE_UNSAFE', 'entry compression ratio');
          }
          if (entries.length >= limits.maxEntries) {
            throw new ContentRejectedError('FILE_ARCHIVE_UNSAFE', 'entry count');
          }
          entries.push({
            name,
            compressedSize: entry.compressedSize,
            uncompressedSize: entry.uncompressedSize,
            isDirectory,
          });
          zip.readEntry();
        } catch (error) {
          fail(error as Error);
        }
      });
      zip.on('end', () => {
        if (settled) return;
        settled = true;
        // Ratio over the whole package: the classic bomb is thousands of tiny
        // entries that each inflate enormously.
        if (
          totalCompressed > 0 &&
          totalUncompressed > 8 * 1024 * 1024 &&
          totalUncompressed / totalCompressed > limits.maxCompressionRatio
        ) {
          reject(new ContentRejectedError('FILE_ARCHIVE_UNSAFE', 'archive compression ratio'));
          return;
        }
        resolve({ entries, totalCompressed, totalUncompressed });
      });
      zip.readEntry();
    });
  });
}

/**
 * yauzl validates entry names before emitting them and reports traversal,
 * absolute and backslash names as errors. Those are hostile packages, not
 * corrupt ones, and are classified as such.
 */
function classifyZipError(error: Error): ContentRejectedError {
  if (/invalid relative path|absolute path|backslash/i.test(error.message)) {
    return new ContentRejectedError(
      'FILE_ARCHIVE_UNSAFE',
      'entry name refused by the archive reader',
    );
  }
  return new ContentRejectedError('FILE_CONTAINER_INVALID', 'corrupt zip central directory');
}

/**
 * Read one part into memory, bounded.
 *
 * yauzl verifies the declared uncompressed size against what actually
 * inflates; the byte cap here is what stops a part whose *declared* size is
 * small but whose inflated stream is not.
 */
export function readArchivePart(
  path: string,
  entryName: string,
  limits: ArchiveLimits,
): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    yauzl.open(path, ZIP_OPTIONS, (openError, zip) => {
      if (openError || zip === undefined) {
        reject(new ContentRejectedError('FILE_CONTAINER_INVALID', 'not a readable zip archive'));
        return;
      }
      let found = false;
      zip.on('error', (error: Error) => reject(classifyZipError(error)));
      zip.on('entry', (entry: yauzl.Entry) => {
        if (entry.fileName !== entryName) {
          zip.readEntry();
          return;
        }
        found = true;
        if (entry.uncompressedSize > limits.maxInspectedPartBytes) {
          zip.close();
          reject(
            new ContentRejectedError(
              'FILE_ARCHIVE_UNSAFE',
              `${entryName} exceeds inspection limit`,
            ),
          );
          return;
        }
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || stream === undefined) {
            zip.close();
            reject(new ContentRejectedError('FILE_CONTAINER_INVALID', `cannot read ${entryName}`));
            return;
          }
          const chunks: Buffer[] = [];
          let total = 0;
          stream.on('data', (chunk: Buffer) => {
            total += chunk.length;
            if (total > limits.maxInspectedPartBytes) {
              stream.destroy();
              zip.close();
              reject(
                new ContentRejectedError(
                  'FILE_ARCHIVE_UNSAFE',
                  `${entryName} inflated past its declared size`,
                ),
              );
              return;
            }
            chunks.push(chunk);
          });
          stream.on('error', () => {
            zip.close();
            reject(new ContentRejectedError('FILE_CONTAINER_INVALID', `corrupt part ${entryName}`));
          });
          stream.on('end', () => {
            zip.close();
            resolve(Buffer.concat(chunks));
          });
        });
      });
      zip.on('end', () => {
        if (!found) resolve(null);
      });
      zip.readEntry();
    });
  });
}
