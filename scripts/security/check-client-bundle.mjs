#!/usr/bin/env node
/**
 * Prohibited deployment placeholders in the built client bundle
 * (Phase 20 Checkpoint 7).
 *
 *   node scripts/security/check-client-bundle.mjs [apps/web/.next]
 *
 * `NEXT_PUBLIC_*` values are not read at run time. Next inlines them into the
 * JavaScript the browser downloads, at build time, as string literals — so
 * whatever they were when the image was built is what every visitor's browser
 * will use forever.
 *
 * That is how the published web image came to carry `http://localhost:4000` as
 * its API base: the Dockerfile's ARG default, baked into the bundle, meaning
 * every API call a browser made from a deployed PalCert went to port 4000 on
 * the visitor's own machine. Every release check missed it, because they are
 * all server-side `curl` and "/en returns 200" is satisfied by server-rendered
 * HTML that has not yet made a single API call.
 *
 * A grep over the built assets is the cheap check that would have caught it,
 * so here it is. It also looks for the other things that should never reach a
 * browser bundle: private hostnames from the deployment network, and anything
 * shaped like a credential.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const root = process.argv[2] ?? 'apps/web/.next';

/**
 * Each pattern is something that is *always* wrong in a shipped bundle, never
 * merely suspicious — a check that cries wolf gets an allow-list and then gets
 * ignored.
 */
const PROHIBITED = [
  {
    name: 'a localhost API base',
    pattern: /https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/g,
    why: 'the browser would call the visitor’s own machine; the release topology is same-origin',
  },
  {
    name: 'a deployment-network hostname',
    // The service names from the release topology. A browser cannot resolve
    // them, so their presence means a server-side value leaked into client
    // code.
    pattern: /https?:\/\/(api|web|postgres|redis|minio|clamav|document-engine):\d+/g,
    why: 'an internal service address is not reachable from a browser and should never be in client code',
  },
  {
    name: 'a credential-shaped literal',
    pattern: /\b(sk_live_[A-Za-z0-9]{8,}|whsec_[A-Za-z0-9]{8,}|AKIA[0-9A-Z]{16})\b/g,
    why: 'a secret in a client bundle is public',
  },
];

/** Only what the browser actually downloads. */
const CLIENT_DIRECTORIES = ['static'];

function walk(directory) {
  const entries = [];
  for (const name of readdirSync(directory)) {
    const full = path.join(directory, name);
    if (statSync(full).isDirectory()) entries.push(...walk(full));
    else if (/\.(js|mjs|css|json|txt|map)$/.test(name)) entries.push(full);
  }
  return entries;
}

const roots = CLIENT_DIRECTORIES.map((name) => path.join(root, name)).filter((directory) => {
  try {
    return statSync(directory).isDirectory();
  } catch {
    return false;
  }
});

if (roots.length === 0) {
  console.error(`check-client-bundle: no built client assets under ${root}`);
  console.error(
    'check-client-bundle: build the web app first — refusing to report a clean scan of nothing',
  );
  process.exit(64);
}

const files = roots.flatMap((directory) => walk(directory));
if (files.length === 0) {
  console.error(`check-client-bundle: ${root} contains no client assets`);
  process.exit(64);
}

let findings = 0;
for (const file of files) {
  const contents = readFileSync(file, 'utf8');
  for (const rule of PROHIBITED) {
    const matches = [...contents.matchAll(rule.pattern)];
    if (matches.length === 0) continue;
    findings += matches.length;
    const shown = [...new Set(matches.map((match) => match[0]))].slice(0, 3);
    console.error(`check-client-bundle: ${rule.name} in ${path.relative(root, file)}`);
    console.error(`check-client-bundle:   ${rule.why}`);
    for (const value of shown) console.error(`check-client-bundle:   found: ${value}`);
  }
}

console.log(`check-client-bundle: scanned ${files.length} client asset(s) under ${root}`);
if (findings > 0) {
  console.error(`check-client-bundle: ${findings} prohibited value(s) in the client bundle`);
  process.exit(65);
}
console.log('check-client-bundle: no prohibited deployment placeholder in the client bundle');
