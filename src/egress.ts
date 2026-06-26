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

/** Seconds a client should wait before retrying a deferred egress path — operator-gated, not transient. */
const EGRESS_RETRY_AFTER_SECONDS = 86_400; // 24h: productization gate, mirrors the per-protocol handlers.

/** Validate an untrusted request body into a typed `RealtimeEgressSource`, or an actionable reason.
 *  Pure + total (never throws): the worker route turns `ok:false` into a typed 400, never a stream. */
function validateSource(
	body: unknown,
): { ok: true; source: RealtimeEgressSource } | { ok: false; reason: string } {
	if (typeof body !== "object" || body === null) return { ok: false, reason: "body must be a JSON object" };
	const b = body as Record<string, unknown>;
	if (b.mode !== "recorded" && b.mode !== "live") return { ok: false, reason: "mode must be 'recorded' or 'live'" };
	if (typeof b.org !== "string" || b.org.length === 0) return { ok: false, reason: "org is required" };
	if (typeof b.sessionId !== "string" || b.sessionId.length === 0) return { ok: false, reason: "sessionId is required" };
	if (b.target !== "srt" && b.target !== "ndi" && b.target !== "omt")
		return { ok: false, reason: "target must be one of srt|ndi|omt" };
	if (b.mode === "recorded" && (typeof b.objectUrl !== "string" || b.objectUrl.length === 0))
		return { ok: false, reason: "recorded mode requires a signed objectUrl" };
	if (b.mode === "live" && (typeof b.moqTrack !== "string" || b.moqTrack.length === 0))
		return { ok: false, reason: "live mode requires a moqTrack name" };
	return {
		ok: true,
		source: {
			mode: b.mode,
			org: b.org,
			sessionId: b.sessionId,
			objectUrl: typeof b.objectUrl === "string" ? b.objectUrl : undefined,
			moqTrack: typeof b.moqTrack === "string" ? b.moqTrack : undefined,
			target: b.target,
		},
	};
}

/**
 * Handle `POST /egress` — the realtime→baseband egress ENTRY ROUTE (task #73 P1.5).
 *
 * This is the missing HTTP seam: it accepts a `RealtimeEgressSource` descriptor and drives the EXISTING
 * `selectRecordedPlayout` / `selectEgress` routing end-to-end, so a finalized realtime recording can ask
 * the bridge to egress it to a baseband transport. It adds NO transport of its own and fabricates NOTHING:
 *   - non-POST            → typed 405 (the descriptor is a body; only POST carries it).
 *   - malformed/invalid   → typed 400 `EGRESS_BAD_REQUEST` with an actionable `reason`.
 *   - unroutable target   → typed 501 `EGRESS_TARGET_NOT_ROUTABLE` (forward-compat; today srt|ndi|omt route).
 *   - `mode:'live'`       → typed 501 `EGRESS_LIVE_MODE_NOT_AVAILABLE` (needs the realtime→MoQ republish
 *                           shim in wave-realtime-edge — net-new, deferred; never a faked live path).
 *   - `mode:'recorded'`   → routes through the ffmpeg file-playout front-end (`handlePlayout`), which itself
 *                           fail-closes to its honest `FFMPEG_PLAYOUT_NOT_ACTIVATED` 501 until `FFMPEG_BRIDGE`
 *                           is bound + the flag is on. When activated, that forward feeds the transport sender.
 *
 * The body is validated on a CLONE so the original request stream stays intact for the downstream forward
 * (when activated, `handlePlayout` hands the verbatim request to the transcode container).
 */
export async function handleEgress(request: Request, env: BridgeEnv): Promise<Response> {
	if (request.method !== "POST") {
		return Response.json(
			{
				error: "EGRESS_METHOD_NOT_ALLOWED",
				protocol: "egress",
				allow: "POST",
				hint: "POST a RealtimeEgressSource descriptor { mode, org, sessionId, target, objectUrl? } to request egress.",
			},
			{ status: 405, headers: { allow: "POST", "cache-control": "no-store" } },
		);
	}

	let parsed: unknown;
	try {
		parsed = await request.clone().json();
	} catch {
		return egressBadRequest("malformed JSON body");
	}
	const v = validateSource(parsed);
	if (!v.ok) return egressBadRequest(v.reason);
	const src = v.source;

	// Forward-compat guard: a target with no real bridge route → honest 501 (today the union is exhaustive).
	if (!selectEgress(src.target, env)) {
		return Response.json(
			{
				error: "EGRESS_TARGET_NOT_ROUTABLE",
				protocol: "egress",
				target: src.target,
				live: false,
				metered: false,
				hint: "No bridge route exists for this target yet — never a fabricated stream.",
			},
			{ status: 501, headers: { "cache-control": "no-store" } },
		);
	}

	if (src.mode === "live") {
		// DEFERRED: live egress needs the realtime→MoQ republish shim (net-new). Never pretend it exists.
		return Response.json(
			{
				error: "EGRESS_LIVE_MODE_NOT_AVAILABLE",
				protocol: "egress",
				mode: "live",
				live: false,
				metered: false,
				blockers: ["realtime→MoQ republish shim in wave-realtime-edge (net-new, deferred)"],
				hint: "Use mode:'recorded' with a finalized R2 objectUrl today.",
			},
			{ status: 501, headers: { "retry-after": String(EGRESS_RETRY_AFTER_SECONDS), "cache-control": "no-store" } },
		);
	}

	// RECORDED mode (the live path today): route FIRST through the ffmpeg file-playout front-end per the
	// ACCEPTED ADR — it PULLs objectUrl → transcode → hands the elementary stream to the selectEgress(target)
	// sender. It fail-closes to its own honest FFMPEG_PLAYOUT_NOT_ACTIVATED 501 until FFMPEG_BRIDGE is bound.
	const playout = selectRecordedPlayout(src, env);
	if (!playout) {
		// validateSource already requires objectUrl for recorded; defensive — never pretend a path exists.
		return egressBadRequest("recorded mode requires a signed objectUrl");
	}
	return playout(request, env);
}

/** Typed 400 for an invalid egress descriptor — actionable reason, never a thrown error or a fake stream. */
function egressBadRequest(reason: string): Response {
	return Response.json(
		{ error: "EGRESS_BAD_REQUEST", protocol: "egress", reason },
		{ status: 400, headers: { "cache-control": "no-store" } },
	);
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

export const __testing = { EGRESS_HANDLERS, validateSource, EGRESS_RETRY_AFTER_SECONDS };
