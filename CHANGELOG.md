# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **SRT egress transport ACTIVATED** (#53) — `containers/srt/egress` is now a REAL sender: the `Dockerfile`
  builds `ffmpeg --enable-libsrt` + libsrt v1.5.5, and `server.mjs` opens an outbound `srt://` caller session
  (`ffmpeg -i <objectUrl> -c copy -f mpegts srt://…?mode=caller`), returning a real receipt
  `{ ok, bytes_sent, ffmpeg_exit }` and fail-closing to an honest 501 if the sender binary is absent. Both
  URLs are SSRF-guarded before reaching an ffmpeg sink (`srt://`/`https://` + non-loopback only). The
  `SRT_BRIDGE` `[[containers]]` binding is now UNCOMMENTED in `wrangler.toml`. SAFETY: `/srt` still returns
  the honest `501 SRT_BRIDGE_NOT_ACTIVATED` until `BRIDGE_FORWARD_ENABLED="true"` (the binding alone does not
  arm — `srtActivated` requires both), so this change is inert until the operator flips the flag.
- **Path-scoped `routes` in `wrangler.toml`** so the worker attaches to `bridge.wave.online/{srt,ndi,omt,
  playout,bridge,health}*` directly. Previously the worker had NO route and was invoked only via the
  gateway service-binding, so `curl bridge.wave.online/srt` fell through to the Core-Origin Next.js app's
  404 — the egress honest-501 was not independently reachable for a receipt. The routes are PATH-SCOPED
  (Worker Routes with `zone_name`, not `custom_domain`) so the Core-Origin apex `/` is untouched. Adding
  a route fabricates no transport — every protocol path still returns its honest typed 501 until armed (#73).
- **SRT egress container scaffold** (`containers/srt/egress/{server.mjs,Dockerfile}`) — the MoQ/file → SRT
  CALLER push-out direction (reverse of the existing SRT ingress adapter), mirroring the `containers/moq`
  hosted-container pattern. Honest-501 control plane (`SRT_EGRESS_NOT_IMPLEMENTED`); the real ffmpeg+libsrt
  sender is added at arm time. The `SRT_BRIDGE` `[[containers]]` binding (now the live-MoQ `class_name`
  schema: `SrtContainer` + durable-object binding + migration) stays **COMMENTED/inert** (#73).
- **`docs/runbook-srt-egress-arm.md`** — the exact ◆-marked steps to arm RECORDED → SRT egress later
  (build+push the egress image, enable CF Containers, uncomment the binding, flip `BRIDGE_FORWARD_ENABLED`,
  drive a stored R2 recording → outbound pull → ffmpeg → srt, prove with `ffplay srt://…` first-frame) (#73).
- `/srt` route with a typed, honest `501 SRT_BRIDGE_NOT_ACTIVATED` response (`status: not_activated`,
  `metered: false`, `live: false`, accurate `Retry-After`, canonical `srt:read`/`srt:write` scope, and
  an explicit operator-blocker list). Gateway-forward SHAPE is wired behind a default-off
  `BRIDGE_FORWARD_ENABLED` flag + `SRT_BRIDGE` container binding; it fail-closes to the 501 until BOTH
  the container image is pushed AND CF Containers is enabled, so it never fabricates transport (#286).
- Workers-pool vitest suite (`test/srt.spec.ts`) + `tsconfig.json` + `typecheck`/`test`/`deploy:dry`
  scripts.

### Changed
- `capabilities.json`: stopped claiming `metered: true` / live endpoints while every route returns 501.
  Each protocol now reports `status: not_activated`, `metered: false`, `live: false` and its canonical
  read/write scopes. This closes a vaporware/security gap (advertised-metered but not live).
