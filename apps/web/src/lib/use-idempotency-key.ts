'use client';

import { useRef } from 'react';
import { newIdempotencyKey } from '@/lib/api-client';

/**
 * One idempotency key per *semantic* request, held across retries.
 *
 * The rule this implements: a key identifies what the user asked for, not the
 * HTTP attempt that carried it. So a retry after an uncertain outcome — a
 * dropped connection, a timeout, a browser that lost the tab — must send the
 * same key, or the server sees a second intention and creates a second
 * endpoint, a second secret or a second replay.
 *
 * `keyFor(fingerprint)` returns the same key while the fingerprint is
 * unchanged and a new one the moment it changes, which is what tells "retry
 * this" apart from "do a different thing": editing the URL before pressing the
 * button again is a new request, pressing the same button again is not.
 * `reset()` is called after a success, so the next deliberate action gets a
 * fresh key rather than being answered with the last one's result.
 *
 * The key is not a credential — it is a random opaque string with no authority
 * of its own — but it stays out of the URL all the same, because a URL is
 * copied, logged and put in a bug report.
 */
export function useIdempotencyKey(): {
  keyFor: (fingerprint: string) => string;
  reset: () => void;
} {
  const held = useRef<{ fingerprint: string; key: string } | null>(null);

  return {
    keyFor(fingerprint: string): string {
      if (held.current === null || held.current.fingerprint !== fingerprint) {
        held.current = { fingerprint, key: newIdempotencyKey() };
      }
      return held.current.key;
    },
    reset(): void {
      held.current = null;
    },
  };
}
