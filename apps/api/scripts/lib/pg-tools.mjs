/**
 * PostgreSQL backup and restore, driven through the client binaries.
 *
 * No Node PostgreSQL driver is used, and that is deliberate rather than
 * frugal: this tool cannot work at all without `pg_dump`, `pg_restore` and
 * `psql` on PATH, so driving `psql` for the few queries it needs adds no
 * dependency an operator did not already have to install. It also means the
 * backup path has no Prisma in it -- recovery must not require the
 * application to be buildable.
 */
import { spawn } from 'node:child_process';

/** PostgreSQL rejects a URI carrying Prisma's `?schema=` parameter. */
export function toLibpqUrl(url) {
  return url.replace(/[?&]schema=[^&]*/g, '').replace(/\?$/, '');
}

/** Redact the password so a URL can appear in a log line or an error. */
export function redactUrl(url) {
  return url.replace(/(:\/\/[^:/@]+:)[^@]*@/, '$1***@');
}

export function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      // Credentials travel in the environment, never in argv, where any other
      // process on the host can read them out of /proc.
      env: { ...process.env, ...(options.env ?? {}) },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => reject(error));
    child.on('close', (code) => {
      if (code === 0 || options.allowFailure === true) {
        resolve({ code, stdout, stderr });
        return;
      }
      const error = new Error(
        `${command} exited ${code}${stderr.trim().length > 0 ? `: ${stderr.trim()}` : ''}`,
      );
      error.code = code;
      error.stderr = stderr;
      reject(error);
    });
  });
}

/**
 * A psql session held open so a snapshot exported inside it stays valid.
 *
 * This is the whole reason the class exists. `pg_dump --snapshot` can be
 * pointed at a snapshot another session exported, but only while that session
 * still has the transaction open -- so the database dump and the reference
 * closure can be made to see *exactly* the same instant, which is what turns
 * "two archives taken at about the same time" into one consistent unit.
 */
export class PsqlSnapshotSession {
  #child = null;
  #buffer = '';
  #waiters = [];

  constructor(url) {
    this.url = toLibpqUrl(url);
  }

  async open() {
    this.#child = spawn(
      'psql',
      [
        this.url,
        '--no-psqlrc',
        '--quiet',
        '--tuples-only',
        '--no-align',
        // Any error must end the session rather than leave the transaction in
        // an aborted state that silently returns nothing.
        '--set=ON_ERROR_STOP=1',
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    this.#child.stdout.setEncoding('utf8');
    this.#child.stdout.on('data', (chunk) => {
      this.#buffer += chunk;
      this.#drain();
    });
    this.stderr = '';
    this.#child.stderr.setEncoding('utf8');
    this.#child.stderr.on('data', (chunk) => {
      this.stderr += chunk;
    });
    this.#exited = new Promise((resolve) => {
      this.#child.on('close', (code) => resolve(code));
    });
  }

  #exited = null;

  #drain() {
    while (this.#waiters.length > 0) {
      const index = this.#buffer.indexOf('\u0001\n');
      if (index === -1) return;
      const payload = this.#buffer.slice(0, index);
      this.#buffer = this.#buffer.slice(index + 2);
      const waiter = this.#waiters.shift();
      waiter.resolve(payload);
    }
  }

  /**
   * Run SQL and collect its rows.
   *
   * A sentinel line marks the end of each statement's output, because psql on
   * a pipe gives no other framing and a reader that guessed would eventually
   * read one query's rows as the next query's answer.
   */
  async query(sql) {
    if (this.#child === null) throw new Error('Session is not open');
    const result = new Promise((resolve, reject) => {
      this.#waiters.push({ resolve, reject });
      this.#exited?.then((code) => {
        if (code !== 0) {
          reject(new Error(`psql exited ${code}: ${this.stderr.trim()}`));
        }
      });
    });
    this.#child.stdin.write(`${sql}\n\\echo '\u0001'\n`);
    const payload = await result;
    return payload.split('\n').filter((line) => line.length > 0);
  }

  /**
   * Begin a repeatable-read transaction and publish its snapshot.
   *
   * Repeatable read is what makes the snapshot exportable and what makes it
   * mean anything: every read in this transaction, and every read by anyone
   * who imports the id, sees the database as it was at this instant.
   */
  async exportSnapshot() {
    await this.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;');
    const [snapshotId] = await this.query('SELECT pg_export_snapshot();');
    const [snapshotAt] = await this.query(
      'SELECT to_char(now(), \'YYYY-MM-DD"T"HH24:MI:SS.MSOF\');',
    );
    if (snapshotId === undefined || snapshotId.length === 0) {
      throw new Error('PostgreSQL did not export a snapshot');
    }
    return { snapshotId, snapshotAt };
  }

  async close() {
    if (this.#child === null) return;
    try {
      this.#child.stdin.end('COMMIT;\n\\q\n');
    } catch {
      // The session is going away regardless.
    }
    await this.#exited;
    this.#child = null;
  }
}

