# wave-bridge-edge

**Any-to-any protocol bridge** — Layer 2 of the [WAVE Protocol Plane](https://github.com/wave-av/wave-foundation/blob/master/frameworks/protocol-plane/README.md).

Routes Worker traffic to CF Containers (GA 2026-04-13) running native broadcast-protocol binaries:

| Protocol | Container | License | Status |
|---|---|---|---|
| SRT | libsrt (BSD) | open | spike planned (Wave 1) |
| NDI | NDI Library | Newtek redistribution check pending | spike scaffolded, blocked on license |
| Dante | DAL | Audinate partner relationship required | research mode |
| OMT | open ref impl | open | spike planned (Wave 2) |
| ffmpeg | open | open | transcode utility (all protocols) |

## Architecture

```
gateway.wave.online (auth/scope/meter)
        │
        ▼
bridge.wave.online (Worker — routes to right Container)
        │
        ├──→ container:srt  (libsrt UDP handler)
        ├──→ container:ndi  (NDI Library, mDNS bridges via Local Agent)
        ├──→ container:dante (DAL, only with Audinate partner license)
        └──→ container:omt  (OMT ref impl)
```

## Initial wave

Wave 1 (now): **SRT spike** — `containers/srt/Dockerfile` bundles libsrt + a Go bridge that converts SRT UDP → MoQ tracks. Goal: round-trip SRT-in → MoQ-out latency < 200ms.

Wave 2: NDI spike (license-gated).

Wave 3: OMT spike.

Wave 4: Dante research → spike (long pole — Audinate partner relationship).

## Roadmap

See [roadmap issue #1](https://github.com/wave-av/wave-bridge-edge/issues/1) when filed.

## Linked

- [Protocol Plane framework](https://github.com/wave-av/wave-foundation/blob/master/frameworks/protocol-plane/README.md)
- [O5 Bridge — strategic spec](https://github.com/wave-av/wave-foundation/issues/104)
- [WAVE Edge Plane roadmap](https://github.com/wave-av/wave-foundation/issues/95)
