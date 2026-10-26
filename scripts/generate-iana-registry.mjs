#!/usr/bin/env node
/**
 * Generate the webhook destination classification table from the committed
 * IANA snapshots.
 *
 * Reads only `security/iana/*.csv`. It makes no network request, which is the
 * point: CI runs this and requires an empty diff, so "the generated table
 * matches the registries we reviewed" is something anyone can reproduce
 * offline rather than a claim the artifact makes about itself.
 *
 * Refreshing the registries is a separate, explicit maintenance step
 * (`pnpm webhooks:refresh-iana`) that does reach the network, updates the
 * snapshots and PROVENANCE.json, and then runs this generator — so a registry
 * change arrives as a reviewable diff naming exactly which ranges moved.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ianaDir = join(root, 'security', 'iana');
const outFile = join(
  root,
  'packages',
  'contracts',
  'src',
  'net',
  'iana-special-registry.generated.ts',
);

const provenance = JSON.parse(readFileSync(join(ianaDir, 'PROVENANCE.json'), 'utf8'));

/** Split a CSV line, honouring the quoted fields the IANA exports contain. */
function splitCsvLine(line) {
  const out = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        field += '"';
        i += 1;
        continue;
      }
      if (ch === '"') {
        quoted = false;
        continue;
      }
      field += ch;
      continue;
    }
    if (ch === '"') {
      quoted = true;
      continue;
    }
    if (ch === ',') {
      out.push(field);
      field = '';
      continue;
    }
    field += ch;
  }
  out.push(field);
  return out;
}

function readRegistry(name) {
  const raw = readFileSync(join(ianaDir, name), 'utf8');
  const recorded = provenance.files[name]?.sha256;
  const actual = createHash('sha256')
    .update(readFileSync(join(ianaDir, name)))
    .digest('hex');
  if (recorded !== actual) {
    throw new Error(
      `${name} does not match PROVENANCE.json (recorded ${recorded}, actual ${actual}). ` +
        'Refresh provenance deliberately rather than editing a snapshot in place.',
    );
  }

  const lines = raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const entries = [];
  for (const line of lines.slice(1)) {
    const [block, label] = splitCsvLine(line);
    // An IANA block cell can list several prefixes separated by commas inside
    // one quoted field; each is its own refused range.
    for (const prefix of block.split(/\s*,\s*/)) {
      const cidr = prefix.trim();
      if (cidr.length === 0) continue;
      entries.push({ cidr, label: label.trim(), registry: name });
    }
  }
  return entries;
}

const entries = [
  ...readRegistry('ipv4-special-registry.csv'),
  ...readRegistry('ipv4-multicast-registry.csv'),
  ...readRegistry('ipv6-special-registry.csv'),
  ...readRegistry('ipv6-multicast-registry.csv'),
  ...readRegistry('ipv6-deprecated-extra.csv'),
];

const v4 = entries.filter((entry) => !entry.cidr.includes(':'));
const v6 = entries.filter((entry) => entry.cidr.includes(':'));

/*
 * Single-quoted, to match what Prettier would produce.
 *
 * `JSON.stringify` emits double quotes, so the generator's output and the
 * repository's formatting disagreed — and the file only ever looked stable
 * because whichever of the two ran last won. That makes the CI empty-diff check
 * report formatting noise instead of a real change to the deny list, which is
 * the one thing it exists to catch.
 */
const quote = (value) => `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

const render = (list) =>
  list.map((entry) => `  { cidr: ${quote(entry.cidr)}, label: ${quote(entry.label)} },`).join('\n');

const banner = `/**
 * GENERATED FILE — do not edit by hand.
 *
 * Produced by scripts/generate-iana-registry.mjs from the committed snapshots
 * in security/iana/: IANA registry snapshots plus reviewed supplemental deny
 * entries. CI regenerates this file and requires an empty diff, so the table
 * below is reproducible offline from artifacts that are in the repository
 * beside it.
 *
 * Not every source is a registry export, and the distinction is kept rather
 * than smoothed over: a registry entry is a fact PalCert imported, while a
 * supplemental entry is a decision PalCert made and is answerable for.
 *
 * PalCert policy: an address inside ANY range below is refused as a webhook
 * destination. Phase 17 has zero allow exceptions.
 *
 * Snapshots retrieved ${provenance.retrievedAt}:
${Object.entries(provenance.files)
  .map(
    ([name, meta]) =>
      ` *   ${meta.kind === 'supplemental-deny' ? '[supplemental]' : '[iana]'} ${name}  sha256 ${meta.sha256}`,
  )
  .join('\n')}
 */

export interface SpecialPurposeRange {
  readonly cidr: string;
  readonly label: string;
}

/** IPv4 ranges IANA reserves for a special purpose, plus multicast. */
export const IANA_SPECIAL_IPV4: readonly SpecialPurposeRange[] = [
${render(v4)}
];

/** IPv6 ranges IANA reserves for a special purpose, plus multicast. */
export const IANA_SPECIAL_IPV6: readonly SpecialPurposeRange[] = [
${render(v6)}
];
`;

/*
 * `--check` regenerates in memory and compares, so CI fails on a hand-edited
 * generated file. Editing the classification by hand is exactly the failure
 * this phase cannot tolerate: the list is what decides where PalCert will
 * open a socket, and a hand-edit leaves no trace of which registry entry it
 * departed from.
 */
if (process.argv.includes('--check')) {
  const current = readFileSync(outFile, 'utf8');
  if (current !== banner) {
    process.stderr.write(
      `${outFile} does not match the committed IANA snapshots.\n` +
        'Run `pnpm webhooks:refresh-iana` and commit the result.\n',
    );
    process.exit(1);
  }
  process.stdout.write(`${outFile} matches the committed snapshots\n`);
} else {
  writeFileSync(outFile, banner);
  process.stdout.write(`generated ${v4.length} IPv4 and ${v6.length} IPv6 ranges\n`);
}
