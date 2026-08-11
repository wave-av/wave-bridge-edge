# wave-bridge-edge

**WAVE bridge edge** — a container-based, any-to-any protocol bridge that translates between broadcast transports (SRT, NDI, Dante, OMT) and MoQ. It is Layer 2 (Bridges) of the [WAVE Protocol Plane](https://github.com/wave-av/wave-foundation/blob/master/frameworks/protocol-plane/README.md).

A Cloudflare Worker routes gateway traffic to Cloudflare Containers running native broadcast-protocol binaries.

## Status

**LIVE, with honest typed-501s where hosting is architecturally impossible.**

- `/bridge` (MoQ) — **LIVE.** Runs the proven MoQ strand in a CF Container that round-trips real objects through the live `moq.wave.online` relay (on-prem → Cloudflare → on-prem) and returns an integrity receipt. Fail-closes to a typed `501` only when the `MOQ_BRIDGE` container binding is absent.
- `/srt`, `/ndi`, `/omt`, `/playout`, `/egress` — **route handlers built, honest typed `501`.** Every handler fail-closes: CF Containers have **no public UDP ingress** (an architectural constraint, not a roadmap gap) and forwarding stays gated off (`BRIDGE_FORWARD_ENABLED="false"`). Maturity varies per strand: `/srt` has a real egress sender image and a provisioned `SRT_BRIDGE` binding; the NDI, OMT, and ffmpeg container images are still scaffolds with their bindings commented out in [`wrangler.toml`](wrangler.toml). `/ndi` is additionally gated on Vizrt NDI Advanced SDK redistribution (#169). `/playout` is the recorded-first ffmpeg file→transport stage.
- Dante — research only (Audinate partner license required).
- Also live: `/health`. The worker also implements a `/` landing page, `/sitemap.xml`, and `/llms.txt`, but its path-scoped routes ([`wrangler.toml`](wrangler.toml)) deliberately leave the `bridge.wave.online` apex to the Core-Origin app, so those pages are not publicly served by this worker.

> Forwarding is intentionally inert: `BRIDGE_FORWARD_ENABLED` stays `"false"` in [`wrangler.toml`](wrangler.toml). The MoQ strand runs live regardless — forwarding is a separate gate.

| Protocol | Container | License | Status |
|---|---|---|---|
| MoQ | container:moq | open | **LIVE** — round-trips through `moq.wave.online` |
| SRT | libsrt (MPL-2.0) | open (weak copyleft) | typed 501 — sender image + binding provisioned; forwarding gated off, no public UDP ingress |
| NDI | NDI Library | NDI SDK licence terms apply | typed 501 — image scaffold, binding unprovisioned + Vizrt redistribution gate (#169) |
| OMT | open reference impl | open | typed 501 — image scaffold, binding unprovisioned; no public UDP ingress |
| ffmpeg | open | open | typed 501 — recorded-playout stage; image scaffold, binding unprovisioned |
| Dante | DAL | Audinate partner license required | research |

> **libsrt is MPL-2.0, not BSD.** Mozilla Public License 2.0 is *weak copyleft at file
> granularity*: modifications to libsrt's own source files must be released under MPL-2.0, and
> that obligation travels with the binary. Any third-party binary that links libsrt — including
> a downstream consumer linking a WAVE-published artifact — inherits the MPL-2.0 notice and
> source-availability obligations for those files. It does not copyleft our own separate files,
> but it is not the no-obligation "BSD" this table previously implied. Treat any distribution
> path that links libsrt as requiring a licence review.

## Architecture

```
gateway.wave.online (auth / scope / meter)
        │
        ▼
bridge.wave.online (Worker — routes to the right Container)
        │
        ├──→ container:moq    (LIVE — MoQ strand, round-trips through moq.wave.online)
        ├──→ container:srt    (libsrt UDP handler; typed 501 — no public UDP ingress)
        ├──→ container:ndi    (NDI Library; mDNS via Local Agent; typed 501 + #169)
        ├──→ container:omt    (OMT reference impl; typed 501 — no public UDP ingress)
        └──→ container:ffmpeg (recorded-playout stage; typed 501)
```

## Develop

Requires Node.js and a Cloudflare account.

```bash
npm install
npx wrangler dev      # local dev
npm run deploy        # wrangler deploy
```

Worker config is in [`wrangler.toml`](wrangler.toml); container build definitions are under [`containers/`](containers). Secrets handling is in [SECRETS.md](SECRETS.md).

## See also

- [Protocol Plane framework](https://github.com/wave-av/wave-foundation/blob/master/frameworks/protocol-plane/README.md)
- [threat-model.md](threat-model.md) · [SECURITY.md](SECURITY.md) · [CONTRIBUTING.md](CONTRIBUTING.md)

## Links
- [wave.online](https://wave.online) · [Docs](https://docs.wave.online) · [Developer portal](https://dev.wave.online)

Operated by WAVE Online, LLC.
