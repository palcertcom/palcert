import { computeCertificateClaimHash, verificationCodeHash } from '@palcert/contracts';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { type AuthClient } from './support/auth-client';
import {
  downloadCertificate,
  readCertificate,
  verify,
  waitForCertificate,
} from './support/certificates-client';
import { type PublishedStandard } from './support/checks-client';
import { createTenant, createUser, type TenantFixture } from './support/organization-client';
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
 * A verification code that begins with the display prefix's own letters.
 *
 * `P` and `C` are ordinary symbols of the alphabet, so roughly one code in
 * 1024 begins with `PC`. An earlier parser stripped those two as though they
 * were the `PC-` prefix, leaving 30 symbols and rejecting a perfectly valid
 * code — which would have made every certificate unlucky enough to draw one
 * unverifiable for its whole life, while looking to its holder like a typo.
 *
 * The unit tests pin the parser. This pins the *product*: the same code has to
 * survive generation, formatting, the immutable claim, the PDF, the QR's URL,
 * the public route, canonicalization, hashing and the database lookup, and
 * come back VALID — in both the printed form and the bare form.
 *
 * The code is forced rather than waited for. A test that generated codes until
 * one started with `PC` would be a test that usually proves nothing and
 * occasionally takes a thousand attempts.
 */
const PREFIX_SHAPED_CODE = 'PC8K21DV765DZY4JNB9MN3FGTVTKWQC0';
const PREFIX_SHAPED_NUMBER = 'PC-PC8K21DV-765DZY4J-NB9MN3FG-TVTKWQC0';

/* eslint-disable @typescript-eslint/no-require-imports */
// The built contracts barrel re-exports through non-configurable getters that
// delegate to this module at call time, so replacing the binding here is what
// the scheduling service sees — without mocking the whole contracts package
// out from under an application that is booting against it.
//
// Reached by path rather than by subpath specifier: the package exports map
// publishes only its root, which is correct and not worth widening for a test.
const verificationCodeModule: { generateVerificationCode: () => string } = require(
  join(dirname(require.resolve('@palcert/contracts')), 'certificates', 'verification-code.js'),
);
/* eslint-enable @typescript-eslint/no-require-imports */

describe('Certificates — a code shaped like the prefix (e2e)', () => {
  let context: TestContext;
  let author: { email: string; userId: string; client: AuthClient };
  let university: TenantFixture;
  let standard: PublishedStandard;
  let originalGenerate: () => string;

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

    originalGenerate = verificationCodeModule.generateVerificationCode;
    verificationCodeModule.generateVerificationCode = () => PREFIX_SHAPED_CODE;
  });

  afterEach(() => {
    verificationCodeModule.generateVerificationCode = originalGenerate;
  });

  it('carries a PC-shaped code through issuance, the PDF and public verification', async () => {
    const check = await completedCheck(context, author, standard);
    const { revisionId } = await submitAndPrepare(context, author.client, check.checkId);
    const approved = await decide(university.owner.client, university.organizationId, revisionId, {
      toStatus: 'APPROVED',
    });
    expect(approved.status).toBe(200);

    const settled = await waitForCertificate(context, revisionId);
    expect([settled.issuanceStatus, settled.failureCode]).toEqual(['ISSUED', null]);

    // --- the row: the digest of the forced code, and no capability ----------
    const row = await context.adminDb.complianceCertificate.findUniqueOrThrow({
      where: { id: settled.id },
    });
    expect(row.verificationCodeHash).toBe(verificationCodeHash(PREFIX_SHAPED_CODE));
    expect(row.verificationCodeCiphertext).toBeNull();

    // --- the claim: the code and the number it displays as -------------------
    const claimBytes = await context.storage.getObjectBytes({
      zone: 'derived',
      key: row.claimObjectKey!,
      versionId: row.claimObjectVersionId,
    });
    const claim = JSON.parse(claimBytes.toString('utf8')) as {
      verificationCode: string;
      certificateNumber: string;
    };
    expect(claim.verificationCode).toBe(PREFIX_SHAPED_CODE);
    expect(claim.certificateNumber).toBe(PREFIX_SHAPED_NUMBER);
    expect(computeCertificateClaimHash(claim as never)).toBe(row.claimHash);

    // --- the holder's view, read back out of that claim ---------------------
    const view = await readCertificate(author.client, settled.id);
    expect(view.status).toBe(200);
    expect(view.body.certificateNumber).toBe(PREFIX_SHAPED_NUMBER);
    expect(view.body.verificationCode).toBe(PREFIX_SHAPED_CODE);
    // The QR's destination, built server-side from the same number.
    expect(view.body.verificationUrl).toContain(PREFIX_SHAPED_NUMBER);

    // --- the PDF: the artifact whose digest the certificate publishes -------
    const artifact = await context.storage.getObjectBytes({
      zone: 'derived',
      key: row.certificateObjectKey!,
      versionId: row.certificateObjectVersionId,
    });
    expect(createHash('sha256').update(artifact).digest('hex')).toBe(row.certificateObjectSha256);
    const download = await downloadCertificate(author.client, settled.id);
    expect(download.status).toBe(200);
    expect(download.body.filename).toBe(`${PREFIX_SHAPED_NUMBER}.pdf`);

    // --- public verification, in every form a holder might present ----------
    for (const presented of [
      PREFIX_SHAPED_NUMBER,
      PREFIX_SHAPED_NUMBER.toLowerCase(),
      PREFIX_SHAPED_NUMBER.replace(/-/g, ' '),
      PREFIX_SHAPED_CODE,
      PREFIX_SHAPED_CODE.toLowerCase(),
      // The look-alikes a person might type off the printed page.
      PREFIX_SHAPED_CODE.replace(/1/g, 'I').replace(/0/g, 'O'),
    ]) {
      const verified = await verify(context, presented);
      expect([presented, verified.status]).toEqual([presented, 200]);
      expect(verified.body.verificationStatus).toBe('VALID');
      // However it was typed, the answer names the canonical printed form.
      expect(verified.body.certificateNumber).toBe(PREFIX_SHAPED_NUMBER);
      expect(verified.body.certificateArtifactSha256).toBe(row.certificateObjectSha256);
    }

    // --- and the thirty symbols the old parser would have left behind -------
    // must still be nothing, so the fix did not simply widen what is accepted.
    const truncated = await verify(context, PREFIX_SHAPED_CODE.slice(2));
    expect(truncated.status).toBe(404);
    expect(truncated.body.error.code).toBe('CERTIFICATE_NOT_FOUND');
  });
});
