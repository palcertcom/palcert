import { AppError, PalCertErrorCode } from '@palcert/contracts';

/**
 * Optimistic concurrency for standard versions.
 *
 * ## One strategy, everywhere
 *
 * Every mutating request against a draft version — including mutations of its
 * rules — must carry `If-Match: "<revision>"`, and the server returns the
 * current revision as the `ETag` of every version read. There is deliberately
 * no second mechanism (no `updatedAt` comparison, no last-write-wins path):
 * two strategies in one aggregate is how a system ends up with a route that
 * quietly overwrites.
 *
 * ## Why the version is the unit
 *
 * A rule has no independent lifecycle: it exists only inside one version, is
 * published with it, and is frozen with it. Two authors editing different rules
 * of the same draft *are* in conflict, because publication takes the whole set.
 * So every accepted mutation bumps the version's `revision`, and the revision
 * is what `If-Match` names.
 *
 * ## Why a missing header is rejected
 *
 * Treating "no If-Match" as "go ahead" would make the protection opt-in, and
 * every client that forgot it would silently get last-write-wins — the exact
 * failure the mechanism exists to prevent. A missing precondition is a
 * `VALIDATION_FAILED`; a stale one is `STANDARD_VERSION_CONFLICT` (HTTP 412).
 */
export const IF_MATCH_HEADER = 'if-match';

/** Format a revision as an entity tag. */
export function revisionToETag(revision: number): string {
  return `"${revision}"`;
}

/**
 * Parse an `If-Match` header into the revision it names.
 *
 * Accepts `"3"` and the weak form `W/"3"`; `*` is deliberately rejected. `*`
 * means "any current representation", which for an edit is indistinguishable
 * from no precondition at all.
 */
export function parseIfMatch(header: string | undefined): number {
  if (header === undefined || header.trim() === '') {
    throw new AppError(PalCertErrorCode.VALIDATION_FAILED, {
      message:
        'This request must carry an If-Match header naming the version revision you are ' +
        'editing. Read the version first and send back its ETag.',
      details: { header: 'If-Match' },
    });
  }

  const match = /^(?:W\/)?"(\d{1,15})"$/.exec(header.trim());
  if (match === null) {
    throw new AppError(PalCertErrorCode.VALIDATION_FAILED, {
      message: 'If-Match must be the ETag returned by a version read, for example "3".',
      details: { header: 'If-Match' },
    });
  }

  return Number.parseInt(match[1]!, 10);
}

/**
 * Refuse the write when the caller's revision is not the current one.
 *
 * The current revision is reported back so a client can re-read, re-apply and
 * retry without guessing.
 */
export function assertRevisionMatches(expected: number, actual: number): void {
  if (expected !== actual) {
    throw new AppError(PalCertErrorCode.STANDARD_VERSION_CONFLICT, {
      message:
        'This standard version has changed since you loaded it. Reload it and reapply your ' +
        'change so you do not overwrite someone else’s edit.',
      details: { expectedRevision: expected, currentRevision: actual },
    });
  }
}
