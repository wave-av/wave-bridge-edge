// scripts/ci/resolve-deploy-host.test.mjs — node:test unit coverage for resolveDeployHost()'s pure
// wrangler.toml parsing. No filesystem, no network. Run via `node --test scripts/ci/*.test.mjs`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, copyFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { resolveDeployHost, hasDeclaredRoute, resolveExitCode } from "./resolve-deploy-host.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESOLVER_PATH = resolve(__dirname, "resolve-deploy-host.mjs");

test("finds the route hostname under [env.production]", () => {
  const toml = `
name = "wave-srt-spoke"
[env.production]
name = "wave-srt-spoke"
routes = [
  { pattern = "srt.wave.online/*", zone_name = "wave.online" }
]
`;
  assert.equal(resolveDeployHost(toml, "production"), "srt.wave.online");
});

test("skips past subsections like [env.production.vars] to find the route", () => {
  const toml = `
[env.production]
routes = [
  { pattern = "wave.online/*", zone_name = "wave.online" }
]
[env.production.observability]
enabled = true
[env.production.vars]
ORIGIN_URL = "https://api.wave.online"
`;
  assert.equal(resolveDeployHost(toml, "production"), "wave.online");
});

test("does not bleed into a different env's section", () => {
  const toml = `
[env.production]
routes = [
  { pattern = "wave.online/*", zone_name = "wave.online" }
]
[env.staging]
routes = [
  { pattern = "staging.wave.online/*", zone_name = "wave.online" }
]
`;
  assert.equal(resolveDeployHost(toml, "production"), "wave.online");
  assert.equal(resolveDeployHost(toml, "staging"), "staging.wave.online");
});

test("returns null when the env section is absent (e.g. the draft template)", () => {
  const toml = `name = "wave-spoke-template"\n[vars]\nWAVE_PRODUCT = "REPLACE_WITH_CATALOG_SKU"\n`;
  assert.equal(resolveDeployHost(toml, "production"), null);
  assert.equal(resolveDeployHost(toml, "staging"), null);
});

test("returns null when the section exists but has no routes", () => {
  const toml = `[env.production]\nname = "x"\n`;
  assert.equal(resolveDeployHost(toml, "production"), null);
});

test("ignores a commented-out mention of the section header in prose", () => {
  const toml = `
# Named envs don't inherit top-level vars; the [env.production] copy further down restates them.
[env.production]
routes = [
  { pattern = "wave.online/*", zone_name = "wave.online" }
]
`;
  assert.equal(resolveDeployHost(toml, "production"), "wave.online");
});

test("ignores a fully commented-out example section (draft template documentation)", () => {
  const toml = `
#   [env.production]
#   route = { pattern = "<proto>.wave.online/*", zone_name = "wave.online" }
`;
  assert.equal(resolveDeployHost(toml, "production"), null);
});

test("supports the singular `route = { ... }` form (not just `routes = [...]`)", () => {
  const toml = `
[env.production]
route = { pattern = "moq.wave.online/*", zone_name = "wave.online" }
`;
  assert.equal(resolveDeployHost(toml, "production"), "moq.wave.online");
});

test("falls back to the top-level route when there are no [env.*] sections at all (single-config, fixed --name deploy spoke)", () => {
  const toml = `
name = "wave-media-edge"
main = "src/index.ts"
workers_dev = false
routes = [{ pattern = "media.wave.online", custom_domain = true }]
[vars]
WAVE_PRODUCT = "media"
`;
  assert.equal(resolveDeployHost(toml, "production"), "media.wave.online");
  assert.equal(resolveDeployHost(toml, "staging"), null);
});

test("top-level fallback ignores a route that appears only inside a later [table] (config-no-silent-noop)", () => {
  const toml = `
name = "wave-example"
[vars]
FOO = "bar"
routes = [{ pattern = "should-not-count.wave.online", custom_domain = true }]
`;
  assert.equal(resolveDeployHost(toml, "production"), null);
});

// ── Four-state exit-code discriminator (hasDeclaredRoute / resolveExitCode) ─────────────────────
//
// hasDeclaredRoute() mirrors resolveDeployHost()'s own scoping exactly (the `[env.<name>]` section
// when the file declares ANY `[env.*]` section, else the top-level scope for "production" only) so
// it can never claim a route is "declared" for an env whose own scope doesn't actually contain one.