/**
 * Dump the database in PostgreSQL's custom format.
 *
 * Custom rather than plain SQL for three reasons that matter on recovery day:
 * it is compressed, `pg_restore` can list its contents without applying any of
 * it (which is how a backup is validated without a database to restore into),
 * and it can be restored selectively when only part of it is wanted.
 *
 * `--no-owner` and `--no-privileges` are deliberately NOT passed: PalCert's
 * least-privilege grants and its 104 row-level-security policies are part of
 * what has to survive, and a dump that dropped them would restore an
 * installation where the application role could suddenly read everything.
 */
export async function dumpDatabase({ url, snapshotId, outputPath }) {
  const args = [
    toLibpqUrl(url),
    '--format=custom',
    '--compress=6',
    '--no-password',
    `--file=${outputPath}`,
  ];
  if (snapshotId !== undefined && snapshotId !== null) {
    args.push(`--snapshot=${snapshotId}`);
  }
  await run('pg_dump', args);
}

/** List a dump's table of contents without restoring any of it. */
export async function listDump(dumpPath) {
  const { stdout } = await run('pg_restore', ['--list', dumpPath]);
  return stdout;
}

/**
 * The database roles a dump's grants and ownerships name.
 *
 * Roles are cluster-level objects: `pg_dump` of one database records who owns
 * what and who was granted what, but it cannot create the roles themselves.
 * Restoring into a fresh cluster therefore fails part-way through with a raw
 * "role does not exist", after the schema is already half applied -- which is
 * the worst moment to learn it. Read them out of the archive first instead.
 */
export async function rolesReferencedByDump(dumpPath) {
  // `--schema-only --file=-` renders the archive as SQL without touching a
  // database, so this costs a read of the dump and nothing else.
  const { stdout } = await run('pg_restore', ['--schema-only', '--file=-', dumpPath]);
  const roles = new Set();
  for (const match of stdout.matchAll(/^(?:GRANT|REVOKE)[\s\S]*?\s(?:TO|FROM)\s+([^;]+);/gm)) {
    for (const name of match[1].split(',')) {
      const role = name.trim().replace(/^"|"$/g, '');
      if (role.length > 0 && role !== 'PUBLIC' && !role.startsWith('pg_')) roles.add(role);
    }
  }
  for (const match of stdout.matchAll(/OWNER TO\s+([^;]+);/g)) {
    const role = match[1].trim().replace(/^"|"$/g, '');
    if (role.length > 0 && !role.startsWith('pg_')) roles.add(role);
  }
  return [...roles].sort();
}

/** Which of the given roles the destination cluster already has. */
export async function existingRoles(url, names) {
  if (names.length === 0) return [];
  const list = names.map((name) => `'${name.replace(/'/g, "''")}'`).join(',');
  return psqlQuery(url, `SELECT rolname FROM pg_roles WHERE rolname IN (${list}) ORDER BY 1;`);
}

export async function restoreDatabase({ url, dumpPath, jobs = 1, sections = null }) {
  const args = [
    `--dbname=${toLibpqUrl(url)}`,
    '--no-password',
    // One failed statement must fail the restore. The default is to carry on
    // and report at the end, which produces a half-restored database that
    // looks like it worked.
    '--exit-on-error',
    `--jobs=${jobs}`,
    // A subset of pg_dump's sections, when the caller has work to do between
    // them: `pre-data` and `data` load the tables and their rows; `post-data`
    // adds indexes, constraints, triggers, policies and row-level security.
    ...(sections === null ? [] : sections.map((section) => `--section=${section}`)),
    dumpPath,
  ];
  await run('pg_restore', args);
}

/** One-shot query outside any snapshot, for checks that do not need one. */
export async function psqlQuery(url, sql) {
  const { stdout } = await run('psql', [
    toLibpqUrl(url),
    '--no-psqlrc',
    '--quiet',
    '--tuples-only',
    '--no-align',
    '--set=ON_ERROR_STOP=1',
    '--command',
    sql,
  ]);
  return stdout.split('\n').filter((line) => line.length > 0);
}
