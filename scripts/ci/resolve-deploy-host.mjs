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

/** Pure: true if a `routes`/`route` key with a NON-EMPTY value is declared in envName's OWN
 *  scope — mirrors resolveDeployHost()'s exact scoping: the `[env.<envName>]` section (and its
 *  live subsections) when the file declares ANY `[env.*]` section, else (single-config spokes
 *  with no `[env.*]` blocks at all) the top-level scope, and only for envName === "production".
 *  This is the discriminator between "a route is declared for THIS env but didn't resolve" (exit
 *  1, must fail closed) and "nothing is declared for THIS env" (exit 2, safe to skip) — matching
 *  resolveDeployHost()'s own scope exactly is what keeps this from wrongly reading, say, a
 *  DIFFERENT env's route (or a route that a later `[table]` silently absorbed) as "declared here".
 *  An empty declaration (`routes = []`, `route = {}`, or a bare key with nothing after it) counts
 *  as NOT declared — the same "nothing to verify" state as the key being absent entirely. */
export function hasDeclaredRoute(tomlSrc, envName) {
  const lines = tomlSrc.split("\n");
  const sectionHeader = `[env.${envName}]`;
  const subsectionPrefix = `[env.${envName}.`;
  const isRouteKeyLine = (line) => {
    const m = /^(routes|route)\s*=\s*(.*)$/.exec(line);
    if (!m) return false;
    const rhs = m[2].trim();
    return rhs !== "" && rhs !== "[]" && rhs !== "{}";
  };
  let inSection = false;
  let sawEnvHeader = false;
  let inAnyTable = false;
  let declaredInSection = false;
  let declaredTopLevel = false;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.startsWith("#")) continue;
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
      if (isRouteKeyLine(line)) declaredInSection = true;
      continue;
    }
    if (line.startsWith("[")) {
      inAnyTable = true;
      continue;
    }
    if (!inAnyTable && isRouteKeyLine(line)) declaredTopLevel = true;
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