test("STATE 1 (resolved, exit 0): [env.production] declares a route that DOES resolve — also counts as declared", () => {
  const toml = `
[env.production]
routes = [{ pattern = "wave.online/*", zone_name = "wave.online" }]
`;
  assert.equal(resolveDeployHost(toml, "production"), "wave.online");
  assert.equal(hasDeclaredRoute(toml, "production"), true);
});

test("STATE 1 (resolved, exit 0): the single-config top-level shape (this repo's actual wrangler.toml) — also counts as declared", () => {
  const toml = `
name = "wave-media-edge"
routes = [{ pattern = "media.wave.online", custom_domain = true }]
[vars]
WAVE_PRODUCT = "media"
`;
  assert.equal(resolveDeployHost(toml, "production"), "media.wave.online");
  assert.equal(hasDeclaredRoute(toml, "production"), true);
});

test("STATE 2 (declared but unresolved, exit 1): a route declared under [env.staging] does not resolve for 'production' and does not count as production-declared either — a route declared under a DIFFERENT env's own section is that env's state, not production's", () => {
  const toml = `
[env.staging]
routes = [{ pattern = "staging.wave.online/*", zone_name = "wave.online" }]
`;
  assert.equal(resolveDeployHost(toml, "production"), null);
  assert.equal(hasDeclaredRoute(toml, "production"), false);
  assert.equal(hasDeclaredRoute(toml, "staging"), true);
});

test("STATE 2 (declared but unresolved, exit 1): [env.production] declares a route key that fails to yield a pattern — a resolver/shape regression, must fail closed", () => {
  const toml = `
[env.production]
routes = [{ zone_name = "wave.online" }]
`;
  assert.equal(resolveDeployHost(toml, "production"), null);
  assert.equal(hasDeclaredRoute(toml, "production"), true);
});

test("STATE 2 (declared but unresolved, exit 1): the single-config top-level shape with a route key that fails to yield a pattern", () => {
  const toml = `
name = "wave-media-edge"
routes = [{ zone_name = "wave.online" }]
[vars]
FOO = "bar"
`;
  assert.equal(resolveDeployHost(toml, "production"), null);
  assert.equal(hasDeclaredRoute(toml, "production"), true);
});

test("STATE 3 (nothing declared, exit 2): the draft template's shape — no [env.*] section, no top-level routes key", () => {
  const toml = `name = "wave-spoke-template"\n[vars]\nWAVE_PRODUCT = "REPLACE_WITH_CATALOG_SKU"\n`;
  assert.equal(hasDeclaredRoute(toml, "production"), false);
});

test("STATE 3 (nothing declared, exit 2): [env.production] section exists but declares no route", () => {
  const toml = `[env.production]\nname = "x"\n`;
  assert.equal(hasDeclaredRoute(toml, "production"), false);
});

test("STATE 3 (nothing declared, exit 2): a single-config repo (no [env.*] at all) queried for 'staging' — there is no separate staging domain by design, not a regression", () => {
  const toml = `
name = "wave-media-edge"
routes = [{ pattern = "media.wave.online", custom_domain = true }]
`;
  assert.equal(resolveDeployHost(toml, "staging"), null);
  assert.equal(hasDeclaredRoute(toml, "staging"), false);
});

test("STATE 3 (nothing declared, exit 2): a route key silently absorbed by a later [table] on a single-config repo does not resolve AND does not count as declared (config-no-silent-noop pitfall: the key is genuinely inert here, matching resolveDeployHost's own top-level-only scan)", () => {
  const toml = `
name = "wave-example"
[vars]
FOO = "bar"
routes = [{ pattern = "should-not-count.wave.online", custom_domain = true }]
`;
  assert.equal(resolveDeployHost(toml, "production"), null);
  assert.equal(hasDeclaredRoute(toml, "production"), false);
});

test("hasDeclaredRoute ignores commented-out route mentions (prose and fully-commented example blocks)", () => {
  const toml = `
# routes = [{ pattern = "not-real.wave.online/*" }] -- just an example in a comment
#   [env.production]
#   route = { pattern = "<proto>.wave.online/*", zone_name = "wave.online" }
`;
  assert.equal(hasDeclaredRoute(toml, "production"), false);
});

