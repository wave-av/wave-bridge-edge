// NDI route handler for wave-bridge-edge (mirrors the SRT honest-501 contract; tasks #282 / #136).
//
// HONESTY CONTRACT — this file deliberately does NOT fabricate transport:
//   - The NDI bridge runs in a CF Container (containers/ndi) whose Go ADAPTER builds today but whose
//     `libndi_advanced` runtime is NEVER bundled into the image — Vizrt's redistribution clause is
//     OPERATOR-GATED behind the NDI Developer Program application (wave-foundation task #169). At
//     runtime the container fetches the licensed library from a Vizrt-authorized URL once cleared.
//   - On top of that, the image is not yet pushed and CF Containers is NOT enabled on the account.
//     There is therefore NO live NDI endpoint today.
//   - So /ndi/* returns a TYPED, HONEST 501 `not_activated` with an accurate Retry-After. It never
//     claims `metered: true` or a live `ndi://` endpoint while the transport cannot run.
//   - A gateway-forward SHAPE is wired behind `BRIDGE_FORWARD_ENABLED` (default OFF). Even when an
//     operator flips it ON, it FAIL-CLOSES to the same honest 501 unless a real `NDI_BRIDGE`
//     container binding is present — i.e. the forward branch is inert until BOTH (a) the image lands
//     AND CF Containers is enabled AND (b) the redistribution clause clears (#169). No dormant fake
//     success path exists.
//
// Trust model (see threat-model.md): bridge.wave.online sits BEHIND the WAVE API gateway. The gateway runs
// authorize → scope(ndi:read|ndi:write) → entitlement → meter, then forwards with x-wave-org /
// x-wave-tier attribution headers. This worker is the origin; it makes NO access decision of its own.

import { type BridgeEnv, bindingPresent, forwardToContainer } from "./srt";

/** Seconds a client should wait before retrying — activation is operator-gated, not transient. */
const NDI_RETRY_AFTER_SECONDS = 86_400; // 24h: this is a productization gate, not a blip.

/** Canonical gateway scopes for this protocol (the API gateway scopes.ts rw("ndi"), PR #71 / #281).
 *  GET/HEAD → ndi:read, mutating verbs → ndi:write. NOT "ndi:stream" — read/write is the vocabulary. */
const NDI_SCOPES = { read: "ndi:read", write: "ndi:write" } as const;

/** TRUE only when the forward flag is on AND a real container binding exists. Today: always false. */
function ndiActivated(env: BridgeEnv): boolean {
	return env.BRIDGE_FORWARD_ENABLED === "true" && bindingPresent(env.NDI_BRIDGE);
}

/** Honest "not activated yet" body — accurate machine-readable state for agents. Claims nothing live. */
function notActivatedBody(method: string) {
	return {
		error: "NDI_BRIDGE_NOT_ACTIVATED",
		protocol: "ndi",
		// Honest lifecycle: scaffold exists (Dockerfile + Go adapter bridging NDI ↔ MoQ tracks) but the
		// transport cannot run yet — libndi_advanced is licensed and the image is unpushed.
		status: "not_activated",
		metered: false,
		live: false,
		required_scope: method === "GET" || method === "HEAD" ? NDI_SCOPES.read : NDI_SCOPES.write,
		// Exactly what an operator must do — no hidden magic, no fake success path.
		blockers: [
			"clear Vizrt NDI Advanced SDK redistribution clause (NDI Developer Program, #169)",
			"build + push containers/ndi image with adapter (libndi_advanced fetched at runtime, never bundled)",
			"enable CF Containers on the account",
			"uncomment the [[containers]] ndi-bridge binding in wrangler.toml",
			"set BRIDGE_FORWARD_ENABLED=true",
		],
		docs: "https://bridge.wave.online/llms.txt",
	};
}

/**
 * Handle /ndi/* requests.
 *
 * - Activated (flag ON + NDI_BRIDGE bound): forward verbatim to the container. This branch is the
 *   spec'd SHAPE; it is unreachable today (no binding) so it cannot fabricate a stream.
 * - Not activated (the only real state today): honest typed 501 + Retry-After.
 */
export async function handleNdi(request: Request, env: BridgeEnv): Promise<Response> {
	if (ndiActivated(env)) {
		// SHAPE: hand the request to the NDI container via getContainer (the MoQ pattern). Inert until the
		// image + CF Containers land. The gateway has already authorized/scoped/metered upstream — pure forward.
		return forwardToContainer(env.NDI_BRIDGE!, request);
	}
	return Response.json(notActivatedBody(request.method), {
		status: 501,
		headers: {
			"retry-after": String(NDI_RETRY_AFTER_SECONDS),
			"cache-control": "no-store",
		},
	});
}

export const __testing = { NDI_SCOPES, NDI_RETRY_AFTER_SECONDS, ndiActivated, notActivatedBody };
