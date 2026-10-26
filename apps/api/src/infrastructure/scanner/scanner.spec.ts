import { Readable } from 'node:stream';
import { parseReply } from './clamav-scanner';
import { EICAR_TEST_STRING, FakeMalwareScanner } from './fake-scanner';

describe('clamd reply mapping', () => {
  it('maps OK to CLEAN', () => {
    expect(parseReply('stream: OK')).toEqual({ result: 'CLEAN' });
  });

  it('maps FOUND to INFECTED with the signature', () => {
    expect(parseReply('stream: Eicar-Test-Signature FOUND')).toEqual({
      result: 'INFECTED',
      signature: 'Eicar-Test-Signature',
    });
    expect(parseReply('stream: Win.Test.EICAR_HDB-1 FOUND\n')).toEqual({
      result: 'INFECTED',
      signature: 'Win.Test.EICAR_HDB-1',
    });
  });

  it('maps everything else to ERROR, never to CLEAN', () => {
    // An outage, a size limit, an empty reply: none of them cleared the file (§34).
    expect(parseReply('INSTREAM size limit exceeded. ERROR').result).toBe('ERROR');
    expect(parseReply('').result).toBe('ERROR');
    expect(parseReply('stream: OKAY NOT REALLY').result).toBe('ERROR');
  });
});

describe('FakeMalwareScanner', () => {
  const subject = (bytes: Buffer) => ({
    sizeBytes: bytes.length,
    open: () => Readable.from([bytes.subarray(0, 10), bytes.subarray(10)]),
  });

  it('flags the EICAR test string even across chunk boundaries', async () => {
    const scanner = new FakeMalwareScanner();
    const outcome = await scanner.scan(subject(Buffer.from(`prefix ${EICAR_TEST_STRING} suffix`)), {
      timeoutMs: 1000,
    });
    expect(outcome.verdict).toEqual({ result: 'INFECTED', signature: 'Eicar-Test-Signature' });
  });

  it('clears ordinary bytes', async () => {
    const outcome = await new FakeMalwareScanner().scan(
      subject(Buffer.from('%PDF-1.7 plain content')),
      { timeoutMs: 1000 },
    );
    expect(outcome.verdict).toEqual({ result: 'CLEAN' });
  });

  it('reports an outage as ERROR and unready', async () => {
    const scanner = new FakeMalwareScanner();
    scanner.mode = 'unavailable';
    expect(
      (await scanner.scan(subject(Buffer.from('x')), { timeoutMs: 1000 })).verdict.result,
    ).toBe('ERROR');
    expect((await scanner.checkReadiness()).ok).toBe(false);
  });
});
