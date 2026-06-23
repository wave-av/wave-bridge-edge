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
	/** Which baseband transport to egress to. `omt` has no route yet (design-only; see below). */
	target: "srt" | "ndi" | "omt";
}

/** Baseband targets that have a real bridge route today. `omt` deliberately excluded (no `omt.ts`). */
export type RoutableTarget = "srt" | "ndi";

/** Per-target handler map — REUSES the existing protocol handlers VERBATIM (no new transport). */
const EGRESS_HANDLERS: Record<RoutableTarget, (request: Request, env: BridgeEnv) => Promise<Response>> = {
	srt: handleSrt,
	ndi: handleNdi,
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
	if (target === "srt" || target === "ndi") {
		return EGRESS_HANDLERS[target];
	}
	// DESIGN (P2/P3): `omt` egress route — net-new, not built here (no containers/omt handler yet).
	return undefined;
}

// DESIGN (P2/P3): adapter emit path — net-new, not built here. The containers/{srt,ndi} Go adapters
// today bridge INGRESS (baseband → MoQ). The reverse — MoQ/file → SRT/NDI SENDER playout — is genuinely
// net-new and is built+proven only in P2 (NDI) / P3 (SRT). P1 builds NO image and touches NO Dockerfile;
// the egress is dormant behind the existing operator-gate (`*_BRIDGE` binding + BRIDGE_FORWARD_ENABLED).

export const __testing = { EGRESS_HANDLERS };
