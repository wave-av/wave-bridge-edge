#!/usr/bin/env bash
# WAVE public-repo BODY policy — the internal-leak gate for PR/issue/comment text.
#
# Companion to content-policy.sh. That script scans the published working TREE;
# this one scans the other half of a public repo's surface: pull-request titles
# and bodies, issue bodies, and comment bodies. Those are equally world-readable
# and, until this script existed, were scanned by NOTHING server-side. That gap
# was not theoretical — a PR was merged whose wrangler.toml was correctly BLOCKED
# for naming a private repo while the PR body named the same repo, with more
# operational detail attached, and sailed through.
#
# Usage: scripts/public-repo-guard/body-policy.sh <file>
#   <file> holds the untrusted text, already materialized to disk. It is passed as
#   a PATH and only ever read — the body is never interpolated into a command line
#   or an environment variable, so no amount of shell metacharacters in a PR body
#   can influence what runs here.
#
# Exit: 0 clean · 1 blocking violation · 2 scanner error (fail closed).
#
# Allowlisting: a line carrying `guard:allow <reason>` is exempt (an accidental
# leak never carries the marker; a deliberate one is visible in a public diff), as
# is any line matching the ABOUT-THE-CONTROL allowlist below.
#
# In BODY text both markers are self-serve: the body's author can edit them in at
# any time, with no reviewable diff. That is the same accepted trade as the
# quoted-marker bypass documented below — the threat model is the ACCIDENTAL
# paste, not a deliberate evader (who could as easily not write the leak, or edit
# the body after the scan ran). The marker still leaves a visible trail: it sits
# in the world-readable body and in GitHub's public edit history for it.
set -uo pipefail

FILE="${1:-}"
[[ -n "$FILE" && -f "$FILE" ]] || { echo "::error::body-policy: usage: body-policy.sh <file>"; exit 2; }
command -v rg >/dev/null 2>&1 || { echo "::error::body-policy: ripgrep (rg) required"; exit 2; }

VIOLATIONS=0

# Lines that TALK ABOUT the control rather than leaking through it. Without this,
# the gate blocks its own pull requests and every security discussion — the
# self-referential trap that gets a gate switched off. Ported verbatim in intent
# from the client-side gate's allowlist, which was built for exactly this.
#
# Opt-in PER RULE (the `about-exempt` argument below), never global. Only the
# prose-shaped rules (internal-marker, private-repo-ops) can legitimately appear
# in a sentence that discusses the gate. A formatted credential has no such
# sentence: "per SECURITY.md, the leaked key is AKIA…" is still a live leak, and
# exempting it would let a real key through because the words around it mention
# security. Credential/identifier rules are therefore filterable only by the
# explicit, visible `guard:allow <reason>` marker.
ABOUT_THE_CONTROL='(public-repo-guard|body-policy|content-policy|public-github-write-gate|\bNDA\s+(gate|guard|policy|denylist|sweep|scan|hook)\b|\bno\s+NDA\b|responsib\w*\s+disclos|SECURITY\.md)'

# check <BLOCK|WARN> <name> <regex> <why> [about-exempt] [multiline]
check() {
  local sev="$1" name="$2" re="$3" why="$4" about="${5:-}" multi="${6:-}"
  [[ -z "$re" ]] && { echo "::error::body-policy: internal bug — empty regex for rule '$name'"; exit 2; }
  # rg exit: 0=match, 1=no match, >=2=real error → FAIL CLOSED. A gate that passes
  # because its scanner broke is worse than no gate: it reports success.
  #
  # `multiline` opts a rule into rg -U so its pattern can span line breaks. The
  # allowlist filters below stay LINE-scoped on purpose: a multi-line match is
  # exempted only where each of its printed lines carries the marker / matches
  # the about-the-control list. Conservative by design — an allow marker on one
  # line must not silently bless leak text on a neighbouring line.
  local raw rc
  local -a _rgflags=(-nP --no-filename)
  [[ "$multi" == "multiline" ]] && _rgflags+=(-U)
  raw="$(rg "${_rgflags[@]}" -- "$re" "$FILE" 2>/dev/null)"; rc=$?
  if (( rc >= 2 )); then
    echo "::error title=public-repo-guard ($name)::ripgrep failed (exit $rc) scanning rule '$name' — failing closed."
    exit 2
  fi
  # Filter with rg, not grep: BSD/macOS grep has no -P, so a `grep -P` allowlist
  # silently errors out locally while working on GNU/CI — the gate would then
  # disagree with itself depending on where it ran. rg is already required above.
  local matches
  matches="$(printf '%s' "$raw" \
    | rg -vN -- 'guard:allow[[:space:]]+[^[:space:]]' || true)"
  if [[ "$about" == "about-exempt" ]]; then
    matches="$(printf '%s' "$matches" | rg -vNiP -- "$ABOUT_THE_CONTROL" || true)"
  fi
  [[ -z "$matches" ]] && return 0
  local count; count="$(printf '%s\n' "$matches" | grep -c '')"
  # Print the LINE NUMBER only — never the matched text. This annotation is itself
  # world-readable, so echoing the hit would re-publish the very thing we caught.
  echo "::group::[$sev] $name — $why"
  printf '%s\n' "$matches" | sed -E 's/^([0-9]+):.*/  line \1: «match redacted — view the body to see it»/'
  echo "::endgroup::"
  if [[ "$sev" == "BLOCK" ]]; then
    echo "::error title=public-repo-guard ($name)::$why — $count occurrence(s) in the title/body. Edit the body to remove it, then re-run."
    VIOLATIONS=$((VIOLATIONS+1))
  else
    echo "::warning title=public-repo-guard ($name)::$why — $count occurrence(s) (non-blocking; review)."
  fi
}

