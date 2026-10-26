#!/usr/bin/env node
/**
 * The account and data the browser journeys need (Phase 20 Checkpoint 8).
 *
 *   BASE=https://localhost:8543 PROJECT=palcert-c7 node qa/seed-fixture.mjs
 *
 * Everything is created through PalCert's own HTTP API — the same endpoints a
 * browser calls — so the fixture is data the product made, not rows invented
 * beside it.
 *
 * **One documented shortcut.** The release stack runs with
 * `NOTIFICATION_EMAIL_PROVIDER=disabled`, which is the correct production
 * default for a deployment that has not configured a mail provider, and it
 * means the email-verification token is never delivered anywhere a test can
 * read it — it is stored only as a hash, deliberately. So registration happens
 * through the real endpoint and the verification *timestamp* is then set with
 * one admin SQL statement. The registration form and the login flow are both
 * genuinely exercised; only the out-of-band mail hop is skipped, and the
 * verification flow itself has its own end-to-end coverage
 * (`auth-lifecycle.e2e-spec.ts`).
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const BASE = process.env.BASE ?? 'https://localhost:8543';
const PROJECT = process.env.PROJECT ?? 'palcert-c7';
const OUT = process.env.OUT ?? 'qa/.fixture.json';
const PASSWORD = 'a-correct-horse-battery-staple';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

function sql(statement) {
  return execFileSync(
    'docker',
    ['exec', `${PROJECT}-postgres-1`, 'psql', '-U', 'palcert', '-d', 'palcert', '-tAqc', statement],
    { encoding: 'utf8' },
  ).trim();
}

async function api(path, { method = 'GET', body, headers = {}, cookie } = {}) {
  const response = await fetch(`${BASE}/api/v1${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      // Every unsafe request needs an Origin the CSRF guard trusts — which is
      // itself a small proof that the guard is on in this deployment.
      Origin: BASE,
      ...(cookie === undefined ? {} : { Cookie: cookie }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: response.status, body: parsed, headers: response.headers };
}

function cookiesFrom(headers) {
  return (headers.getSetCookie?.() ?? [])
    .map((entry) => entry.split(';')[0])
    .filter((entry) => entry.startsWith('palcert_'))
    .join('; ');
}

async function register(email) {
  const created = await api('/auth/register', {
    method: 'POST',
    body: { email, password: PASSWORD, locale: 'en' },
  });
  if (![200, 201, 202, 409].includes(created.status)) {
    throw new Error(
      `register ${email} failed (${created.status}): ${JSON.stringify(created.body)}`,
    );
  }
  // The documented shortcut, and the only one.
  sql(
    `UPDATE users SET email_verified_at = COALESCE(email_verified_at, NOW()), status = 'ACTIVE' WHERE normalized_email = '${email.toLowerCase()}'`,
  );
  return sql(`SELECT id FROM users WHERE normalized_email = '${email.toLowerCase()}'`);
}

async function signIn(email) {
  const response = await api('/auth/login', {
    method: 'POST',
    body: { email, password: PASSWORD },
  });
  if (response.status !== 200) {
    throw new Error(`login ${email} failed (${response.status}): ${JSON.stringify(response.body)}`);
  }
  const cookie = cookiesFrom(response.headers);
  const csrf = /palcert_csrf=([^;]+)/.exec(cookie)?.[1];
  if (csrf === undefined) throw new Error('login returned no CSRF cookie');
  return { cookie, csrf };
}

const stamp = Date.now().toString(36);
const author = `qa-author-${stamp}@example.com`;
const registrar = `qa-registrar-${stamp}@example.com`;

const authorId = await register(author);
const registrarId = await register(registrar);
// Signed in once here as a check that the account the browser journeys will
// use actually works before they start — a fixture that looks created and
// cannot sign in wastes a whole matrix run to find out.
await signIn(author);
const registrarSession = await signIn(registrar);

// An organization, owned by the registrar. Organization-scoped screens — API
// clients, webhooks, the review queue — all hang off this.
const organization = await api('/organizations', {
  method: 'POST',
  cookie: registrarSession.cookie,
  headers: { 'x-csrf-token': registrarSession.csrf },
  body: {
    type: 'UNIVERSITY',
    displayName: 'QA University',
    legalName: 'QA University Legal Entity',
    countryCode: 'PS',
    timezone: 'Asia/Hebron',
  },
});
if (organization.status !== 201) {
  throw new Error(
    `organization creation failed (${organization.status}): ${JSON.stringify(organization.body)}`,
  );
}
const organizationId = organization.body.id ?? organization.body.organization?.id;

const fixture = {
  createdAt: new Date().toISOString(),
  base: BASE,
  note: 'Created through PalCert’s own API. Only the email-verification timestamp is set directly, because this deployment has email disabled by design.',
  password: PASSWORD,
  author: { email: author, userId: authorId },
  registrar: { email: registrar, userId: registrarId, organizationId },
};

writeFileSync(OUT, `${JSON.stringify(fixture, null, 2)}\n`, { mode: 0o600 });
console.log(`seed-fixture: author ${author}`);
console.log(`seed-fixture: registrar ${registrar} owns organization ${organizationId}`);
console.log(`seed-fixture: written to ${OUT}`);
