// REL-003 regression test: the `expect-marker:` value gam-post-deploy-guard.yml feeds into the
// canary probe MUST match the ACTUAL live /health response shape, not a hand-assumed one.
//
// THE BUG THIS CATCHES (as first found live in wave-moq-edge, and pinned here from the START so
// wave-bridge-edge's NEW guard never ships with the same defect): a hardcoded
// `expect-marker: '"sha":"<sha>"'` — a zero-whitespace JSON key:value substring — can never match
// a real /health endpoint's PRETTY-PRINTED JSON body (`"sha": "<sha>"`, a space after the colon;
// see src/worker.ts's `Response.json({...})` call, which Workers renders pretty-printed).
// `canary-probe.mjs`'s marker check is a literal `body.includes(expectMarker)` substring test, so
// a zero-whitespace marker would read every healthy deploy as "regressed" and roll it back the
// moment GAM_ROLLBACK_ENABLED is turned on.
//
// This test extracts the REAL `expect-marker:` line out of the REAL workflow file (not a
// reimplementation) and proves it matches a body shaped exactly like wave-bridge-edge's live
// /health handler. It is written to FAIL against the broken `"sha":"<sha>"` marker style and PASS
// against the raw-sha marker actually used here, so it pins the fix rather than merely describing
// it.
//
// Run: node --test health-marker-format.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GUARD_YML = join(__dirname, '..', '..', '..', 'workflows', 'gam-post-deploy-guard.yml');

const FAKE_SHA = '22d92fc4a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';

// Mirrors src/worker.ts's /health handler exactly:
//   Response.json({ ok: true, service: "wave-bridge-edge", layer: "bridges", version: "dev", sha })
// Workers' Response.json renders pretty-printed (space after every colon).
const LIVE_HEALTH_BODY = JSON.stringify(
  { ok: true, service: 'wave-bridge-edge', layer: 'bridges', version: 'dev', sha: FAKE_SHA },
  null,
  2,
);

/** Pull the raw `expect-marker: '...'` value out of the real workflow file and substitute the
 *  `${{ steps.target.outputs.sha }}` expression the way GitHub Actions would at run time. This is
 *  extraction, not reimplementation: if the line moves or is reworded, the anchor regex below
 *  fails loudly instead of silently testing stale text. */
function resolvedExpectMarker() {
  const src = readFileSync(GUARD_YML, 'utf8');
  const m = src.match(/expect-marker:\s*'([^']*)'/);
  if (!m) {
    throw new Error('could not find an `expect-marker:` line in gam-post-deploy-guard.yml — extraction anchor drifted, fix this test before trusting it');
  }
  return m[1].replaceAll('${{ steps.target.outputs.sha }}', FAKE_SHA);
}

test('the REAL expect-marker line, resolved, is found verbatim in a pretty-printed (space-after-colon) /health body', () => {
  const marker = resolvedExpectMarker();
  assert.ok(
    LIVE_HEALTH_BODY.includes(marker),
    `resolved marker '${marker}' was not found in a live-shaped health body:\n${LIVE_HEALTH_BODY}`,
  );
});

test('regression pin: a zero-whitespace `"sha":"<sha>"` marker style would NOT match the live pretty-printed body (proves this repo\'s NEW guard avoids the bug wave-moq-edge shipped with)', () => {
  const oldStyleMarker = `"sha":"${FAKE_SHA}"`;
  assert.ok(
    !LIVE_HEALTH_BODY.includes(oldStyleMarker),
    'the old marker style unexpectedly matched — the live body fixture no longer reproduces the bug this test is pinning',
  );
  assert.notEqual(resolvedExpectMarker(), oldStyleMarker);
});
