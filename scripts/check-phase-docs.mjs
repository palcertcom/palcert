#!/usr/bin/env node
/*
 * A small guard against the drift that actually happened.
 *
 * `docs/requirements/phases.md` carried a summary table saying Phases 7 to 16
 * were "Not started" while the same file, a few hundred lines down, described
 * what each of them had delivered. Nobody was careless; the table is edited at
 * the start of a phase and the section at the end, and the two simply stopped
 * agreeing.
 *
 * So this checks exactly that one thing — the table against the sections — and
 * nothing else. A documentation linter that checked everything would be a
 * second thing to keep true.
 */
import { readFileSync } from 'node:fs';

const FILE = 'docs/requirements/phases.md';
const source = readFileSync(FILE, 'utf8');

const problems = [];

/** `| 7 | Title | ✅ Complete |` */
const rowPattern = /^\|\s*(\d+)\s*\|\s*([^|]+?)\s*\|\s*(.+?)\s*\|$/gm;
const rows = new Map();
for (const match of source.matchAll(rowPattern)) {
  rows.set(Number(match[1]), { title: match[2], status: match[3] });
}

/** `## Phase 7 scope (delivered)` or `(in progress)` */
const sectionPattern = /^## Phase (\d+) scope \(([^)]+)\)/gm;
const sections = new Map();
for (const match of source.matchAll(sectionPattern)) {
  sections.set(Number(match[1]), match[2]);
}

if (rows.size === 0 || sections.size === 0) {
  problems.push('could not parse the phase table or the phase sections');
}

for (const [phase, section] of sections) {
  const row = rows.get(phase);
  if (row === undefined) {
    problems.push(`Phase ${phase} has a scope section but no row in the summary table`);
    continue;
  }

  const complete = row.status.includes('Complete');
  const inProgress = row.status.includes('In progress');

  if (section === 'delivered' && !complete) {
    problems.push(`Phase ${phase} is described as delivered but the table says "${row.status}"`);
  }
  if (section === 'in progress' && !inProgress) {
    problems.push(`Phase ${phase} is described as in progress but the table says "${row.status}"`);
  }
}

for (const [phase, row] of rows) {
  const section = sections.get(phase);
  if (row.status.includes('Complete') && section !== 'delivered') {
    problems.push(`Phase ${phase} is marked Complete but has no "(delivered)" scope section`);
  }
  if (row.status.includes('In progress') && section !== 'in progress') {
    problems.push(`Phase ${phase} is marked In progress but has no "(in progress)" scope section`);
  }
}

if (problems.length > 0) {
  process.stderr.write(`${FILE} is inconsistent:\n`);
  for (const problem of problems) process.stderr.write(`  - ${problem}\n`);
  process.exit(1);
}

process.stdout.write(`${FILE}: ${rows.size} phases, ${sections.size} scope sections, consistent\n`);
