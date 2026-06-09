# wave-bridge-edge

**WAVE bridge edge** — a container-based, any-to-any protocol bridge that translates between broadcast transports (SRT, NDI, Dante, OMT) and MoQ. It is Layer 2 (Bridges) of the [WAVE Protocol Plane](https://github.com/wave-av/wave-foundation/blob/master/frameworks/protocol-plane/README.md).

A Cloudflare Worker routes gateway traffic to Cloudflare Containers running native broadcast-protocol binaries.

## Status

**Early / scaffold.** The Worker serves only `/health`; protocol routes return `501 BRIDGE_NOT_IMPLEMENTED`. Container scaffolds exist under [`containers/`](containers) (`srt`, `ndi`, `omt`, `ffmpeg`); the SRT spike is the first target.

| Protocol | Container | License | Status |
|---|---|---|---|
| SRT | libsrt (BSD) | open | spike planned (Wave 1) |
| NDI | NDI Library | Newtek redistribution check pending | scaffolded, license-blocked |
| Dante | DAL | Audinate partner license required | research |
| OMT | open reference impl | open | spike planned (Wave 2) |
| ffmpeg | open | open | transcode utility (all protocols) |

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
