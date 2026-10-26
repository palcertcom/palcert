import { apiEnvSchema, loadEnv, type ApiEnv } from '@palcert/config';

/**
 * Validate the process environment *before* the Nest container is created.
 *
 * Validating inside a DI factory is too late: Nest wraps the failure in its own
 * exception handler, which prints a dependency-injection stack trace and exits
 * with a generic code. Operators need the list of bad variables and a
 * distinguishable exit status, so the check runs first.
 */
export function validateEnvironment(source: NodeJS.ProcessEnv = process.env): ApiEnv {
  return loadEnv(apiEnvSchema, source);
}
