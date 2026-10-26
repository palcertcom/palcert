import { MalwareScannerPort, type ScanOutcome, type ScanSubject } from './malware-scanner.port';

/** The harmless industry-standard antivirus test string (§38). */
export const EICAR_TEST_STRING =
  'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

/**
 * A test double behind the same port as ClamAV.
 *
 * Detects the EICAR string (so "malware" tests stay harmless), and can be
 * switched into an outage so the pipeline's ERROR handling is exercised. It
 * records every scan so tests can assert a file was scanned exactly once.
 */
export class FakeMalwareScanner extends MalwareScannerPort {
  mode: 'normal' | 'unavailable' = 'normal';
  readonly scannedSizes: number[] = [];

  async scan(subject: ScanSubject, _options: { timeoutMs: number }): Promise<ScanOutcome> {
    const started = Date.now();
    this.scannedSizes.push(subject.sizeBytes);

    if (this.mode === 'unavailable') {
      return {
        verdict: { result: 'ERROR', reason: 'scanner unavailable' },
        engine: 'fake',
        durationMs: 0,
      };
    }

    // Stream like a real scanner would: no whole-file buffering assumption in
    // the caller is validated by this consuming chunk by chunk.
    let carry = '';
    let infected = false;
    for await (const chunk of subject.open()) {
      // Search the carry-over plus the whole chunk, then keep only a tail so
      // a signature split across two chunks is still seen.
      const combined = carry + (chunk as Buffer).toString('latin1');
      if (combined.includes(EICAR_TEST_STRING)) {
        infected = true;
        break;
      }
      carry = combined.slice(-(EICAR_TEST_STRING.length - 1));
    }
    return {
      verdict: infected
        ? { result: 'INFECTED', signature: 'Eicar-Test-Signature' }
        : { result: 'CLEAN' },
      engine: 'fake 1.0',
      durationMs: Date.now() - started,
    };
  }

  async checkReadiness(): Promise<{ ok: boolean; message?: string }> {
    return this.mode === 'normal' ? { ok: true } : { ok: false, message: 'unavailable' };
  }
}
