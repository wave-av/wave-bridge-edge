#!/usr/bin/env bash
# Fixture tests for body-policy.sh.
#
# Deliberately fixture-only: the gate is NEVER proved by writing a real leak into a
# live public PR body, because doing so would publish the exact thing it guards.
#
# The negatives here are the load-bearing half. A leak gate that blocks everything
# is trivially "correct" and useless — it gets disabled within a week. The bare
# cross-reference case below is the one that keeps this gate deployable.
set -uo pipefail

SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/body-policy.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# The names the real gate is configured with come from an org variable; the tests
# pin their own so they are hermetic and do not depend on CI configuration.
#
# The pinned names are deliberately SYNTHETIC. This file is world-readable, and
# GUARD_PRIVATE_REPOS exists precisely because private repo names must not be
# hardcoded into a public tree — a fixture that pinned real names would label
# them "private WAVE repos" in public, the exact disclosure the gate prevents.
export GUARD_PRIVATE_REPOS="acme-gateway, acme-transports, acme-billing"

PASS=0; FAIL=0

# expect <exit-code> <name> <body-text>
expect() {
  local want="$1" name="$2" body="$3" out rc
  printf '%s\n' "$body" > "$TMP/body.txt"
  out="$(bash "$SCRIPT" "$TMP/body.txt" 2>&1)"; rc=$?
  if [[ "$rc" == "$want" ]]; then
    PASS=$((PASS+1)); printf '  ok   %s\n' "$name"
  else
    FAIL=$((FAIL+1)); printf '  FAIL %s — want exit %s, got %s\n%s\n' "$name" "$want" "$rc" "$out"
  fi
  # The annotation is world-readable; a hit must never echo the matched text.
  if [[ "$rc" == 1 ]] && printf '%s' "$out" | grep -qF "$body"; then
    FAIL=$((FAIL+1)); printf '  FAIL %s — LEAKED the matched text into the annotation\n' "$name"
  fi
}

echo "body-policy fixtures"

# --- must BLOCK ---------------------------------------------------------------
expect 1 'private repo + credential name' \
  'Flip is live: WAVE_VIEWPORT_LEASE_SECRET is bound on acme-gateway now.'
expect 1 'private repo + credential name, reverse order' \
  'The MOQ_JOIN_SECRET was added; acme-transports picks it up on deploy.'
expect 1 'private repo + secret count' \
  'acme-gateway went from 74 secrets to 75 after this change.'
expect 1 'private repo + service binding' \
  'This adds a service binding from the worker to acme-billing for settlement.'
expect 1 'operator home path' \
  'Repro: run it from /Users/someoperator/Documents/notes and it fails.'  # enforce-ignore (fixture)
expect 1 'internal-only marker' \
  'Attaching the internal-only rollout plan for context.'
# Assembled at run time rather than written as a literal: a fixture that LOOKS like
# a live AWS key trips this repo's own pre-commit secret scanners (it did, on the
# first draft). Splitting the prefix keeps the fixture exercising the real regex
# without parking a credential-shaped string in source.
AKID_FIXTURE="AKI""A1234567890ABCDEF"
expect 1 'AWS access key id' \
  "The failing job had ${AKID_FIXTURE} configured."
# The about-the-control allowlist is for PROSE rules only. A formatted credential
# on a line that happens to mention the security policy is still a live leak.
expect 1 'credential on a line mentioning SECURITY.md still blocks' \
  "Per SECURITY.md, reporting that ${AKID_FIXTURE} was pasted here."
expect 1 'internal tailscale IP' \
  'It resolves to 100.71.4.19 from inside the fleet.'
# Repo names stay case-insensitive after scoping (?i:) to the name alternation.
expect 1 'private repo name matches case-insensitively' \
  'Acme-Gateway went from 74 secrets to 75 after this change.'
# Regression: prose rules used to be case-sensitive, so the SAME phrase written
# the normal way — capitalized at the start of a sentence — passed silently.
expect 1 'sentence-initial "Do not share" still blocks' \
  'Do not share this outside the team.'
expect 1 'capitalized Internal-Only marker still blocks' \
  'Attaching the Internal-Only rollout plan.'
expect 1 'capitalized For Internal Use still blocks' \
  'For Internal Use only, see attached.'
expect 1 'sentence-initial Service binding near a private repo still blocks' \
  'Service binding added from the worker to acme-billing.'
expect 1 'sentence-initial Wrangler secret near a private repo still blocks' \
  'Wrangler secret put on acme-gateway is done.'

# --- must PASS (precision — these keep the gate deployable) -------------------
expect 0 'bare private-repo cross-reference' \
  'This is the companion change to acme-transports#260; merge that one first.'
expect 0 'two private repos, no operational detail' \
  'Both acme-gateway and acme-transports will need a follow-up for this.'
expect 0 'credential NAME with no private repo nearby' \
  'The handler now reads SOME_API_TOKEN from the environment instead of a literal.'
# Regression: a leading inline (?i) used to bleed into OPS_DETAIL, so its
# SCREAMING_CASE-only credential-name branch matched ordinary lowercase words
# and everyday sentences near a repo name got blocked.
expect 0 'lowercase api_key near a private repo name' \
  'Reminder: acme-gateway now reads the api_key from config.'
