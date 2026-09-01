#!/usr/bin/env node
// scripts/ci/bundle-eval-gate.mjs
//
// Ported from wave-av/wave-moq-edge PR #217 (merged to main) via the pilot rollout, the
// systemic prevention for moq-edge #215 — a 5-day prod
// outage where every `wrangler deploy --env production` failed at Cloudflare's upload step with
// `Uncaught ReferenceError: buildTokensCss is not defined`, while `tsc --noEmit` (typecheck.yml)
// and a bundle-only `wrangler deploy --dry-run` (npm run check / deploy:dry) both stayed green
// the whole time. Neither typechecks nor bundles EVALUATE the produced JS — Cloudflare's upload
// step does that server-side, which is why the break shipped silently. wave-bridge-edge
// auto-deploys to prod on every push to main (.github/workflows/deploy.yml, gated only on the
// CLOUDFLARE_API_TOKEN secret being present) and has NO such gate today.
//
// This gate boots the ACTUAL Worker bundle inside workerd via `wrangler dev` (local mode, zero
// Cloudflare credentials) — the same bundling path `wrangler deploy` uses — then a real workerd
// isolate loads the module graph exactly like Cloudflare's upload-time evaluation does. A
// top-level ReferenceError/SyntaxError fails the boot before "Ready on" ever prints, and this
// script fails loudly with the captured error. A clean boot + one successful HTTP round trip is
// the only thing that passes.
//
// ── wave-bridge-edge-specific adaptation (vs. the pilot template) ──────────────────────────────
// The pilot's audit stripped `[ai]` / `[[vectorize]]` — bindings that literally cannot bind
// locally without a live Cloudflare account. wave-bridge-edge has NEITHER of those; its
// wrangler.toml audited clean of remote-credential-only bindings. Instead it declares TWO
// `[[containers]]` blocks (MoqContainer, SrtContainer) whose images ARE buildable fully locally
// via Docker (verified: `wrangler dev` on the UNMODIFIED wrangler.toml boots clean with zero CF
// credentials, Docker builds both images, "Ready on" prints) — so containers are not a
// credential problem here. They are a BUDGET problem: containers/srt/egress/Dockerfile compiles
// ffmpeg n8.1.1 and libsrt v1.5.5 FROM SOURCE (git clone + `./configure && make`) on every
// uncached run, which is a multi-minute-to-tens-of-minutes cold build — the wrong shape for a
// fast per-push/per-PR JS-eval gate (this job's 10-minute timeout exists precisely so a hung
// boot fails loud rather than burning a runner all day) and duplicates work deploy.yml's own
// `wrangler deploy` already does at actual deploy time. So this gate strips BOTH `[[containers]]`
// blocks and their paired `[[durable_objects.bindings]]` blocks (MOQ_BRIDGE, SRT_BRIDGE) —
// mirroring the exact pattern this repo's OWN wrangler.toml already uses for the NDI/OMT/FFmpeg
// container classes, which stay registered in `[[migrations]]` (harmless — just declares the
// SQLite-backed DO class exists) while their `[[containers]]` + binding blocks stay commented
// out/absent. Stripping is safe for THIS gate's purpose: the Worker entry
// (src/worker.ts) re-exports the container DO classes at module scope regardless of whether
// wrangler.toml binds them, and no route touches env.MOQ_BRIDGE / env.SRT_BRIDGE until a request
// actually hits that path — so the module graph still evaluates exactly as it will at deploy,
// and a top-level ReferenceError/SyntaxError anywhere in that graph still fails the boot. What
// this gate does NOT catch: a request-time throw specific to the container-binding code path
// (out of scope — that's `wrangler deploy --dry-run` / `npm run check` plus deploy.yml's own
// real container build, not this gate's job).
//
// Verified locally 2026-09-01 (see PR description for the full transcript): (a) the UNMODIFIED
// wrangler.toml boots clean via `wrangler dev` with zero CF credentials — Docker builds both
// container images and "Ready on" prints, proving neither container binding is a credential
// problem; (b) the STRIPPED derived config also boots clean, with NO Docker build at all (far
// faster, and container-build-free); (c) injecting a module-scope
// `ReferenceError: <undefined identifier> is not defined` into src/worker.ts makes wrangler
// print `Uncaught ReferenceError: ... is not defined` and exit before "Ready on" — confirmed
// caught RED — then the fault was reverted (`git diff` clean) before this PR was opened.
//
// wave-bridge-edge has a single top-level environment (no `[env.production]` block — see
// wrangler.toml's top-level `routes` entries), so unlike the moq-edge template this gate does
// NOT pass `--env production`; top-level IS the deployed config.

