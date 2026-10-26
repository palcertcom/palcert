import { notFound } from 'next/navigation';

/**
 * Every address under a known locale that matches nothing else (Phase 20
 * Checkpoint 8, F-010).
 *
 * A nested `not-found.tsx` only renders when something inside its segment
 * calls `notFound()`. An address that matches no route at all never enters the
 * segment, so it falls all the way out to the root boundary — which is why
 * adding `[locale]/not-found.tsx` on its own changed nothing, and
 * `/ar/anything-missing` still answered in English. This route exists to be
 * matched last and to call `notFound()` from inside the locale, which is what
 * puts the reader's own language on the screen.
 *
 * It cannot shadow a real page: a catch-all is the lowest-priority match in
 * the App Router, so every static and dynamic sibling wins first. A locale
 * PalCert does not have still lands on the root boundary, via the layout's own
 * `notFound()` — correct, because there is no language to answer in.
 */
export default function MissingPage(): never {
  notFound();
}
