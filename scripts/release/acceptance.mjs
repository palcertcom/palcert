#!/usr/bin/env node
/**
 * Release acceptance: PalCert's critical workflows, driven over HTTP against a
 * deployed release (Phase 20 Checkpoint 9).
 *
 *   BASE=https://staging.example.org PROJECT=palcert-staging \
 *     node scripts/release/acceptance.mjs --out acceptance.json
 *
 * `staging-smoke.sh` proves a deployment is *wired*: readiness, identity,
 * migrations, the proxy. It does not prove anyone can use it. Checkpoint 20.9
 * found the difference the hard way: the release stack passed every smoke and
 * could not store a single document -- uploads were signed for an unpublished
 * origin, and the object store refused the encryption production requires.
 * Nothing had ever pushed a document through the deployed images.
 *
 * This does, through the published surface only, as the people who use
 * PalCert would:
 *
 *   operator     bootstrap the first administrator (the documented CLI), who
 *                enrolls MFA and grants a separate finance role
 *   finance      sets the check price and credits the author (audited
 *                adjustment -- the path that needs no payment provider)
 *   institution  requests verification, which the administrator approves;
 *                publishes a DOCX standard and a PDF standard
 *   author       uploads a DOCX and a PDF (presigned PUT through the proxy),
 *                buys a check of each, reads the reports, submits one
 *   institution  reviews and approves; a certificate is issued
 *   anyone       verifies the certificate publicly, by its code
 *   integration  an API client reads the submission and the certificate;
 *                a webhook endpoint is registered under the keyring
 *
 * **Two documented shortcuts, both out-of-band hops a test cannot make:**
 *
 *  - Email verification. A release stack runs with
 *    `NOTIFICATION_EMAIL_PROVIDER=disabled` (the correct default until a
 *    provider is configured), so the verification token is delivered nowhere
 *    and stored only as a hash. Registration goes through the real endpoint;
 *    the verification *timestamp* is then set with one admin SQL statement,
 *    exactly as `qa/seed-fixture.mjs` does. The verification flow itself is
 *    covered by `auth-lifecycle.e2e-spec.ts`.
 *  - The first administrator, which by design has no HTTP path at all
 *    (ADR-0015): `node dist/cli/bootstrap-admin.js`, run in the API
 *    container, as `docs/security/admin-bootstrap.md` prescribes.
 *
 * Payments: the top-up path needs a reachable payment provider, which a
 * rehearsal does not call. Credit arrives as an audited finance adjustment,
 * which is a production path in its own right (Phase 10 §76).
 *
 * The summary written to `--out` holds identifiers, hashes and verdicts. No
 * password, session, client secret, signing secret or verification code.
 *
 * ## Proving the same data again, later
 *
 *   … acceptance.mjs --out before.json --state state.json      (build)
 *   … acceptance.mjs --verify state.json --out after.json       (re-prove)
 *
 * `--state` writes what a second run needs to ask the *same* questions of a
 * restored or upgraded installation: the throwaway passwords, the enrolled
 * TOTP secrets, the API client's secret and the certificate's verification
 * code. It is created mode 0600 and belongs beside the environment's secrets,
 * never in a report. `--verify` then signs the same people in and checks that
 * every document is byte-identical, every report hash unchanged, the balance
 * the same, the certificate still verifies publicly, the API client still
 * authenticates, the webhook URL still decrypts under the keyring, MFA still
 * works, tenancy still holds -- and that new work still flows through the
 * worker.
 */
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';

const BASE = (process.env.BASE ?? 'https://localhost:8443').replace(/\/$/, '');
const PROJECT = process.env.PROJECT ?? 'palcert-release';
const argument = (name) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
};
const OUT = argument('--out');
const STATE_OUT = argument('--state');
const VERIFY = argument('--verify');
const API = `${BASE}/api/v1`;
const RUN = randomBytes(4).toString('hex');
// Generated per run and never written anywhere: every account this creates is
// a throwaway on a rehearsal deployment.
const PASSWORD = `acceptance-${randomBytes(12).toString('base64url')}`;

const summary = { base: BASE, run: RUN, startedAt: new Date().toISOString(), steps: [] };
let failures = 0;

