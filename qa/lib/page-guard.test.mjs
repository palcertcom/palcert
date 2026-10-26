/**
 * The one narrowing in the page guard, tested — because a rule that decides
 * what is *not* an error is the rule most worth being wrong about.
 *
 *   node --test qa/lib/page-guard.test.mjs
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isCancelledSameOriginLoad } from './page-guard.mjs';

const BASE = 'https://localhost:8543';

test('ignores a same-origin load WebKit cancelled', () => {
  for (const message of [
    '/localhost:8543/api/v1/users/me due to access control checks.',
    '/localhost:8543/ar/sessions?_rsc=0HCsoHSgFCJW3hOT due to access control checks.',
    'https://localhost:8543/api/v1/notifications/unread-count due to access control checks.',
  ]) {
    assert.equal(isCancelledSameOriginLoad(message, BASE), true, message);
  }
});

test('still reports a genuine exception', () => {
  for (const message of [
    'TypeError: entries.map is not a function',
    'ReferenceError: x is not defined',
    'Minified React error #418',
    'Cannot read properties of undefined',
    '',
  ]) {
    assert.equal(isCancelledSameOriginLoad(message, BASE), false, message);
  }
});

test('still reports a cancelled load from anywhere else', () => {
  for (const message of [
    'https://evil.example/x due to access control checks.',
    '/localhost:4000/api/v1/users/me due to access control checks.',
    '/other.test/thing due to access control checks.',
  ]) {
    assert.equal(isCancelledSameOriginLoad(message, BASE), false, message);
  }
});

test('reports everything when there is no base to compare against', () => {
  assert.equal(
    isCancelledSameOriginLoad('/localhost:8543/x due to access control checks.', null),
    false,
  );
});

test('does not match wording that merely contains the phrase', () => {
  assert.equal(
    isCancelledSameOriginLoad(
      'Error: blocked /localhost:8543/x due to access control checks. and then some',
      BASE,
    ),
    false,
  );
});
