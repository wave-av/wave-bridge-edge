# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
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