import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SOURCE_CONFIG = join(ROOT, "wrangler.toml");
// Derived, gitignored (see .gitignore) — never committed, regenerated every run from the
// deployed wrangler.toml so it cannot drift. Must live at repo root: wrangler resolves `main`
// and every other relative path against the config file's own directory.
const DERIVED_CONFIG = join(ROOT, "wrangler.bundle-eval.generated.toml");

const PORT = process.env.BUNDLE_EVAL_GATE_PORT ?? "18787";
const READY_TIMEOUT_MS = 60_000;
const FAILURE_PATTERNS = [
  /ReferenceError/,
  /is not defined/,
  /SyntaxError/,
  /Uncaught \(in promise\)/,
  /threw an exception/i,
  /Error: Could not resolve/,
];

// The two container-backed DO tables this repo's wrangler.toml declares as LIVE/uncommented
// today (MoqContainer, SrtContainer). Stripped so `wrangler dev` never invokes Docker — see this
// script's header for why that's a budget decision, not a credential one. Both patterns are
// hardcoded literals, never built from a variable: a dynamic RegExp here would be a ReDoS
// footgun for no benefit. If a future container binding is added, add its table header here.
const CONTAINER_TABLE_HEADER = /^\[\[containers\]\]\s*$|^\[\[durable_objects\.bindings\]\]\s*$/;
const ANY_TABLE_HEADER = /^\[/; // `[x]` and `[[x]]` both end the skipped region

function log(...args) {
  console.log("[bundle-eval-gate]", ...args);
}

/**
 * Remove the `[[containers]]` and `[[durable_objects.bindings]]` TOML tables plus the key/value
 * lines belonging to each, stopping at the next table header. `[[migrations]]` is deliberately
 * left untouched — it only registers the SQLite-backed DO class names (already the pattern this
 * repo uses for its NDI/OMT/FFmpeg container classes, which are registered but unbound). Comments
 * above each stripped table are left in place — harmless, and it keeps a diff of the generated
 * file readable when debugging.
 */
function stripContainerTables(toml) {
  const out = [];
  let skipping = false;
  for (const line of toml.split("\n")) {
    if (CONTAINER_TABLE_HEADER.test(line)) {
      skipping = true;
      continue;
    }
    if (skipping) {
      if (ANY_TABLE_HEADER.test(line)) skipping = false;
      else continue;
    }
    out.push(line);
  }
  return out.join("\n");
}

function writeDerivedConfig() {
  writeFileSync(
    DERIVED_CONFIG,
    "# GENERATED by scripts/ci/bundle-eval-gate.mjs — DO NOT EDIT, DO NOT COMMIT.\n" +
      "# Identical to the deployed wrangler.toml except the [[containers]] and\n" +
      "# [[durable_objects.bindings]] tables, which are stripped so `wrangler dev` boots without\n" +
      "# invoking Docker at all (see this script's header comment: this is a CI-budget decision,\n" +
      "# not a credential one — the unmodified wrangler.toml also boots fully local with zero\n" +
      "# Cloudflare credentials, it just costs a multi-minute Docker build of ffmpeg/libsrt from\n" +
      "# source). [[migrations]] is untouched — it only registers DO class names, which this\n" +
      "# repo's own wrangler.toml already does for its unbound NDI/OMT/FFmpeg container classes.\n" +
      stripContainerTables(readFileSync(SOURCE_CONFIG, "utf8")),
  );
  log(
    `derived ${DERIVED_CONFIG} from wrangler.toml ([[containers]] + [[durable_objects.bindings]] stripped for a Docker-free local boot)`,
  );
}

async function main() {
  writeDerivedConfig();

  log(`booting Worker bundle in workerd via 'wrangler dev' on port ${PORT} ...`);

  const child = spawn(
    "npx",
    [
      "wrangler",
      "dev",
      "--config",
      DERIVED_CONFIG,
      "--port",
      PORT,
      "--local-protocol",
      "http",
      "--ip",
      "127.0.0.1",
    ],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        CI: "true",
        WRANGLER_UPDATE_CHECK: "false",
        WRANGLER_SEND_METRICS: "false",
        // Deliberately NO CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID — this gate proves the
        // bundle evaluates with zero Cloudflare credentials, matching the pilot's posture: no
        // deploy-capable secret belongs in a job that runs on every PR push.
        CLOUDFLARE_API_TOKEN: "",
        CLOUDFLARE_ACCOUNT_ID: "",
        CF_API_TOKEN: "",
        CF_ACCOUNT_ID: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let output = "";
  let ready = false;
  let failureLine = null;
  let exited = false;
  let exitCode = null;

  const onData = (buf) => {
    const text = buf.toString();
    output += text;
    process.stdout.write(text);
    if (!ready && /Ready on http/.test(text)) {
      ready = true;
    }
    if (!failureLine) {
      for (const pattern of FAILURE_PATTERNS) {
        const match = text.match(pattern);
        if (match) {
          failureLine = text.trim().split("\n").find((l) => pattern.test(l)) ?? match[0];
          break;
        }
      }
    }
  };

  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  child.on("exit", (code) => {
    exited = true;
    exitCode = code;
  });

  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (!ready && !failureLine && !exited && Date.now() < deadline) {
    await delay(250);
  }

  // Give a fast-failing process a brief grace window to flush its final error output.
  if (!ready && !failureLine) {
    await delay(500);
  }

  const shutdown = () => {
    if (!child.killed) {
      child.kill("SIGTERM");
    }
  };

  const cleanup = () => {
    try {
      unlinkSync(DERIVED_CONFIG);
    } catch {
      // best-effort — a CI runner is thrown away after the job anyway
    }
  };

  if (failureLine || exited) {
    shutdown();
    cleanup();
    log("FAILED — the Worker bundle did not evaluate cleanly in workerd.");
    if (failureLine) log(`Detected failure signature: ${failureLine}`);
    if (exited) log(`wrangler dev exited early with code ${exitCode}`);
    log("--- captured output ---");
    console.log(output);
    process.exitCode = 1;
    return;
  }

  if (!ready) {
    shutdown();
    cleanup();
    log(`FAILED — 'wrangler dev' never printed "Ready on" within ${READY_TIMEOUT_MS}ms.`);
    console.log(output);
    process.exitCode = 1;
    return;
  }

  // The module evaluated and the dev server bound its port. Confirm it actually serves a
  // request too — this is exactly the "throws only when Cloudflare EVALUATES the bundle at
  // upload" class (moq-edge #215): the process is up, but hitting it can still surface a
  // request-time throw for some defect shapes, so a green gate proves round-trip, not just
  // process-alive.
  let httpOk = false;
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/health`, {
      signal: AbortSignal.timeout(10_000),
    });
    // Any HTTP status (including 404/401) proves the worker evaluated AND handled a request
    // without throwing — we don't assert a route contract here, only "it's alive".
    httpOk = typeof res.status === "number";
  } catch (err) {
    log(`HTTP round-trip to booted worker failed: ${err}`);
  }

  shutdown();
  cleanup();

  if (!httpOk) {
    log("FAILED — worker process bound its port but did not answer an HTTP request.");
    process.exitCode = 1;
    return;
  }

  log("PASSED — Worker bundle evaluated cleanly in workerd and served a request.");
  process.exitCode = 0;
}

main().catch((err) => {
  console.error("[bundle-eval-gate] unexpected error:", err);
  process.exitCode = 1;
});
