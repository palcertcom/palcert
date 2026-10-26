/** Shared health-check contract used by the API, the document engine and probes. */
export const HealthStatus = {
  OK: 'ok',
  DEGRADED: 'degraded',
  ERROR: 'error',
} as const;

export type HealthStatus = (typeof HealthStatus)[keyof typeof HealthStatus];

export interface HealthDependency {
  readonly name: string;
  readonly status: HealthStatus;
  readonly latencyMs?: number;
  readonly message?: string;
}

/**
 * Which build is answering (Phase 20 Checkpoint 2).
 *
 * A deployed system has to be able to say what it is. `version` alone is a
 * hand-set string that two different builds can share, so it cannot answer
 * "is the rollback actually live yet?" — the commit can.
 *
 * Every field is optional because it is baked in at image build time. A
 * process started from source in development has no commit to report, and
 * that is not a failure worth crashing over: it reports what it knows.
 */
export interface ReleaseIdentity {
  /** The Git commit the image was built from, full 40-character SHA. */
  readonly commit?: string;
  /** RFC 3339 build timestamp. Never part of content identity. */
  readonly builtAt?: string;
}

export interface HealthResponse {
  readonly status: HealthStatus;
  readonly service: string;
  readonly version: string;
  readonly release: ReleaseIdentity;
  readonly uptimeSeconds: number;
  readonly checkedAt: string;
  readonly dependencies: readonly HealthDependency[];
}
