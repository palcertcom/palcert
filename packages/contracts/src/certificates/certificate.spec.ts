import { describe, expect, it } from 'vitest';
import {
  CERTIFICATE_CLAIM_CANONICALIZATION_VERSION,
  CERTIFICATE_CLAIM_SCHEMA_VERSION,
  CERTIFICATE_ISSUANCE_STATUSES,
  CERTIFICATE_NUMBER_PREFIX,
  CertificateFailureCode,
  CertificateIssuanceStatus,
  CertificateVerificationStatus,
  VERIFICATION_CODE_BYTES,
  VERIFICATION_CODE_SYMBOLS,
  base32Decode,
  canonicalCertificateClaim,
  canonicalizeVerificationCode,
  computeCertificateClaimHash,
  formatCertificateNumber,
  generateVerificationCode,
  isPermanentCertificateFailure,
  isRequeueable,
  isValidIssuanceTransition,
  issuanceStatusForFailure,
  verificationCodeHash,
  verificationStatusOf,
  type CertificateClaim,
} from './index.js';

describe('the public verification code', () => {
  it('represents every bit of the entropy it generates', () => {
    // The mistake this guards against is choosing a pretty length and encoding
    // into it: 28 Base32 symbols is 140 bits, which would silently discard 20
    // bits of a 160-bit secret. 20 bytes is 160 bits, and 160 / 5 is 32
    // symbols exactly, with no remainder and nothing thrown away.
    expect(VERIFICATION_CODE_BYTES * 8).toBe(VERIFICATION_CODE_SYMBOLS * 5);
    expect(generateVerificationCode()).toHaveLength(VERIFICATION_CODE_SYMBOLS);
  });

  it('round-trips all twenty random bytes', () => {
    // A real Base32 encoding, proved by decoding it back. A character-picking
    // loop over `randomByte % alphabet.length` would pass a length check and
    // fail this one.
    for (let attempt = 0; attempt < 200; attempt++) {
      const code = generateVerificationCode();
      const decoded = base32Decode(code);
      expect(decoded).toHaveLength(VERIFICATION_CODE_BYTES);
      // And re-encoding the decoded bytes reproduces the code exactly.
      expect(canonicalizeVerificationCode(code)).toBe(code);
    }
  });

  it('produces a different code every time', () => {
    const codes = new Set(Array.from({ length: 500 }, () => generateVerificationCode()));
    expect(codes.size).toBe(500);
  });

  it('uses no character a reader could confuse', () => {
    // Crockford's alphabet omits I, L, O and U so a printed certificate
    // survives being typed in by a person reading it.
    for (let attempt = 0; attempt < 200; attempt++) {
      expect(generateVerificationCode()).not.toMatch(/[ILOU]/);
    }
  });

  it('canonicalizes what a person actually types', () => {
    const code = generateVerificationCode();
    const displayed = formatCertificateNumber(code);

    expect(displayed.startsWith(`${CERTIFICATE_NUMBER_PREFIX}-`)).toBe(true);
    expect(canonicalizeVerificationCode(displayed)).toBe(code);
    expect(canonicalizeVerificationCode(displayed.toLowerCase())).toBe(code);
    expect(canonicalizeVerificationCode(` ${displayed} `)).toBe(code);
    expect(canonicalizeVerificationCode(displayed.replace(/-/g, ' '))).toBe(code);
  });

  it('keeps a bare code that happens to start with the prefix letters', () => {
    // The 1-in-1024 bug, pinned with a fixed vector so it can never hide
    // behind probability again.
    //
    // `P` and `C` are ordinary symbols of the alphabet, so a perfectly valid
    // code begins with `PC` about once in every 1024. An earlier version of
    // the parser removed those two as though they were the display prefix,
    // leaving 30 symbols, and returned null — every certificate unlucky
    // enough to draw such a code would have been unverifiable for its whole
    // life, and it would have looked like a typo to whoever hit it.
    //
    // What makes the two forms unambiguous is length, not the first two
    // characters, and that is what these vectors assert.
    const bare = 'PC8K21DV765DZY4JNB9MN3FGTVTKWQC0';
    expect(bare).toHaveLength(VERIFICATION_CODE_SYMBOLS);
    expect(bare.startsWith(CERTIFICATE_NUMBER_PREFIX)).toBe(true);

    // A bare 32-symbol code is itself, prefix letters and all.
    expect(canonicalizeVerificationCode(bare)).toBe(bare);
    expect(canonicalizeVerificationCode(bare.toLowerCase())).toBe(bare);
    expect(canonicalizeVerificationCode(` ${bare} `)).toBe(bare);

    // And its displayed form — which now carries `PC` twice, once as the
    // prefix and once as the code's own first two symbols — still resolves
    // back to exactly the same code.
    const displayed = formatCertificateNumber(bare);
    expect(displayed).toBe('PC-PC8K21DV-765DZY4J-NB9MN3FG-TVTKWQC0');
    expect(canonicalizeVerificationCode(displayed)).toBe(bare);
    expect(canonicalizeVerificationCode(displayed.toLowerCase())).toBe(bare);
    expect(canonicalizeVerificationCode(displayed.replace(/-/g, ''))).toBe(bare);
    expect(canonicalizeVerificationCode(displayed.replace(/-/g, ' '))).toBe(bare);

    // The hash is of the canonical 32 symbols, whichever form was typed.
    expect(verificationCodeHash(canonicalizeVerificationCode(displayed)!)).toBe(
      verificationCodeHash(bare),
    );

    // A second fixed vector, to prove the first is not a coincidence of its
    // own symbols: a code that is entirely prefix-shaped at the front.
    const alsoBare = 'PCPCPCPC0123456789ABCDEFGHJKMNPQ';
    expect(alsoBare).toHaveLength(VERIFICATION_CODE_SYMBOLS);
    expect(canonicalizeVerificationCode(alsoBare)).toBe(alsoBare);
    expect(canonicalizeVerificationCode(formatCertificateNumber(alsoBare))).toBe(alsoBare);
  });

  it('decides the prefix by length, and refuses the shapes in between', () => {
    const bare = 'PC8K21DV765DZY4JNB9MN3FGTVTKWQC0';
    // 34 symbols only count as prefixed when they really do start with PC.
    expect(canonicalizeVerificationCode(`XY${bare}`)).toBeNull();
    // 33 is neither form.
    expect(canonicalizeVerificationCode(`${bare}A`)).toBeNull();
    // 34 that does start with PC *is* the prefixed form, by definition —
    // there is no valid 34-symbol bare code for it to be confused with — so
    // the leading PC is the prefix and the remaining 32 are the code.
    expect(canonicalizeVerificationCode(`${bare}AB`)).toBe('8K21DV765DZY4JNB9MN3FGTVTKWQC0AB');
    // 30 symbols — what the old parser left behind — is not a code either.
    expect(canonicalizeVerificationCode(bare.slice(2))).toBeNull();
    // And a doubled prefix on a full display form is 36, which is nothing.
    expect(
      canonicalizeVerificationCode(`${CERTIFICATE_NUMBER_PREFIX}-${formatCertificateNumber(bare)}`),
    ).toBeNull();
  });

  it('maps the documented look-alikes rather than refusing them', () => {
    const code = generateVerificationCode();
    // Someone reading a printed 1 as an I, or a 0 as an O, still gets through.
    const misread = code.replace(/1/g, 'I').replace(/0/g, 'O');
    expect(canonicalizeVerificationCode(misread)).toBe(code);
  });

  it('rejects anything that is not a code, without throwing', () => {
    // The public route turns null into a flat not-found, so hostile input can
    // neither crash it nor be distinguished from a code that simply does not
    // exist.
    for (const bad of ['', 'PC-', 'not-a-code', 'U'.repeat(32), 'A'.repeat(31), 'A'.repeat(33)]) {
      expect([bad, canonicalizeVerificationCode(bad)]).toEqual([bad, null]);
    }
  });

  it('hashes the canonical form, so the plaintext need never be stored', () => {
    const code = generateVerificationCode();
    expect(verificationCodeHash(code)).toHaveLength(64);
    expect(verificationCodeHash(code)).toBe(
      verificationCodeHash(canonicalizeVerificationCode(formatCertificateNumber(code))!),
    );
    expect(verificationCodeHash(code)).not.toContain(code);
  });
});