function report(ok, what, detail = '') {
  if (!ok) failures += 1;
  summary.steps.push({ ok, what, ...(detail === '' ? {} : { detail }) });
  console.log(`acceptance: ${ok ? 'ok  ' : 'FAIL'} ${what}${detail === '' ? '' : `  ${detail}`}`);
}

function fatal(what, detail) {
  report(false, what, detail);
  finish();
}

function finish() {
  summary.finishedAt = new Date().toISOString();
  summary.failures = failures;
  if (OUT !== null) writeFileSync(OUT, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(
    `acceptance: ${failures === 0 ? 'all workflows accepted' : `${failures} step(s) failed`}`,
  );
  process.exit(failures === 0 ? 0 : 65);
}

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

function container(service) {
  return `${PROJECT}-${service}-1`;
}

function sql(statement) {
  return execFileSync(
    'docker',
    ['exec', container('postgres'), 'psql', '-U', 'palcert', '-d', 'palcert', '-tAqc', statement],
    { encoding: 'utf8' },
  ).trim();
}

/** One person's browser: a cookie jar, and the CSRF echo PalCert requires. */
class Actor {
  constructor(label) {
    this.label = label;
    this.cookies = new Map();
  }

  absorb(headers) {
    for (const entry of headers.getSetCookie?.() ?? []) {
      const [pair] = entry.split(';');
      const split = pair.indexOf('=');
      const name = pair.slice(0, split).trim();
      const value = pair.slice(split + 1).trim();
      if (value === '' || /max-age=0|expires=thu, 01 jan 1970/i.test(entry)) {
        this.cookies.delete(name);
      } else this.cookies.set(name, value);
    }
  }

  async call(method, path, { body, headers = {}, raw = false } = {}) {
    const unsafe = !['GET', 'HEAD'].includes(method);
    const response = await fetch(path.startsWith('http') ? path : `${API}${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        Origin: BASE,
        ...(this.cookies.size === 0
          ? {}
          : { Cookie: [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ') }),
        ...(unsafe && this.cookies.has('palcert_csrf')
          ? { 'x-csrf-token': this.cookies.get('palcert_csrf') }
          : {}),
        ...(unsafe ? { 'Idempotency-Key': randomUUID() } : {}),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    this.absorb(response.headers);
    if (raw) return response;
    const text = await response.text();
    let parsed = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      // not JSON; kept as text
    }
    return { status: response.status, body: parsed, headers: response.headers };
  }

  get(path, options) {
    return this.call('GET', path, options);
  }

  post(path, body = {}, options = {}) {
    return this.call('POST', path, { ...options, body });
  }

  patch(path, body = {}, options = {}) {
    return this.call('PATCH', path, { ...options, body });
  }
}

function expect(response, statuses, what) {
  const allowed = Array.isArray(statuses) ? statuses : [statuses];
  if (!allowed.includes(response.status)) {
    fatal(what, `${response.status} ${JSON.stringify(response.body).slice(0, 300)}`);
  }
  return response.body;
}

async function until(what, probe, { timeoutMs = 180_000, everyMs = 2_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await probe();
    if (last.done) return last.value;
    await new Promise((resolve) => setTimeout(resolve, everyMs));
  }
  fatal(what, `timed out; last seen ${JSON.stringify(last?.value ?? null).slice(0, 200)}`);
  return undefined;
}

/** RFC 6238 TOTP, SHA-1, 30 s, 6 digits: what PalCert's authenticator enrolls. */
function totp(base32Secret, at = Date.now()) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const char of base32Secret.replace(/=+$/, '').toUpperCase()) {
    bits += alphabet.indexOf(char).toString(2).padStart(5, '0');
  }
  const key = Buffer.from(bits.match(/.{8}/g).map((byte) => Number.parseInt(byte, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / 30)));
  const digest = createHmac('sha1', key).update(counter).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const code = (digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(code).padStart(6, '0');
}

// ---------------------------------------------------------------------------
// Documents: the same minimal, well-formed shapes the end-to-end suites use
// (apps/api/test/support/fixtures.ts).
// ---------------------------------------------------------------------------

function crc32(buffer) {
  let crc = ~0;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const raw = Buffer.from(entry.data, 'utf8');
    const payload = deflateRawSync(raw, { level: 9 });
    const crc = crc32(raw);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    locals.push(local, payload);
    centrals.push(central);
    offset += local.length + payload.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

function minimalDocx(text) {
  return zip([
    {
      name: '[Content_Types].xml',
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
        '</Types>',
    },
    {
      name: '_rels/.rels',
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
        '</Relationships>',
    },
    {
      name: 'word/document.xml',
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
        `<w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`,
    },
  ]);
}

function minimalPdf(text) {
  const objects = [
    '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n',
    '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n',
    '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R >> endobj\n',
  ];
  const stream = `BT /F1 12 Tf 72 770 Td (${text}) Tj ET`;
  objects.push(`4 0 obj << /Length ${stream.length} >> stream\n${stream}\nendstream endobj\n`);
  let body = '%PDF-1.7\n%âãÏÓ\n';
  const offsets = [];
  for (const object of objects) {
    offsets.push(Buffer.byteLength(body, 'latin1'));
    body += object;
  }
  const xref = Buffer.byteLength(body, 'latin1');
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  body += `trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

async function register(label) {
  const actor = new Actor(label);
  actor.email = `acceptance-${label}-${RUN}@example.com`;
  const created = await actor.post('/auth/register', {
    email: actor.email,
    password: PASSWORD,
    locale: 'en',
  });
  expect(created, [200, 201, 202], `register the ${label}`);
  // The documented shortcut (see the header): the mail hop only.
  // Verifying an address is also what activates the account, so both are set.
  sql(
    `UPDATE users SET email_verified_at = COALESCE(email_verified_at, now()), status = 'ACTIVE' ` +
      `WHERE normalized_email = lower('${actor.email}')`,
  );
  return actor;
}

async function signIn(actor) {
  const login = await actor.post('/auth/login', {
    email: actor.email,
    password: actor.password ?? PASSWORD,
  });
  expect(login, 200, `sign in as the ${actor.label}`);
  if (login.body.status === 'MFA_ENROLLMENT_REQUIRED') {
    const enrollment = expect(
      await actor.post('/auth/mfa/enroll', {}),
      200,
      `${actor.label}: begin MFA enrollment`,
    );
    actor.totpSecret = enrollment.secret;
    expect(
      await actor.post('/auth/mfa/confirm', { code: totp(actor.totpSecret) }),
      200,
      `${actor.label}: confirm MFA`,
    );
  } else if (login.body.status === 'MFA_REQUIRED') {
    // A code is single-use: one already spent in this 30 s window is refused
    // as a replay, so a refusal is retried once in the next window.
    let challenge = await actor.post('/auth/mfa/challenge', { code: totp(actor.totpSecret) });
    if (challenge.status !== 200) {
      await new Promise((resolve) => setTimeout(resolve, 31_000));
      challenge = await actor.post('/auth/mfa/challenge', { code: totp(actor.totpSecret) });
    }
    expect(challenge, 200, `${actor.label}: answer the MFA challenge`);
    actor.challengedMfa = true;
  }
  const me = expect(await actor.get('/users/me'), 200, `${actor.label}: read own profile`);
  actor.userId = me.id;
  return actor;
}

// ---------------------------------------------------------------------------
// --verify: the same questions, asked of a restored or upgraded installation.
// ---------------------------------------------------------------------------

async function verify(state) {
  const ready = await (await fetch(`${BASE}/health/ready`)).json().catch(() => ({}));
  report(
    ready.status === 'ok',
    'the recovered deployment reports ready',
    `commit ${ready.release?.commit ?? '?'}`,
  );
  summary.commit = ready.release?.commit ?? null;
  summary.verifying = { run: state.run ?? null, source: state.source ?? 'acceptance' };

  const author = Object.assign(new Actor('author'), {
    email: state.author.email,
    password: state.author.password ?? state.password,
  });
  await signIn(author);

  for (const [label, document] of Object.entries(state.documents ?? {})) {
    const grant = expect(
      await author.post(
        `/documents/${document.documentId}/versions/${document.versionId}/download-authorization`,
        {},
      ),
      [200, 201],
      `authorize a download of the ${label} document`,
    );
    const bytes = Buffer.from(await (await fetch(grant.url)).arrayBuffer());
    report(sha256(bytes) === document.sha256, `the ${label} document is byte-identical`);
  }

  for (const [label, check] of Object.entries(state.checks ?? {})) {
    const read = await author.get(`/checks/${check.checkId}/report`);
    const reportHash = read.body?.reportHash ?? read.body?.report?.reportHash ?? null;
    report(
      read.status === 200 && reportHash === check.reportHash,
      `the ${label} report hash is unchanged`,
      read.status === 200 ? '' : `${read.status}`,
    );
  }

  if (state.balance !== undefined) {
    const balance = expect(await author.get('/balance'), 200, 'read the balance');
    report(
      balance.available?.minorUnits === state.balance,
      'the balance is exactly what it was',
      `${balance.available?.minorUnits} vs ${state.balance}`,
    );
  }

  if (state.certificate?.code !== undefined) {
    const anonymous = new Actor('anonymous');
    const verified = await anonymous.get(
      `/public/certificates/${encodeURIComponent(state.certificate.code)}`,
    );
    report(
      verified.status === 200 && /VALID|ISSUED|valid/i.test(JSON.stringify(verified.body)),
      'the certificate still verifies publicly by its code',
      `${verified.status}`,
    );
    const own = await author.get(`/certificates/${state.certificate.id}`);
    report(own.status === 200, 'the owner still reads the certificate', `${own.status}`);
  }

  if (state.client !== undefined) {
    const machine = await fetch(`${API}/integration/v1/submissions`, {
      headers: {
        Authorization: `Basic ${Buffer.from(`${state.client.clientId}:${state.client.clientSecret}`).toString('base64')}`,
      },
    });
    const body = await machine.text();
    report(
      machine.status === 200 && body.includes(state.certificate?.submissionId ?? ''),
      'the API client still authenticates and reads the submission',
      `${machine.status}`,
    );
  }

  if (state.registrar !== undefined) {
    const registrar = Object.assign(new Actor('registrar'), {
      email: state.registrar.email,
      password: state.registrar.password ?? state.password,
    });
    await signIn(registrar);
    const hooks = await registrar.get(`/organizations/${state.organizationId}/webhooks/endpoints`);
    report(
      hooks.status === 200 && JSON.stringify(hooks.body).includes(state.webhookHost),
      'the sealed webhook URL decrypts under the restored keyring',
      `${hooks.status}`,
    );
    // Tenancy: the institution still cannot read the author's private work.
    const [first] = Object.values(state.documents ?? {});
    if (first !== undefined) {
      const peek = await registrar.get(`/documents/${first.documentId}`);
      report(
        peek.status === 403 || peek.status === 404,
        "the institution still cannot read the author's private document",
        `${peek.status}`,
      );
    }
  }

  if (state.admin?.totpSecret !== undefined) {
    const admin = Object.assign(new Actor('administrator'), {
      email: state.admin.email,
      password: state.admin.password ?? state.password,
      totpSecret: state.admin.totpSecret,
    });
    await signIn(admin);
    report(
      admin.challengedMfa === true,
      'the administrator signs in with the enrolled second factor',
    );
  }

  // New work, not only old data: a fresh upload has to go through scanning,
  // promotion and analysis on the recovered queue, worker and object store.
  await uploadDocument(
    author,
    'after-recovery.pdf',
    minimalPdf(`After recovery ${RUN}`),
    'application/pdf',
  );
}

process.env.NODE_TLS_REJECT_UNAUTHORIZED ??= '0';

if (VERIFY !== null) {
  await verify(JSON.parse(readFileSync(VERIFY, 'utf8')));
  finish();
}

// ---------------------------------------------------------------------------
// 0. The deployment is the one we think it is.
// ---------------------------------------------------------------------------

const ready = await (await fetch(`${BASE}/health/ready`)).json().catch(() => ({}));
report(
  ready.status === 'ok',
  'the deployment reports ready',
  `commit ${ready.release?.commit ?? '?'}`,
);
summary.commit = ready.release?.commit ?? null;
summary.version = ready.version ?? null;

// ---------------------------------------------------------------------------
// 1. Staff: the first administrator, and finance as a separate person.
// ---------------------------------------------------------------------------

const admin = new Actor('administrator');
admin.email = `acceptance-admin-${RUN}@example.com`;
execFileSync(
  'docker',
  [
    'exec',
    '-e',
    `PALCERT_BOOTSTRAP_ADMIN_EMAIL=${admin.email}`,
    '-e',
    `PALCERT_BOOTSTRAP_ADMIN_PASSWORD=${PASSWORD}`,
    container('api'),
    'node',
    'dist/cli/bootstrap-admin.js',
  ],
  { stdio: 'ignore' },
);
await signIn(admin);
report(admin.totpSecret !== undefined, 'the administrator had to enroll MFA before acting');

const finance = await register('finance');
await signIn(finance);
expect(
  await admin.post(`/admin/users/${finance.userId}/roles`, { roleCode: 'PALCERT_FINANCE' }),
  [200, 201],
  'the administrator grants the finance role',
);
// A role that requires MFA takes effect on the next sign-in, which enrolls it.
finance.cookies.clear();
await signIn(finance);
report(finance.totpSecret !== undefined, 'finance had to enroll MFA once granted the role');

// ---------------------------------------------------------------------------
// 2. Pricing and credit.
// ---------------------------------------------------------------------------

const price = expect(
  await finance.post('/admin/finance/prices', {
    productCode: 'DOCUMENT_CHECK',
    currency: 'USD',
    amountMinorUnits: '300',
  }),
  [200, 201],
  'finance creates the check price',
);
expect(
  await finance.post(`/admin/finance/prices/${price.id}/activate`, {}),
  [200, 201],
  'finance activates it',
);

const author = await signIn(await register('author'));
const credit = await finance.post('/admin/finance/adjustments', {
  ownerUserId: author.userId,
  currency: 'USD',
  creditClass: 'PROMOTIONAL',
  amountMinorUnits: '5000',
  reasonCode: 'PROMOTION',
  idempotencyKey: `acceptance-${RUN}`,
  note: 'Release acceptance credit',
});
expect(credit, [200, 201], 'finance credits the author (audited adjustment)');
const balanceBefore = expect(await author.get('/balance'), 200, 'the author reads the balance');
report(true, 'the author has credit to spend', JSON.stringify(balanceBefore).slice(0, 120));

// ---------------------------------------------------------------------------
// 3. The institution: verified, with a DOCX standard and a PDF standard.
// ---------------------------------------------------------------------------

const registrar = await signIn(await register('registrar'));
const organization = expect(
  await registrar.post('/organizations', {
    type: 'UNIVERSITY',
    displayName: `Acceptance University ${RUN}`,
    legalName: `Acceptance University ${RUN}`,
    countryCode: 'PS',
    timezone: 'Asia/Hebron',
  }),
  201,
  'the registrar creates the institution',
);
const org = organization.id;
expect(
  await registrar.post(`/organizations/${org}/verification`, { note: 'Release acceptance' }),
  202,
  'the institution requests verification',
);
expect(
  await admin.post(`/admin/organizations/${org}/verification`, {
    approve: true,
    decisionReason: 'Release acceptance',
  }),
  [200, 201],
  'the administrator approves it',
);

async function publishStandard(code, rule) {
  const type = expect(
    await registrar.post(`/organizations/${org}/document-types`, {
      systemCategory: 'THESIS',
      name: `Thesis ${code}`,
    }),
    201,
    `document type for ${code}`,
  );
  const standard = expect(
    await registrar.post(`/organizations/${org}/standards`, {
      documentTypeId: type.id,
      code,
      nameEn: `Acceptance ${code}`,
      nameAr: `قبول ${code}`,
    }),
    201,
    `standard ${code}`,
  );
  const version = expect(
    await registrar.post(`/organizations/${org}/standards/${standard.id}/versions`, {
      versionLabel: '1.0',
    }),
    201,
    `draft of ${code}`,
  );
  expect(
    await registrar.post(
      `/organizations/${org}/standards/${standard.id}/versions/${version.id}/rules`,
      rule,
      { headers: { 'If-Match': `"${version.revision}"` } },
    ),
    201,
    `rule for ${code}`,
  );
  expect(
    await registrar.post(
      `/organizations/${org}/standards/${standard.id}/versions/${version.id}/publish`,
      {},
    ),
    200,
    `publish ${code}`,
  );
  expect(
    await registrar.patch(`/organizations/${org}/standards/${standard.id}/check-availability`, {
      checkAvailability: 'PUBLIC_CHECKABLE',
    }),
    200,
    `offer ${code} publicly`,
  );
  return standard.id;
}

const rule = (overrides) => ({
  evaluationMode: 'DETERMINISTIC',
  severity: 'MAJOR',
  blocking: true,
  autofix: 'NONE',
  origin: 'ORGANIZATION_POLICY',
  ...overrides,
});
const docxStandard = await publishStandard(
  `ACC.DOCX.${RUN.toUpperCase()}`,
  rule({
    ruleCode: 'MARGIN.TOP.MIN',
    category: 'MARGINS',
    scope: { kind: 'DOCUMENT', property: 'marginTop' },
    operator: 'GREATER_THAN_OR_EQUAL',
    expected: { type: 'NUMBER', number: 25 },
    unit: 'MILLIMETRE',
    tolerance: 0.5,
    titleEn: 'Top margin at least 25 mm',
    titleAr: 'الهامش العلوي 25 مم على الأقل',
  }),
);
const pdfStandard = await publishStandard(
  `ACC.PDF.${RUN.toUpperCase()}`,
  rule({
    ruleCode: 'PAGE.COUNT.MIN',
    category: 'PAGE_SETUP',
    scope: { kind: 'DOCUMENT', property: 'pageCount' },
    operator: 'GREATER_THAN_OR_EQUAL',
    expected: { type: 'NUMBER', number: 1 },
    unit: 'PAGES',
    titleEn: 'At least one page',
    titleAr: 'صفحة واحدة على الأقل',
  }),
);
report(true, 'the institution publishes a DOCX standard and a PDF standard');

// ---------------------------------------------------------------------------
// 4. The author: two documents, uploaded the way a browser uploads them.
// ---------------------------------------------------------------------------

async function uploadDocument(author, name, bytes, mimeType) {
  const document = expect(
    await author.post('/documents', { displayName: `Acceptance ${name}` }),
    201,
    `create ${name}`,
  );
  const created = expect(
    await author.post(`/documents/${document.id}/versions`, {
      originalFilename: name,
      declaredMimeType: mimeType,
      sizeBytes: bytes.length,
    }),
    201,
    `request an upload for ${name}`,
  );
  const grant = created.upload;
  const origin = new URL(grant.url).origin;
  report(
    origin === BASE,
    `${name}: the upload URL is on the deployment's own origin`,
    origin === BASE ? '' : origin,
  );
  const put = await fetch(grant.url, {
    method: grant.method ?? 'PUT',
    headers: grant.headers,
    body: new Uint8Array(bytes),
  });
  report(put.status === 200, `${name}: the bytes are stored through the proxy`, `${put.status}`);
  expect(
    await author.post(`/documents/${document.id}/versions/${created.version.id}/finalize`, {}),
    [200, 201, 202],
    `finalize ${name}`,
  );
  const version = await until(`${name} to be scanned and promoted`, async () => {
    const read = await author.get(`/documents/${document.id}/versions/${created.version.id}`);
    const status = read.body?.status;
    return {
      done: ['READY', 'REJECTED', 'FAILED'].includes(status),
      value: read.body,
    };
  });
  report(version.status === 'READY', `${name}: scanned, promoted and Ready`, version.status);
  report(
    version.sha256 === sha256(bytes),
    `${name}: PalCert's fingerprint is the uploaded bytes' SHA-256`,
  );

  // Download goes back out through the same route.
  const grantOut = expect(
    await author.post(
      `/documents/${document.id}/versions/${created.version.id}/download-authorization`,
      {},
    ),
    [200, 201],
    `authorize a download of ${name}`,
  );
  const downloaded = Buffer.from(await (await fetch(grantOut.url)).arrayBuffer());
  report(sha256(downloaded) === sha256(bytes), `${name}: the download is byte-identical`);
  return { documentId: document.id, versionId: created.version.id, sha256: version.sha256 };
}

const docx = await uploadDocument(
  author,
  'thesis.docx',
  minimalDocx(`Acceptance ${RUN}`),
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
);
const pdf = await uploadDocument(
  author,
  'thesis.pdf',
  minimalPdf(`Acceptance ${RUN}`),
  'application/pdf',
);
summary.documents = { docx, pdf };

// ---------------------------------------------------------------------------
// 5. Paid checks, one per analyzer, and their reports.
// ---------------------------------------------------------------------------

async function runCheck(label, versionId, standardId) {
  const quote = expect(
    await author.get('/pricing/quote?product=DOCUMENT_CHECK&currency=USD'),
    200,
    `${label}: quote the check`,
  );
  const created = expect(
    await author.post('/checks', {
      documentVersionId: versionId,
      standardId,
      priceQuoteId: quote.id,
    }),
    [201, 202],
    `${label}: buy the check`,
  );
  const settled = await until(`${label} check to settle`, async () => {
    const read = await author.get(`/checks/${created.id}`);
    const status = read.body?.status;
    return { done: ['COMPLETED', 'FAILED', 'CANCELLED'].includes(status), value: read.body };
  });
  report(settled.status === 'COMPLETED', `${label}: the check completes`, settled.status);
  const reportView = expect(
    await author.get(`/checks/${created.id}/report`),
    200,
    `${label}: read the report`,
  );
  const reportHash = reportView.reportHash ?? reportView.report?.reportHash ?? null;
  report(
    typeof reportHash === 'string' && /^[0-9a-f]{64}$/.test(reportHash),
    `${label}: the report carries its canonical hash`,
  );
  const artifact = await author.get(`/checks/${created.id}/report/artifact`);
  report(
    [200, 201].includes(artifact.status),
    `${label}: the report artifact is retrievable`,
    `${artifact.status}`,
  );
  return { checkId: created.id, reportHash };
}

const docxCheck = await runCheck('DOCX', docx.versionId, docxStandard);
const pdfCheck = await runCheck('PDF', pdf.versionId, pdfStandard);
summary.checks = { docx: docxCheck, pdf: pdfCheck };

const ledger = expect(await author.get('/balance'), 200, 'the author reads the balance again');
report(
  ledger.available?.minorUnits === String(5000 - 2 * 300),
  'exactly two checks were charged against the credit',
  `${ledger.available?.minorUnits}`,
);

// ---------------------------------------------------------------------------
// 6. Submission, review, certificate, public verification.
// ---------------------------------------------------------------------------

const submitted = expect(
  await author.post('/submissions', { checkId: docxCheck.checkId }),
  202,
  'the author submits the DOCX check to the institution',
);
const revisionId = submitted.id;
const submissionId = submitted.submissionId;
await until('the submission to be prepared', async () => {
  const read = await author.get(`/submissions/${submissionId}`);
  const revision = (read.body?.revisions ?? []).find((entry) => entry.id === revisionId);
  const status = revision?.processingStatus ?? read.body?.currentRevision?.processingStatus;
  return { done: status === 'READY' || status === 'FAILED', value: status ?? read.body };
});

const queue = expect(
  await registrar.get(`/organizations/${org}/submissions`),
  200,
  'the institution reads its review queue',
);
report(JSON.stringify(queue).includes(submissionId), 'the submission is in the institution queue');
for (const toStatus of ['UNDER_REVIEW', 'APPROVED']) {
  expect(
    await registrar.post(`/organizations/${org}/submissions/revisions/${revisionId}/decision`, {
      toStatus,
    }),
    [200, 201],
    `the institution moves the revision to ${toStatus}`,
  );
}

const certificate = await until(
  'the certificate to be issued',
  async () => {
    const read = await author.get(`/certificates/revisions/${revisionId}`);
    const status = read.body?.certificate?.issuanceStatus;
    return { done: status === 'ISSUED' || status === 'FAILED', value: read.body?.certificate };
  },
  { timeoutMs: 240_000 },
);
report(
  certificate.issuanceStatus === 'ISSUED',
  'a certificate is issued',
  certificate.issuanceStatus,
);
const certificateView = expect(
  await author.get(`/certificates/${certificate.id}`),
  200,
  'the author reads the certificate',
);
const code = certificateView.verificationCode;
report(typeof code === 'string' && code.length > 0, 'the owner is shown the verification code');

const pdfGrant = expect(
  await author.post(`/certificates/${certificate.id}/download`, {}),
  [200, 201],
  'authorize the certificate PDF',
);
const certificatePdf = Buffer.from(await (await fetch(pdfGrant.url)).arrayBuffer());
report(
  certificatePdf.subarray(0, 5).toString('latin1') === '%PDF-',
  'the certificate PDF downloads through the proxy',
);

const anonymous = new Actor('anonymous');
const verified = await anonymous.get(`/public/certificates/${encodeURIComponent(code)}`);
report(
  verified.status === 200 && JSON.stringify(verified.body).includes(certificate.id) === false,
  'the public verifies the certificate by code, without internal identifiers',
  `${verified.status}`,
);
report(
  /VALID|ISSUED|valid/i.test(JSON.stringify(verified.body)),
  'public verification says the certificate is valid',
);
const forged = await anonymous.get(`/public/certificates/${encodeURIComponent(`${code}x`)}`);
report(forged.status !== 200, 'a wrong code does not verify', `${forged.status}`);
summary.certificate = {
  certificateId: certificate.id,
  claimHash: certificateView.claimHash ?? null,
  submissionId,
  revisionId,
};

// ---------------------------------------------------------------------------
// 7. Integrations: an API client, and a webhook endpoint under the keyring.
// ---------------------------------------------------------------------------

const client = expect(
  await registrar.post(`/organizations/${org}/api-clients`, {
    displayName: 'Acceptance integration',
    scopes: ['submissions:read', 'certificates:read'],
  }),
  201,
  'the institution creates an API client',
);
const machine = `Basic ${Buffer.from(`${client.client.clientId}:${client.clientSecret}`).toString('base64')}`;
const integration = await fetch(`${API}/integration/v1/submissions`, {
  headers: { Authorization: machine },
});
const listed = await integration.text();
report(
  integration.status === 200 && listed.includes(submissionId),
  'the API client reads the submission',
  `${integration.status}`,
);
const certificateByMachine = await fetch(`${API}/integration/v1/certificates/${certificate.id}`, {
  headers: { Authorization: machine },
});
report(
  certificateByMachine.status === 200,
  'the API client reads the certificate',
  `${certificateByMachine.status}`,
);
const wrongSecret = await fetch(`${API}/integration/v1/submissions`, {
  headers: {
    Authorization: `Basic ${Buffer.from(`${client.client.clientId}:wrong`).toString('base64')}`,
  },
});
report(wrongSecret.status === 401, 'a wrong client secret is refused', `${wrongSecret.status}`);

const webhook = await registrar.post(`/organizations/${org}/webhooks/endpoints`, {
  description: 'Acceptance registrar hook',
  url: 'https://registrar.example/palcert-hook',
  eventTypes: [],
});
report(webhook.status === 201, 'the institution registers a webhook endpoint', `${webhook.status}`);
const hooks = expect(
  await registrar.get(`/organizations/${org}/webhooks/endpoints`),
  200,
  'the institution lists its webhook endpoints',
);
report(
  !/whsec_|"secret"\s*:/.test(JSON.stringify(hooks)),
  'the signing secret is never shown again',
);
summary.integration = { apiClientId: client.client.apiClientId ?? null, organizationId: org };

if (STATE_OUT !== null) {
  // What `--verify` needs. Credentials, so 0600 and never part of a report.
  writeFileSync(
    STATE_OUT,
    `${JSON.stringify(
      {
        source: 'acceptance',
        run: RUN,
        password: PASSWORD,
        admin: { email: admin.email, totpSecret: admin.totpSecret },
        author: { email: author.email },
        registrar: { email: registrar.email },
        organizationId: org,
        documents: { docx, pdf },
        checks: { docx: docxCheck, pdf: pdfCheck },
        balance: ledger.available?.minorUnits,
        certificate: { id: certificate.id, code, submissionId, revisionId },
        client: { clientId: client.client.clientId, clientSecret: client.clientSecret },
        webhookHost: 'registrar.example',
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
}

finish();
