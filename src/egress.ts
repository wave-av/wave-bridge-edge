// Realtime → baseband EGRESS SEAM for wave-bridge-edge (task #73 P1).
//
// WHAT THIS IS — a dormant SEAM, not a new egress stack. bridge-edge ALREADY owns container egress
// (the live MoQ strand + the honest-501 SRT/NDI scaffolds). This module teaches a WAVE realtime
// session (a finalized recording object today; a live SFU re-published as MoQ tracks later) to become
// a SOURCE for that EXISTING egress — by routing a typed source descriptor to the SAME
// `handleSrt`/`handleNdi` forward branch, which already FAIL-CLOSES to its typed
// `*_BRIDGE_NOT_ACTIVATED` 501 unless its `[[containers]]` binding is bound + the flag is flipped.
//
// HONESTY CONTRACT (inherited verbatim — NOT weakened here):
//   - This seam adds NO transport of its own. It reuses `srtActivated(env)` / `ndiActivated(env)` as
//     the ONLY activation gates. Today, with SRT_BRIDGE/NDI_BRIDGE commented in wrangler.toml and
//     BRIDGE_FORWARD_ENABLED="false", every target returns the existing honest 501. No fake stream.
//   - The container Go adapter's emit/playout (MoQ/file → SRT/NDI sender) is genuinely net-new and is
//     DESIGN-ONLY here (see the marker below). P1 builds NO image and touches NO Dockerfile.
//
// Source-shape contract: ~/.claude/plans/realtime-recording-dedup/contract-rt-to-bridge-egress.md
// (RECORDED-first: a finalized R2 object the egress container PULLs (outbound GET) → ffmpeg → SRT).

import { handleSrt, type BridgeEnv } from "./srt";
import { handleNdi } from "./ndi";
import { handleOmt } from "./omt";
import { handlePlayout } from "./ffmpeg";

/**
 * A realtime session expressed as a source for bridge-edge's container egress.
 *
 * - `recorded`: a finalized R2 recording object (#34 managed PULL / #67-#68 raw-SFU). `objectUrl` is a
 *   short-lived signed GET the egress container PULLs (outbound) → ffmpeg → target transport. No R2
 *   creds in the container (the DO/driver owns R2; the container is pure transcode/egress).
 * - `live` (DEFERRED, P-later): SFU tracks re-published as MoQ tracks (`moqTrack` =
 *   `${org}/${sessionId}/${trackName}`, the naming #67 uses). Needs a realtime→MoQ republish shim in
 *   wave-realtime-edge — net-new, out of P1 scope.
 */
export interface RealtimeEgressSource {
	mode: "recorded" | "live";
	org: string;
	sessionId: string;
	/** RECORDED mode: short-lived signed GET to the R2 object the container pulls (outbound). */
	objectUrl?: string;
	/** LIVE mode (deferred): MoQ track name `${org}/${sessionId}/${trackName}` to subscribe. */
	moqTrack?: string;
	/** Which baseband transport to egress to. SRT, NDI, OMT each route to their own honest-501 handler. */
	target: "srt" | "ndi" | "omt";
}

/** Baseband transports that have a real bridge route. The full inert matrix: SRT, NDI, OMT. Each handler
 *  fail-closes to its own typed `*_BRIDGE_NOT_ACTIVATED` 501 unless its `[[containers]]` binding is bound. */
export type RoutableTarget = "srt" | "ndi" | "omt";

/** Per-target handler map — REUSES the existing protocol handlers VERBATIM (no new transport). The
 *  per-protocol `*Activated(env)` guard inside each handler is the ONLY activation gate (not weakened). */
const EGRESS_HANDLERS: Record<RoutableTarget, (request: Request, env: BridgeEnv) => Promise<Response>> = {
	srt: handleSrt,
	ndi: handleNdi,
	omt: handleOmt,
};

/**
 * Route an egress target to bridge-edge's EXISTING protocol handler.
 *
 * Returns the handler unchanged for `srt`/`ndi` (each already fail-closes to its honest
 * `*_BRIDGE_NOT_ACTIVATED` 501 unless its `[[containers]]` binding is bound + the flag is on).
 * Returns `undefined` for `omt` (and any future target) that has no route yet — the caller emits the
 * generic honest 501, never a fabricated stream.
 *
 * @param target the egress transport from a `RealtimeEgressSource`.
 * @param _env reserved for future per-target binding-shape selection; the activation gate lives inside
 *             each handler (`srtActivated`/`ndiActivated`), which is NOT bypassed here.
 */
