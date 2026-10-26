import { Injectable } from '@nestjs/common';

/**
 * Injectable clock.
 *
 * Session expiry, token TTLs and throttle windows are all time-dependent.
 * Injecting the clock lets tests construct exact instants instead of sleeping,
 * which keeps the suite fast and free of timing flakes (Phase 1 §40).
 */
@Injectable()
export abstract class ClockPort {
  abstract now(): Date;

  /** Convenience helper: `now + minutes`, without mutating shared state. */
  plusMinutes(minutes: number): Date {
    return new Date(this.now().getTime() + minutes * 60_000);
  }
}

@Injectable()
export class SystemClock extends ClockPort {
  now(): Date {
    return new Date();
  }
}

/** Test double. Time advances only when a test says so. */
export class FakeClock extends ClockPort {
  private current: Date;

  constructor(start: Date = new Date('2026-01-01T00:00:00.000Z')) {
    super();
    this.current = new Date(start);
  }

  now(): Date {
    return new Date(this.current);
  }

  advanceMinutes(minutes: number): void {
    this.current = new Date(this.current.getTime() + minutes * 60_000);
  }

  set(instant: Date): void {
    this.current = new Date(instant);
  }
}
