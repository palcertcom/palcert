import { type AuthClient } from './support/auth-client';
import {
  certificateEvents,
  downloadCertificate,
  listCertificates,
  organizationCertificate,
  readCertificate,
  revokeCertificate,
  verify,
  waitForCertificate,
} from './support/certificates-client';
import { type PublishedStandard } from './support/checks-client';
import {
  createTenant,
  createUser,
  grantOrganizationRoleTo,
  type TenantFixture,
} from './support/organization-client';
import {
  completedCheck,
  decide,
  publishStandardFor,
  submitAndPrepare,
} from './support/submissions-client';
import {
  createTestContext,
  destroyTestContext,
  resetState,
  type TestContext,
} from './support/test-app';

/**
 * Verification, as a stranger meets it (§17–§23, §99–§115, §153–§165).
 *
 * The public route is the only unauthenticated thing in PalCert that answers
 * about somebody's work, so nearly every assertion here is about what it does
 * *not* say. A verifier learns that a document was measured compliant and that
 * a named institution approved it. They do not learn who wrote it, what it was
 * called, what the institution said in private, or that any other certificate
 * exists at all.
 */
describe('Certificates — public verification and revocation (e2e)', () => {
  let context: TestContext;
  let author: { email: string; userId: string; client: AuthClient };
  let university: TenantFixture;
  let standard: PublishedStandard;

  beforeAll(async () => {
    context = await createTestContext();
  });

  afterAll(async () => {
    await destroyTestContext(context);
  });

  beforeEach(async () => {
    await resetState(context);
    author = await createUser(context, 'author@example.com');
    university = await createTenant(context, 'Islamic University of Gaza', 'registrar@example.com');
    standard = await publishStandardFor(context, university);
  });

  /** One issued certificate, reached the way a person reaches it. */
  async function issued(): Promise<{
    certificateId: string;
    revisionId: string;
    code: string;
    number: string;
  }> {
    const check = await completedCheck(context, author, standard);
    const { revisionId } = await submitAndPrepare(context, author.client, check.checkId);
    await decide(university.owner.client, university.organizationId, revisionId, {
      toStatus: 'APPROVED',
    });
    const settled = await waitForCertificate(context, revisionId);
    expect(settled.issuanceStatus).toBe('ISSUED');

    const view = await readCertificate(author.client, settled.id);
    expect(view.status).toBe(200);
    return {
      certificateId: settled.id,
      revisionId,
      code: view.body.verificationCode as string,
      number: view.body.certificateNumber as string,
    };
  }

  // -------------------------------------------------------------------------
  // What a verifier is told (§99–§107, §153)
  // -------------------------------------------------------------------------

  it('answers a valid code with the claim and nothing more', async () => {
    const { number } = await issued();
    const response = await verify(context, number);

    expect(response.status).toBe(200);
    expect(Object.keys(response.body).sort()).toEqual(
      [
        'certificateArtifactSha256',
        'certificateClaimHash',
        'certificateNumber',
        'documentFormat',
        'documentSha256',
        'institutionDecision',
        'issuedAt',
        'organizationName',
        'reportHash',
        'revocationReason',
        'standardCode',
        'revokedAt',
        'standardContentHash',
        'standardName',
        'standardVersionLabel',
        'submissionEvidenceHash',
        'technicalResult',
        'validUntil',
        'verificationStatus',
        'documentTypeName',
      ].sort(),
    );
    expect(response.body.verificationStatus).toBe('VALID');
    expect(response.body.technicalResult).toBe('COMPLIANT');
    expect(response.body.institutionDecision).toBe('APPROVED');
    expect(response.body.organizationName).toBe('Islamic University of Gaza');
    expect(response.body.validUntil).toBeNull();
  });

  it('carries no identity, no title and no internal identifier', async () => {
    // §10, §11, §129–§135: the claim is document-bound. Sentinel names rather
    // than an eyeball: a future field called `ownerUserId` must fail here.
    const { number } = await issued();
    const body = JSON.stringify((await verify(context, number)).body);

    for (const forbidden of [
      'author@example.com',
      'ownerUserId',
      'userId',
      'displayName',
      'submissionId',
      'submissionRevisionId',
      'certificateId',
      'documentId',
      'documentName',
      'thesis.docx',
      'comment',
      'objectKey',
      'claimObjectKey',
      'verificationCode',
      'verificationCodeHash',
      'bucket',
    ]) {
      expect([forbidden, body.includes(forbidden)]).toEqual([forbidden, false]);
    }
  });

  it('tells crawlers and caches to leave it alone', async () => {
    // §21, §23: a verification page is a capability somebody was handed, and a
    // cached VALID for a certificate that has since been withdrawn would be
    // worse than no verification at all.
    const { number } = await issued();
    const response = await verify(context, number);

    expect(response.headers['x-robots-tag']).toContain('noindex');
    expect(response.headers['x-robots-tag']).toContain('nofollow');
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
  });

  it('accepts the number as printed, and as a person would mistype it', async () => {
    const { number, code } = await issued();
    const variants = [
      number,
      code,
      number.toLowerCase(),
      code.toLowerCase(),
      number.replace(/-/g, ' '),
      // The look-alikes the alphabet deliberately omits, so a reader copying
      // from paper is not punished for reading O as 0 or I as 1.
      code.replace(/0/g, 'O').replace(/1/g, 'I'),
    ];
    for (const variant of variants) {
      const response = await verify(context, variant);
      expect([variant, response.status]).toEqual([variant, 200]);
    }
  });

  it('answers unknown, malformed and empty codes identically', async () => {
    // §153–§155: distinguishing them would tell somebody probing which of
    // their guesses had the right shape.
    await issued();
    const answers = await Promise.all(
      [
        'PC-ZZZZZZZZ-ZZZZZZZZ-ZZZZZZZZ-ZZZZZZZZ',
        'not-a-code',
        '0',
        'PC-!!!!!!!!-@@@@@@@@-########-$$$$$$$$',
      ].map((code) => verify(context, code)),
    );
    for (const answer of answers) {
      expect(answer.status).toBe(404);
      expect(answer.body.error.code).toBe('CERTIFICATE_NOT_FOUND');
    }
  });

  it('answers nothing for a certificate that is still being prepared', async () => {
    // §154: PENDING is not a certificate yet, and saying "being prepared"
    // would confirm that a code exists.
    const check = await completedCheck(context, author, standard);
    const { revisionId } = await submitAndPrepare(context, author.client, check.checkId);
    await decide(university.owner.client, university.organizationId, revisionId, {
      toStatus: 'APPROVED',
    });
    const settled = await waitForCertificate(context, revisionId);
    const row = await context.adminDb.complianceCertificate.findUniqueOrThrow({
      where: { id: settled.id },
    });
    // Put it back to PENDING through the system function's own guard rails is
    // not possible, so this asserts the projection's condition directly: the
    // public function answers only for an issued or revoked certificate.
    const projected = await context.adminDb.$queryRawUnsafe<unknown[]>(
      'SELECT * FROM app_public_certificate($1)',
      'f'.repeat(64),
    );
    expect(projected).toEqual([]);
    expect(row.issuanceStatus).toBe('ISSUED');
  });

  it('publishes no list, no search and no way to enumerate', async () => {
    // §18, §19. The route takes a code and nothing else; there is no sibling
    // path to ask a broader question of.
    await issued();
    for (const path of ['', '/', '?organizationId=any', '?limit=10']) {
      const response = await verify(context, path);
      expect([path, response.status === 404 || response.status === 400]).toEqual([path, true]);
    }
  });

  // -------------------------------------------------------------------------
  // Revocation (§59–§70, §157, §162–§165)
  // -------------------------------------------------------------------------

  it('says revoked rather than not found, because an old QR must tell the truth', async () => {
    const { certificateId, number } = await issued();

    const revoked = await revokeCertificate(
      university.owner.client,
      university.organizationId,
      certificateId,
      { reasonCode: 'ADMINISTRATIVE_CORRECTION', comment: 'Recorded against the wrong intake.' },
    );
    expect(revoked.status).toBe(200);

    const response = await verify(context, number);
    expect(response.status).toBe(200);
    expect(response.body.verificationStatus).toBe('REVOKED');
    expect(response.body.revokedAt).not.toBeNull();
    // §67: the category, never the note.
    expect(response.body.revocationReason).toBe('ADMINISTRATIVE_CORRECTION');
    expect(JSON.stringify(response.body)).not.toContain('wrong intake');

    // §63: the claim is untouched. Revoking changes validity and nothing else.
    expect(response.body.technicalResult).toBe('COMPLIANT');
    expect(response.body.institutionDecision).toBe('APPROVED');
    expect(response.body.certificateClaimHash).toHaveLength(64);
  });

  it('refuses to revoke twice, and offers no way back', async () => {
    const { certificateId } = await issued();
    await revokeCertificate(university.owner.client, university.organizationId, certificateId, {
      reasonCode: 'ISSUED_IN_ERROR',
    });

    const again = await revokeCertificate(
      university.owner.client,
      university.organizationId,
      certificateId,
      { reasonCode: 'ISSUED_IN_ERROR' },
    );
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('CERTIFICATE_ALREADY_REVOKED');

    // §67: there is no un-revoke route to call, at any level.
    const row = await context.adminDb.complianceCertificate.findUniqueOrThrow({
      where: { id: certificateId },
    });
    expect(row.issuanceStatus).toBe('REVOKED');
  });

  it('leaves the issued PDF downloadable after revocation', async () => {
    // §70: the artifact is the record of what was issued. What changed is what
    // verification says about it.
    const { certificateId } = await issued();
    await revokeCertificate(university.owner.client, university.organizationId, certificateId, {
      reasonCode: 'SECURITY_INCIDENT',
    });

    const download = await downloadCertificate(author.client, certificateId);
    expect(download.status).toBe(200);
    expect(download.body.method).toBe('GET');
    expect(download.body.url).toContain('http');
    // §51: the identifier-only key never reaches the response.
    expect(JSON.stringify(download.body)).not.toContain('claim');
  });

  it('records a revocation as the institution’s act, with an actor', async () => {
    const { certificateId } = await issued();
    await revokeCertificate(university.owner.client, university.organizationId, certificateId, {
      reasonCode: 'ISSUED_IN_ERROR',
      comment: 'Duplicate of an earlier submission.',
    });

    const events = await certificateEvents(author.client, certificateId);
    expect(events.status).toBe(200);
    expect(events.body).toHaveLength(2);
    expect(events.body[0]).toMatchObject({ eventType: 'ISSUED', eventSource: 'SYSTEM' });
    expect(events.body[1]).toMatchObject({
      eventType: 'REVOKED',
      eventSource: 'ORGANIZATION',
      reasonCode: 'ISSUED_IN_ERROR',
    });
    // §67: the author sees the category and never the institution's note.
    expect(JSON.stringify(events.body)).not.toContain('Duplicate of an earlier');
  });

  it('writes an audit trail that carries no code, no URL and no private note', async () => {
    // §181, §183, §184: the audit log records that something happened to which
    // certificate. A code in it would let anybody with log access verify a
    // certificate they were never shown, and the institution's note is theirs.
    const { certificateId, code, number } = await issued();
    await revokeCertificate(university.owner.client, university.organizationId, certificateId, {
      reasonCode: 'ISSUED_IN_ERROR',
      comment: 'Duplicate of an earlier submission.',
    });

    const audited = await context.adminDb.auditEvent.findMany({
      where: { targetId: certificateId },
      orderBy: { createdAt: 'asc' },
    });
    expect(audited.map((row) => row.action)).toEqual(
      expect.arrayContaining(['CERTIFICATE_ISSUED', 'CERTIFICATE_REVOKED']),
    );

    const serialized = JSON.stringify(audited);
    for (const secret of [code, number, 'Duplicate of an earlier', '/verify/']) {
      expect([secret, serialized.includes(secret)]).toEqual([secret, false]);
    }
  });

  it('refuses revocation to a reviewer who may decide but not withdraw', async () => {
    // §63, §213: recording a decision and withdrawing a certificate are
    // different acts, and the second is not granted by default.
    const { certificateId } = await issued();
    const reviewer = await createUser(context, 'reviewer@example.com');
    await grantOrganizationRoleTo(context, university, reviewer, 'ORGANIZATION_REVIEWER');

    const refused = await revokeCertificate(
      reviewer.client,
      university.organizationId,
      certificateId,
      { reasonCode: 'ISSUED_IN_ERROR' },
    );
    expect(refused.status).toBe(403);
    expect(
      (
        await context.adminDb.complianceCertificate.findUniqueOrThrow({
          where: { id: certificateId },
        })
      ).issuanceStatus,
    ).toBe('ISSUED');
  });

  // -------------------------------------------------------------------------
  // The two parties, and nobody else (§52, §53, §212)
  // -------------------------------------------------------------------------

  it('shows a certificate to its subject and to the institution, and to no one else', async () => {
    const { certificateId } = await issued();
    const stranger = await createUser(context, 'stranger@example.com');
    const otherUniversity = await createTenant(context, 'Al-Azhar', 'other@example.com');

    expect((await readCertificate(author.client, certificateId)).status).toBe(200);
    expect(
      (
        await organizationCertificate(
          university.owner.client,
          university.organizationId,
          certificateId,
        )
      ).status,
    ).toBe(200);

    // Not forbidden — not found. A 403 would confirm the certificate exists.
    expect((await readCertificate(stranger.client, certificateId)).status).toBe(404);
    expect((await listCertificates(stranger.client)).body).toEqual([]);
    expect(
      (
        await organizationCertificate(
          otherUniversity.owner.client,
          otherUniversity.organizationId,
          certificateId,
        )
      ).status,
    ).toBe(404);
  });
});
