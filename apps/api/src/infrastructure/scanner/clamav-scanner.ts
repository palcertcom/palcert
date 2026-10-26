import { Socket, createConnection } from 'node:net';
import type { Readable } from 'node:stream';
import { MalwareScannerPort, type ScanOutcome, type ScanSubject } from './malware-scanner.port';

export interface ClamAvOptions {
  readonly host: string;
  readonly port: number;
  readonly chunkBytes: number;
  readonly connectTimeoutMs: number;
}

const ENGINE = 'clamav';

/**
 * ClamAV over the clamd TCP protocol, INSTREAM only (§35).
 *
 * The file is streamed to the daemon in length-prefixed chunks; it is never
 * written where clamd could be pointed at it by path, never passed as a
 * command argument, and never executed. The daemon answers with one line.
 */
export class ClamAvScanner extends MalwareScannerPort {
  constructor(private readonly options: ClamAvOptions) {
    super();
  }

  async scan(subject: ScanSubject, options: { timeoutMs: number }): Promise<ScanOutcome> {
    const started = Date.now();
    try {
      const reply = await this.instream(subject.open(), options.timeoutMs);
      return {
        verdict: parseReply(reply),
        engine: await this.engineName(),
        durationMs: Date.now() - started,
      };
    } catch (error) {
      return {
        verdict: { result: 'ERROR', reason: describe(error) },
        engine: ENGINE,
        durationMs: Date.now() - started,
      };
    }
  }

  async checkReadiness(): Promise<{ ok: boolean; message?: string }> {
    try {
      const reply = await this.command('zPING\0', 3_000);
      return reply.trim() === 'PONG' ? { ok: true } : { ok: false, message: 'unexpected reply' };
    } catch {
      return { ok: false, message: 'unreachable' };
    }
  }

  private async engineName(): Promise<string> {
    try {
      const version = await this.command('zVERSION\0', 3_000);
      // "ClamAV 1.5.3/27500/..." → keep engine and version only; the database
      // revision is operational noise for a persisted record.
      const match = /^ClamAV\s+([0-9.]+)/.exec(version.trim());
      return match ? `${ENGINE} ${match[1]}` : ENGINE;
    } catch {
      return ENGINE;
    }
  }

  private connect(timeoutMs: number): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const socket = createConnection({ host: this.options.host, port: this.options.port });
      const timer = setTimeout(
        () => {
          socket.destroy();
          reject(new Error('connect timeout'));
        },
        Math.min(timeoutMs, this.options.connectTimeoutMs),
      );
      socket.once('connect', () => {
        clearTimeout(timer);
        resolve(socket);
      });
      socket.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  private async command(command: string, timeoutMs: number): Promise<string> {
    const socket = await this.connect(timeoutMs);
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error('command timeout'));
      }, timeoutMs);
      socket.on('data', (chunk: Buffer) => chunks.push(chunk));
      socket.on('end', () => {
        clearTimeout(timer);
        resolve(Buffer.concat(chunks).toString('utf8').replace(/\0+$/, ''));
      });
      socket.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      socket.write(command);
    });
  }

  private async instream(source: Readable, timeoutMs: number): Promise<string> {
    const socket = await this.connect(timeoutMs);
    return new Promise<string>((resolve, reject) => {
      const replyChunks: Buffer[] = [];
      let settled = false;
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        source.destroy();
        fn();
      };
      const timer = setTimeout(() => {
        socket.destroy();
        finish(() => reject(new Error('scan timeout')));
      }, timeoutMs);

      socket.on('data', (chunk: Buffer) => replyChunks.push(chunk));
      socket.on('end', () =>
        finish(() => resolve(Buffer.concat(replyChunks).toString('utf8').replace(/\0+$/, ''))),
      );
      socket.on('error', (error) => finish(() => reject(error)));

      socket.write('zINSTREAM\0');

      const chunkBytes = this.options.chunkBytes;
      source.on('error', (error) => {
        socket.destroy();
        finish(() => reject(error));
      });
      source.on('data', (data: Buffer) => {
        for (let offset = 0; offset < data.length; offset += chunkBytes) {
          const piece = data.subarray(offset, offset + chunkBytes);
          const header = Buffer.alloc(4);
          header.writeUInt32BE(piece.length, 0);
          socket.write(header);
          socket.write(piece);
        }
        // Respect back-pressure from the daemon.
        if (socket.writableNeedDrain) {
          source.pause();
          socket.once('drain', () => source.resume());
        }
      });
      source.on('end', () => {
        socket.write(Buffer.alloc(4)); // zero-length chunk terminates the stream
      });
    });
  }
}

/** Map clamd's one-line reply onto the verdict vocabulary. Exported for tests. */
export function parseReply(reply: string): ScanOutcome['verdict'] {
  const line = reply.trim();
  if (/\bOK$/.test(line)) return { result: 'CLEAN' };
  const found = /:\s*(.+?)\s+FOUND$/.exec(line);
  if (found) return { result: 'INFECTED', signature: found[1]! };
  // "INSTREAM size limit exceeded. ERROR", "Can't allocate memory ERROR", or
  // anything unrecognized: the scanner has not cleared the file.
  return { result: 'ERROR', reason: line.length > 0 ? line.slice(0, 200) : 'empty reply' };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 200) : 'unknown error';
}
