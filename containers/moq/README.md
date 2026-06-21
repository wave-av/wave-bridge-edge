# containers/moq — the WAVE Bridge MoQ strand, hosted

The **cloud anchor** of the WAVE Bridge's 3rd strand: a CF Container that runs the proven MoQ strand
and round-trips real objects through the live relay at **`moq.wave.online`** (the `wave-moq-edge`
product — a Cloudflare Worker + Durable Object). It is fronted by `wave-bridge-edge` at `/bridge`.

## Why this strand is hostable (and SRT/NDI are not, yet)

CF Containers have **no public UDP ingress** — they are Worker-fronted and reach the network via
*outbound* connections (that's why `wave-mux-engine` *pulls* its source rather than receiving a push).
A public `srt://` / NDI listener therefore cannot run here. MoQ is different: the strand reaches the
relay over an **outbound WebSocket/TLS** connection, which works perfectly from inside a container. So
MoQ is the strand that genuinely runs in the cloud; `/srt` and `/ndi` stay honest-501 at the edge
(`src/srt.ts`, `src/ndi.ts`) until a non-UDP ingress path exists for them.

## What runs

- **`moq-strand.mjs`** — vendored **verbatim** from the WAVE transports MoQ strand (built on
  `wave-moq-edge`'s draft-18 wire codec `src/moq-wire.ts` @ `752efd7`). Zero npm deps; a real MoQ client
  of the live relay over the global `WebSocket`. Never hand-edit — re-vendor the bundled strand artifact
  from the upstream transports source.
- **`server.mjs`** — HTTP control plane (port 8080). On `GET /bridge?n=N` it spawns `node
  moq-strand.mjs sub` + `node moq-strand.mjs pub` (exactly as the proven on-prem `roundtrip-test.mjs`),
  pushes N opaque units through the relay, and returns a JSON receipt
  (`{ok, sent, received, integrity_ok, e2e_mean_ms, relay}`). `GET /health` → liveness.
  **No fabrication:** if the relay is unreachable the round-trip fails and the receipt is non-ok (502).

## Flow

```
gateway ─▶ wave-bridge-edge Worker ──.fetch()──▶ [CF Container: server.mjs]
                                                        │ spawns moq-strand.mjs (pub + sub)
                                                        ▼  WSS (outbound, real)
                                                 moq.wave.online (live relay)
```