describe('the issuance lifecycle', () => {
  it('lets a retryable failure return to pending, and a permanent one never', () => {
    // The conflict this resolves: one certificate row per revision means a
    // single terminal FAILED would bar an eligible revision for ever, even
    // when the cause was a storage timeout.
    expect(
      isValidIssuanceTransition(
        CertificateIssuanceStatus.FAILED_RETRYABLE,
        CertificateIssuanceStatus.PENDING,
      ),
    ).toBe(true);
    expect(
      isValidIssuanceTransition(
        CertificateIssuanceStatus.FAILED_PERMANENT,
        CertificateIssuanceStatus.PENDING,
      ),
    ).toBe(false);
    expect(isRequeueable(CertificateIssuanceStatus.FAILED_RETRYABLE)).toBe(true);
    expect(isRequeueable(CertificateIssuanceStatus.FAILED_PERMANENT)).toBe(false);
  });

  it('never un-revokes and never re-issues', () => {
    for (const status of CERTIFICATE_ISSUANCE_STATUSES) {
      expect([
        status,
        isValidIssuanceTransition(CertificateIssuanceStatus.REVOKED, status),
      ]).toEqual([status, false]);
    }
    expect(
      isValidIssuanceTransition(
        CertificateIssuanceStatus.ISSUED,
        CertificateIssuanceStatus.PENDING,
      ),
    ).toBe(false);
  });

  it('never borrows the evidence vocabulary for a certificate state', () => {
    // A certificate is not APPROVED and not COMPLIANT. Those words belong to
    // the two authorities it is derived from, and reusing them here would be
    // the first step to one status standing for all three.
    for (const status of CERTIFICATE_ISSUANCE_STATUSES) {
      expect(['APPROVED', 'COMPLIANT', 'REJECTED']).not.toContain(status);
    }
  });

  it('routes evidence failures to permanent and infrastructure to retryable', () => {
    for (const code of [
      CertificateFailureCode.DOCUMENT_SNAPSHOT_MISMATCH,
      CertificateFailureCode.REPORT_SNAPSHOT_MISMATCH,
      CertificateFailureCode.EVIDENCE_HASH_MISMATCH,
      CertificateFailureCode.APPROVAL_EVENT_INVALID,
    ]) {
      expect([code, isPermanentCertificateFailure(code)]).toEqual([code, true]);
      expect(issuanceStatusForFailure(code)).toBe(CertificateIssuanceStatus.FAILED_PERMANENT);
    }
    for (const code of [
      CertificateFailureCode.STORAGE_UNAVAILABLE,
      CertificateFailureCode.RENDERER_FAILED,
      CertificateFailureCode.ARTIFACT_VERIFICATION_FAILED,
    ]) {
      expect([code, isPermanentCertificateFailure(code)]).toEqual([code, false]);
      expect(issuanceStatusForFailure(code)).toBe(CertificateIssuanceStatus.FAILED_RETRYABLE);
    }
  });
});

