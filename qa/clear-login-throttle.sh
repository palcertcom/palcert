#!/usr/bin/env bash
# Keep the QA matrix from tripping PalCert's per-IP login throttle
# (Phase 20 Checkpoint 8).
#
#   PROJECT=palcert-c7 bash qa/clear-login-throttle.sh &   # alongside qa/run.mjs
#
# The full matrix is three engines x two locales x four widths, and each cell
# signs in as two people and signs out again. Two limiters object, and both are
# right to:
#
#   * **per IP**, fifty attempts — roughly a hundred and twenty sign-ins arrive
#     from one address inside an hour;
#   * **per account**, ten attempts — two fixture accounts stand in for every
#     person PalCert has, and the author's signs in three times a cell.
#
# The throttles are doing exactly their job. The traffic is what is
# unrealistic: one machine and two accounts playing a whole population.
#
# **Nothing about the deployment is changed.** Both limits keep their shipped
# values, the image is untouched, the release topology is untouched, and CI is
# untouched. This only deletes the *counters* — the `login:ip` and
# `login:account` keys, and only those — every half minute, which is what a
# real population spread across real addresses would look like to the
# limiters.
#
# The throttle itself is still proved, at its shipped value, in two places
# this does not touch: the public-visitor journey's failed sign-in, which
# asserts either a rejection or a throttle and the right message for each, and
# `auth-security.e2e-spec.ts` in the API suite.
set -uo pipefail
PROJECT="${PROJECT:-palcert-c7}"
INTERVAL="${INTERVAL:-30}"

while true; do
  docker exec "${PROJECT}-redis-1" sh -c \
    'redis-cli --scan --pattern "palcert:throttle:login:*" | xargs -r redis-cli DEL' \
    > /dev/null 2>&1 || exit 0
  sleep "$INTERVAL"
done
