#!/usr/bin/env node
/**
 * Decide whether a backup could be restored — without restoring it.
 *
 *   pnpm --filter @palcert/api backup:verify -- --from /var/backups/palcert/palcert-...
 *
 * This is the step that turns "the backup job exited 0" into something worth
 * believing. A backup command can succeed and still leave an archive that is
 * truncated, half-written, produced by a newer PalCert, or empty because the
 * credentials it used could read nothing. Every one of those looks identical
 * to success from the outside, and every one is only discovered on the day it
 * matters -- unless something like this runs on the ordinary days.
 *
 * Needs no database and no object store: it reads the archive and nothing else.
 * Intended for a scheduled job right after each backup, and for an operator
 * choosing between archives during an incident.
 */
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
// The format module is CommonJS so the operator tooling and the test
// suite share one implementation rather than two that can drift.
import backupFormat from './lib/backup-format.cjs';

const { LAYOUT, manifestIsClean, objectDataPath, parseJsonl, sha256Hex, validateManifest } =
  backupFormat;
import { listDump } from './lib/pg-tools.mjs';

function parseArgs(argv) {
  const args = { from: null, deep: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--from') args.from = argv[(index += 1)];
    else if (argv[index] === '--deep') args.deep = true;
  }
  return args;
}

const problems = [];
const notes = [];
function problem(message) {
  problems.push(message);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.from === null) {
    console.error('verify-backup: --from <backup directory> is required');
    process.exit(64);
  }
  const root = args.from;

  let manifest = null;
  try {
    manifest = JSON.parse(await readFile(path.join(root, LAYOUT.manifest), 'utf8'));
  } catch (error) {
    console.error(`verify-backup: cannot read ${LAYOUT.manifest}: ${error.message}`);
    process.exit(65);
  }

  for (const message of validateManifest(manifest)) problem(message);

  // Each component, checked for existence, length and checksum. Length is
  // checked before the checksum so a truncated archive is named as truncated
  // rather than simply "corrupt" -- an operator can do something about the
  // first (the transfer was cut short) that they cannot about the second.
  for (const [name, component] of Object.entries(manifest.components ?? {})) {
    const absolute = path.join(root, component.path ?? '');
    let info;
    try {
      info = await stat(absolute);
    } catch {
      problem(`component ${name} is missing (${component.path})`);
      continue;
    }
    if (info.size !== component.sizeBytes) {
      problem(
        `component ${name} is ${info.size} bytes but the manifest records ${component.sizeBytes} — truncated`,
      );
      continue;
    }
    const digest = sha256Hex(await readFile(absolute));
    if (digest !== component.sha256) {
      problem(`component ${name} fails its checksum — corrupt`);
    }
  }

  // The dump's own table of contents. `pg_restore --list` parses the archive
  // header and index without touching a database, so a dump that cannot be
  // read at all is caught here rather than during a recovery.
  if (problems.length === 0) {
    try {
      const toc = await listDump(path.join(root, manifest.components.databaseDump.path));
      const entries = toc.split('\n').filter((line) => line.length > 0 && !line.startsWith(';'));
      if (entries.length === 0) {
        problem('database dump contains no objects');
      } else {
        notes.push(`database dump lists ${entries.length} objects`);
        // The parts of the schema that carry PalCert's security model. A dump
        // that restored tables but not policies would produce an installation
        // where every tenant could read every other tenant.
        for (const [label, needle] of [
          ['row-level-security policies', ' POLICY '],
          ['functions', ' FUNCTION '],
          ['grants', ' ACL '],
        ]) {
          const count = entries.filter((line) => line.includes(needle)).length;
          if (count === 0) problem(`database dump contains no ${label}`);
          else notes.push(`${count} ${label}`);
        }
      }
    } catch (error) {
      problem(`database dump is unreadable: ${error.message}`);
    }
  }

  // Object manifest against the bytes on disk.
  if (problems.length === 0) {
    const records = parseJsonl(
      (await readFile(path.join(root, LAYOUT.objectManifest))).toString('utf8'),
    );
    if (records.length !== manifest.objectCount) {
      problem(
        `object manifest lists ${records.length} objects but the header records ${manifest.objectCount}`,
      );
    }
    let checked = 0;
    // A shallow pass proves every object is present and the right length, which
    // is what catches a partial copy. `--deep` also re-hashes them, which is
    // what catches silent corruption on the backup medium; it costs a full read
    // of the archive, so it is a choice rather than the default.
    for (const record of records) {
      const absolute = path.join(root, objectDataPath(record.zone, record.key));
      let info;
      try {
        info = await stat(absolute);
      } catch {
        problem(`object ${record.zone}/${record.key} is listed but absent`);
        continue;
      }
      if (info.size !== record.sizeBytes) {
        problem(
          `object ${record.zone}/${record.key} is ${info.size} bytes, expected ${record.sizeBytes}`,
        );
        continue;
      }
      if (args.deep) {
        const digest = sha256Hex(await readFile(absolute));
        if (digest !== record.sha256) {
          problem(`object ${record.zone}/${record.key} fails its checksum`);
          continue;
        }
      }
      checked += 1;
    }
    notes.push(`${checked} object(s) ${args.deep ? 're-hashed' : 'present at the recorded size'}`);
  }

  console.log(`verify-backup: ${manifest.backupId ?? '(unnamed)'}`);
  for (const note of notes) console.log(`verify-backup:   ${note}`);

  if (!manifestIsClean(manifest)) {
    const reconciliation = manifest.reconciliation ?? {};
    console.warn(
      `verify-backup: WARNING this backup recorded ${reconciliation.missingReferenced ?? 0} ` +
        `missing object(s) and ${reconciliation.checksumMismatches ?? 0} checksum mismatch(es)`,
    );
  }

  if (problems.length > 0) {
    for (const message of problems) console.error(`verify-backup: ${message}`);
    console.error(`verify-backup: NOT RESTORABLE (${problems.length} problem(s))`);
    process.exit(65);
  }
  console.log('verify-backup: OK');
}

main().catch((error) => {
  console.error(`verify-backup: ${error.message}`);
  process.exit(1);
});
