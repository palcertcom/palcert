import { lookup } from 'node:dns';

import { classifyDestination, WebhookErrorCode } from '@palcert/contracts';

/**
 * Resolving a webhook host, and deciding whether PalCert will talk to it.
 *
 * The rule of the phase: PalCert refuses every special-purpose and multicast
 * registry destination, with no exceptions. The classification comes from the
 * committed IANA snapshots, so what counts as special-purpose is a registry
 * fact rather than somebody's recollection.
 *
 * Two properties matter more than the list itself.
 *
 * First, resolution happens again on every attempt. A hostname that resolved
 * to a public address yesterday resolves to whatever its owner points it at
 * today, and an endpoint verified six months ago has had six months to become
 * a pointer at something internal.
 *
 * Second, the address PalCert checked is the address PalCert connects to. A
 * check followed by an independent connection is a race the attacker wins:
 * answer publicly for the lookup, answer privately for the connect, and the
 * check has validated one thing while the socket reaches another. The address
 * is pinned here and handed to the client, which connects to it literally.
 */

export interface PinnedDestination {
  /** The exact address the socket must use. */
  readonly address: string;
  readonly family: 4 | 6;
  /** Every address the name answered with, all of them allowed. */
  readonly allAddresses: readonly string[];
}

export class WebhookDestinationError extends Error {
  constructor(
    readonly code: WebhookErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'WebhookDestinationError';
  }
}

export interface ResolveOptions {
  readonly timeoutMs: number;
}

export interface LookupAddress {
  readonly address: string;
  readonly family: number;
}

/**
 * Resolve a hostname and pin one address, or refuse.
 *
 * A name answering with a mix of allowed and refused addresses is refused
 * outright rather than filtered down to the allowed ones. Filtering would mean
 * PalCert kept talking to a host that is *also* an internal address — the
 * classic DNS rebinding shape — and each attempt would be a coin flip that the
 * attacker gets to retry as often as PalCert retries.
 */
export async function resolveWebhookDestination(
  host: string,
  options: ResolveOptions,
): Promise<PinnedDestination> {
  return pinAllowedAddress(await lookupAll(host, options.timeoutMs));
}

/**
 * The policy decision, separated from the resolver that feeds it.
 *
 * Exported so the rule can be tested against every shape of answer without a
 * seam in the resolver itself: the production path has no way to be handed a
 * different lookup, which is the point.
 */
export function pinAllowedAddress(answers: readonly LookupAddress[]): PinnedDestination {
  if (answers.length === 0) {
    throw new WebhookDestinationError(
      WebhookErrorCode.DESTINATION_UNRESOLVABLE,
      'the webhook host did not resolve to any address',
    );
  }

  const refused: string[] = [];
  const allowed: LookupAddress[] = [];
  for (const answer of answers) {
    if (classifyDestination(answer.address).allowed) {
      allowed.push(answer);
    } else {
      refused.push(answer.address);
    }
  }

  if (refused.length > 0) {
    throw new WebhookDestinationError(
      WebhookErrorCode.DESTINATION_NOT_PUBLIC,
      allowed.length === 0
        ? 'the webhook host resolves only to addresses PalCert refuses to contact'
        : 'the webhook host resolves to both public and non-public addresses',
    );
  }

  const pinned = allowed[0] as LookupAddress;
  return {
    address: pinned.address,
    family: pinned.family === 6 ? 6 : 4,
    allAddresses: allowed.map((answer) => answer.address),
  };
}

/**
 * `dns.lookup` with a deadline.
 *
 * The OS resolver is used rather than a direct query, because it is what the
 * socket would use: validating with one resolver and connecting with another
 * reintroduces the gap this function exists to close.
 *
 * Node's lookup has no timeout of its own, so a resolver that never answers
 * would otherwise hold the worker's lease until the job lease expired. The
 * lookup itself cannot be cancelled; the deadline stops PalCert waiting for
 * it, and its late answer lands on a promise nobody is holding.
 */
function lookupAll(host: string, timeoutMs: number): Promise<LookupAddress[]> {
  return new Promise<LookupAddress[]>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(
        new WebhookDestinationError(
          WebhookErrorCode.DNS_TEMPORARY_FAILURE,
          'the webhook host did not resolve within the deadline',
        ),
      );
    }, timeoutMs);
    timer.unref?.();

    lookup(host, { all: true, verbatim: true }, (error, addresses) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        // A resolver error is reported as temporary: NXDOMAIN and a broken
        // resolver are indistinguishable from here, and treating a broken
        // resolver as a permanent endpoint failure would disable every
        // endpoint in the deployment over one outage.
        reject(
          new WebhookDestinationError(
            WebhookErrorCode.DNS_TEMPORARY_FAILURE,
            'the webhook host could not be resolved',
          ),
        );
        return;
      }
      resolve(addresses as LookupAddress[]);
    });
  });
}
