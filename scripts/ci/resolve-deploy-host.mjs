#!/usr/bin/env node
// scripts/ci/resolve-deploy-host.mjs — print the bare hostname of the first `routes[].pattern`
// declared under `[env.<ENV_NAME>]` in wrangler.toml, for a given env name ("production" or
// "staging").
//
// Ported from wave-spoke-template (ci/deploy-ordering, PR #69) with ONE extension: some spokes'
// wrangler.toml has NO `[env.*]` blocks at all — a single-config, fixed-`--name`-deploy spoke (the
// wrangler env-fork bug means an `--env` deploy would silently fork a second worker, so deploy.yml
// pins `--name` instead and there is no `[env.production]` section to look under). The route
// pattern for such a spoke lives at the TOP LEVEL of wrangler.toml, before any `[table]` header
// (config-no-silent-noop: a `routes` key placed after a `[table]` header is parsed as that table's
// field and silently ignored — see wave-bridge-edge/wave-media-edge wrangler.toml comments). When
// wrangler.toml declares no `[env.*]` section AT ALL, fall back to that top-level route for
// envName === "production" only (there is no separate staging domain on these single-config spokes).
//
// Why this exists: .github/workflows/deploy.yml's post-deploy verify step needs to know which live
// host to poll after a deploy, but every spoke names its own domain differently. Deriving the host
// from wrangler.toml itself (the ONE place guaranteed correct, because it is what wrangler actually
// deployed) avoids hardcoding a guess per spoke.
//
// Line-based (not one mega-regex) on purpose: wrangler.toml is full of comments that mention
// `[env.production]` in prose — a naive regex scan of the raw text matches those comments too.
// Parsing line-by-line and skipping `#`-comment lines avoids that trap.
//
// FOUR-STATE exit contract (wave-foundation#1453 / wave-spoke-template#77 postmortem, corrected
// 2026-09-05 — see wave-vision-ingest#15 gitar-bot thread, which correctly flagged the original
// two-state fix that hard-failed ANY empty resolver output for production): a bare "resolved or
// not" collapses two different states the caller MUST treat differently, so the resolver itself
// now tells the caller which:
//   exit 0 + hostname on stdout = resolved.
//   exit 1 + empty stdout       = a route IS declared for this env's own scope, but did not
//                                 resolve — a resolver/TOML-shape regression (the wave-email-edge
//                                 run 33994760933 defect class). Unverifiable. Fail closed.
//   exit 2 + empty stdout       = no route is declared in this env's own scope — a legitimate
//                                 gated draft, a spoke that hasn't added a route yet, or (this
//                                 repo's single-config shape) requesting "staging" when there is
//                                 no separate staging domain at all. Safe to skip.
//   exit 3 + empty stdout       = this script itself crashed unexpectedly.
//
// hasDeclaredRoute() below mirrors resolveDeployHost()'s own scoping exactly (the `[env.<name>]`
// section when one exists anywhere in the file, else the top-level scope for "production" only)
// so the discriminator can never claim a route is "declared" for an env whose own scope doesn't
// actually contain one — never a `grep` in the calling workflow.
//
// Usage: node scripts/ci/resolve-deploy-host.mjs <production|staging>

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
export const WRANGLER_TOML = resolve(__dir, "../../wrangler.toml");

/** Pure: given the raw wrangler.toml text and an env name, return the first route hostname under
 *  `[env.<envName>]` (and its live, non-commented subsections, e.g. `[env.<envName>.vars]`), or the
 *  top-level route (single-config, fixed-`--name` spokes with NO `[env.*]` blocks at all — see
 *  header comment) when envName is "production", or null if neither is present. Ignores
 *  `#`-commented lines entirely (documentation-only example blocks don't count). */
