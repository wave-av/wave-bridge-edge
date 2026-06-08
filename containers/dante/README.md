# containers/dante — Dante bridge (DEP-based)

Layer 2 of the [WAVE Protocol Plane](https://github.com/wave-av/wave-foundation/blob/master/frameworks/protocol-plane/README.md).

**This container ships the [Audinate Dante Embedded Platform (DEP)](https://dev.audinate.com) as an OCI runtime bundle** — DEP is a licensed Audinate binary, not an open codec. The container wraps it in a Debian outer layer plus a thin Go control-plane adapter; no Dante source code is included.

## Boundary

| Plane | Owner | What it does |
|---|---|---|
| **Audio + protocol** | DEP (runc-managed `dante` container) | Receives/transmits Dante AES67 audio, runs the official Audinate firmware |
| **Control + observability** | `adapter/` Go binary on `:8080` | JWT validation, x402 heartbeat, structured logs, proxy `/v1/subscribe` etc. to DEP runc-side tools |

The two run in the same outer container but in different process trees — `tini` is PID 1, `entrypoint.sh` starts DEP via `dep.sh start &` (which forks `runc`), then `exec`s the Go adapter so the adapter takes PID 2 and receives Cloudflare Containers' SIGTERM directly on shutdown.

## License posture

- **DEP runtime bundle** — fetched at build-time from `dev.audinate.com` via the buildkit secret-mount cookie at `$HOME/.wave/secrets/dna-cookie.txt`. SHA256-verified post-fetch; pinned in `Dockerfile` ARG `DEP_SHA256`.
- **WAVE_AUDINATE_LICENSE_KEY** — per-endpoint license issued by Audinate's License Pool, supplied at runtime via `wrangler secret put`. The first boot activates against Audinate's cloud (one round-trip); subsequent boots no-op because activation state persists in `dante_data/activation/`.
- **Token refresh** — see `~/.wave/drafts/audinate-dal-token-refresh.eml` (manual hand-off to `support@audinate.com`). The current DAL access token expired 2025-07-23; a refresh ticket has been drafted.
- **Production licenses** — DEFERRED per task #141. Current state: developer access only, License Pool balance = 0. Target negotiation: per-active-stream service-provider tier.

This container will **not start** in production until both:
1. `WAVE_AUDINATE_LICENSE_KEY` is set (wrangler secret)
2. The DAL access token in the upstream WAVE Audinate developer account is unexpired

In development, with `--skip-download` mode (via `scripts/fetch-dep-container.sh` in `wave-transports/dante`), the AES67 fallback (`wave-transports/dante/aes67_fallback.cc`) handles RFC 2974 SAP + RFC 4566 SDP + RFC 3550 RTP — same wire format as Dante's AES67 mode, no Audinate code required.

## Build

```sh
export DOCKER_BUILDKIT=1
docker build \
  --secret id=dna_cookie,src=$HOME/.wave/secrets/dna-cookie.txt \
  --build-arg DEP_VERSION=1.5.4.3 \
  -t wave-av/wave-dante-bridge:1.5.4.3 \
  containers/dante
```

## Runtime env

| Var | Purpose | Source |
|---|---|---|
| `WAVE_AUDINATE_LICENSE_KEY` | Per-endpoint Audinate license | `wrangler secret put` |
| `WAVE_GATEWAY_JWKS_URL` | Gateway public-key endpoint for inbound JWT validation | env default `https://api.wave.online/.well-known/jwks.json` |
| `WAVE_GATEWAY_BASE` | x402 + observability endpoints | env default `https://api.wave.online` |

## Endpoints

| Verb | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/health` | none | DEP runc state (the body reports `running`/`status` from the runc list output; activation status is tracked by the `dante_data/activation/.activated` flag — surfaced once the validator follow-up lands) |
| GET | `/v1/devices` | gateway JWT (`dante:read`) | List Dante peers visible on this endpoint |
| GET | `/v1/routes` | gateway JWT (`dante:read`) | Current subscriptions |
| POST | `/v1/subscribe` | gateway JWT (`dante:write`) | `{local_rx_channel: uint32, remote_channel: string, remote_device: string}` |
| POST | `/v1/unsubscribe` | gateway JWT (`dante:write`) | `{local_rx_channel: uint32}` |

> Field names mirror `adapter/cmd/bridge/main.go::subscribeReq` — the runc-side `dante_routing_cli subscribe` invocation needs the local RX channel index plus the upstream `channel@device` qualifier, which is why subscribe carries all three keys and unsubscribe carries only the local index.

JWT validation is currently base64-decode + scope-check pending a `jose/v2`-backed JWKS verifier (lifted into `internal/auth` post-MVP). Today's posture: zero-trust gateway issues short-lived tokens, but the cryptographic signature check is **deferred to follow-on PR**. Do not promote this to a production gateway route until that lands.

## Related

- Upstream library wrapper: `wave-av/wave-transports` PR #6 (`dante/` subtree — DAL C++ wrapper + AES67 fallback)
- Protocol plane spec: `wave-av/wave-foundation` frameworks/protocol-plane
- Cross-layer auth model: protocol-plane `auth-token-spec.md`
- x402 metering spec: protocol-plane `x402-metering-spec.md`
