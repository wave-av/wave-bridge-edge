// SRT route handler for wave-bridge-edge (task #286).
//
// HONESTY CONTRACT — this file deliberately does NOT fabricate transport:
//   - The SRT bridge runs in a CF Container (containers/srt) that is NOT yet built/pushed
//     (image is `0.0.0-scaffold`, never published) and CF Containers is NOT enabled on the
//     account. There is therefore NO live SRT endpoint today.
//   - So /srt/* returns a TYPED, HONEST 501 `not_activated` with an accurate Retry-After. It never
//     claims `metered: true` or a live `srt://` endpoint while the transport cannot run.
//   - A gateway-forward SHAPE is wired behind `BRIDGE_FORWARD_ENABLED` (default OFF). Even when an
//     operator flips it ON, it FAIL-CLOSES to the same honest 501 unless a real `SRT_BRIDGE`
//     container binding is present — i.e. the forward branch is inert until BOTH the image lands
//     AND CF Containers is enabled. No dormant fake success path exists.
//
// Trust model (see threat-model.md): bridge.wave.online sits BEHIND the WAVE API gateway. The gateway runs
// authorize → scope(srt:read|srt:write) → entitlement → meter, then forwards with x-wave-org /
// x-wave-tier attribution headers. This worker is the origin; it makes NO access decision of its own.
//
// BINDING SHAPE (task #134): every container binding here is a Durable-Object-backed CF Container — the
// SAME shape the live MoQ strand uses (src/moq.ts). The binding is a `DurableObjectNamespace<X>`, reached
// via `getContainer(ns, id).fetch()`; a DurableObjectNamespace exposes `idFromName`, NOT a top-level
// `.fetch`. So activation is gated on `typeof ns?.idFromName === "function"` (never `?.fetch`).
import { getContainer } from "@cloudflare/containers";
import { resolvePoolSize, poolContainerId, isContainerStartFailure, DEFAULT_POOL_SIZE } from "@wave-av/container-pool";
import type { SrtContainer, FfmpegContainer, NdiContainer, OmtContainer } from "./containers";

export interface BridgeEnv {
	/** Default-OFF activation flag. Unset/"false" = honest 501 for every protocol. Flipping to "true"
	 *  only takes effect when the matching per-protocol binding is ALSO present — otherwise each route
	 *  still fail-closes to its typed 501 (no fake transport on any protocol). */
	BRIDGE_FORWARD_ENABLED?: string;
	/** CF Container binding for the SRT↔MoQ bridge. Absent today (image unpushed + Containers off). */
	SRT_BRIDGE?: DurableObjectNamespace<SrtContainer>;
	/** Warm-pool size: how many stable container shards requests hash across (mirrors src/moq.ts's
	 *  MOQ_POOL_SIZE). Tunable WITHOUT a code deploy. Absent/invalid → DEFAULT_POOL_SIZE (from
	 *  @wave-av/container-pool). */
	SRT_POOL_SIZE?: string;
	/** CF Container binding for the NDI↔MoQ bridge. Absent today (license-gated #169 + image unpushed). */
	NDI_BRIDGE?: DurableObjectNamespace<NdiContainer>;
	/** CF Container binding for the OMT (Open Media Transport) bridge. Absent today (image unpushed +
	 *  Containers off). OMT is open-spec — NO license gate (unlike NDI), so it has one fewer blocker. */
	OMT_BRIDGE?: DurableObjectNamespace<OmtContainer>;
	/** CF Container binding for the ffmpeg file-playout stage — the RECORDED-first egress engine that
	 *  PULLs a finalized R2 recording (outbound GET on `objectUrl`) → demux → re-encode → feeds a
	 *  transport (SRT/NDI/OMT). Absent today (image unpushed + Containers off). */
	FFMPEG_BRIDGE?: DurableObjectNamespace<FfmpegContainer>;
}

/** TRUE when a binding is a real DurableObjectNamespace (exposes `idFromName`) — the shape `getContainer`
 *  needs. Mirrors src/moq.ts's `moqActivated`. A DurableObjectNamespace has NO top-level `.fetch`. */
export function bindingPresent(ns: { idFromName?: unknown } | undefined): boolean {
	return typeof ns?.idFromName === "function";
}

/** Seconds a client should wait before retrying — activation is operator-gated, not transient. */
const SRT_RETRY_AFTER_SECONDS = 86_400; // 24h: this is a productization gate, not a blip.

/** Canonical gateway scopes for this protocol (the API gateway scopes.ts rw("srt"), PR #71 / #281).
 *  GET/HEAD → srt:read, mutating verbs → srt:write. NOT "srt:stream" — read/write is the vocabulary. */
const SRT_SCOPES = { read: "srt:read", write: "srt:write" } as const;