test("resolves a MULTILINE top-level routes array — a cosmetic reformat (not a config regression) must not fail closed (coderabbitai review, wave-realtime-edge#487, same class of gap in this repo's sibling resolver)", () => {
  const toml = `
routes = [
  { pattern = "bridge.wave.online/health", zone_name = "wave.online" }
]
`;
  assert.equal(resolveDeployHost(toml, "production"), "bridge.wave.online");
  assert.deepEqual(resolveExitCode(toml, "production"), { host: "bridge.wave.online", exitCode: 0 });
});

test("STATE 3 (nothing declared, exit 2): a trailing inline comment on an empty top-level routes declaration must NOT be misread as a non-empty value (coderabbitai review, wave-realtime-edge#487)", () => {
  const toml = `routes = [] # deliberately empty\n`;
  assert.equal(hasDeclaredRoute(toml, "production"), false);
  assert.deepEqual(resolveExitCode(toml, "production"), { host: null, exitCode: 2 });
});

test("STATE 3 (nothing declared, exit 2): a trailing inline comment on an empty [env.production] routes declaration must NOT be misread as a non-empty value", () => {
  const toml = `[env.production]\nroutes = [] # deliberately empty\n`;
  assert.equal(hasDeclaredRoute(toml, "production"), false);
});

test("a trailing inline comment on a RESOLVED route does not break host extraction", () => {
  const toml = `routes = [{ pattern = "bridge.wave.online/health", zone_name = "wave.online" }] # health route\n`;
  assert.equal(resolveDeployHost(toml, "production"), "bridge.wave.online");
});

test("resolveExitCode STATE 1: resolved (this repo's actual top-level shape) — exit 0 with the hostname", () => {
  const toml = `routes = [{ pattern = "bridge.wave.online/health", zone_name = "wave.online" }]\n`;
  assert.deepEqual(resolveExitCode(toml, "production"), { host: "bridge.wave.online", exitCode: 0 });
});

test("resolveExitCode STATE 2: declared but unresolved — exit 1 with a null host", () => {
  const toml = `routes = [{ zone_name = "wave.online" }]\n`;
  assert.deepEqual(resolveExitCode(toml, "production"), { host: null, exitCode: 1 });
});

test("resolveExitCode STATE 3: nothing declared for 'staging' on this repo's single-config shape — exit 2 with a null host, NOT a failure", () => {
  const toml = `routes = [{ pattern = "bridge.wave.online/health", zone_name = "wave.online" }]\n`;
  assert.deepEqual(resolveExitCode(toml, "staging"), { host: null, exitCode: 2 });
});

test("resolveExitCode STATE 3 (ENOENT equivalent): tomlSrcOrNull === null (wrangler.toml absent) — exit 2 with a null host", () => {
  assert.deepEqual(resolveExitCode(null, "production"), { host: null, exitCode: 2 });
  assert.deepEqual(resolveExitCode(null, "staging"), { host: null, exitCode: 2 });
});

// ── Multiline-empty-array false positive (isRouteValueEmpty) ───────────────────────────────────
//
// The old `isRouteKeyLine` compared the route key's OWN line against exactly three sentinels
// (`""`, `"[]"`, `"{}"`). A multiline-reformatted empty array —
//   routes = [
//   ]
// — puts only `[` on the key's own line, so its rhs was the bare string `"["`: a fourth shape
// matching none of the three sentinels, so the key was misread as non-empty ("declared"),
// producing exit 1 (fail closed) where exit 2 (nothing to verify, safe to skip) is correct. These
// tests cover every emptiness shape from the brief: single-line `[]`, single-line `{}`, and the
// multiline case the old sentinel check could not see — plus a genuinely populated multiline
// route, to prove the fix doesn't just special-case emptiness into a false negative instead.

test("STATE 3 (nothing declared, exit 2): single-line empty `routes = []` at the top level", () => {
  const toml = `routes = []\n`;
  assert.equal(hasDeclaredRoute(toml, "production"), false);
  assert.deepEqual(resolveExitCode(toml, "production"), { host: null, exitCode: 2 });
});

