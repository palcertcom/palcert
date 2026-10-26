/** Collecting results across a matrix, and printing them so a person can act. */
export class Results {
  constructor() {
    this.rows = [];
  }

  record(entry) {
    this.rows.push(entry);
    const status = entry.problems.length === 0 ? 'ok  ' : 'FAIL';
    const where = `${entry.engine}/${entry.locale}/${entry.viewport}`;
    console.log(`qa: ${status} ${where.padEnd(28)} ${entry.journey} — ${entry.step}`);
    for (const problem of entry.problems.slice(0, 6)) console.log(`qa:        ! ${problem}`);
  }

  get failures() {
    return this.rows.filter((row) => row.problems.length > 0);
  }

  summary() {
    const byJourney = new Map();
    for (const row of this.rows) {
      const current = byJourney.get(row.journey) ?? { total: 0, failed: 0 };
      current.total += 1;
      if (row.problems.length > 0) current.failed += 1;
      byJourney.set(row.journey, current);
    }
    console.log('\nqa: summary');
    for (const [journey, counts] of [...byJourney].sort()) {
      const status = counts.failed === 0 ? 'ok  ' : 'FAIL';
      console.log(
        `qa:   ${status} ${journey.padEnd(34)} ${counts.total - counts.failed}/${counts.total} steps clean`,
      );
    }
    console.log(`qa: ${this.rows.length} step(s), ${this.failures.length} with findings`);
    return this.failures.length === 0;
  }
}
