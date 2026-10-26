import { Readable } from 'node:stream';
import { ClamAvScanner } from './clamav-scanner';

/**
 * Live clamd integration (§35, §88).
 *
 * Opt-in: set CLAMAV_INTEGRATION=1 with a reachable daemon (CLAMAV_HOST /
 * CLAMAV_PORT, defaults localhost:3310). The daemon needs only the EICAR
 * signature; the fast suites use the fake scanner and never depend on it.
 * The test file is the industry-standard harmless EICAR string, assembled
 * at runtime so the repository never contains malware (§101).
 */
const enabled = process.env['CLAMAV_INTEGRATION'] === '1';
const describeLive = enabled ? describe : describe.skip;

const EICAR =
  'X5O!P%@AP[4' +
  String.fromCharCode(92) +
  'PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

function subject(bytes: Buffer): { sizeBytes: number; open: () => Readable } {
  return { sizeBytes: bytes.length, open: () => Readable.from([bytes]) };
}

describeLive('ClamAvScanner against a live clamd', () => {
  const scanner = new ClamAvScanner({
    host: process.env['CLAMAV_HOST'] ?? 'localhost',
    port: Number(process.env['CLAMAV_PORT'] ?? 3310),
    chunkBytes: 64 * 1024,
    connectTimeoutMs: 5_000,
  });

  it('is ready', async () => {
    expect(await scanner.checkReadiness()).toEqual({ ok: true });
  });

  it('reports a clean file as CLEAN with the engine version', async () => {
    const outcome = await scanner.scan(subject(Buffer.from('%PDF-1.4\n%%EOF\n')), {
      timeoutMs: 30_000,
    });
    expect(outcome.verdict).toEqual({ result: 'CLEAN' });
    expect(outcome.engine).toMatch(/^clamav( [0-9.]+)?$/);
  });

  it('reports the EICAR test file as INFECTED with a signature name', async () => {
    const outcome = await scanner.scan(subject(Buffer.from(EICAR, 'latin1')), {
      timeoutMs: 30_000,
    });
    expect(outcome.verdict.result).toBe('INFECTED');
    if (outcome.verdict.result === 'INFECTED') expect(outcome.verdict.signature).toMatch(/eicar/i);
  });

  it('streams a multi-chunk body and still gets a verdict', async () => {
    // Larger than several INSTREAM chunks; the daemon must see every one.
    const body = Buffer.concat([
      Buffer.from('%PDF-1.4\n'),
      Buffer.alloc(300 * 1024, 0x20),
      Buffer.from('%%EOF\n'),
    ]);
    const outcome = await scanner.scan(subject(body), { timeoutMs: 30_000 });
    expect(outcome.verdict).toEqual({ result: 'CLEAN' });
  });

  it('answers ERROR, never CLEAN, when the daemon is unreachable', async () => {
    const dead = new ClamAvScanner({
      host: '127.0.0.1',
      port: 1,
      chunkBytes: 1024,
      connectTimeoutMs: 500,
    });
    const outcome = await dead.scan(subject(Buffer.from('anything')), { timeoutMs: 2_000 });
    expect(outcome.verdict.result).toBe('ERROR');
  });
});
