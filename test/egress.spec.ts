// wave-bridge-edge — realtime → baseband EGRESS SEAM suite (task #73 P1).
//
// What these prove (the inert-seam + no-vaporware contract):
//   (a) A `recorded` RealtimeEgressSource with target `srt` routes to the EXISTING SRT handler
//       (and `ndi` → the NDI handler) — the seam reuses bridge-edge's egress, it does not add one.
//   (b) Unconfigured env (today's real state: SRT_BRIDGE/NDI_BRIDGE unbound) → the existing honest
//       501 `SRT_BRIDGE_NOT_ACTIVATED` / `NDI_BRIDGE_NOT_ACTIVATED`, with NO throw. The seam never
//       fabricates a stream.
//   (c) The gateway scope for egress is still srt:read|srt:write (and ndi:read|ndi:write) — the seam
//       inherits the canonical scope vocabulary unchanged, never "srt:stream".
//   (d) `omt` (and any future target) has no route yet → selectEgress returns undefined (design-only),
//       so the caller falls back to the generic honest 501 — no fabricated transport.
//   (e) WRANGLER-INERT GUARD: the live MoQ `[[containers]]` binding stays intact AND the
//       SRT_BRIDGE/NDI_BRIDGE bindings + BRIDGE_FORWARD_ENABLED stay COMMENTED/false — the inert-leak
//       guard that proves this PR arms nothing.

import { env } from "cloudflare:test";
// Raw-import the deployed wrangler.toml as a string (Vite `?raw`, Workers-pool compatible — no node:fs,
// which the workerd runtime lacks). This is the inert-leak guard's source of truth: the actual config.
import wranglerToml from "../wrangler.toml?raw";
import { describe, expect, it, vi } from "vitest";
import { selectEgress, type RealtimeEgressSource } from "../src/egress";
import { handleSrt, type BridgeEnv, type ContainerBinding } from "../src/srt";
import { handleNdi } from "../src/ndi";

const baseEnv = env as unknown as BridgeEnv;

function source(overrides: Partial<RealtimeEgressSource> = {}): RealtimeEgressSource {
	return {
		mode: "recorded",
		org: "org_demo",
		sessionId: "sess_demo",
		objectUrl: "https://r2.example/org_demo/realtime-recordings/sess_demo/recording.webm?sig=x",
		target: "srt",
		...overrides,
	};
}

describe("selectEgress — routes a realtime source to the EXISTING protocol handler", () => {
	it("(a) recorded + target 'srt' resolves to the existing handleSrt", () => {
		const handler = selectEgress(source({ target: "srt" }).target, baseEnv);
		expect(handler).toBe(handleSrt);
	});

	it("(a) target 'ndi' resolves to the existing handleNdi", () => {
		const handler = selectEgress(source({ target: "ndi" }).target, baseEnv);
		expect(handler).toBe(handleNdi);
	});

	it("(d) target 'omt' has no route yet → undefined (design-only, no fabricated transport)", () => {
		const handler = selectEgress("omt", baseEnv);
		expect(handler).toBeUndefined();
	});
});

describe("selectEgress — fail-closed: unconfigured env yields the honest 501, never throws", () => {
	it("(b) recorded → srt with NO SRT_BRIDGE binding (today's real state) → honest 501, no throw", async () => {
		const handler = selectEgress(source().target, baseEnv);
		expect(handler).toBeDefined();
		// Drive the resolved handler with the real unconfigured env — must NOT throw.
		const res = await handler!(new Request("https://bridge.wave.online/srt"), baseEnv);
		expect(res.status).toBe(501);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.error).toBe("SRT_BRIDGE_NOT_ACTIVATED");
		expect(body.live).toBe(false);
		expect(body.metered).toBe(false);
	});

	it("(b) flag ON but binding absent (the only real state) still 501 — seam never weakens srtActivated", async () => {
		const handler = selectEgress("srt", baseEnv);
		const res = await handler!(new Request("https://bridge.wave.online/srt"), {
			...baseEnv,
			BRIDGE_FORWARD_ENABLED: "true",
			SRT_BRIDGE: undefined,
		});
		expect(res.status).toBe(501);
		expect(((await res.json()) as Record<string, unknown>).error).toBe("SRT_BRIDGE_NOT_ACTIVATED");
	});

	it("ndi target with no NDI_BRIDGE → honest NDI 501, no throw", async () => {
		const handler = selectEgress("ndi", baseEnv);
		const res = await handler!(new Request("https://bridge.wave.online/ndi"), baseEnv);
		expect(res.status).toBe(501);
		expect(((await res.json()) as Record<string, unknown>).error).toBe("NDI_BRIDGE_NOT_ACTIVATED");
	});

	it("the seam does NOT bypass the gate: flag ON + a real binding still forwards via the SAME handler", async () => {
		// Proves the seam routes to the unmodified handler whose activation logic is intact — when a
		// real binding IS present (a stub here), the existing handler forwards. The seam adds nothing.
		const stub: ContainerBinding = { fetch: vi.fn(async () => new Response("fwd", { status: 200 })) };
		const handler = selectEgress("srt", baseEnv);
		const res = await handler!(new Request("https://bridge.wave.online/srt/play", { method: "POST" }), {
			...baseEnv,
			BRIDGE_FORWARD_ENABLED: "true",
			SRT_BRIDGE: stub,
		});
		expect(res.status).toBe(200);
		expect(stub.fetch).toHaveBeenCalledOnce();
	});
});

describe("egress scope is still the canonical srt:read|srt:write (never srt:stream)", () => {
	it("(c) GET via the SRT egress route → srt:read", async () => {
		const handler = selectEgress("srt", baseEnv);
		const res = await handler!(new Request("https://bridge.wave.online/srt"), baseEnv);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.required_scope).toBe("srt:read");
	});

	it("(c) POST via the SRT egress route → srt:write, and never advertises srt:stream", async () => {
		const handler = selectEgress("srt", baseEnv);
		const res = await handler!(new Request("https://bridge.wave.online/srt/ingest", { method: "POST" }), baseEnv);
		const text = await res.text();
		expect(JSON.parse(text).required_scope).toBe("srt:write");
		expect(text).not.toContain("srt:stream");
	});
});

describe("(e) wrangler-inert guard — the seam arms NOTHING", () => {
	const wrangler = wranglerToml;

	it("the live MoQ [[containers]] binding (class_name MoqContainer) is intact", () => {
		expect(wrangler).toMatch(/\[\[containers\]\]\s*\nclass_name\s*=\s*"MoqContainer"/);
	});

	it("the SRT_BRIDGE binding stays COMMENTED (inert)", () => {
		// An ACTIVE binding would be `binding = "SRT_BRIDGE"` at column 0; the only occurrence must be
		// inside a comment (`# binding = "SRT_BRIDGE"`). Assert no uncommented activation line exists.
		expect(wrangler).not.toMatch(/^\s*binding\s*=\s*"SRT_BRIDGE"/m);
		expect(wrangler).toMatch(/#\s*binding\s*=\s*"SRT_BRIDGE"/);
	});

	it("the NDI_BRIDGE binding stays COMMENTED (inert)", () => {
		expect(wrangler).not.toMatch(/^\s*binding\s*=\s*"NDI_BRIDGE"/m);
		expect(wrangler).toMatch(/#\s*binding\s*=\s*"NDI_BRIDGE"/);
	});

	it("BRIDGE_FORWARD_ENABLED stays \"false\" (the operator-gate is closed)", () => {
		expect(wrangler).toMatch(/^BRIDGE_FORWARD_ENABLED\s*=\s*"false"/m);
	});
});