# --- Credential formats — never legitimate in prose --------------------------
check BLOCK stripe-live-key  '(sk|rk)_live_[A-Za-z0-9]{16,}'                 'Live Stripe secret/restricted key'
check BLOCK stripe-account   'acct_[A-Za-z0-9]{16,}'                         'Live Stripe account ID — financial infra, never publish'
check BLOCK anthropic-key    'sk-ant-(api|admin)[0-9]{2}-[A-Za-z0-9_-]{20,}' 'Real Anthropic API/admin key'
check BLOCK github-pat       'github_pat_[A-Za-z0-9_]{30,}'                  'GitHub fine-grained PAT'
check BLOCK supabase-pat     'sbp_[a-f0-9]{40}'                              'Supabase personal access token'
check BLOCK aws-akid         'AKIA[0-9A-Z]{16}'                              'AWS access key ID'
check BLOCK private-key      '-----BEGIN [A-Z ]*PRIVATE KEY-----'            'Embedded private key material'

# --- Infrastructure identifiers ----------------------------------------------
# shellcheck disable=SC2016  # $CLOUDFLARE_ACCOUNT_ID is literal guidance text
check BLOCK cf-account-id    'account_id\s*[:=]\s*["'"'"']?[0-9a-f]{32}'      'Hardcoded Cloudflare account_id — reference the env var instead'
check BLOCK internal-ip      '100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.[0-9]{1,3}\.[0-9]{1,3}'  'Internal Tailscale-CGNAT IP (100.64.0.0/10) — internal fleet address'
# shellcheck disable=SC2016  # $HOME is literal guidance text
check BLOCK abs-user-path    '/(Users|home)/(?!runner/)[a-z][a-z0-9._-]+/'    'Operator absolute home path — leaks identity and local layout'

# --- Self-identified internal material ---------------------------------------
# USE vs MENTION. A body that SAYS "internal-only" is leaking; a body that QUOTES
# the phrase is describing a policy — including this one. The lookarounds exempt a
# marker wrapped in straight, smart, or backtick quotes.
#
# Not hypothetical: the first run of this job failed on its own pull request,
# because a review bot had edited the PR body to summarize the change and its
# summary quoted the phrase verbatim. The line-level allowlist could not help —
# that line named no gate. Only use-vs-mention separates the two.
#
# A quoted marker is also a trivial bypass, and that is an accepted trade. The
# threat here is the ACCIDENTAL paste; a deliberate evader has easier routes, and
# `guard:allow <reason>` already exists as the honest, visible one.
#
# Case-insensitive ((?i:…)): these phrases most often start a sentence — "Do not
# share…", "For Internal Use…" — and a gate that only catches the lowercase
# mid-sentence form misses the normal way the phrase is written.
check BLOCK internal-marker  '(?<![“"'"'"'`])\b(?i:internal[- ]only|do\s+not\s+(?:share|publish|distribute)|for\s+internal\s+use)\b(?![”"'"'"'`])' 'Text self-identifies as not-for-public' about-exempt

