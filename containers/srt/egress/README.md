# containers/srt/egress — the WAVE Bridge SRT egress sender, hosted

The SRT strand of the WAVE Bridge that **genuinely runs in the cloud**. A CF Container that, on request,
PULLs a finalized recording (short-lived signed R2 GET, outbound) and pushes it to a customer's SRT
listener as MPEG-TS over an **outbound `srt://` caller** session. Fronted by `wave-bridge-edge` at `/srt`.

## Why egress is hostable (and SRT ingress is not)

CF Containers have **no public UDP ingress** — they are Worker-fronted and reach the network only via
*outbound* connections (see `containers/moq/README.md`). A public `srt://` *listener* (ingress) therefore
cannot run here — that's why `containers/srt/adapter` (the SRT↔MoQ ingress Go adapter) stays a scaffold and
can never be the hosted activation path. **Egress is the reverse and favorable direction:** an SRT *caller*
dials OUT to the customer's listener, which works perfectly from inside a container — exactly like the live
MoQ strand's outbound WebSocket.

## What runs

- **`server.mjs`** — HTTP control plane (port 8080), no npm deps. `GET /health` → liveness +
  `stage:"armed"` once the ffmpeg sender is present. A `POST` (the Worker forwards `/srt` here verbatim)
  carrying `{ objectUrl, destUrl, target:"srt", org, sessionId }` spawns:
  ```
  ffmpeg -i <objectUrl> -c copy -f mpegts "srt://<host>:<port>?mode=caller&latency=200"
  ```
  and returns a real receipt `{ ok, bytes_sent, ffmpeg_exit }` (200 on exit 0, 502 on a failed push).
  **No fabrication:** if the ffmpeg binary is missing it fail-closes to an honest `501`.
- **ffmpeg** (built `--enable-libsrt`) + **libsrt v1.5.5** — the real wire sender. `-c copy` remuxes
  H.264/AAC recordings straight into MPEG-TS; libx264 is available for the transcode fallback.

## Security

Both URLs are UNTRUSTED and become ffmpeg I/O sinks (`validate-untrusted-input-before-sink`,
`ssrf-guard-before-user-supplied-url-fetch`): `destUrl` must be `srt://` to a real non-loopback host,
`objectUrl` must be `https://` to a real non-loopback host — loopback / link-local / unspecified hosts are
rejected before ffmpeg is spawned. No R2 credentials live in the container (single-writer A-DO invariant):
only the short-lived signed `objectUrl` it is handed per request.

## Flow

```
gateway ─▶ wave-bridge-edge Worker ──.fetch()──▶ [CF Container: server.mjs]
  /srt (descriptor body)                               │ spawns ffmpeg (libsrt caller)
                                                        ├── outbound HTTPS GET objectUrl (R2)
                                                        ▼  srt:// caller push (outbound, real)
                                                 customer SRT listener
```

## Activation

`/srt` stays an honest `501 SRT_BRIDGE_NOT_ACTIVATED` until BOTH: the `SRT_BRIDGE` binding is provisioned
(now uncommented in `wrangler.toml`) AND `BRIDGE_FORWARD_ENABLED="true"`. See
`docs/runbook-srt-egress-arm.md` for the exact ◆-gated arm sequence and the on-wire `ffplay` receipt.
