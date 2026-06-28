// FFmpeg file-playout route handler for wave-bridge-edge — the RECORDED-first egress ENGINE
// (tasks #73 P1/P3, per contract-rt-to-bridge-egress.md). Mirrors the SRT honest-501 contract VERBATIM.
//
// WHAT THIS STAGE IS — the RECORDED-first source adapter. Per the ACCEPTED ADR, the first egress source
// the bridge consumes is a finalized R2 recording object (`${org}/realtime-recordings/${sessionId}/
// recording.{webm,mp4}` from #34/#67). This stage's container (containers/ffmpeg, ffmpeg 8.1.1) PULLs
// that object via an OUTBOUND signed GET on `objectUrl` (CF Containers reach the net only outbound — see
// containers/moq/README.md), demuxes it, re-encodes for the chosen transport, and HANDS the elementary
// stream to the SRT/NDI/OMT sender. It is NOT a transport itself — it is the playout front-end the
// recorded path flows through before a transport's `*_BRIDGE`. No R2 creds live in the container (the
// DO/driver owns R2; this container is pure transcode/egress — single-writer A-DO invariant).
//
// HONESTY CONTRACT — this file deliberately does NOT fabricate playout:
//   - The ffmpeg playout container's image is NOT yet built/pushed (scaffold) and CF Containers is NOT
//     enabled on the account. There is therefore NO live playout today.
//   - So /playout/* returns a TYPED, HONEST 501 `not_activated` with an accurate Retry-After. It never
//     claims `metered: true` or a live playout while the transcode container cannot run.
//   - A gateway-forward SHAPE is wired behind `BRIDGE_FORWARD_ENABLED` (default OFF). Even flipped ON it
//     FAIL-CLOSES to the same honest 501 unless a real `FFMPEG_BRIDGE` container binding is present.
//
// Trust model: bridge.wave.online sits BEHIND the WAVE API gateway. The gateway runs
// authorize → scope(playout:read|playout:write) → entitlement → meter, then forwards with x-wave-org /
// x-wave-tier attribution headers. This worker is the origin; it makes NO access decision of its own.

import { type BridgeEnv, bindingPresent, forwardToContainer } from "./srt";

/** Seconds a client should wait before retrying — activation is operator-gated, not transient. */
const FFMPEG_RETRY_AFTER_SECONDS = 86_400; // 24h: this is a productization gate, not a blip.

/** Canonical gateway scopes for the file-playout stage. GET/HEAD → playout:read, mutating → playout:write.
 *  The recorded-pull + transcode is a distinct metered capability from the wire transports themselves. */
const PLAYOUT_SCOPES = { read: "playout:read", write: "playout:write" } as const;

/** TRUE only when the forward flag is on AND a real container binding exists. Today: always false. */
function ffmpegActivated(env: BridgeEnv): boolean {
	return env.BRIDGE_FORWARD_ENABLED === "true" && bindingPresent(env.FFMPEG_BRIDGE);
}

/** Honest "not activated yet" body — accurate machine-readable state for agents. Claims nothing live. */
function notActivatedBody(method: string) {
	return {
		error: "FFMPEG_PLAYOUT_NOT_ACTIVATED",
		protocol: "ffmpeg",
		// Honest lifecycle: scaffold exists (ffmpeg 8.1.1 + AV2/AV1/H.264/VP8/Opus lineup) but the
		// playout cannot run yet — the image is unpushed and CF Containers is off.
		status: "not_activated",
		metered: false,
		live: false,
		required_scope: method === "GET" || method === "HEAD" ? PLAYOUT_SCOPES.read : PLAYOUT_SCOPES.write,
		// Exactly what an operator must do — no hidden magic, no fake success path.
		blockers: [
			"build + push containers/ffmpeg image (ffmpeg 8.1.1 transcode, currently scaffold, unpublished)",
			"enable CF Containers on the account",
			"uncomment the [[containers]] ffmpeg-playout binding in wrangler.toml",
			"set BRIDGE_FORWARD_ENABLED=true",
		],
		docs: "https://bridge.wave.online/llms.txt",
	};
}

/**
 * Handle /playout/* requests — the RECORDED-first file→transport playout stage.
 *
 * - Activated (flag ON + FFMPEG_BRIDGE bound): forward verbatim to the transcode container. This branch
 *   is the spec'd SHAPE; it is unreachable today (no binding) so it cannot fabricate a playout.
 * - Not activated (the only real state today): honest typed 501 + Retry-After.
 */
export async function handlePlayout(request: Request, env: BridgeEnv): Promise<Response> {
	if (ffmpegActivated(env)) {
		// SHAPE: hand the request to the ffmpeg transcode container via getContainer (the MoQ pattern).
		// Inert until the image + CF Containers land. The gateway has authorized/scoped/metered upstream.
		return forwardToContainer(env.FFMPEG_BRIDGE!, request);
	}
	return Response.json(notActivatedBody(request.method), {
		status: 501,
		headers: {
			"retry-after": String(FFMPEG_RETRY_AFTER_SECONDS),
			"cache-control": "no-store",
		},
	});
}

export const __testing = { PLAYOUT_SCOPES, FFMPEG_RETRY_AFTER_SECONDS, ffmpegActivated, notActivatedBody };
