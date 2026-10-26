import type { z } from 'zod';

export class ConfigurationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'ConfigurationError';
    this.issues = issues;
  }
}

/**
 * Strip values a validator echoed back into its own message.
 *
 * Zod reports a rejected enum as `Expected 'a' | 'b', received '<value>'`, and
 * that `<value>` is whatever the deployment actually set. Until Phase 20
 * Checkpoint 7 those messages went straight into `ConfigurationError` — which
 * is thrown at boot, printed to stderr and collected by whatever ships
 * container logs — despite this function documenting the opposite. The
 * realistic way it bites is not an attack: it is an operator pasting a key
 * into the wrong variable, after which the key is in the startup log of every
 * replica, in plaintext, for as long as logs are kept.
 *
 * Two passes, because one is not enough on its own.
 *
 * The first rewrites the `received …` clause. That is where the echo comes
 * from by construction, and it applies to every field regardless of its name —
 * which matters, because the value that needs hiding is usually in a field
 * nobody would call sensitive. A key pasted into `API_DOCS_ENABLED` is still a
 * key.
 *
 * The second removes values supplied under a sensitive-looking name, covering
 * hand-written `refine` messages that interpolate what they rejected. It is
 * deliberately *not* applied to every value: the first version of this
 * scrubbed anything four characters or longer, which meant `NODE_ENV` supplied
 * the string `production` and ten messages that legitimately end "in
 * production" came back reading "in [REDACTED]". A redaction that destroys the
 * message an operator needs has traded one problem for another.
 */
const MIN_SCRUBBED_LENGTH = 4;

function withoutValues(message: string, source: Record<string, string | undefined>): string {
  let safe = message.replace(/received\s+'[^']*'/g, 'received a value that is not one of them');
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || value.length < MIN_SCRUBBED_LENGTH) continue;
    if (!isSensitiveConfigKey(key) || !safe.includes(value)) continue;
    safe = safe.split(value).join('[REDACTED]');
  }
  return safe;
}

/**
 * Validate a raw environment object against a schema.
 *
 * Throws `ConfigurationError` listing every problem at once, so an operator can
 * fix a misconfigured deployment in a single pass. Every message names the
 * field and says what was wrong with it; none of them contains the value,
 * because a misconfigured variable is exactly as likely to hold a secret as a
 * correctly configured one.
 */
export function loadEnv<TSchema extends z.ZodTypeAny>(
  schema: TSchema,
  source: Record<string, string | undefined> = process.env,
): z.infer<TSchema> {
  const result = schema.safeParse(source);

  if (!result.success) {
    const issues = result.error.issues.map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      return `${path}: ${withoutValues(issue.message, source)}`;
    });
    throw new ConfigurationError(issues);
  }

  return result.data;
}

/** Keys whose values must never be logged or echoed back (§38, §49). */
const SENSITIVE_KEY_PATTERN =
  /(SECRET|PASSWORD|TOKEN|API_KEY|ACCESS_KEY|PRIVATE|DATABASE_URL|REDIS_URL)/i;

export function isSensitiveConfigKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key);
}

/** Produce a log-safe snapshot of configuration with secrets redacted. */
export function redactConfig<T extends Record<string, unknown>>(
  config: T,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(config).map(([key, value]) => [
      key,
      isSensitiveConfigKey(key) ? '[REDACTED]' : value,
    ]),
  );
}
