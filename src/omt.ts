// OMT (Open Media Transport) route handler for wave-bridge-edge — mirrors the SRT honest-501 contract
// VERBATIM (tasks #73 P2/P3 egress matrix). OMT is OPEN-SPEC — no Vizrt-style redistribution clause —
// so it has one FEWER blocker than NDI (no license gate), but the same no-fabrication discipline.
//
// HONESTY CONTRACT — this file deliberately does NOT fabricate transport:
//   - The OMT bridge runs in a CF Container (containers/omt: .NET 8 + libomtnet + libvmx + a Go control
//     plane) whose image is NOT yet built/pushed (scaffold, never published) and CF Containers is NOT
//     enabled on the account. There is therefore NO live OMT endpoint today.
//   - So /omt/* returns a TYPED, HONEST 501 `not_activated` with an accurate Retry-After. It never
//     claims `metered: true` or a live OMT source while the transport cannot run.
//   - A gateway-forward SHAPE is wired behind `BRIDGE_FORWARD_ENABLED` (default OFF). Even when an
//     operator flips it ON, it FAIL-CLOSES to the same honest 501 unless a real `OMT_BRIDGE` container
//     binding is present — i.e. the forward branch is inert until BOTH the image lands AND CF Containers
//     is enabled. No dormant fake success path exists. (OMT being open-spec means no THIRD legal gate.)
//
// Trust model (see threat-model.md): bridge.wave.online sits BEHIND the WAVE API gateway. The gateway runs
// authorize → scope(omt:read|omt:write) → entitlement → meter, then forwards with x-wave-org /
// x-wave-tier attribution headers. This worker is the origin; it makes NO access decision of its own.

import { type BridgeEnv, bindingPresent, forwardToContainer } from "./srt";

/** Seconds a client should wait before retrying — activation is operator-gated, not transient. */
const OMT_RETRY_AFTER_SECONDS = 86_400; // 24h: this is a productization gate, not a blip.

/** Canonical gateway scopes for this protocol (the API gateway scopes.ts rw("omt")).
 *  GET/HEAD → omt:read, mutating verbs → omt:write. NOT "omt:stream" — read/write is the vocabulary. */
const OMT_SCOPES = { read: "omt:read", write: "omt:write" } as const;

/** TRUE only when the forward flag is on AND a real container binding exists. Today: always false. */
function omtActivated(env: BridgeEnv): boolean {
	return env.BRIDGE_FORWARD_ENABLED === "true" && bindingPresent(env.OMT_BRIDGE);
}

/** Honest "not activated yet" body — accurate machine-readable state for agents. Claims nothing live. */
function notActivatedBody(method: string) {
	return {
		error: "OMT_BRIDGE_NOT_ACTIVATED",
		protocol: "omt",
		// Honest lifecycle: scaffold exists (.NET 8 + libomtnet + libvmx + Go control plane) but the
		// transport cannot run yet — the image is unpushed and CF Containers is off. NO license gate.
		status: "not_activated",
		metered: false,
		live: false,
		required_scope: method === "GET" || method === "HEAD" ? OMT_SCOPES.read : OMT_SCOPES.write,
		// Exactly what an operator must do — no hidden magic, no fake success path. Open-spec ⇒ no
		// redistribution-license blocker (the SINGLE difference from the NDI blocker list).
		blockers: [
			"build + push containers/omt image (.NET 8 + libomtnet + libvmx, currently scaffold, unpublished)",
			"enable CF Containers on the account",
			"uncomment the [[containers]] omt-bridge binding in wrangler.toml",
			"set BRIDGE_FORWARD_ENABLED=true",
		],
		docs: "https://bridge.wave.online/llms.txt",
	};
}

/**
 * Handle /omt/* requests.
 *
 * - Activated (flag ON + OMT_BRIDGE bound): forward verbatim to the container. This branch is the
 *   spec'd SHAPE; it is unreachable today (no binding) so it cannot fabricate a source.
 * - Not activated (the only real state today): honest typed 501 + Retry-After.
 */
export async function handleOmt(request: Request, env: BridgeEnv): Promise<Response> {
	if (omtActivated(env)) {
		// SHAPE: hand the request to the OMT container via getContainer (the MoQ pattern). Inert until the
		// image + CF Containers land. The gateway has already authorized/scoped/metered upstream — pure forward.
		return forwardToContainer(env.OMT_BRIDGE!, request);
	}
	return Response.json(notActivatedBody(request.method), {
		status: 501,
		headers: {
			"retry-after": String(OMT_RETRY_AFTER_SECONDS),
			"cache-control": "no-store",
		},
	});
}

export const __testing = { OMT_SCOPES, OMT_RETRY_AFTER_SECONDS, omtActivated, notActivatedBody };
