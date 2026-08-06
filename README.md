# wave-bridge-edge

**WAVE bridge edge** — a container-based, any-to-any protocol bridge that translates between broadcast transports (SRT, NDI, Dante, OMT) and MoQ. It is Layer 2 (Bridges) of the [WAVE Protocol Plane](https://github.com/wave-av/wave-foundation/blob/master/frameworks/protocol-plane/README.md).

A Cloudflare Worker routes gateway traffic to Cloudflare Containers running native broadcast-protocol binaries.

## Status

**Early / scaffold.** The Worker serves only `/health`; protocol routes return `501 BRIDGE_NOT_IMPLEMENTED`. Container scaffolds exist under [`containers/`](containers) (`srt`, `ndi`, `omt`, `ffmpeg`); the SRT spike is the first target.

| Protocol | Container | License | Status |
|---|---|---|---|
| SRT | libsrt (MPL-2.0) | open (weak copyleft) | spike planned (Wave 1) |
| NDI | NDI Library | NDI SDK licence terms apply | scaffolded |
| Dante | DAL | Audinate partner license required | research |
| OMT | open reference impl | open | spike planned (Wave 2) |
| ffmpeg | open | open | transcode utility (all protocols) |

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
        ├──→ container:srt    (libsrt UDP handler)
        ├──→ container:ndi    (NDI Library; mDNS via Local Agent)
        ├──→ container:dante  (DAL; only with Audinate partner license)
        └──→ container:omt    (OMT reference impl)
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
