# `containers/dante` — Runtime Contract

This document defines what the WAVE Dante Bridge container needs at runtime to actually pass audio. It's the operator-facing companion to `README.md` (which covers boundary/architecture) and `dante.json.template` (which carries the ISV identity Audinate verifies against).

## The three-legged activation tripod (recap)

```
   ┌─────────────────────────┐  ┌─────────────────────────┐  ┌───────────────────────────┐
   │  1. DEP runtime bundle  │  │  2. dante.json identity │  │  3. License key + DDM     │
   │                         │  │                         │  │     enrollment            │
   │  /opt/dep/dante_package │  │  manfId   = 0x...39     │  │  WAVE_AUDINATE_LICENSE_   │
   │  (fetched at build)     │  │  modelId  = WAVEBRDG    │  │  KEY  (wrangler secret)   │
   │  SHA256-pinned          │  │  rendered at boot from  │  │  + DDM domain enrollment  │
   │                         │  │  the template           │  │  (Connect-solution-level) │
   └─────────────────────────┘  └─────────────────────────┘  └───────────────────────────┘
                                                                         │
                                                                         ▼
                                                          (without DDM enrollment, the device
                                                           presents as ZERO channels in Dante
                                                           Controller — audio cannot flow)
```

## Required runtime env

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `WAVE_AUDINATE_LICENSE_KEY` | ✅ yes | — | Per-endpoint license key issued by Audinate Sales. Must match the `manfId`+`modelId` pair baked into `dante.json` for activation to succeed. Time-based (daily/monthly/yearly) per Connect SDK posture — needs refresh cadence. |
| `WAVE_GATEWAY_BASE` | no | `https://api.wave.online` | Gateway base URL for x402 metering heartbeats + observability emission. |
| `WAVE_GATEWAY_JWKS_URL` | no | `https://api.wave.online/.well-known/jwks.json` | Where this container fetches the gateway's JWKS for inbound JWT validation. |
| `WAVE_AUDINATE_LICENSE_TIER` | no | `developer` | Tier label emitted on x402 heartbeats. **In `production`, the adapter fail-closes at startup** until JWKS signature verification ships (see `main.go::isProdTier`). |
| `WAVE_DANTE_IFACE` | no | `eth0` | NIC name inside the container network namespace. CF Containers default is `eth0`; AWS EC2 example uses `ens5`. |
| `WAVE_DANTE_WS_PORT` | no | `49999` | Websocket port the CLI Dante Activator uses to reach DEP. Pinning this skips device discovery and makes the activate call deterministic. |
| `DEP_BOOT_TIMEOUT_S` | no | `30` | Seconds the entrypoint waits for the `dante` runc container to appear in `runc list` before refusing to start the adapter (fail-fast). |

## Required Cloudflare wrangler bindings

Once `wrangler.toml` is wired (TODO once we deploy):

```toml
[[containers]]
class_name = "DanteBridgeContainer"
image      = "wave-av/wave-dante-bridge:1.5.4.3"
instances  = 1
# CF Containers caveat: Connect SDK was designed for AWS EC2 cross-instance
# audio (see #231); we need to verify the networking semantics work on CF.

[[wrangler.secrets]]
name = "WAVE_AUDINATE_LICENSE_KEY"

[vars]
WAVE_AUDINATE_LICENSE_TIER = "developer"
WAVE_GATEWAY_BASE = "https://api.wave.online"
```

## DDM (Dante Domain Manager) — the channel-activation gate

Per the Dante SDK Connect Edition Getting Started page:

> "Unenrolled Dante SDK devices will initially present as zero-channel devices in Dante Controller. Dante Domain Manager (DDM) for Dante Connect activates channels for Dante SDK when the Dante SDK device is enrolled into a DDM domain, at which point they can be used for audio transport."

This means: even a fully-licensed, correctly-configured, healthy container has **zero audio channels** until enrolled in a DDM domain. DDM is a separate component, **installed and updated by Audinate Sales** as part of a Dante Connect solution.

Open architectural decisions (tracked in tasks #229 + #231):

1. **Who runs DDM for WAVE customers?**
   - (a) WAVE hosts a single DDM instance and enrolls every container at boot — multi-tenant DDM domain per customer.
   - (b) Each customer brings their own DDM — we hand them the modelId + activation token and they enroll on their side.
   - (c) Hybrid — WAVE-hosted for SaaS, customer-hosted for self-managed enterprise.

2. **Where does DDM run?**
   - DDM example deployments assume AWS EC2 instances. CF Containers may or may not support the necessary networking; (a) and (c) above may need a separate VPC/EC2 footprint.

3. **What's the enrollment trigger?**
   - At container boot? At first-stream subscribe? At a control-plane API call?
   - The Go adapter has a placeholder `/v1/admin/dante/enroll` handler (added in this round) — actual DDM API integration depends on the answer to (1).

## Smoke-test before deploy

From the repo root:

```sh
bash containers/dante/dante.json.test.sh
```

Exits 0 if the template renders to valid JSON with the WAVE product identity in the right slots. Cheap; runs in any environment with `envsubst` + `python3`. Should be wired into CI.

## Known limitations

- **No JWKS signature verification yet** — `requireScope` parses the token structure but does not verify the cryptographic signature. The adapter `fail-closes` if `WAVE_AUDINATE_LICENSE_TIER ∈ {production, prod, live}` until `jose/v2 + JWKS in internal/auth` lands. Developer-tier deployments behind the CF Worker are acceptable.
- **DAL-era references** — historical `~/.wave/drafts/audinate-dal-token-refresh.eml` and similar may surface in older READMEs. Per Audinate's Alex Grieco (2026-06-08): DAL is deprecated for new designs; this container uses DEP + Connect SDK, which is the recommended path.
- **CF Containers vs AWS EC2** — Dante Connect was originally designed for AWS EC2 cross-instance audio. Tracked as task #231.

## Open follow-ups

- **#229** Pivot Wave Node (macOS) from DAL → DVS (Connect SDK is Linux-only — macOS path is different).
- **#230** Chat with Alex Grieco once we have hands-on the SDK package.
- **#231** Investigate CF Containers ↔ AWS EC2 networking compatibility for the Connect cross-instance audio flow.
- **#233** Once the SDK package lands at `~/.wave/dante-sdk/`, wire the Dockerfile to consume it from a local artifact path (currently fetches over the network from `dev.audinate.com`).