/** Transient pool-exhaustion / cold-start failure clears in seconds — not the account-gate horizon. */
const SRT_UNAVAILABLE_RETRY_AFTER_SECONDS = 5;

/** Warm-pool size clamp / stable-id / pool-exhaustion helpers live in @wave-av/container-pool (shared
 *  across every spoke, mirrors src/moq.ts) — see the import above. */

/** Honest typed receipt for a transient container failure (pool exhausted / cold-start) — not a raw 500. */
function srtUnavailableBody() {
	return {
		error: "SRT_BRIDGE_UNAVAILABLE",
		protocol: "srt",
		status: "unavailable",
		metered: false,
		live: false,
		retry_after_seconds: SRT_UNAVAILABLE_RETRY_AFTER_SECONDS,
	};
}

/** Build the honest 503 backpressure Response (shared by the throw path and the returned-5xx path). */
function srtUnavailableResponse(): Response {
	return Response.json(srtUnavailableBody(), {
		status: 503,
		headers: {
			"retry-after": String(SRT_UNAVAILABLE_RETRY_AFTER_SECONDS),
			"cache-control": "no-store",
		},
	});
}

/** Forward a request to a container behind a DurableObjectNamespace, the MoQ way: a bounded warm pool of
 *  stable shard ids (mirrors src/moq.ts's forward path) — never a fresh instance per call. The caller has
 *  already proven the binding is present (`bindingPresent`) and the flag is on. */
export async function forwardToContainer(
	ns: DurableObjectNamespace<SrtContainer | FfmpegContainer | NdiContainer | OmtContainer>,
	request: Request,
	poolSize: number = DEFAULT_POOL_SIZE,
): Promise<Response> {
	const container = getContainer(ns, poolContainerId("srt-bridge", poolSize));
	let res: Response;
	try {
		res = await container.fetch(request);
	} catch {
		return srtUnavailableResponse();
	}
	if (!res.ok || !res.body) {
		const bodyText = await res.text();
		if (isContainerStartFailure(res.status, bodyText)) return srtUnavailableResponse();
		return new Response(bodyText, { status: res.status, headers: res.headers });
	}
	return res;
}

/** TRUE only when the forward flag is on AND a real container binding exists. Today: always false. */
function srtActivated(env: BridgeEnv): boolean {
	return env.BRIDGE_FORWARD_ENABLED === "true" && bindingPresent(env.SRT_BRIDGE);
}

/** Honest "not activated yet" body — accurate machine-readable state for agents. Claims nothing live. */
function notActivatedBody(method: string) {
	return {
		error: "SRT_BRIDGE_NOT_ACTIVATED",
		protocol: "srt",
		// Honest lifecycle: scaffold exists (Dockerfile + Go bridge) but the transport cannot run yet.
		status: "not_activated",
		metered: false,
		live: false,
		required_scope: method === "GET" || method === "HEAD" ? SRT_SCOPES.read : SRT_SCOPES.write,
		// Exactly what an operator must do — no hidden magic, no fake success path.
		blockers: [
			"build + push containers/srt image (currently 0.0.0-scaffold, unpublished)",
			"enable CF Containers on the account",
			"uncomment the [[containers]] srt-bridge binding in wrangler.toml",
			"set BRIDGE_FORWARD_ENABLED=true",
		],
		docs: "https://bridge.wave.online/llms.txt",
	};
}

/**
 * Handle /srt/* requests.
 *
 * - Activated (flag ON + SRT_BRIDGE bound): forward verbatim to the container. This branch is the
 *   spec'd SHAPE; it is unreachable today (no binding) so it cannot fabricate a stream.
 * - Not activated (the only real state today): honest typed 501 + Retry-After.
 */
export async function handleSrt(request: Request, env: BridgeEnv): Promise<Response> {
	if (srtActivated(env)) {
		// SHAPE: hand the request to the SRT container via getContainer (the MoQ pattern). Inert until the
		// image + CF Containers land. The gateway has already authorized/scoped/metered upstream — pure forward.
		return forwardToContainer(env.SRT_BRIDGE!, request, resolvePoolSize(env.SRT_POOL_SIZE));
	}
	return Response.json(notActivatedBody(request.method), {
		status: 501,
		headers: {
			"retry-after": String(SRT_RETRY_AFTER_SECONDS),
			"cache-control": "no-store",
		},
	});
}

export const __testing = {
	SRT_SCOPES,
	SRT_RETRY_AFTER_SECONDS,
	srtActivated,
	notActivatedBody,
	bindingPresent,
	srtUnavailableBody,
	srtUnavailableResponse,
	SRT_UNAVAILABLE_RETRY_AFTER_SECONDS,
};
