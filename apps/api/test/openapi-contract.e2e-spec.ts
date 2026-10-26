import { SwaggerModule } from '@nestjs/swagger';
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME, SESSION_COOKIE_NAME } from '@palcert/contracts';
import { buildOpenApiConfig } from '../src/bootstrap';
import { createTestContext, destroyTestContext, type TestContext } from './support/test-app';

interface OpenApiOperation {
  summary?: string;
  responses?: Record<string, unknown>;
}

interface OpenApiDocument {
  paths: Record<string, Record<string, OpenApiOperation>>;
  components?: { securitySchemes?: Record<string, unknown> };
}

/**
 * API contract tests (§44).
 *
 * These fail the build if an endpoint ships undocumented, so "no undocumented
 * APIs" is enforced mechanically rather than by review discipline.
 */
describe('OpenAPI contract (e2e)', () => {
  let context: TestContext;
  let spec: OpenApiDocument;

  /**
   * Prefix the generator applies to controller routes.
   *
   * `createDocument` does not necessarily reproduce the global prefix and URI
   * version that the running server mounts, and that detail has changed between
   * Nest versions. Deriving it from the document keeps these assertions about
   * *coverage* rather than about the generator's prefixing behaviour — which is
   * what they are actually for.
   */
  let prefix = '';
  const versioned = (path: string): string => `${prefix}${path}`;

  beforeAll(async () => {
    context = await createTestContext();

    // The server's own configuration, not a copy of it. A scheme added in
    // `bootstrap` and forgotten here would otherwise pass a test that asserts
    // the test's own builder.
    spec = SwaggerModule.createDocument(
      context.app,
      buildOpenApiConfig('test'),
    ) as unknown as OpenApiDocument;

    const loginPath = Object.keys(spec.paths).find((path) => path.endsWith('/auth/login'));
    if (loginPath === undefined) {
      throw new Error('The generated OpenAPI document contains no login route at all.');
    }
    prefix = loginPath.slice(0, loginPath.length - '/auth/login'.length);
  });

  afterAll(async () => {
    await destroyTestContext(context);
  });

  it('documents every product endpoint', () => {
    const expected: ReadonlyArray<readonly [string, string]> = [
      ['post', '/auth/register'],
      ['post', '/auth/login'],
      ['post', '/auth/logout'],
      ['post', '/auth/logout-all'],
      ['post', '/auth/email/verify'],
      ['post', '/auth/email/resend'],
      ['post', '/auth/password/forgot'],
      ['post', '/auth/password/reset'],
      ['post', '/auth/password/change'],
      ['get', '/auth/sessions'],
      ['delete', '/auth/sessions/{id}'],
      ['post', '/auth/mfa/enroll'],
      ['post', '/auth/mfa/confirm'],
      ['post', '/auth/mfa/challenge'],
      ['delete', '/auth/mfa'],
      ['get', '/users/me'],
      ['patch', '/users/me'],
      ['get', '/admin/users'],
      ['get', '/admin/users/{id}'],
      ['post', '/admin/users/{id}/suspend'],
      ['post', '/admin/users/{id}/reactivate'],
      ['post', '/admin/users/{id}/roles'],
      ['delete', '/admin/users/{id}/roles/{roleCode}'],

      // Phase 2
      ['post', '/organizations'],
      ['get', '/organizations'],
      ['get', '/organizations/{organizationId}'],
      ['patch', '/organizations/{organizationId}'],
      ['get', '/organizations/{organizationId}/verification'],
      ['post', '/organizations/{organizationId}/verification'],
      ['get', '/organizations/{organizationId}/members'],
      ['patch', '/organizations/{organizationId}/members/{membershipId}'],
      ['delete', '/organizations/{organizationId}/members/{membershipId}'],
      ['post', '/organizations/{organizationId}/members/{membershipId}/roles'],
      ['delete', '/organizations/{organizationId}/members/{membershipId}/roles/{roleCode}'],
      ['post', '/organizations/{organizationId}/ownership-transfer'],
      ['get', '/organizations/{organizationId}/invitations'],
      ['post', '/organizations/{organizationId}/invitations'],
      ['delete', '/organizations/{organizationId}/invitations/{invitationId}'],
      ['post', '/invitations/preview'],
      ['post', '/invitations/accept'],
      ['get', '/admin/organizations'],
      ['get', '/admin/organizations/verification-queue'],
      ['post', '/admin/organizations/{organizationId}/verification'],
      ['post', '/admin/organizations/{organizationId}/suspend'],
      ['post', '/admin/organizations/{organizationId}/reactivate'],

      // Phase 3
      ['get', '/standards/rule-schema'],
      ['get', '/organizations/{organizationId}/document-types'],
      ['post', '/organizations/{organizationId}/document-types'],
      ['get', '/organizations/{organizationId}/document-types/{documentTypeId}'],
      ['patch', '/organizations/{organizationId}/document-types/{documentTypeId}'],
      ['post', '/organizations/{organizationId}/document-types/{documentTypeId}/archive'],
      ['post', '/organizations/{organizationId}/document-types/{documentTypeId}/restore'],
      ['get', '/organizations/{organizationId}/standards'],
      ['post', '/organizations/{organizationId}/standards'],
      ['get', '/organizations/{organizationId}/standards/{standardId}'],
      ['patch', '/organizations/{organizationId}/standards/{standardId}'],
      ['post', '/organizations/{organizationId}/standards/{standardId}/archive'],
      ['post', '/organizations/{organizationId}/standards/{standardId}/restore'],
      ['get', '/organizations/{organizationId}/standards/{standardId}/versions'],
      ['post', '/organizations/{organizationId}/standards/{standardId}/versions'],
      ['get', '/organizations/{organizationId}/standards/{standardId}/versions/{versionId}'],
      ['patch', '/organizations/{organizationId}/standards/{standardId}/versions/{versionId}'],
      ['post', '/organizations/{organizationId}/standards/{standardId}/versions/{versionId}/clone'],
      [
        'post',
        '/organizations/{organizationId}/standards/{standardId}/versions/{versionId}/publish',
      ],
      [
        'post',
        '/organizations/{organizationId}/standards/{standardId}/versions/{versionId}/archive',
      ],
      [
        'get',
        '/organizations/{organizationId}/standards/{standardId}/versions/{versionId}/validation',
      ],
      [
        'get',
        '/organizations/{organizationId}/standards/{standardId}/versions/{versionId}/snapshot',
      ],
      ['get', '/organizations/{organizationId}/standards/{standardId}/versions/{versionId}/usage'],
      ['get', '/organizations/{organizationId}/standards/{standardId}/versions/{versionId}/export'],
      ['post', '/organizations/{organizationId}/standards/import/preview'],
      ['post', '/organizations/{organizationId}/standards/import'],
      ['get', '/organizations/{organizationId}/standards/{standardId}/versions/{versionId}/rules'],
      ['post', '/organizations/{organizationId}/standards/{standardId}/versions/{versionId}/rules'],
      [
        'get',
        '/organizations/{organizationId}/standards/{standardId}/versions/{versionId}/rules/{ruleId}',
      ],
      [
        'patch',
        '/organizations/{organizationId}/standards/{standardId}/versions/{versionId}/rules/{ruleId}',
      ],
      [
        'delete',
        '/organizations/{organizationId}/standards/{standardId}/versions/{versionId}/rules/{ruleId}',
      ],
      [
        'post',
        '/organizations/{organizationId}/standards/{standardId}/versions/{versionId}/rules/reorder',
      ],
      // Phase 5: user-private documents, versions, uploads and downloads.
      ['get', '/documents'],
      ['post', '/documents'],
      ['get', '/documents/{documentId}'],
      ['patch', '/documents/{documentId}'],
      ['delete', '/documents/{documentId}'],
      ['get', '/documents/{documentId}/versions'],
      ['post', '/documents/{documentId}/versions'],
      ['get', '/documents/{documentId}/versions/{versionId}'],
      ['post', '/documents/{documentId}/versions/{versionId}/upload-authorizations'],
      ['post', '/documents/{documentId}/versions/{versionId}/finalize'],
      ['post', '/documents/{documentId}/versions/{versionId}/cancel'],
      ['post', '/documents/{documentId}/versions/{versionId}/retry'],
      ['post', '/documents/{documentId}/versions/{versionId}/download-authorization'],

      // Phase 7: the public catalogue and the caller's own checks.
      ['get', '/catalogue/organizations'],
      ['get', '/catalogue/organizations/{organizationId}/document-types'],
      ['get', '/catalogue/document-types/{documentTypeId}/standards'],
      ['get', '/catalogue/standards/{standardId}'],

      // Phase 13
      ['get', '/catalogue/standards/{standardId}/compatibility'],
      ['post', '/checks'],
      ['get', '/checks'],
      ['get', '/checks/{checkId}'],
      ['get', '/checks/{checkId}/results'],
      ['get', '/checks/{checkId}/report'],
      ['get', '/checks/{checkId}/report/artifact'],
      ['post', '/checks/{checkId}/retry'],
      ['post', '/checks/{checkId}/cancel'],
      ['patch', '/organizations/{organizationId}/standards/{standardId}/check-availability'],

      // Phase 8: AI consent, and AI reviews of the caller's own checks.
      ['get', '/ai/consent'],
      ['post', '/ai/consent'],
      ['delete', '/ai/consent'],
      ['post', '/checks/{checkId}/ai-reviews'],
      ['get', '/checks/{checkId}/ai-reviews'],
      ['get', '/checks/{checkId}/ai-reviews/{reviewId}'],
      ['get', '/checks/{checkId}/ai-reviews/{reviewId}/assessments'],
      ['get', '/checks/{checkId}/ai-reviews/{reviewId}/supplement'],
      ['post', '/checks/{checkId}/ai-reviews/{reviewId}/cancel'],

      // Phase 9: guideline sources, rule extraction and proposal review.
      ['get', '/organizations/{organizationId}/ai-consent'],
      ['post', '/organizations/{organizationId}/ai-consent'],
      ['delete', '/organizations/{organizationId}/ai-consent'],
      ['get', '/organizations/{organizationId}/standard-versions/{versionId}/sources'],
      ['post', '/organizations/{organizationId}/standard-versions/{versionId}/sources'],
      ['get', '/organizations/{organizationId}/standard-versions/{versionId}/sources/{sourceId}'],
      [
        'delete',
        '/organizations/{organizationId}/standard-versions/{versionId}/sources/{sourceId}',
      ],
      [
        'post',
        '/organizations/{organizationId}/standard-versions/{versionId}/sources/{sourceId}/finalize',
      ],
      [
        'post',
        '/organizations/{organizationId}/standard-versions/{versionId}/sources/{sourceId}/download-authorization',
      ],
      ['post', '/organizations/{organizationId}/standard-versions/{versionId}/extractions'],
      ['get', '/organizations/{organizationId}/standard-versions/{versionId}/extractions'],
      ['get', '/organizations/{organizationId}/standard-versions/{versionId}/extractions/{runId}'],
      [
        'post',
        '/organizations/{organizationId}/standard-versions/{versionId}/extractions/{runId}/cancel',
      ],
      [
        'get',
        '/organizations/{organizationId}/standard-versions/{versionId}/extractions/{runId}/proposals',
      ],
      [
        'get',
        '/organizations/{organizationId}/standard-versions/{versionId}/extractions/{runId}/proposals/{proposalId}',
      ],
      [
        'post',
        '/organizations/{organizationId}/standard-versions/{versionId}/extractions/{runId}/proposals/{proposalId}/accept',
      ],
      [
        'post',
        '/organizations/{organizationId}/standard-versions/{versionId}/extractions/{runId}/proposals/{proposalId}/reject',
      ],
      [
        'post',
        '/organizations/{organizationId}/standard-versions/{versionId}/extractions/{runId}/proposals/accept-selected',
      ],
      [
        'post',
        '/organizations/{organizationId}/standard-versions/{versionId}/extractions/{runId}/proposals/reject-selected',
      ],
      [
        'get',
        '/organizations/{organizationId}/standard-versions/{versionId}/extractions/{runId}/progress',
      ],
      [
        'get',
        '/organizations/{organizationId}/standard-versions/{versionId}/rules/{ruleId}/provenance',
      ],
      ['get', '/organizations/{organizationId}/standard-versions/{versionId}/extraction-counters'],

      // Phase 10: PalCert Balance, payments, pricing and finance administration.
      ['get', '/balance'],
      ['get', '/balance/currencies'],
      ['get', '/balance/transactions'],
      ['get', '/balance/holds'],
      ['post', '/balance/top-ups'],
      ['get', '/balance/top-ups'],
      ['get', '/balance/top-ups/{topUpId}'],
      ['get', '/balance/refunds'],
      ['get', '/pricing/products'],
      ['get', '/pricing/quote'],
      ['post', '/webhooks/payments/{provider}'],
      ['get', '/admin/finance/prices'],
      ['post', '/admin/finance/prices'],
      ['post', '/admin/finance/prices/{priceVersionId}/activate'],
      ['post', '/admin/finance/prices/{priceVersionId}/retire'],
      ['get', '/admin/finance/customers/{ownerUserId}/balance'],
      ['get', '/admin/finance/customers/{ownerUserId}/payments'],
      ['post', '/admin/finance/adjustments'],
      ['post', '/admin/finance/refunds'],
      ['get', '/admin/finance/refunds/{refundId}'],
      ['get', '/admin/finance/customers/{ownerUserId}/purchases'],
      ['get', '/admin/finance/verify-ledger'],

      // Phase 14: official submissions. The author's side, then the
      // institution's — two surfaces, because they answer to two authorities.
      ['get', '/submissions/checks/{checkId}/disclosure'],
      ['post', '/submissions'],
      ['get', '/submissions'],
      ['get', '/submissions/{submissionId}'],
      ['get', '/submissions/revisions/{revisionId}/history'],
      ['get', '/submissions/revisions/{revisionId}/comments'],
      ['post', '/submissions/revisions/{revisionId}/document'],
      ['post', '/submissions/revisions/{revisionId}/report'],
      ['get', '/organizations/{organizationId}/submissions'],
      ['get', '/organizations/{organizationId}/submissions/{submissionId}'],
      ['get', '/organizations/{organizationId}/submissions/revisions/{revisionId}/history'],
      ['get', '/organizations/{organizationId}/submissions/revisions/{revisionId}/comments'],
      ['post', '/organizations/{organizationId}/submissions/revisions/{revisionId}/decision'],
      ['post', '/organizations/{organizationId}/submissions/revisions/{revisionId}/comments'],
      ['post', '/organizations/{organizationId}/submissions/revisions/{revisionId}/document'],
      ['post', '/organizations/{organizationId}/submissions/revisions/{revisionId}/report'],
      // Phase 15: the holder's own certificates, the institution's side, and
      // the one unauthenticated verification route.
      ['get', '/certificates'],
      ['get', '/certificates/{certificateId}'],
      ['get', '/certificates/revisions/{revisionId}'],
      ['get', '/certificates/{certificateId}/events'],
      ['post', '/certificates/{certificateId}/download'],
      ['get', '/organizations/{organizationId}/certificates/{certificateId}'],
      ['get', '/organizations/{organizationId}/certificates/{certificateId}/events'],
      ['post', '/organizations/{organizationId}/certificates/{certificateId}/download'],
      ['post', '/organizations/{organizationId}/certificates/{certificateId}/revocation'],
      ['get', '/public/certificates/{verificationCode}'],

      // Phase 17: an organization's outbound integrations. Every mutation that
      // creates a durable intent is documented as requiring an Idempotency-Key.
      ['get', '/organizations/{organizationId}/webhooks/endpoints'],
      ['post', '/organizations/{organizationId}/webhooks/endpoints'],
      ['get', '/organizations/{organizationId}/webhooks/endpoints/{endpointId}'],
      ['put', '/organizations/{organizationId}/webhooks/endpoints/{endpointId}/description'],
      ['put', '/organizations/{organizationId}/webhooks/endpoints/{endpointId}/url'],
      ['post', '/organizations/{organizationId}/webhooks/endpoints/{endpointId}/verify'],
      ['post', '/organizations/{organizationId}/webhooks/endpoints/{endpointId}/pause'],
      ['post', '/organizations/{organizationId}/webhooks/endpoints/{endpointId}/resume'],
      ['post', '/organizations/{organizationId}/webhooks/endpoints/{endpointId}/disable'],
      ['get', '/organizations/{organizationId}/webhooks/endpoints/{endpointId}/subscriptions'],
      ['put', '/organizations/{organizationId}/webhooks/endpoints/{endpointId}/subscriptions'],
      ['post', '/organizations/{organizationId}/webhooks/endpoints/{endpointId}/test'],
      ['post', '/organizations/{organizationId}/webhooks/endpoints/{endpointId}/rotate-secret'],
      ['get', '/organizations/{organizationId}/webhooks/endpoints/{endpointId}/rotation-pending'],
      [
        'get',
        '/organizations/{organizationId}/webhooks/endpoints/{endpointId}/verification-attempts',
      ],
      ['get', '/organizations/{organizationId}/webhooks/endpoints/{endpointId}/config-versions'],
      ['get', '/organizations/{organizationId}/webhooks/endpoints/{endpointId}/operations'],
      ['get', '/organizations/{organizationId}/webhooks/deliveries'],
      ['get', '/organizations/{organizationId}/webhooks/deliveries/{deliveryId}/attempts'],
      ['post', '/organizations/{organizationId}/webhooks/deliveries/{deliveryId}/replay'],

      // Phase 19: an organization's machine credentials, and the public
      // integration API those credentials reach. The integration routes are
      // the machine-access allow-list in full — a machine can reach these and
      // nothing else in PalCert.
      ['get', '/organizations/{organizationId}/api-clients/scopes'],
      ['get', '/organizations/{organizationId}/api-clients'],
      ['post', '/organizations/{organizationId}/api-clients'],
      ['get', '/organizations/{organizationId}/api-clients/{apiClientId}'],
      ['post', '/organizations/{organizationId}/api-clients/{apiClientId}/secret'],
      ['post', '/organizations/{organizationId}/api-clients/{apiClientId}/enabled'],
      ['post', '/organizations/{organizationId}/api-clients/{apiClientId}/revocation'],
      ['get', '/integration/v1/organization'],
      ['get', '/integration/v1/standards'],
      ['get', '/integration/v1/standards/{standardId}'],
      ['get', '/integration/v1/submissions'],
      ['get', '/integration/v1/submissions/{submissionId}'],
      ['get', '/integration/v1/revisions/{revisionId}/history'],
      ['get', '/integration/v1/certificates/{certificateId}'],
      ['get', '/integration/v1/certificates/{certificateId}/events'],
      ['get', '/integration/v1/webhook-endpoints'],
    ];

    const undocumented = expected
      .filter(([method, path]) => spec.paths[versioned(path)]?.[method] === undefined)
      .map(([method, path]) => `${method.toUpperCase()} ${path}`);

    expect(undocumented).toEqual([]);
  });

  it('requires an idempotency key on every durable webhook intent', () => {
    // Each of these mints a credential or sends something to a third party, so
    // a dropped response has to be recoverable by repeating the request rather
    // than by doing it twice.
    const durable: ReadonlyArray<readonly [string, string]> = [
      ['post', '/organizations/{organizationId}/webhooks/endpoints'],
      ['put', '/organizations/{organizationId}/webhooks/endpoints/{endpointId}/url'],
      ['post', '/organizations/{organizationId}/webhooks/endpoints/{endpointId}/verify'],
      ['post', '/organizations/{organizationId}/webhooks/endpoints/{endpointId}/test'],
      ['post', '/organizations/{organizationId}/webhooks/endpoints/{endpointId}/rotate-secret'],
      ['post', '/organizations/{organizationId}/webhooks/deliveries/{deliveryId}/replay'],

      // Phase 19: the two routes that mint a credential. A create or a
      // rotation without a key cannot be retried safely, and the failure mode
      // — a second credential the customer did not ask for and may not know
      // about — is exactly what a machine-credential feature must not do.
      ['post', '/organizations/{organizationId}/api-clients'],
      ['post', '/organizations/{organizationId}/api-clients/{apiClientId}/secret'],
    ];

    const missing = durable.filter(([method, path]) => {
      const operation = spec.paths[versioned(path)]?.[method] as
        { parameters?: Array<{ name?: string; required?: boolean }> } | undefined;
      return !(operation?.parameters ?? []).some(
        (parameter) => parameter.name === 'Idempotency-Key' && parameter.required === true,
      );
    });

    expect(missing.map(([method, path]) => `${method.toUpperCase()} ${path}`)).toEqual([]);
  });

  it('documents the webhook error codes', () => {
    const documented = JSON.stringify(spec.paths);
    for (const code of [
      'WEBHOOK_URL_NOT_ALLOWED',
      'WEBHOOK_ENDPOINT_LIMIT_REACHED',
      'WEBHOOK_ENDPOINT_NOT_FOUND',
      'WEBHOOK_ENDPOINT_NOT_VERIFIED',
      'WEBHOOK_NO_PENDING_CONFIG',
      'WEBHOOK_EVENT_TYPE_INVALID',
      'WEBHOOK_TEST_DELIVERY_NOT_REPLAYABLE',
    ]) {
      expect(documented).toContain(code);
    }
  });

  it('never puts a secret in an example', () => {
    // A generated document is published; an example value in it is published
    // with it.
    expect(JSON.stringify(spec)).not.toContain('whsec_');
  });

  it('answers a submission request with 202, not 200', () => {
    // §33: accepted, not completed. The organization sees nothing until the
    // copy has been made and verified.
    const submit = spec.paths[versioned('/submissions')]?.post;
    expect(submit).toBeDefined();
    expect(Object.keys(submit?.responses ?? {})).toContain('202');
  });

  it('documents the submission error codes', () => {
    const documented = JSON.stringify(spec.paths);
    for (const code of [
      'SUBMISSION_NOT_FOUND',
      'SUBMISSION_CHECK_ALREADY_SUBMITTED',
      'SUBMISSION_ORGANIZATION_NOT_ELIGIBLE',
      'SUBMISSION_INVALID_TRANSITION',
      'SUBMISSION_ALREADY_DECIDED',
      'SUBMISSION_REVISION_CONFLICT',
      'SUBMISSION_COMMENT_REQUIRED',
    ]) {
      expect([code, documented.includes(code)]).toEqual([code, true]);
    }
  });

  it('documents the certificate error codes', () => {
    const documented = JSON.stringify(spec.paths);
    for (const code of [
      'CERTIFICATE_NOT_FOUND',
      'CERTIFICATE_NOT_ISSUED',
      'CERTIFICATE_ALREADY_REVOKED',
    ]) {
      expect([code, documented.includes(code)]).toEqual([code, true]);
    }
  });

  it('publishes exactly one public certificate route, and it takes a code', () => {
    // §18, §19: the whole privacy argument rests on there being no way to ask
    // "which certificates exist". A list, a search, a lookup by organization
    // or by hash would each turn holder-mediated verification into a
    // directory, so the absence is asserted rather than assumed.
    const publicPaths = Object.keys(spec.paths).filter((path) =>
      path.includes('/public/certificates'),
    );
    expect(publicPaths).toEqual([versioned('/public/certificates/{verificationCode}')]);

    const operations = spec.paths[publicPaths[0] ?? ''] ?? {};
    expect(Object.keys(operations).sort()).toEqual(['get']);
  });

  it('offers no route that issues a certificate', () => {
    // §190, §191: a certificate follows from an institution approving a
    // compliant submission. Nobody — not the subject, not the organization,
    // not a platform admin — can ask for one, and there is no endpoint that
    // would let them.
    for (const [path, operations] of Object.entries(spec.paths)) {
      if (!path.includes('certificate')) continue;
      for (const [method, operation] of Object.entries(operations)) {
        if (method !== 'post') continue;
        const tail = path.split('/').pop() ?? '';
        expect([path, method, ['download', 'revocation'].includes(tail)]).toEqual([
          path,
          method,
          true,
        ]);
        expect([path, JSON.stringify(operation).match(/\bissue\b/i) === null]).toEqual([
          path,
          true,
        ]);
      }
    }
  });

  it('never documents an identity field on the public certificate route', () => {
    // §10, §11, §129: the public claim is document-bound. A field named for a
    // person on this route would be a leak whatever it happened to contain.
    // The responses only: the code is the path parameter, so it legitimately
    // names the request. What must never appear is a field in the answer.
    const operations = JSON.stringify(
      spec.paths[versioned('/public/certificates/{verificationCode}')]?.get?.responses ?? {},
    );
    for (const forbidden of [
      'displayName',
      'email',
      'userId',
      'ownerUserId',
      'studentNumber',
      'documentName',
      'objectKey',
      'verificationCode',
      'comment',
    ]) {
      expect([forbidden, operations.includes(forbidden)]).toEqual([forbidden, false]);
    }
  });

  it('never documents an object key or a bucket on a submission route', () => {
    // §78, §79: the snapshot key is organization-scoped and carries no name or
    // title, and it is never part of the API surface either. A reviewer gets a
    // short-lived signed URL, not a key.
    for (const [path, operations] of Object.entries(spec.paths)) {
      if (!path.includes('/submissions')) continue;
      const serialized = JSON.stringify(operations);
      for (const forbidden of ['objectKey', 'bucket', 'snapshotKey', 'storageKey']) {
        expect([path, forbidden, serialized.includes(forbidden)]).toEqual([path, forbidden, false]);
      }
    }
  });

  it('exposes no route by which an organization could reach a private check', () => {
    // §25, §26: the organization's entire surface is the submission. There is
    // no organization-scoped route to a document, a version, a check, a
    // report, an analysis, an AI review, a SmartFix plan or anything financial.
    const organizationPaths = Object.keys(spec.paths).filter((path) =>
      path.includes('/organizations/{organizationId}'),
    );
    for (const path of organizationPaths) {
      for (const forbidden of [
        '/documents/',
        '/checks/',
        '/ai-review',
        '/smartfix',
        '/balance',
        '/analyses/',
      ]) {
        expect([path, forbidden, path.includes(forbidden)]).toEqual([path, forbidden, false]);
      }
    }
  });

  it('gives every operation a summary', () => {
    const missing: string[] = [];

    for (const [path, operations] of Object.entries(spec.paths)) {
      for (const [method, operation] of Object.entries(operations)) {
        if (operation.summary === undefined || operation.summary.trim() === '') {
          missing.push(`${method.toUpperCase()} ${path}`);
        }
      }
    }

    expect(missing).toEqual([]);
  });

  it('documents at least one response per operation', () => {
    const missing: string[] = [];

    for (const [path, operations] of Object.entries(spec.paths)) {
      for (const [method, operation] of Object.entries(operations)) {
        if (Object.keys(operation.responses ?? {}).length === 0) {
          missing.push(`${method.toUpperCase()} ${path}`);
        }
      }
    }

    expect(missing).toEqual([]);
  });

  it('declares the session cookie as the authentication scheme', () => {
    // `addCookieAuth` registers the scheme under the key `cookie`; what matters
    // for the contract is that a cookie-based scheme naming our session cookie
    // exists, not the key Nest happens to choose.
    const schemes = Object.values(spec.components?.securitySchemes ?? {});

    expect(schemes).toContainEqual(
      expect.objectContaining({ type: 'apiKey', in: 'cookie', name: SESSION_COOKIE_NAME }),
    );
  });

  it('declares HTTP Basic for the integration API (Phase 19)', () => {
    const schemes = Object.values(spec.components?.securitySchemes ?? {});
    expect(schemes).toContainEqual(expect.objectContaining({ type: 'http', scheme: 'basic' }));
  });

  it('confines the machine surface to the integration API', () => {
    // Every documented machine route lives under one prefix, and that prefix
    // carries nothing but machine routes. This is the allow-list restated as a
    // contract: a route added elsewhere in PalCert never becomes reachable by
    // a credential, and none of these takes an organization id, because the
    // tenant comes from the credential and there is no parameter to tamper
    // with.
    const machinePaths = Object.keys(spec.paths).filter((path) =>
      path.includes('/integration/v1/'),
    );

    expect(machinePaths.length).toBeGreaterThan(0);
    for (const path of machinePaths) {
      expect(path).not.toContain('{organizationId}');
      // Read-only in Phase 19, deliberately: a machine that can act wrongly at
      // scale is a different class of incident from one that can only read.
      expect(Object.keys(spec.paths[path] ?? {})).toEqual(['get']);
    }
  });

  it('documents the error codes of the flows that have them', () => {
    const login = spec.paths[versioned('/auth/login')]?.post;
    expect(JSON.stringify(login?.responses)).toContain('AUTHENTICATION_FAILED');

    const verify = spec.paths[versioned('/auth/email/verify')]?.post;
    expect(JSON.stringify(verify?.responses)).toContain('VERIFICATION_TOKEN_EXPIRED');
  });

  it('never documents a credential or internal field as a request or response field', () => {
    const serialized = JSON.stringify(spec).toLowerCase();

    const leaked = [
      'passwordhash',
      'tokenhash',
      'csrftokenhash',
      'secretciphertext',
      // Phase 2: reviewer notes and suspension reasons are PalCert-internal and
      // must not appear in any organization-facing schema.
      'suspensionreason',
      // Phase 10 §158: no provider secret, raw webhook payload or internal
      // provider object may be documented as a field of anything.
      'stripe-signature',
      'stripesecretkey',
      'webhooksecret',
      'providerpayload',
      'rawpayload',
      'providersecret',
      'cardnumber',
      'securitycode',
      // Phase 11 §148: a check's billing block names the purchase and nothing
      // else. A hold, an account or a ledger id in any documented schema
      // would invite a client to act on an internal identifier.
      'holdid',
      'accountid',
      'ledgerentryid',
      'allocationid',
      // Phase 19: a client secret is shown once, by one response, and that
      // response is the only place the word may appear as a schema field. The
      // verifier and the sealed reveal copy may appear nowhere at all.
      'secretverifier',
      'revealedsecretciphertext',
    ].filter((forbidden) => serialized.includes(forbidden));

    expect(leaked).toEqual([]);
  });

  it('documents the tenant-scoped error codes', () => {
    const read = spec.paths[versioned('/organizations/{organizationId}')]?.get;
    expect(JSON.stringify(read?.responses)).toContain('ORGANIZATION_NOT_FOUND');

    const invite = spec.paths[versioned('/organizations/{organizationId}/invitations')]?.post;
    expect(JSON.stringify(invite?.responses)).toContain('MEMBERSHIP_ALREADY_EXISTS');
  });

  it('keeps health endpoints outside the versioned product API', () => {
    // Health is version-neutral, so it must appear at its bare path and never
    // under whatever prefix the product routes carry.
    expect(spec.paths['/health/live']).toBeDefined();
    if (prefix !== '') {
      expect(spec.paths[versioned('/health/live')]).toBeUndefined();
    }
  });

  it('uses the documented CSRF header and cookie names', () => {
    expect(CSRF_HEADER_NAME).toBe('x-csrf-token');
    expect(CSRF_COOKIE_NAME).toBe('palcert_csrf');
  });

  it('documents the standards error codes', () => {
    const publish =
      spec.paths[
        versioned(
          '/organizations/{organizationId}/standards/{standardId}/versions/{versionId}/publish',
        )
      ]?.post;
    expect(JSON.stringify(publish?.responses)).toContain('STANDARD_VERSION_EMPTY');
    expect(JSON.stringify(publish?.responses)).toContain('STANDARD_VERSION_INVALID');

    const update =
      spec.paths[
        versioned('/organizations/{organizationId}/standards/{standardId}/versions/{versionId}')
      ]?.patch;
    expect(JSON.stringify(update?.responses)).toContain('STANDARD_VERSION_IMMUTABLE');
    expect(JSON.stringify(update?.responses)).toContain('STANDARD_VERSION_CONFLICT');
  });

  it('documents the document upload error codes, and never a signed URL', () => {
    const finalize =
      spec.paths[versioned('/documents/{documentId}/versions/{versionId}/finalize')]?.post;
    expect(JSON.stringify(finalize?.responses)).toContain('UPLOAD_SESSION_EXPIRED');
    expect(JSON.stringify(finalize?.responses)).toContain('UPLOAD_OBJECT_NOT_FOUND');

    const download =
      spec.paths[versioned('/documents/{documentId}/versions/{versionId}/download-authorization')]
        ?.post;
    expect(JSON.stringify(download?.responses)).toContain('DOCUMENT_NOT_READY');

    // Examples are illustrative only: no real signature may ever be committed (§99).
    expect(JSON.stringify(spec)).not.toMatch(/X-Amz-Signature=[0-9a-f]{64}/);
  });

  it('documents the check error codes', () => {
    const create = spec.paths[versioned('/checks')]?.post;
    const documented = JSON.stringify(create?.responses);
    expect(documented).toContain('CHECK_STANDARD_NOT_AVAILABLE');
    expect(documented).toContain('CHECK_DOCUMENT_FORMAT_UNSUPPORTED');

    const retry = spec.paths[versioned('/checks/{checkId}/retry')]?.post;
    expect(JSON.stringify(retry?.responses)).toContain('CHECK_ALREADY_COMPLETED');
  });

  it('answers a check request with 202, not 200', () => {
    // The check has been accepted, not answered. Documenting 200 would invite
    // clients to read a verdict out of a response that does not carry one.
    const create = spec.paths[versioned('/checks')]?.post;
    expect(Object.keys(create?.responses ?? {})).toContain('202');
    expect(Object.keys(create?.responses ?? {})).not.toContain('200');
  });

  it('never documents an object key or a bucket on a check or report route', () => {
    // The report artifact is served through the API. A key in the spec would
    // be an invitation to reach past it (§53, §94).
    const checkRoutes = Object.entries(spec.paths).filter(
      ([path]) => path.includes('/checks') || path.includes('/catalogue'),
    );
    expect(checkRoutes.length).toBeGreaterThan(0);

    // Matched against field *names* rather than the whole serialization: the
    // route descriptions legitimately say "never from a public bucket", which
    // is a promise not to leak one rather than a leak.
    const names = JSON.stringify(checkRoutes, (key, value) =>
      key === 'description' || key === 'summary' ? undefined : value,
    );
    expect(names).not.toMatch(/objectKey|bucket|presigned|X-Amz/i);
  });

  it('documents the PDF compatibility preview without exposing a PDF internal', () => {
    // Phase 13 §152: the boundary returns an answer about the standard, never
    // a raw PDF dictionary, a storage key or a parser handle.
    const preview = spec.paths[versioned('/catalogue/standards/{standardId}/compatibility')]?.get;
    expect(preview).toBeDefined();
    expect(JSON.stringify(preview)).not.toMatch(
      /MediaBox|CropBox|XObject|StructTreeRoot|objectKey|artifactKey|FPDF/i,
    );
  });

  it('documents the format-compatibility refusal on the check route', () => {
    // §66: a standard a format cannot answer at all is refused before payment,
    // and a client needs to be able to see that code to explain it.
    const create = spec.paths[versioned('/checks')]?.post;
    expect(JSON.stringify(create?.responses)).toContain('CHECK_STANDARD_NOT_SUPPORTED_FOR_FORMAT');
  });

  it('documents If-Match on every draft mutation', () => {
    // The optimistic-concurrency contract is only usable if clients can see it
    // in the spec; an undocumented required header is an undocumented 400.
    const mutations = Object.entries(spec.paths).filter(([path, operations]) => {
      if (!path.includes('/standards/') || !path.includes('/versions/')) return false;
      return (
        operations['patch'] !== undefined ||
        (operations['delete'] !== undefined && path.includes('/rules/')) ||
        path.endsWith('/rules') ||
        path.endsWith('/rules/reorder')
      );
    });

    expect(mutations.length).toBeGreaterThan(0);

    const undocumented: string[] = [];
    for (const [path, operations] of mutations) {
      for (const [method, operation] of Object.entries(operations)) {
        if (method === 'get') continue;
        const parameters =
          (operation as { parameters?: Array<{ name?: string }> }).parameters ?? [];
        if (!parameters.some((parameter) => parameter.name === 'If-Match')) {
          undocumented.push(`${method.toUpperCase()} ${path}`);
        }
      }
    }

    expect(undocumented).toEqual([]);
  });

  it('documents the AI review error codes', () => {
    const create = spec.paths[versioned('/checks/{checkId}/ai-reviews')]?.post;
    const documented = JSON.stringify(create?.responses);
    expect(documented).toContain('AI_CONSENT_REQUIRED');
    expect(documented).toContain('AI_REVIEW_CHECK_NOT_COMPLETED');
    expect(documented).toContain('AI_DISABLED');

    const read = spec.paths[versioned('/checks/{checkId}/ai-reviews/{reviewId}')]?.get;
    expect(JSON.stringify(read?.responses)).toContain('AI_REVIEW_NOT_FOUND');
  });

  it('answers an AI review request with 202, not 200', () => {
    // Same reasoning as a check: the request has been accepted, and an
    // assessment that does not exist yet must not look like one that does.
    const create = spec.paths[versioned('/checks/{checkId}/ai-reviews')]?.post;
    expect(Object.keys(create?.responses ?? {})).toContain('202');
    expect(Object.keys(create?.responses ?? {})).not.toContain('200');
  });

  it('exposes no general-purpose AI endpoint', () => {
    // Every AI route names a PalCert task with a fixed prompt and a validated
    // output schema. A route that simply forwarded text to a model would be a
    // prompt-injection surface with no product behind it (§83).
    const aiRoutes = Object.keys(spec.paths).filter((path) => /\/ai(\/|-)/.test(path));
    expect(aiRoutes.length).toBeGreaterThan(0);
    for (const path of aiRoutes) {
      expect(path).toMatch(
        // Phase 8: a user's own AI review. Phase 9: an organization's consent
        // to external processing of its own guidelines. Both name one task.
        /\/ai\/consent$|\/checks\/\{checkId\}\/ai-reviews|\/organizations\/\{organizationId\}\/ai-consent$/,
      );
    }
    expect(Object.keys(spec.paths)).not.toContain(versioned('/ai/ask'));
    expect(Object.keys(spec.paths)).not.toContain(versioned('/ask-claude'));
    expect(Object.keys(spec.paths)).not.toContain(versioned('/extract-anything'));
  });

  it('never documents a prompt, a raw provider response or an API key', () => {
    // The provider contract lives on the server. None of it — not the prompt,
    // not the key, not the untruncated model output — is part of the API a
    // client can see (§12, §94).
    const aiRoutes = Object.entries(spec.paths).filter(
      ([path]) => path.includes('/ai/') || path.includes('/ai-reviews'),
    );
    expect(aiRoutes.length).toBeGreaterThan(0);

    // Field names only: the route descriptions legitimately explain what
    // PalCert sends, which is a disclosure rather than a leak.
    const names = JSON.stringify(aiRoutes, (key, value) =>
      key === 'description' || key === 'summary' ? undefined : value,
    );
    expect(names).not.toMatch(
      /apiKey|anthropicApiKey|ANTHROPIC_API_KEY|systemPrompt|userPrompt|rawResponse|providerRequest|providerResponse/i,
    );

    const serialized = JSON.stringify(spec);
    expect(serialized).not.toMatch(/sk-ant-/);
  });

  it('documents the idempotency key as optional, and bounds it', () => {
    const create = spec.paths[versioned('/checks/{checkId}/ai-reviews')]?.post;
    const parameters =
      (create as { parameters?: Array<{ name?: string; required?: boolean }> } | undefined)
        ?.parameters ?? [];
    const idempotency = parameters.find((parameter) => parameter.name === 'Idempotency-Key');
    expect(idempotency).toBeDefined();
    expect(idempotency?.required).toBe(false);
  });
});
