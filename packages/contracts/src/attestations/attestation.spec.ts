import { describe, expect, it } from 'vitest';
import {
  ATTESTATION_REFERENCE_PATTERN,
  ATTESTATION_REQUEST_STATUSES,
  ATTESTATION_REQUEST_TRANSITIONS,
  type AttestationRequestStatus,
  AttestationVerificationStatus,
  OWNER_CANCELLABLE_STATUSES,
  addValidityDays,
  attestationFormatForFilename,
  attestationManifestHash,
  attestationTokenHash,
  attestationVerificationStatus,
  canTransitionAttestationRequest,
  canonicalizeAttestationToken,
  dueReminderStage,
  formatCommissionPercent,
  generateAttestationReference,
  generateAttestationToken,
  isCalendarDate,
  isTerminalAttestationRequestStatus,
  isValidReminderSchedule,
  parseCommissionPercent,
  splitAttestationFee,
  type AttestationManifest,
} from './attestation';

describe('attestation request workflow', () => {
  it('lets every terminal state go nowhere', () => {
    for (const status of ATTESTATION_REQUEST_STATUSES) {
      if (isTerminalAttestationRequestStatus(status)) {
        expect(ATTESTATION_REQUEST_TRANSITIONS[status]).toEqual([]);
      }
    }
  });

  it('allows exactly the documented edges', () => {
    const allowed = new Set<string>();
    for (const from of ATTESTATION_REQUEST_STATUSES) {
      for (const to of ATTESTATION_REQUEST_TRANSITIONS[from]) allowed.add(`${from}->${to}`);
    }
    expect([...allowed].sort()).toEqual(
      [
        'DRAFT->SUBMITTED',
        'DRAFT->CANCELLED',
        'SUBMITTED->IN_REVIEW',
        'SUBMITTED->CANCELLED',
        'IN_REVIEW->NEEDS_INFORMATION',
        'IN_REVIEW->APPROVED',
        'IN_REVIEW->REJECTED',
        'NEEDS_INFORMATION->SUBMITTED',
        'NEEDS_INFORMATION->REJECTED',
      ].sort(),
    );
  });

  it('refuses the shortcuts a careless caller might try', () => {
    const refused: Array<[AttestationRequestStatus, AttestationRequestStatus]> = [
      ['DRAFT', 'APPROVED'],
      ['SUBMITTED', 'APPROVED'],
      ['SUBMITTED', 'REJECTED'],
      ['APPROVED', 'REJECTED'],
      ['REJECTED', 'APPROVED'],
      ['CANCELLED', 'SUBMITTED'],
      ['IN_REVIEW', 'CANCELLED'],
      ['APPROVED', 'APPROVED'],
    ];
    for (const [from, to] of refused) {
      expect([from, to, canTransitionAttestationRequest(from, to)]).toEqual([from, to, false]);
    }
  });

  it('lets the owner cancel only before review starts', () => {
    expect(OWNER_CANCELLABLE_STATUSES).toEqual(['DRAFT', 'SUBMITTED']);
  });
});

describe('verification status', () => {
  const now = new Date('2027-01-01T00:00:00Z');

  it('treats validUntil as a valid-through instant', () => {
    const until = new Date('2027-01-01T00:00:00Z');
    expect(attestationVerificationStatus({ revokedAt: null, validUntil: until, now })).toBe(
      AttestationVerificationStatus.EXPIRED,
    );
    const later = new Date(until.getTime() + 1);
    expect(attestationVerificationStatus({ revokedAt: null, validUntil: later, now })).toBe(
      AttestationVerificationStatus.VALID,
    );
  });

  it('never expires without a validUntil', () => {
    expect(attestationVerificationStatus({ revokedAt: null, validUntil: null, now })).toBe('VALID');
  });

  it('reports revocation over expiry', () => {
    expect(
      attestationVerificationStatus({
        revokedAt: new Date('2026-06-01T00:00:00Z'),
        validUntil: new Date('2026-01-01T00:00:00Z'),
        now,
      }),
    ).toBe('REVOKED');
  });
});

