// Tests resolve-dispatch-sha.mjs — the fix for the workflow_dispatch head_sha-vs-actually-deployed
// divergence (REL-003, 2026-09-28). Runs the REAL script as a child process (no mocking).
//
// This is the exact scenario the original guard could not detect: a rollback deploy run is
// triggered via workflow_dispatch with `-f sha=<PRIOR_SHA>`, so GitHub reports that run's own
// `head_sha` as the DISPATCHED REF's (main's) current tip — which, immediately after a bad
// commit lands, IS the regressed commit — never the `sha` input the job actually checked out and
// deployed. Without this fix, the guard would key its canary's expect-marker off the wrong sha.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const execFileP = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, '..', 'resolve-dispatch-sha.mjs');

const C1_PRIOR_GOOD = 'c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1c1';
const C2_REGRESSED = 'c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2';

async function run(displayTitle, headSha) {
  const { stdout } = await execFileP('node', [SCRIPT, displayTitle ?? '', headSha ?? '']);
  return stdout.trim();
}

test('REL-003 regression: workflow_dispatch rollback run — head_sha reports main tip (the regressed commit), but the stamped display_title carries the ACTUAL deployed (rolled-back-to) sha; the stamp must win', async () => {
  const resolved = await run(`deploy @ ${C1_PRIOR_GOOD}`, C2_REGRESSED);
  assert.equal(resolved, C1_PRIOR_GOOD, 'must prefer the stamped sha over head_sha for a dispatch-triggered run');
  assert.notEqual(resolved, C2_REGRESSED, 'must NOT key off head_sha — that is main\'s tip, not what this run actually deployed');
});

test('push-triggered run: display_title stamp matches head_sha (both are the pushed tip) — resolves the same sha either way', async () => {
  const sha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  assert.equal(await run(`deploy @ ${sha}`, sha), sha);
});

test('falls back to head_sha when display_title has no parseable stamp (pre-fix run, or hand-edited title)', async () => {
  const sha = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  assert.equal(await run('deploy', sha), sha);
  assert.equal(await run('', sha), sha);
});

test('accepts a short (7-char) hex sha in the stamp, not only full 40-char', async () => {
  const resolved = await run('deploy @ c1c1c1c', C2_REGRESSED);
  assert.equal(resolved, 'c1c1c1c');
});

test('does not false-match a non-hex or too-short token as a sha stamp', async () => {
  const sha = 'dddddddddddddddddddddddddddddddddddddddd';
  // "deploy" and "main" are not 7-40 char hex tokens — must fall back to head_sha.
  assert.equal(await run('deploy @ main', sha), sha);
});
