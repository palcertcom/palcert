import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ContentRejectedError } from './errors';

export interface StreamDigest {
  readonly sha256: string;
  readonly sizeBytes: number;
}

/**
 * SHA-256 over a stream, chunk by chunk (§33).
 *
 * The digest is over the exact bytes as they arrive; chunk boundaries are
 * irrelevant to the result, which the tests prove by re-chunking. Nothing is
 * buffered beyond the hash state.
 */
export async function sha256Stream(source: Readable): Promise<StreamDigest> {
  const hash = createHash('sha256');
  let sizeBytes = 0;
  for await (const chunk of source) {
    const buffer = chunk as Buffer;
    hash.update(buffer);
    sizeBytes += buffer.length;
  }
  return { sha256: hash.digest('hex'), sizeBytes };
}

/**
 * Stream to a file while hashing, refusing to write past a ceiling.
 *
 * The ceiling is enforced *during* the copy, so an object that lies about
 * its size cannot fill the disk before being rejected. The file is created
 * exclusively with owner-only permissions (§62).
 */
export async function sha256ToFile(
  source: Readable,
  path: string,
  options: { readonly maxBytes: number },
): Promise<StreamDigest> {
  const hash = createHash('sha256');
  let sizeBytes = 0;

  const guard = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      sizeBytes += chunk.length;
      if (sizeBytes > options.maxBytes) {
        callback(
          new ContentRejectedError('FILE_TOO_LARGE', `stream exceeded ${options.maxBytes} bytes`),
        );
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    },
  });

  await pipeline(source, guard, createWriteStream(path, { flags: 'wx', mode: 0o600 }));
  return { sha256: hash.digest('hex'), sizeBytes };
}