describe('fee split', () => {
  it('splits $10.00 at 15% into $1.50 and $8.50', () => {
    const split = splitAttestationFee(1000n, 1500);
    expect(split.platformFeeMinor).toBe(150n);
    expect(split.institutionNetMinor).toBe(850n);
    expect(split.institutionShareBps).toBe(8500);
  });

  it.each([
    [1000n, 1000, 100n, 900n],
    [1000n, 2000, 200n, 800n],
    [1000n, 0, 0n, 1000n],
    [1000n, 10000, 1000n, 0n],
    [5n, 1500, 1n, 4n],
    [3n, 1500, 0n, 3n],
    [0n, 1500, 0n, 0n],
    [999_999_999_999n, 3333, 333_300_000_000n, 666_699_999_999n],
  ])('%s at %s bps → %s + %s', (gross, bps, platform, institution) => {
    const split = splitAttestationFee(gross, bps);
    expect(split.platformFeeMinor).toBe(platform);
    expect(split.institutionNetMinor).toBe(institution);
    expect(split.platformFeeMinor + split.institutionNetMinor).toBe(gross);
  });

  it('always sums to the gross, for every rate', () => {
    for (let bps = 0; bps <= 10_000; bps += 7) {
      for (const gross of [1n, 7n, 99n, 1001n, 123_457n]) {
        const split = splitAttestationFee(gross, bps);
        expect(split.platformFeeMinor + split.institutionNetMinor).toBe(gross);
        expect(split.platformFeeMinor >= 0n && split.institutionNetMinor >= 0n).toBe(true);
      }
    }
  });

  it('refuses an impossible rate or a negative fee', () => {
    expect(() => splitAttestationFee(100n, -1)).toThrow();
    expect(() => splitAttestationFee(100n, 10_001)).toThrow();
    expect(() => splitAttestationFee(100n, 12.5)).toThrow();
    expect(() => splitAttestationFee(-1n, 100)).toThrow();
  });

  it('parses and formats percentages exactly', () => {
    expect(parseCommissionPercent('15')).toBe(1500);
    expect(parseCommissionPercent('15.5')).toBe(1550);
    expect(parseCommissionPercent('0')).toBe(0);
    expect(parseCommissionPercent('100')).toBe(10_000);
    expect(parseCommissionPercent('100.01')).toBeNull();
    expect(parseCommissionPercent('-1')).toBeNull();
    expect(parseCommissionPercent('1.234')).toBeNull();
    expect(parseCommissionPercent('1e2')).toBeNull();
    expect(formatCommissionPercent(1550)).toBe('15.50');
    expect(formatCommissionPercent(0)).toBe('0.00');
    expect(formatCommissionPercent(10_000)).toBe('100.00');
  });
});

describe('reminders', () => {
  const until = new Date('2027-06-30T12:00:00Z');
  const day = 24 * 60 * 60 * 1000;
  const at = (daysBefore: number) => new Date(until.getTime() - daysBefore * day);
  const schedule = [30, 14, 7, 1];

  it('fires each stage once, in order', () => {
    const sent: number[] = [];
    const fired: number[] = [];
    for (let d = 40; d >= -2; d -= 0.5) {
      const stage = dueReminderStage({
        validUntil: until,
        now: at(d),
        scheduleDays: schedule,
        alreadySent: sent,
      });
      if (stage !== null) {
        sent.push(stage);
        fired.push(stage);
      }
    }
    expect(fired).toEqual([30, 14, 7, 1, 0]);
  });

  it('sends only the nearest stage when several open at once', () => {
    expect(
      dueReminderStage({ validUntil: until, now: at(5), scheduleDays: schedule, alreadySent: [] }),
    ).toBe(7);
    // …and never goes back for the earlier ones.
    expect(
      dueReminderStage({ validUntil: until, now: at(4), scheduleDays: schedule, alreadySent: [7] }),
    ).toBeNull();
  });

  it('sends nothing before the first window, and expiry exactly once', () => {
    expect(
      dueReminderStage({ validUntil: until, now: at(31), scheduleDays: schedule, alreadySent: [] }),
    ).toBeNull();
    expect(
      dueReminderStage({ validUntil: until, now: at(0), scheduleDays: schedule, alreadySent: [1] }),
    ).toBe(0);
    expect(
      dueReminderStage({
        validUntil: until,
        now: at(-3),
        scheduleDays: schedule,
        alreadySent: [1, 0],
      }),
    ).toBeNull();
  });

  it('validates schedules', () => {
    expect(isValidReminderSchedule([30, 14, 7, 1])).toBe(true);
    expect(isValidReminderSchedule([])).toBe(true);
    expect(isValidReminderSchedule([0])).toBe(false);
    expect(isValidReminderSchedule([7, 7])).toBe(false);
    expect(isValidReminderSchedule([1.5])).toBe(false);
    expect(isValidReminderSchedule([366])).toBe(false);
  });

  it('adds validity days exactly in UTC', () => {
    expect(addValidityDays(new Date('2026-09-30T00:00:00Z'), 365).toISOString()).toBe(
      '2027-09-30T00:00:00.000Z',
    );
  });
});

