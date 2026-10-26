import { writeFileSync } from 'node:fs';
import { buildRecoveryFixture, redactFixture } from './support/recovery-fixture';
import {
  createTestContext,
  destroyTestContext,
  resetState,
  type TestContext,
} from './support/test-app';

/**
 * Build the recovery dataset once, through real application workflows, and
 * assert it actually crossed the persistence boundaries a restore has to
 * bring back.
 *
 * Separate from the drill so a failure here is legible: "the fixture could
 * not be built" and "the restore lost something" are different problems and
 * should not arrive as the same red test.
 */
/**
 * Read before the harness replaces `process.env` with the deterministic test
 * environment, which is what happens inside `createTestContext`.
 */
const CAPABILITY_OUT = process.env['DRILL_CAPABILITY_OUT'];
/**
 * Where to write the redacted fixture summary -- identifiers and hashes only
 * -- so a later drill can ask a restored or *upgraded* installation the same
 * questions (Phase 20 Checkpoint 9's upgrade rehearsal runs this spec against
 * the Phase 19 code and reads the result back through the release candidate).
 */
const FIXTURE_OUT = process.env['DRILL_FIXTURE_OUT'];

describe('Recovery fixture (e2e)', () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await createTestContext();
    await resetState(context);
  }, 120_000);

  afterAll(async () => {
    await destroyTestContext(context);
  });

  it('crosses the major persistence boundaries using real workflows', async () => {
    const fixture = await buildRecoveryFixture(context);

    expect(fixture.author.userId).toHaveLength(36);
    expect(fixture.organizationId).toHaveLength(36);

    // Documents reached the clean zone with a hash PalCert computed itself.
    for (const document of [fixture.docx, fixture.pdf]) {
      expect(document.sha256).toMatch(/^[0-9a-f]{64}$/);
      const version = await context.adminDb.documentVersion.findUniqueOrThrow({
        where: { id: document.versionId },
      });
      expect(version.cleanObjectKey).not.toBeNull();
    }

    // Both analyzers persisted an artifact, not merely a status.
    const analyses = await context.adminDb.documentAnalysis.findMany({
      where: { documentVersionId: { in: [fixture.docx.versionId, fixture.pdf.versionId] } },
    });
    expect(analyses.length).toBeGreaterThanOrEqual(2);
    expect(analyses.every((analysis) => analysis.artifactObjectKey !== null)).toBe(true);

    // A report with a canonical hash, which is what a restore must not change.
    expect(fixture.reportHash).toMatch(/^[0-9a-f]{64}$/);

    // Money moved through the append-only ledger, and a purchase exists.
    expect(fixture.ledgerEntryCount).toBeGreaterThan(0);
    expect(fixture.paidPurchaseId).toHaveLength(36);

    // A certificate was issued, and its code was disclosed exactly once.
    expect(fixture.certificateClaimHash).toMatch(/^[0-9a-f]{64}$/);
    expect(fixture.certificateVerificationCode.length).toBeGreaterThan(0);

    // Secret-dependent state exists: a sealed webhook endpoint and an API
    // client whose credential is a verifier rather than ciphertext.
    const endpoint = await context.adminDb.webhookEndpoint.findUniqueOrThrow({
      where: { id: fixture.webhookEndpointId },
    });
    expect(endpoint.organizationId).toBe(fixture.organizationId);
    const apiClient = await context.adminDb.apiClient.findUniqueOrThrow({
      where: { id: fixture.apiClientId },
    });
    expect(apiClient.organizationId).toBe(fixture.organizationId);

    // Notifications and domain events were produced by the workflows above
    // rather than inserted, which is what makes them worth restoring.
    expect(fixture.notificationCount).toBeGreaterThan(0);
    expect(await context.adminDb.domainEvent.count()).toBeGreaterThan(0);

    // And the object closure is non-trivial: this is the list the backup has
    // to cover, so a fixture that produced no objects would prove nothing.
    const closureSize = await context.adminDb.$queryRawUnsafe<{ count: bigint }[]>(
      `SELECT count(*)::bigint AS count FROM (
         SELECT quarantine_object_key AS k FROM document_versions WHERE quarantine_object_key IS NOT NULL
         UNION ALL SELECT clean_object_key FROM document_versions WHERE clean_object_key IS NOT NULL
         UNION ALL SELECT artifact_object_key FROM document_analyses WHERE artifact_object_key IS NOT NULL
         UNION ALL SELECT artifact_object_key FROM check_reports WHERE artifact_object_key IS NOT NULL
         UNION ALL SELECT certificate_object_key FROM compliance_certificates WHERE certificate_object_key IS NOT NULL
       ) refs`,
    );
    expect(Number(closureSize[0]?.count ?? 0)).toBeGreaterThan(5);

    // A drill affordance, off unless an operator asks for it. The certificate
    // verification code is a capability, and the fixture summary deliberately
    // never contains it -- but proving the *public verification endpoint*
    // works on a restored stack needs a real code to present to it. Written
    // only where the operator points, and expected to be destroyed with the
    // drill's working directory.
    if (FIXTURE_OUT !== undefined && FIXTURE_OUT.length > 0) {
      writeFileSync(FIXTURE_OUT, `${JSON.stringify(redactFixture(fixture), null, 2)}\n`);
    }
    if (CAPABILITY_OUT !== undefined && CAPABILITY_OUT.length > 0) {
      writeFileSync(
        CAPABILITY_OUT,
        `${JSON.stringify({
          certificateId: fixture.certificateId,
          verificationCode: fixture.certificateVerificationCode,
        })}\n`,
        { mode: 0o600 },
      );
    }
  }, 300_000);
});