describe('what a verifier is told', () => {
  const now = new Date('2026-09-16T12:00:00.000Z');

  it('reports a live certificate as valid', () => {
    expect(
      verificationStatusOf({
        issuanceStatus: CertificateIssuanceStatus.ISSUED,
        validUntil: null,
        now,
      }),
    ).toBe(CertificateVerificationStatus.VALID);
  });

  it('derives expiry from the date rather than a midnight job', () => {
    expect(
      verificationStatusOf({
        issuanceStatus: CertificateIssuanceStatus.ISSUED,
        validUntil: new Date('2026-09-16T11:59:59.000Z'),
        now,
      }),
    ).toBe(CertificateVerificationStatus.EXPIRED);
  });

  it('reports revocation ahead of expiry', () => {
    // Both are true of the row; the one that matters to a verifier is that it
    // was withdrawn.
    expect(
      verificationStatusOf({
        issuanceStatus: CertificateIssuanceStatus.REVOKED,
        validUntil: new Date('2020-01-01T00:00:00.000Z'),
        now,
      }),
    ).toBe(CertificateVerificationStatus.REVOKED);
  });

  it('gives an unissued certificate no public status at all', () => {
    // Which is what lets the public route answer a flat not-found, so nobody
    // can probe for certificates that are still being prepared or that failed.
    for (const status of [
      CertificateIssuanceStatus.PENDING,
      CertificateIssuanceStatus.FAILED_RETRYABLE,
      CertificateIssuanceStatus.FAILED_PERMANENT,
    ]) {
      expect([
        status,
        verificationStatusOf({ issuanceStatus: status, validUntil: null, now }),
      ]).toEqual([status, null]);
    }
  });
});

