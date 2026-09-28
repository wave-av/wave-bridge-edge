#!/usr/bin/env node
// resolve-dispatch-sha.mjs — extracts the ACTUAL deployed commit sha from a completed `deploy`
// workflow_run event, correctly handling workflow_dispatch-triggered (rollback) runs.
//
// THE BUG THIS FIXES (REL-003, 2026-09-28): `github.event.workflow_run.head_sha` reports the
// DISPATCHED REF's current tip for a workflow_dispatch run — standard GitHub Actions semantics,
// not a bug in this repo's workflow — NEVER the `sha` input that was actually checked out and
// deployed inside the job. Every GAM rollback dispatches
//   gh workflow run deploy.yml --ref main -f sha="${PRIOR_SHA}"
// so on that run's completion event, head_sha is main's CURRENT tip (which may already be a
// newer, unrelated, or even the regressed commit that triggered the rollback), not PRIOR_SHA.
//
// Concrete failure this caused before this fix: commit C2 (bad) lands on main -> deploy.yml
// deploys C2 -> canary correctly detects regression, rolls back via `-f sha=C1` -> the rollback
// run genuinely deploys C1 -> but the NEXT guard run (triggered by the rollback run's own
// workflow_run completion) trusted head_sha and set expect-marker to C2 (main's tip) instead of
// C1 -> canary sees C1 live, calls it "regressed" AGAIN, triggers a second unwanted rollback,
// which can cascade into resolve-prior-good-sha.mjs re-selecting C2's own successful run as
// "prior good" and redeploying the regressed commit.
//
// THE FIX: deploy.yml's `run-name` stamps the RESOLVED sha it actually checked out and deployed
// into the run's `display_title` ("deploy @ <sha>") — GitHub sets `display_title` from
// `run-name` at trigger time, using the SAME `github.event.inputs.sha || github.sha` expression
// the job itself resolves its checkout ref from, so the stamp and the deployed commit can never
// diverge. This script parses that sha back out of display_title, falling back to head_sha only
// when no stamp is present (e.g. a pre-fix run, or `display_title` was hand-edited).
//
// Usage: node resolve-dispatch-sha.mjs <display_title> <head_sha>
// Always exits 0 and prints exactly one sha to stdout (never refuses — the caller already has
// head_sha as a safe fallback; this script's only job is "prefer the stamp when present").
const [displayTitle, headSha] = process.argv.slice(2);

const match = /(?:^|\s)([0-9a-f]{7,40})(?:\s|$)/.exec(String(displayTitle ?? ""));
const resolved = match ? match[1] : String(headSha ?? "");

process.stdout.write(resolved + "\n");
