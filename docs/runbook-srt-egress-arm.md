# Runbook — Arm RECORDED → SRT egress (#73)

> **Status: DORMANT.** Today every step below is UN-done. `/srt` returns the honest typed 501
> `SRT_BRIDGE_NOT_ACTIVATED`; the egress container is a scaffold (honest-501 control plane, no ffmpeg /
> libsrt sender). This runbook is the exact sequence to arm the **RECORDED → SRT** slice — the narrowest
> first baseband receipt (libsrt is BSD, no license gate, so SRT arms before NDI/OMT).
>
> Each step that crosses a named floor (prod deploy, CF Containers enable, account spend, a live flip) is
> marked **◆** — STOP and get Jake to NAME the crossing before performing it. Steps without ◆ are
> read-only or build-only and safe to do unprompted.

## Preconditions (verify before arming)

- A finalized R2 recording object exists (`${org}/realtime-recordings/${sessionId}/recording.{webm,mp4}`
  from #34 managed-PULL or #67/#68 raw-SFU) and you can mint a **short-lived signed GET** (`objectUrl`)
  for it. No long-lived R2 creds go into the container (single-writer A-DO invariant).
- A customer SRT **listener** URL to push to (`srt://<host>:<port>?mode=listener`), or run your own
  `ffplay` listener for the proof (Step 7).
- `bridge.wave.online/srt` is reachable as THIS worker (not the Core-Origin 404). The PR that adds this
  runbook also adds the path-scoped `routes` in wrangler.toml — confirm `curl -s
  https://bridge.wave.online/srt | jq .error` returns `SRT_BRIDGE_NOT_ACTIVATED` (the worker's 501),
  NOT a Next.js 404. If it still 404s, the route did not attach (audit for a stale shadowing Worker Route).

## Arm sequence

### 1. Build the egress image (build-only — no ◆)
Replace the scaffold control-plane image with the real sender. Layer ffmpeg 8.1.1 (mirror
`containers/ffmpeg/Dockerfile`) + libsrt v1.5.5 (mirror `containers/srt/Dockerfile`'s multi-stage build)
into `containers/srt/egress/Dockerfile`, so the container can run:
```
ffmpeg -i "<objectUrl>" -c copy -f mpegts "srt://<host>:<port>?mode=caller&latency=200"
```
`-c copy` when the recording codecs already match SRT/MPEG-TS (H.264/AAC); transcode otherwise. Build
LOCALLY first to smoke the sender against a local `ffplay` listener — do NOT push yet.

### 2. ◆ Push the egress image
**◆** Push `wave-av/wave-srt-egress:<tag>` (account registry). This is the first artifact crossing —
NAME it. Verify the digest pulls clean.

### 3. ◆ Enable CF Containers on the deploying account
**◆** CF Containers must be ON for the account that deploys (the Jake@gmail account — the wave.online
account is free-tier with no Containers). This is an account-capability + spend crossing — NAME it.

### 4. Uncomment the SrtContainer binding (build-only — no ◆)
In `wrangler.toml`, uncomment the `[[containers]] class_name = "SrtContainer"` block + its
`[[durable_objects.bindings]] name = "SRT_BRIDGE"` + the `[[migrations]] new_sqlite_classes` entry. Point
`image` at `./containers/srt/egress/Dockerfile` (or the pushed registry tag). Re-export `SrtContainer`
from `src/worker.ts` (mirroring the `MoqContainer` export) so wrangler can bind the DO class. Run
`npm run check` (`wrangler deploy --dry-run`) — must stay green. This change is INERT until deployed.

### 5. ◆ Flip BRIDGE_FORWARD_ENABLED for SRT
**◆** The activation flag is shared, but each handler fail-closes per-protocol on its own binding. With
`SRT_BRIDGE` now bound (Step 4) AND `BRIDGE_FORWARD_ENABLED="true"`, `srtActivated(env)` becomes true and
`/srt` forwards to the container instead of returning 501. **NDI/OMT/FFMPEG bindings stay commented**, so
flipping the flag arms SRT ONLY — every other protocol still 501s on its absent binding. NAME this flip;
it is the live crossing. (Re-flip to `"false"` or re-comment the binding = instant rollback.)

### 6. ◆ Deploy (merge to main = deploy)
**◆** `deploy.yml` is push-to-main. Merging the armed config DEPLOYS it. NAME the deploy. CI is the
container build host (ubuntu-latest has Docker; the image is never built on a Mac). Watch the deploy
build the egress image and bind the DO.

### 7. Prove with a receipt (the only terminal state)
Drive a stored recording → outbound pull → ffmpeg → srt, and lock the proof:
1. Start a listener: `ffplay -fflags nobuffer "srt://0.0.0.0:9000?mode=listener"` (or point at the
   customer listener).
2. POST the descriptor through the gateway → `bridge.wave.online/srt`:
   `{ "mode":"recorded", "org":"…", "sessionId":"…", "objectUrl":"<signed R2 GET>", "target":"srt",
     "srtUrl":"srt://<listener>:9000?mode=caller" }`
3. **RECEIPT = first frame renders in `ffplay`** (or `ffprobe srt://…` reports a valid stream + the
   container logs `ffmpeg` exit 0 with bytes sent). A 200 from the worker is NOT the receipt — the frame
   on the wire is. Capture: the `ffplay` first-frame + the container's ffmpeg byte/exit log line.

## Rollback (instant, no ◆ to UN-arm)
Set `BRIDGE_FORWARD_ENABLED="false"` OR re-comment the `SrtContainer` binding → `srtActivated(env)`
returns false → `/srt` returns the honest 501 again. Either is sufficient (both conditions are required
to activate); re-comment the binding for the hard stop.

## See also
- `src/egress.ts` — `selectEgress` / `selectRecordedPlayout` (the seam this arms).
- `containers/srt/egress/{server.mjs,Dockerfile}` — the scaffold this runbook turns into a real sender.
- `containers/moq/` — the proven hosted-container pattern this mirrors.
- `~/.claude/plans/realtime-recording-dedup/contract-rt-to-bridge-egress.md` — the RECORDED-first ADR.