test("STATE 3 (nothing declared, exit 2): single-line empty `route = {}` under [env.production]", () => {
  const toml = `[env.production]\nroute = {}\n`;
  assert.equal(hasDeclaredRoute(toml, "production"), false);
  assert.deepEqual(resolveExitCode(toml, "production"), { host: null, exitCode: 2 });
});

test("STATE 3 (nothing declared, exit 2): MULTILINE empty `routes = [\\n]` at the top level — the exact false-positive this file fixes (old code read this as declared/exit 1)", () => {
  const toml = `
name = "wave-example"
routes = [
]
`;
  assert.equal(hasDeclaredRoute(toml, "production"), false);
  assert.deepEqual(resolveExitCode(toml, "production"), { host: null, exitCode: 2 });
});

test("STATE 3 (nothing declared, exit 2): MULTILINE empty `routes = [\\n]` under [env.production]", () => {
  const toml = `
[env.production]
routes = [
]
`;
  assert.equal(hasDeclaredRoute(toml, "production"), false);
  assert.deepEqual(resolveExitCode(toml, "production"), { host: null, exitCode: 2 });
});

test("STATE 3 (nothing declared, exit 2): MULTILINE empty inline-table `route = {\\n}` with a blank/comment continuation line before the close", () => {
  const toml = `
route = {
  # nothing here yet
}
`;
  assert.equal(hasDeclaredRoute(toml, "production"), false);
  assert.deepEqual(resolveExitCode(toml, "production"), { host: null, exitCode: 2 });
});

test("STATE 1 (resolved, exit 0): a genuinely populated MULTILINE routes array is declared AND resolves — the fix must not turn every multiline array into a false negative", () => {
  const toml = `
[env.production]
routes = [
  { pattern = "bridge.wave.online/*", zone_name = "wave.online" }
]
`;
  assert.equal(hasDeclaredRoute(toml, "production"), true);
  assert.deepEqual(resolveExitCode(toml, "production"), { host: "bridge.wave.online", exitCode: 0 });
});

test("STATE 2 (declared but unresolved, exit 1): a MULTILINE routes array with real content that still fails to yield a pattern is declared, not empty", () => {
  const toml = `
[env.production]
routes = [
  { zone_name = "wave.online" }
]
`;
  assert.equal(hasDeclaredRoute(toml, "production"), true);
  assert.deepEqual(resolveExitCode(toml, "production"), { host: null, exitCode: 1 });
});

// ── exit 3 (unexpected crash) — the CLI entrypoint's fourth state ──────────────────────────────
//
// resolveExitCode() itself never crashes (a pure function over a string or null); exit 3 is
// reserved for the CLI block's own try/catch around readFileSync + resolveExitCode + process.exit.
// wave-bridge-edge#198/wave-realtime-edge#487 both shipped this four-state contract with NO test
// ever driving that path — spawn the actual script as a subprocess against a wrangler.toml that
// fails to read for a reason OTHER than ENOENT (here: the path is a directory, so readFileSync
// throws EISDIR) and assert it exits 3, not 1.
test("CLI: exits 3 (not 1, not an uncaught-exception default of 1) when wrangler.toml exists but fails to read for a non-ENOENT reason", () => {
  // realpathSync: on macOS, os.tmpdir() resolves through a symlink (/tmp -> /private/tmp); the
  // resolver's own `import.meta.url === file://${process.argv[1]}` entrypoint guard compares
  // against the SYMLINK-RESOLVED module URL, so an unresolved tmp path here would silently fail
  // that guard, skip the whole CLI block, and exit 0 — never reaching the crash path at all.
  const tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), "resolve-deploy-host-exit3-")));
  const scriptDir = join(tmpRoot, "scripts", "ci");
  mkdirSync(scriptDir, { recursive: true });
  const scriptCopy = join(scriptDir, "resolve-deploy-host.mjs");
  copyFileSync(RESOLVER_PATH, scriptCopy);
  // wrangler.toml as a DIRECTORY (not a file): readFileSync throws EISDIR, a non-ENOENT error the
  // script must NOT swallow as "absent" (exit 2) — it must fall through to the crash handler.
  mkdirSync(join(tmpRoot, "wrangler.toml"));
  const result = spawnSync(process.execPath, [scriptCopy, "production"], { encoding: "utf8" });
  assert.equal(result.status, 3);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /crashed while resolving the deploy host/);
});