describe('the certificate claim', () => {
  function claim(): CertificateClaim {
    return {
      claimSchemaVersion: CERTIFICATE_CLAIM_SCHEMA_VERSION,
      claimCanonicalizationVersion: CERTIFICATE_CLAIM_CANONICALIZATION_VERSION,
      certificateNumber: 'PC-0123456789ABCDEFGHJKMNPQRSTVWX',
      verificationCode: '0123456789ABCDEFGHJKMNPQRSTVWXYZ',
      submissionRevisionId: '11111111-1111-4111-8111-111111111111',
      organizationId: '22222222-2222-4222-8222-222222222222',
      organizationName: 'Islamic University of Gaza',
      documentTypeId: '33333333-3333-4333-8333-333333333333',
      documentTypeName: "Master's thesis",
      documentFormat: 'DOCX',
      documentSha256: 'a'.repeat(64),
      reportHash: 'b'.repeat(64),
      evaluationHash: 'c'.repeat(64),
      standardId: '44444444-4444-4444-8444-444444444444',
      standardVersionId: '55555555-5555-4555-8555-555555555555',
      standardContentHash: `sha256:${'d'.repeat(64)}`,
      standardCode: 'IUG.THESIS.FORMAT',
      standardName: 'IUG Thesis Formatting',
      standardVersionLabel: '1.0',
      submissionEvidenceHash: 'e'.repeat(64),
      technicalDetermination: 'COMPLIANT',
      institutionDecision: 'APPROVED',
      approvalDecisionEventId: '66666666-6666-4666-8666-666666666666',
      approvedAt: '2026-09-15T10:00:00.000Z',
      issuedAt: '2026-09-16T10:00:00.000Z',
      validUntil: null,
    };
  }

  it('hashes to the golden digest', () => {
    // A serialization refactor must not silently change every certificate
    // hash ever issued. If this value moves, the canonicalization version has
    // to move with it.
    expect(computeCertificateClaimHash(claim())).toBe(
      '63edcf66d7223a015a90cc184ebb196ef08c7b831d085c6d98b3eae122af99fe',
    );
  });

  it('serializes with sorted keys and no whitespace', () => {
    const canonical = canonicalCertificateClaim(claim());
    expect(canonical.startsWith('{"approvalDecisionEventId":')).toBe(true);
    expect(canonical).not.toContain('\n');
    expect(canonical).not.toContain(': ');
  });

  it('changes when any covered field changes', () => {
    const base = computeCertificateClaimHash(claim());
    expect(computeCertificateClaimHash({ ...claim(), documentSha256: 'f'.repeat(64) })).not.toBe(
      base,
    );
    expect(computeCertificateClaimHash({ ...claim(), organizationName: 'Renamed' })).not.toBe(base);
    expect(
      computeCertificateClaimHash({ ...claim(), validUntil: '2030-01-01T00:00:00.000Z' }),
    ).not.toBe(base);
  });

  it('carries no identity, no prose and no money', () => {
    // The claim is printed on an artifact meant to be handed to strangers.
    const canonical = canonicalCertificateClaim(claim()).toLowerCase();
    for (const forbidden of [
      'email',
      'displayname',
      'userid',
      'owneruserid',
      'comment',
      'filename',
      'title',
      'price',
      'amount',
      'balance',
      'smartfix',
      'aireview',
      'objectkey',
      // Storage object versions specifically: `standardVersionId` is a
      // legitimate part of the claim and must not trip this guard.
      'objectversionid',
      'snapshotkey',
    ]) {
      expect([forbidden, canonical.includes(forbidden)]).toEqual([forbidden, false]);
    }
  });

  it('refuses to hash a claim canonicalized under another version', () => {
    expect(() =>
      canonicalCertificateClaim({ ...claim(), claimCanonicalizationVersion: 99 }),
    ).toThrow(/canonicalized at version 99/);
  });
});