export function resolveDeployHost(tomlSrc, envName) {
  const lines = tomlSrc.split("\n");
  const sectionHeader = `[env.${envName}]`;
  const subsectionPrefix = `[env.${envName}.`;
  let inSection = false;
  let sawEnvHeader = false;
  let inAnyTable = false;
  let topLevelHost = null;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.startsWith("#")) continue; // skip comments/documentation-only examples
    if (line.startsWith("[env.")) sawEnvHeader = true;
    if (line === sectionHeader) {
      inSection = true;
      continue;
    }
    if (inSection && line.startsWith("[")) {
      // A new section header: stay "in" only if it's a live subsection of this same env.
      inSection = line.startsWith(subsectionPrefix);
      continue;
    }
    if (inSection) {
      const m = /pattern\s*=\s*"([^"/]+)/.exec(line);
      if (m) return m[1];
    }
    if (line.startsWith("[")) {
      inAnyTable = true;
      continue;
    }
    if (!inAnyTable && topLevelHost === null) {
      const m = /pattern\s*=\s*"([^"/]+)/.exec(line);
      if (m) topLevelHost = m[1];
    }
  }
  if (!sawEnvHeader && envName === "production" && topLevelHost) return topLevelHost;
  return null;
}

/** Strip a trailing `# comment` from a TOML line, respecting simple double-quoted strings (a `#`
 *  inside quotes is data, not a comment start). Not a full TOML parser — this repo's route lines
 *  never contain an escaped quote or a `#` inside a pattern string, and this is only relied on to
 *  keep hasDeclaredRoute() (below) from misreading `routes = [] # ...` as a non-empty (declared)
 *  value (same class of gap coderabbitai caught in wave-realtime-edge#487's sibling resolver). */
function stripTrailingComment(line) {
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"' && line[i - 1] !== "\\") inQuotes = !inQuotes;
    else if (ch === "#" && !inQuotes) return line.slice(0, i);
  }
  return line;
}

/** Pure: given the (already comment-stripped, trimmed) right-hand side of a `routes = ` /
 *  `route = ` key on line `allLines[index]`, decide whether the value it introduces is EMPTY — a
 *  same-line `[]` / `{}`, or a MULTILINE array/inline-table whose brackets contain nothing but
 *  blank lines and comments before they close (e.g. `routes = [\n]`, a cosmetic reformat of
 *  `routes = []` — the exact shape a `prettier`/manual reflow produces and the bug this function
 *  replaces could not see: the old `rhs !== "" && rhs !== "[]" && rhs !== "{}"` check only ever
 *  looked at the key's OWN line, so a multiline-empty array's rhs was the bare, unbalanced `"["`
 *  — a fourth string matching none of the three sentinels — and the key was misread as non-empty,
 *  i.e. "declared", turning a legitimate exit-2 skip into a false exit-1 fail-closed).
 *
 *  Deliberately conservative rather than a fourth literal sentinel: this tracks BRACKET DEPTH
 *  across as many continuation lines as it takes to close, so it is correct regardless of how
 *  many lines the empty array/table is split across, not just one extra shape. ANY non-bracket,
 *  non-whitespace content between the opening and closing bracket — on the key's own line or a
 *  continuation line — counts as non-empty, matching how the `pattern = "..."` regex in
 *  resolveDeployHost() would find a real route inside that same span. */
function isRouteValueEmpty(rhs, allLines, index) {
  const bracketDelta = (s) => {
    let delta = 0;
    for (const ch of s) {
      if (ch === "[" || ch === "{") delta++;
      else if (ch === "]" || ch === "}") delta--;
    }
    return delta;
  };
  const hasContent = (s) => s.replace(/[[\]{}]/g, "").trim() !== "";
  if (hasContent(rhs)) return false; // real content already on the key's own line
  let depth = bracketDelta(rhs);
  if (depth <= 0) return true; // "[]" / "{}" / bare "" — already balanced (or never opened): empty
  for (let i = index + 1; i < allLines.length; i++) {
    const next = stripTrailingComment(allLines[i]).trim();
    if (next === "") continue; // blank/fully-commented continuation line: keep looking
    if (hasContent(next)) return false; // real content on a continuation line
    depth += bracketDelta(next);
    if (depth <= 0) return true; // closed with nothing but brackets/whitespace in between
  }
  return true; // ran off the end without closing — no content was ever found, so not "declared"
}

