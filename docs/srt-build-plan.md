# SRT Ingest — Build Scoping Plan

**Status:** scoping (no build). **Owner:** TBD. **Date:** 2026-06-08.
**Goal:** turn the existing ~40% SRT scaffold into a working public SRT ingest reachable at a stable WAVE host, feeding the WAVE pipeline (MoQ/relay).

---

## 1. Where it stands today (inventory)

| Piece | Repo / path | State |
|---|---|---|
| Worker route shape | `wave-av/wave-bridge-edge` `src/srt.ts` | scaffold; returns honest `501 not_activated` |
| Container (Go + libsrt) | `wave-bridge-edge/containers/srt/` (Dockerfile, `adapter/cmd/bridge/main.go`) | builds libsrt 1.5.5; Go `main.go` = scaffold, **no SRT socket loop**, listens `:8080` returning `NotImplemented` |
| Real SRT wire impl (C++) | `wave-av/wave-transports` `srt/`, `srt-adapter/` (`srt_listen`/`srt_accept`) | real protocol code, used by Media Engine; **not** exposed as a public ingest |
| GStreamer SRT listener | `wave-av/wave-modules` `wave-srt-in/` | edge-device (SBC) module, port 9000 listener; not a cloud endpoint |
| SBC profile | `wave-av/wave-profiles` `srt-gateway.yaml` | runs `wave-srt-in` on :9000, re-streams to RTMP/SRT |
| Public host mapping | `wave-foundation/docs/conventions/url-naming.md` | `srt.wave.online → wave-av/wave-srt-edge (future)` — **repo never created** |
| Product listing | `wave-gateway/src/products.ts` | lists `srt.wave.online` status `"preview"` |
| Playback host (consumer) | WSC `PlaybackUrlService.ts` | **hardcodes** `srt.wave.online` |

**Net:** build infra (Dockerfile, Worker route, health endpoint) exists; the actual SRT socket → forward path is 0% implemented; nothing is deployed; `srt.wave.online` is an orange-cloud `AAAA 100::` with no origin (→ 530).

---

## 2. The critical decision BEFORE any code: where does UDP terminate?

SRT is a **UDP** protocol. This breaks two assumptions baked into the current scaffold:

