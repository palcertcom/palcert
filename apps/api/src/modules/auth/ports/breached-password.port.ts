import { Injectable } from '@nestjs/common';

/**
 * Breached-credential check (NIST SP 800-63B §5.1.1.2).
 *
 * Phase 1 ships the abstraction and a no-op implementation rather than a live
 * integration: making an external service a hard dependency of registration
 * would mean an outage at the provider blocks all sign-ups. When a provider is
 * added it must fail open on transport errors and be enabled explicitly via
 * AUTH_BREACHED_PASSWORD_CHECK_ENABLED.
 */
@Injectable()
export abstract class BreachedPasswordPort {
  abstract isBreached(password: string): Promise<boolean>;
}

@Injectable()
export class NoopBreachedPasswordChecker extends BreachedPasswordPort {
  async isBreached(_password: string): Promise<boolean> {
    return Promise.resolve(false);
  }
}

/** Test double for asserting the policy wiring without a network call. */
export class StubBreachedPasswordChecker extends BreachedPasswordPort {
  constructor(private readonly breached: ReadonlySet<string> = new Set()) {
    super();
  }

  async isBreached(password: string): Promise<boolean> {
    return Promise.resolve(this.breached.has(password));
  }
}