/** Pure: true if a `routes`/`route` key with a NON-EMPTY value is declared in envName's OWN
 *  scope — mirrors resolveDeployHost()'s exact scoping: the `[env.<envName>]` section (and its
 *  live subsections) when the file declares ANY `[env.*]` section, else (single-config spokes
 *  with no `[env.*]` blocks at all) the top-level scope, and only for envName === "production".
 *  This is the discriminator between "a route is declared for THIS env but didn't resolve" (exit
 *  1, must fail closed) and "nothing is declared for THIS env" (exit 2, safe to skip) — matching
 *  resolveDeployHost()'s own scope exactly is what keeps this from wrongly reading, say, a
 *  DIFFERENT env's route (or a route that a later `[table]` silently absorbed) as "declared here".
 *  An empty declaration (`routes = []`, `route = {}`, a bare key with nothing after it, or the
 *  same split across multiple lines) counts as NOT declared — the same "nothing to verify" state
 *  as the key being absent entirely; see isRouteValueEmpty() above for the multiline case this
 *  used to get wrong. */
export function hasDeclaredRoute(tomlSrc, envName) {
  const lines = tomlSrc.split("\n");
  const sectionHeader = `[env.${envName}]`;
  const subsectionPrefix = `[env.${envName}.`;
  // `allLines`/`index` are threaded through so isRouteKeyLine() can look ahead across a multiline
  // `routes = [ ... ]` value via isRouteValueEmpty() above — resolveDeployHost() never needs this,
  // it only ever matches a `pattern = "..."` that must live entirely on one line.
  const isRouteKeyLine = (allLines, index) => {
    const line = stripTrailingComment(allLines[index]).trim();
    const m = /^(routes|route)\s*=\s*(.*)$/.exec(line);
    if (!m) return false;
    return !isRouteValueEmpty(m[2].trim(), allLines, index);
  };
  let inSection = false;
  let sawEnvHeader = false;
  let inAnyTable = false;
  let declaredInSection = false;
  let declaredTopLevel = false;
  for (let i = 0; i < lines.length; i++) {
    const line = stripTrailingComment(lines[i]).trim();
    if (line === "") continue;
    if (line.startsWith("[env.")) sawEnvHeader = true;
    if (line === sectionHeader) {
      inSection = true;
      continue;
    }
    if (inSection && line.startsWith("[")) {
      inSection = line.startsWith(subsectionPrefix);
      continue;
    }
    if (inSection) {
      if (isRouteKeyLine(lines, i)) declaredInSection = true;
      continue;
    }
    if (line.startsWith("[")) {
      inAnyTable = true;
      continue;
    }
    if (!inAnyTable && isRouteKeyLine(lines, i)) declaredTopLevel = true;
  }
  if (declaredInSection) return true;
  if (!sawEnvHeader && envName === "production" && declaredTopLevel) return true;
  return false;
}

/** Pure: given the raw wrangler.toml text (or null if wrangler.toml is absent — ENOENT) and an
 *  env name, return `{ host, exitCode }` per the four-state exit contract in the header comment.
 *  Kept separate from readFileSync/process.exit specifically so the exit-code decision (including
 *  the ENOENT-as-null path) is unit-testable without spawning a subprocess. */
export function resolveExitCode(tomlSrcOrNull, envName) {
  if (tomlSrcOrNull === null) return { host: null, exitCode: 2 };
  const host = resolveDeployHost(tomlSrcOrNull, envName);
  if (host) return { host, exitCode: 0 };
  return { host: null, exitCode: hasDeclaredRoute(tomlSrcOrNull, envName) ? 1 : 2 };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const envName = process.argv[2];
  if (envName !== "production" && envName !== "staging") {
    console.error("usage: resolve-deploy-host.mjs <production|staging>");
    process.exit(1);
  }
  try {
    let src = null;
    try {
      src = readFileSync(WRANGLER_TOML, "utf8");
    } catch (err) {
      if (err.code !== "ENOENT") throw err; // any OTHER read error is an unexpected crash below
    }
    const { host, exitCode } = resolveExitCode(src, envName);
    if (host) process.stdout.write(host);
    process.exit(exitCode);
  } catch (err) {
    // An unexpected crash (a parser bug, a permissions error reading wrangler.toml, etc.) is NOT
    // the same state as "a route is declared but unresolved" (exit 1) — Node's default exit code
    // for an uncaught exception is 1, which would silently conflate the two. Exit 3 is reserved
    // for this distinct, genuinely-unexpected state.
    console.error(`resolve-deploy-host.mjs crashed while resolving the deploy host: ${err.stack || err}`);
    process.exit(3);
  }
}