1. **Cloudflare's HTTP proxy (orange-cloud) cannot carry SRT/UDP.** `https://srt.wave.online` and `srt://srt.wave.online:9000` are entirely different planes. A CF-proxied record can serve a *landing page*, never the ingest.
2. **CF Containers (the scaffold's deploy target) are invoked *behind a Worker over HTTP* — they do not get public raw-UDP ingress.** A container bound via `SRT_BRIDGE` receives Worker `fetch` traffic, not inbound UDP on :9000. So the scaffold's "CF Containers + `[[containers]]`" plan likely **cannot accept SRT at all**. This must be validated first — it may invalidate the chosen compute.

**Three viable UDP-ingress architectures (pick one in Phase 0):**

- **A. Dedicated compute with a public IP** (Fly.io UDP app / a small VM / SBC fleet): the libsrt listener binds a real public `:9000/udp`. `srt.wave.online` becomes a **grey-cloud (DNS-only)** A/AAAA record → that IP. Simplest correct path; CF is bypassed for ingest. *Recommended baseline.*
- **B. Cloudflare Spectrum** in front of an origin: CF-proxied raw TCP/UDP. Adds Spectrum activation + cost; keeps everything on CF. Verify Spectrum supports UDP for this account/plan.
- **C. Keep CF Containers** only if Phase-0 validation proves a container can expose public UDP ingress (currently believed **not** possible). If false, drop C.

**Until this is decided, the Go socket work has no deployment target.** Phase 0 is mandatory.

---

## 3. Phased plan

### Phase 0 — Validate ingress + decide compute (½–1 day, no app code)
- Confirm whether CF Containers can terminate public inbound UDP (docs + a throwaway test). Expectation: no.
- Decide A / B / C. Document in `wave-bridge-edge/docs/srt-architecture.md`.
- Decide the **terminating host**: keep `bridge.wave.online/srt` (current scaffold) vs the convention's `srt.wave.online`. Reconcile with `url-naming.md`, `wave-gateway/products.ts`, and the WSC hardcode (they currently disagree).

### Phase 1 — SRT socket loop in the bridge (2–4 days)
- Implement the real listener in `containers/srt/adapter/cmd/bridge/main.go`: `srt_startup → srt_create_socket → srt_bind(:9000) → srt_listen → srt_accept` loop, per-connection goroutine.
- **Reuse, don't re-port:** the working C++ in `wave-transports/srt-adapter` is the reference. Either CGo-bind libsrt directly from Go, or wrap the wave-transports adapter as a sidecar. Avoid a second from-scratch SRT impl.
- Connection auth: streamid → org/key mapping via the gateway (mirror the clip-engine "trust gateway-injected principal" model where possible; SRT has no HTTP headers, so streamid-based auth + a gateway lookup).
- Keep the `:8080` HTTP control/health endpoint for liveness + metrics.

### Phase 2 — Forward SRT → WAVE pipeline (2–3 days)
- Define the egress: SRT payload → MoQ tracks (ties to `wave-moq-edge`) or → the relay/Media Engine ingest. Pick the canonical target with the Media team.
- Flip `BRIDGE_FORWARD_ENABLED` to a real implementation (currently hard-`false`).
- Backpressure / reconnect / drop policy.

### Phase 3 — Build, publish, deploy (1 day)
- Build + push `docker.io/wave-av/wave-srt-bridge` (currently `0.0.0-scaffold`, never pushed) — wire the image tag into CI (`wave-bridge-edge` deploy workflow).
- Deploy to the Phase-0 compute (Fly app / VM / Spectrum origin). NOT CF Containers unless Phase 0 proved UDP ingress.

### Phase 4 — DNS + host wiring (½ day)
- Point the ingest hostname as **grey-cloud DNS-only** → the public ingest IP (A/B). Remove the orange-cloud `AAAA 100::` placeholder that causes today's 530.
- If `srt.wave.online` is the chosen ingest host, the `https://` landing and the `srt://` ingest are separate records/planes — document both.

### Phase 5 — Integration + cutover (1 day)
- Update `wave-gateway/products.ts` status `preview → live`, reconcile `url-naming.md`, and verify the WSC `PlaybackUrlService` hardcode resolves to the live endpoint.
- E2E: publish an SRT stream (OBS/ffmpeg `srt://…:9000?streamid=…`) → confirm it reaches the pipeline.

---

## 4. Decoupled immediate fix for the 530 (independent of the build)

`srt.wave.online` returns 530 now. Regardless of the build timeline, kill it honestly with a tiny CF Worker at `srt.wave.online` serving an **"SRT ingest — preview"** landing + the standard discoverability surfaces (+ a link/redirect to `bridge.wave.online/srt`). This is a ~1-hour task, removes the broken-host signal from the fleet audit, and makes no false promise of working ingest. (This is the "preview page" option; can be done now if you want.)

---

## 5. Risks / open questions

- **R1 (highest):** CF Containers likely can't do public UDP ingress → the scaffold's deploy target may be wrong. Phase 0 resolves this; if confirmed, compute moves to Fly/VM/Spectrum.
- **R2:** Two SRT implementations exist (Go scaffold vs wave-transports C++). Converging on one (reuse C++) avoids divergence + double maintenance.
- **R3:** Host identity is inconsistent across `url-naming.md` (srt.wave.online/future), the scaffold (bridge.wave.online/srt), products.ts (preview), and the WSC hardcode. Pick one canonical ingest host in Phase 0.
- **R4:** Auth model for a header-less UDP protocol (streamid-based) needs design with the gateway team.
- **R5:** Cost — Spectrum (option B) and always-on UDP compute (option A) both carry recurring cost vs today's $0 placeholder.

## 6. Rough estimate
~7–11 working days end-to-end once Phase 0 picks the architecture, excluding CF Spectrum procurement lead time (option B). The 530 mitigation (§4) is independent and ~1 hour.