export function selectEgress(
	target: RealtimeEgressSource["target"],
	_env: BridgeEnv,
): ((request: Request, env: BridgeEnv) => Promise<Response>) | undefined {
	if (target === "srt" || target === "ndi" || target === "omt") {
		return EGRESS_HANDLERS[target];
	}
	// Any future target with no route yet → undefined; the caller emits the generic honest 501, never a
	// fabricated stream. (Today the union is exhaustive; this guards forward-compatibly.)
	return undefined;
}

/**
 * RECORDED-first source-stage selector (per contract-rt-to-bridge-egress.md — ACCEPTED ADR).
 *
 * A `mode:'recorded'` descriptor carrying `objectUrl` (a short-lived signed R2 GET) routes FIRST through
 * the ffmpeg file-playout stage (`handlePlayout`): the container PULLs the object (OUTBOUND GET — the
 * favorable direction, no public ingress needed), demuxes, and re-encodes for the chosen transport before
 * handing the elementary stream to `selectEgress(target)`'s sender. This stage ALSO fail-closes to its
 * own honest `FFMPEG_PLAYOUT_NOT_ACTIVATED` 501 until `FFMPEG_BRIDGE` is bound — no fabricated playout.
 *
 * A `mode:'live'` descriptor (DEFERRED): the egress container subscribes the MoQ track directly (no
 * file-playout stage) — but that needs the realtime→MoQ republish shim in wave-realtime-edge (net-new,
 * out of scope here). Returns `undefined` for live so the caller does NOT pretend a playout path exists.
 */
export function selectRecordedPlayout(
	source: RealtimeEgressSource,
	_env: BridgeEnv,
): ((request: Request, env: BridgeEnv) => Promise<Response>) | undefined {
	if (source.mode === "recorded" && typeof source.objectUrl === "string") {
		// DESIGN: the playout container will fetch(objectUrl) → ffmpeg demux/transcode → pipe to the
		// selectEgress(target) sender. Built+proven only in P3 (RECORDED→SRT, the narrowest first slice).
		return handlePlayout;
	}
	// LIVE mode (or a recorded descriptor missing its signed objectUrl) has no playout route here.
	return undefined;
}

// DESIGN (P2/P3) — the adapter EMIT path, per protocol. The containers/{srt,ndi,omt} Go/.NET adapters
// today bridge INGRESS (baseband → MoQ tracks). EGRESS is the REVERSE — MoQ/file → a native SENDER — and
// is the FAVORABLE direction: a sender pushes OUT (outbound), and CF Containers reach the net only
// outbound (containers/moq/README.md), so egress is more tractable than ingress ever was. Genuinely
// net-new; built+proven only in P2/P3. P1 builds NO image, touches NO Dockerfile, fetches NO SDK.
//   • SRT  (containers/srt, libsrt v1.5.5 vendored): MoQ/file → SRT CALLER (push OUT to a customer
//     listener) — outbound, container-friendly; plain ffmpeg codec (H.264/AAC in MPEG-TS). Likely the
//     FIRST baseband receipt (no license gate). `ffplay srt://…` locks the proof.
//   • NDI  (containers/ndi): MoQ/file → NDI 6 sender (NDIlib_send_*), libndi_advanced RUNTIME-FETCHED
//     from the Vizrt-authorized URL once #169/#142 clears — NEVER bundled. LAN-mode wants a host-mode
//     wave-agent on Studio; cloud uses the NDI Discovery Server (WAN). NDI Studio Monitor locks the proof.
//   • OMT  (containers/omt, .NET 8 + libomtnet + libvmx): MoQ/file → OMT sender via libomtnet — open-spec,
//     NO license gate, so it can arm as soon as its image + binding land (one fewer floor than NDI).
//   • RECORDED source-feed (containers/ffmpeg, ffmpeg 8.1.1): fetch(objectUrl) → demux → re-encode →
//     hand the elementary stream to whichever transport sender above. This is the file-playout front-end
//     `selectRecordedPlayout` routes to; the wire transport stays the per-protocol `*_BRIDGE` above.
// All of the above stay dormant behind the operator-gate (`*_BRIDGE` binding + BRIDGE_FORWARD_ENABLED).

export const __testing = { EGRESS_HANDLERS };