expect 0 'lowercase private_key near a private repo name' \
  'See acme-gateway docs, section on the private_key rotation.'
# The about-the-control exemption still works where it should: prose rules.
expect 0 'internal-only marker on a line discussing SECURITY.md' \
  'SECURITY.md explains why internal-only material must never be posted publicly.'
expect 0 'public runner path is not an operator path' \
  'CI checks out to /home/runner/work/repo/repo before the scan runs.'  # enforce-ignore (fixture)
expect 0 'talking about the control' \
  'body-policy blocks a private repo named next to a SECRET_TOKEN; that is intended.'
expect 0 'explicit guard:allow with a reason' \
  'Example for the docs: acme-gateway holds EXAMPLE_SECRET — guard:allow documented-example'
expect 0 'ordinary clean body' \
  'Bumps the draft revision and regenerates the fixtures. No behaviour change.'
# Regression: the first CI run of this job failed on its own PR, because a review
# bot edited the body to summarize the change and quoted the marker verbatim.
expect 0 'marker MENTIONED in straight quotes is a description' \
  'Blocks infra identifiers and markers (account_id, home paths, "internal-only" text).'
expect 0 'marker MENTIONED in a code span' \
  'The rule matches `internal-only` and `for internal use` in body text.'
expect 0 'marker MENTIONED in smart quotes' \
  'Blocks operator home paths and “internal-only” text.'
expect 1 'marker USED unquoted still blocks' \
  'Attaching the internal-only rollout plan; do not share outside the team.'

# --- empty GUARD_PRIVATE_REPOS in CI -------------------------------------------
# Two different situations, split by GUARD_PRIVATE_REPOS_EXPECTED (set by the
# workflow). On a same-repo run vars.* ARE delivered, so an empty value is a
# misconfiguration and must FAIL CLOSED — a green check over an unscanned leak
# class is the rubber-stamp failure mode. On a fork-triggered run GitHub
# withholds vars.* entirely, so the skip is announced but non-blocking.
printf '%s\n' 'Ordinary clean body, nothing to see.' > "$TMP/body.txt"
out="$(GUARD_PRIVATE_REPOS='' GUARD_PRIVATE_REPOS_EXPECTED=true GITHUB_ACTIONS=true bash "$SCRIPT" "$TMP/body.txt" 2>&1)"; rc=$?
if [[ "$rc" == 2 ]] && printf '%s' "$out" | grep -q '^::error.*private-repo-ops'; then
  PASS=$((PASS+1)); printf '  ok   empty GUARD_PRIVATE_REPOS on a same-repo CI run fails closed\n'
else
  FAIL=$((FAIL+1)); printf '  FAIL empty GUARD_PRIVATE_REPOS expected in CI — want exit 2 + error, got exit %s\n%s\n' "$rc" "$out"
fi
out="$(env -u GUARD_PRIVATE_REPOS_EXPECTED GUARD_PRIVATE_REPOS='' GITHUB_ACTIONS=true bash "$SCRIPT" "$TMP/body.txt" 2>&1)"; rc=$?
if [[ "$rc" == 0 ]] && printf '%s' "$out" | grep -q '^::warning.*private-repo-ops'; then
  PASS=$((PASS+1)); printf '  ok   empty GUARD_PRIVATE_REPOS on a fork-shaped CI run warns, still exits 0\n'
else
  FAIL=$((FAIL+1)); printf '  FAIL empty GUARD_PRIVATE_REPOS on a fork-shaped run — want exit 0 + warning, got exit %s\n%s\n' "$rc" "$out"
fi
# Locally (outside GitHub Actions) the skip stays silent, as documented.
out="$(env -u GITHUB_ACTIONS GUARD_PRIVATE_REPOS='' bash "$SCRIPT" "$TMP/body.txt" 2>&1)"; rc=$?
if [[ "$rc" == 0 ]] && ! printf '%s' "$out" | grep -q '::warning'; then
  PASS=$((PASS+1)); printf '  ok   empty GUARD_PRIVATE_REPOS locally skips silently\n'
else
  FAIL=$((FAIL+1)); printf '  FAIL empty GUARD_PRIVATE_REPOS locally — want exit 0, no warning, got exit %s\n%s\n' "$rc" "$out"
fi

# --- fail closed --------------------------------------------------------------
# Invoked directly, not through expect(): expect() always materializes a file, so
# it cannot reach these paths. A gate that returns "OK" when it was handed nothing
# to scan is the failure mode this whole file exists to prevent.
for case in "no argument at all::" "nonexistent path::$TMP/does-not-exist.txt"; do
  name="${case%%::*}"; arg="${case##*::}"
  if [[ -n "$arg" ]]; then bash "$SCRIPT" "$arg" >/dev/null 2>&1; else bash "$SCRIPT" >/dev/null 2>&1; fi
  rc=$?
  if [[ "$rc" == 2 ]]; then
    PASS=$((PASS+1)); printf '  ok   %s → exit 2 (fails closed)\n' "$name"
  else
    FAIL=$((FAIL+1)); printf '  FAIL %s — want exit 2, got %s\n' "$name" "$rc"
  fi
done

echo "  ---"
if (( FAIL > 0 )); then
  echo "  $PASS passed, $FAIL FAILED"; exit 1
fi
echo "  $PASS passed, 0 failed"