describe('tokens and references', () => {
  it('generates 160-bit tokens that canonicalize to themselves', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      const token = generateAttestationToken();
      expect(token).toMatch(/^[0-9A-HJKMNP-TV-Z]{32}$/);
      expect(canonicalizeAttestationToken(token)).toBe(token);
      seen.add(token);
    }
    expect(seen.size).toBe(200);
  });

  it('accepts dashes, lower case and look-alikes, and refuses anything else', () => {
    const token = generateAttestationToken();
    const dashed = token
      .toLowerCase()
      .match(/.{1,8}/g)!
      .join('-');
    expect(canonicalizeAttestationToken(dashed)).toBe(token);
    expect(canonicalizeAttestationToken('O'.repeat(32))).toBe('0'.repeat(32));
    expect(canonicalizeAttestationToken('')).toBeNull();
    expect(canonicalizeAttestationToken(token.slice(1))).toBeNull();
    expect(canonicalizeAttestationToken(`${token.slice(1)}U`)).toBeNull();
    expect(canonicalizeAttestationToken('../../etc/passwd')).toBeNull();
  });

  it('hashes tokens one-way and domain-separated', () => {
    const token = generateAttestationToken();
    const hash = attestationTokenHash(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(token.toLowerCase());
    expect(attestationTokenHash(token)).toBe(hash);
  });

  it('prints references in the documented shape', () => {
    const reference = generateAttestationReference(2026);
    expect(reference).toMatch(ATTESTATION_REFERENCE_PATTERN);
    expect(reference.startsWith('PC-ATT-2026-')).toBe(true);
  });
});

describe('artifacts and metadata', () => {
  it('reads an expected format from the extension, case-insensitively', () => {
    expect(attestationFormatForFilename('degree.PDF')).toBe('PDF');
    expect(attestationFormatForFilename('scan.jpeg')).toBe('JPEG');
    expect(attestationFormatForFilename('scan.jpg')).toBe('JPEG');
    expect(attestationFormatForFilename('photo.webp')).toBe('WEBP');
    expect(attestationFormatForFilename('image.png')).toBe('PNG');
    expect(attestationFormatForFilename('macro.docm')).toBeNull();
    expect(attestationFormatForFilename('run.exe')).toBeNull();
    expect(attestationFormatForFilename('noextension')).toBeNull();
  });

  it('accepts only real calendar dates', () => {
    expect(isCalendarDate('2024-02-29')).toBe(true);
    expect(isCalendarDate('2023-02-29')).toBe(false);
    expect(isCalendarDate('2024-13-01')).toBe(false);
    expect(isCalendarDate('24-01-01')).toBe(false);
  });
});

describe('attestation manifest hash', () => {
  const manifest: AttestationManifest = {
    manifestVersion: 1,
    reference: 'PC-ATT-2026-7K3M9QXR',
    organizationId: '00000000-0000-4000-8000-000000000001',
    organizationName: 'University A',
    attestationTypeId: '00000000-0000-4000-8000-000000000002',
    attestationTypeNameEn: 'Degree certificate',
    artifact: { sha256: 'a'.repeat(64), sizeBytes: 1234, mimeType: 'application/pdf' },
    certificate: {
      title: 'Bachelor of Science',
      type: null,
      holderName: 'A. Student',
      issuingOrganization: 'University A',
      issueDate: '2024-06-30',
      referenceNumber: 'BS-001',
    },
    validFrom: '2026-09-30T00:00:00.000Z',
    validUntil: '2027-09-30T00:00:00.000Z',
    approvedAt: '2026-09-30T00:00:00.000Z',
    approvedByUserId: '00000000-0000-4000-8000-000000000003',
    previousAttestationId: null,
  };

  it('is deterministic and independent of key order', () => {
    const reordered = JSON.parse(JSON.stringify(manifest)) as AttestationManifest;
    expect(attestationManifestHash(reordered)).toBe(attestationManifestHash(manifest));
  });

  it('is distinct from the artifact fingerprint and moves with any asserted field', () => {
    const hash = attestationManifestHash(manifest);
    expect(hash).not.toBe(manifest.artifact.sha256);
    expect(
      attestationManifestHash({ ...manifest, validUntil: '2028-09-30T00:00:00.000Z' }),
    ).not.toBe(hash);
    expect(
      attestationManifestHash({
        ...manifest,
        artifact: { ...manifest.artifact, sha256: 'b'.repeat(64) },
      }),
    ).not.toBe(hash);
  });
});