# --- Private repo + operational detail (PROXIMITY, not bare name) ------------
# The BODY profile deliberately DIVERGES from the FILE profile here, and the
# divergence is the whole design. content-policy.sh blocks a bare private-repo
# name outright, which is right for a checked-in file. Applying that to bodies
# would be unusable: a sweep of public issues found 134 LEGITIMATE cross-repo
# references ("companion to <private-repo>#260"). A gate that fires on all of
# those gets switched off, and then it protects nothing.
#
# So a bare mention stays silent. What fires is a private repo name within ~140
# characters of INTERNAL OPERATIONAL DETAIL — a SCREAMING_CASE credential NAME, a
# secret-binding verb, a service binding, or a secret COUNT. That is the topology
# of what is wired to what, and it is the shape that actually leaked.
#
# The window spans LINE BREAKS ([\s\S], scanned with rg -U). Real bodies are
# markdown: the repo name sits in a heading or one bullet and the credential in
# the next, which is exactly the shape of the motivating leak — a line-scoped
# window would go blind on the most common layout while claiming "~140
# characters" of proximity.
#
# Names are NOT hardcoded (this file is public); CI injects them via the
# GUARD_PRIVATE_REPOS variable. Unset locally → this check is skipped silently.
# In CI a skip is never quiet (see the block below): on a run that SHOULD have
# received the variable it FAILS CLOSED as a misconfiguration; on a fork run,
# where GitHub withholds vars.* entirely, the skip is ANNOUNCED as a warning.
PRIVATE_REPO_RULE_RAN=0
if [[ -n "${GUARD_PRIVATE_REPOS:-}" ]]; then
  # Case-insensitivity is scoped PER BRANCH: the prose branches ("Wrangler
  # secret…", "Service binding…") get (?i:…) because they routinely start a
  # sentence capitalized; the credential-name branch stays case-sensitive on
  # purpose — SCREAMING_CASE is the signal, and matching lowercase "api_key"
  # would block the everyday sentences the design notes above promise to spare.
  OPS_DETAIL='(?:[A-Z][A-Z0-9]*_(?:SECRET|TOKEN|KEY|PASSWORD)|(?i:wrangler\s+secret|secret\s+(?:is\s+)?(?:bound|binding|list)|(?:is\s+)?bound\s+on|service\s+binding)|\d{2,}\s+secrets)'
  _ALT=''
  # Split on commas, spaces, tabs AND newlines. A plain `read <<<` consumes only
  # the FIRST line of a here-string, so a repo/org variable entered one name per
  # line (the natural shape in the GitHub UI) would silently drop every name
  # after the first while PRIVATE_REPO_RULE_RAN still reported the rule as live.
  # The NUL terminator from printf lets `read -d ''` consume the whole value.
  IFS=$', \t\n' read -r -d '' -a _PRIV < <(printf '%s\0' "$GUARD_PRIVATE_REPOS")
  for _name in "${_PRIV[@]}"; do
    [[ -z "$_name" ]] && continue
    # Regex-escape so metacharacters in a name match literally.
    _esc="$(printf '%s' "$_name" | sed -E 's/[][(){}.^$*+?|\\]/\\&/g')"
    _ALT="${_ALT:+$_ALT|}${_esc}"
  done
  if [[ -n "$_ALT" ]]; then
    PRIVATE_REPO_RULE_RAN=1
    # Both orders: name-then-detail and detail-then-name. Case-insensitivity is
    # scoped to the repo-name alternation with (?i:…) — a leading inline (?i)
    # would bleed into ${OPS_DETAIL} for the rest of the pattern and make its
    # deliberately-SCREAMING_CASE credential-name branch match ordinary prose
    # like "api_key", blocking exactly the harmless sentences the design above
    # promises to leave alone.
    #
    # No \b in front of ${OPS_DETAIL}, in EITHER order. The credential-name
    # branch spans at most one underscore, so in WAVE_VIEWPORT_LEASE_SECRET the
    # only viable match start is LEASE_SECRET — preceded by "_", a word
    # character. A boundary there made the name-then-detail order silently miss
    # every multi-segment credential name while the mirrored order caught them.
    check BLOCK private-repo-ops \
      "\\b(?i:${_ALT})\\b[\\s\\S]{0,140}?${OPS_DETAIL}|${OPS_DETAIL}[\\s\\S]{0,140}?\\b(?i:${_ALT})\\b" \
      'A private WAVE repo named alongside internal operational detail (credential name, secret binding, or secret count) — the wiring topology is not public' \
      about-exempt multiline
  fi
fi
# An empty variable in CI is one of two very different situations, and the
# workflow tells them apart via GUARD_PRIVATE_REPOS_EXPECTED:
#   expected=true — a same-repo run, where GitHub DOES deliver vars.*, so an empty
#     value is a misconfiguration. FAIL CLOSED (exit 2): a green check that
#     scanned nothing for a whole leak class is exactly the rubber stamp every
#     other path in this file refuses to be.
#   otherwise — a fork-triggered (or Dependabot) run. GitHub withholds vars.*
#     from those runs entirely (community/discussions/44322), so the value CANNOT
#     arrive and failing would permanently red every fork PR — which gets the
#     gate switched off. Announce the gap loudly instead; the other body rules
#     all ran, and the same-repo re-scan on merge still has the full rule set.
if (( PRIVATE_REPO_RULE_RAN == 0 )) && [[ "${GITHUB_ACTIONS:-}" == "true" ]]; then
  if [[ "${GUARD_PRIVATE_REPOS_EXPECTED:-}" == "true" ]]; then
    echo "::error title=public-repo-guard (private-repo-ops)::GUARD_PRIVATE_REPOS is empty on a run that should receive it — the private-repo proximity rule scanned NOTHING. Set the repo/org variable; failing closed rather than reporting a pass."
    exit 2
  fi
  echo "::warning title=public-repo-guard (private-repo-ops)::GUARD_PRIVATE_REPOS is empty (GitHub withholds vars.* from fork-triggered runs) — the private-repo proximity rule scanned NOTHING this run; the other body rules did run."
fi

if (( VIOLATIONS > 0 )); then
  echo "::error::public-repo-guard: $VIOLATIONS blocking body-policy violation(s) — see annotations above."
  exit 1
fi
echo "public-repo-guard: body policy OK"
