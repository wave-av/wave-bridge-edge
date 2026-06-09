// wave-bridge-edge — NDI-route honesty + forward-shape suite (mirrors srt.spec.ts; tasks #282 / #136).
//
// What these prove (the NO-VAPORWARE contract):
//   (a) /ndi and /ndi/* return a TYPED, HONEST 501 `NDI_BRIDGE_NOT_ACTIVATED` — status "not_activated",
//       metered:false, live:false, an accurate Retry-After, and the canonical ndi:read/ndi:write scope
//       (NOT "ndi:stream"). It NEVER claims a live NDI transport.
//   (b) Method maps to the canonical gateway scope: GET/HEAD → ndi:read, mutating verbs → ndi:write.
//   (c) The blockers list mentions the Vizrt redistribution license gate (#169) — the extra
//       license-clearance condition that NDI has and SRT does not.
//   (d) The forward SHAPE FAIL-CLOSES: even with BRIDGE_FORWARD_ENABLED="true", with NO NDI_BRIDGE
//       binding (the only real state today) it still returns the honest 501 — no fabricated stream.
//   (e) The forward branch only fires when a REAL container binding is present (a stub here), proving
//       the shape is wired correctly without lying when the binding is absent.
//   (f) /srt and /ndi are independent — activating one does not activate the other.

import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import worker from "../src/worker";
import type { BridgeEnv, ContainerBinding } from "../src/srt";

type WorkerEnv = Parameters<typeof worker.fetch>[1];
const baseEnv = env as unknown as BridgeEnv;

async function call(req: Request, overrides: Partial<BridgeEnv> = {}): Promise<Response> {
	return worker.fetch(req, { ...baseEnv, ...overrides } as WorkerEnv);
}

describe("NDI route — honest 501 (not activated)", () => {
	it("GET /ndi returns 501 not_activated with ndi:read scope + Retry-After, claiming nothing live", async () => {
		const res = await call(new Request("https://bridge.wave.online/ndi"));
		expect(res.status).toBe(501);
		expect(res.headers.get("retry-after")).toBe("86400");
		expect(res.headers.get("cache-control")).toBe("no-store");
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.error).toBe("NDI_BRIDGE_NOT_ACTIVATED");
		expect(body.protocol).toBe("ndi");
		expect(body.status).toBe("not_activated");
		// The whole point: must NOT claim a live, metered transport while it returns 501.
		expect(body.metered).toBe(false);
		expect(body.live).toBe(false);
		expect(body.required_scope).toBe("ndi:read");
		expect(Array.isArray(body.blockers)).toBe(true);
	});

	it("POST /ndi/publish maps to the canonical ndi:write scope", async () => {
		const res = await call(new Request("https://bridge.wave.online/ndi/publish", { method: "POST" }));
		expect(res.status).toBe(501);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.required_scope).toBe("ndi:write");
	});

	it("never advertises an 'ndi:stream' scope (canonical vocabulary is read/write)", async () => {
		const res = await call(new Request("https://bridge.wave.online/ndi/foo"));
		const text = await res.text();
		expect(text).not.toContain("ndi:stream");
	});

	it("blockers list calls out the Vizrt redistribution license gate (the NDI-specific condition)", async () => {
		const res = await call(new Request("https://bridge.wave.online/ndi"));
		const body = (await res.json()) as { blockers: string[] };
		expect(body.blockers.some((b) => /vizrt|redistribution|#169/i.test(b))).toBe(true);
	});
});

describe("NDI forward shape — fail-closed, never fabricates transport", () => {
	it("flag ON but NO NDI_BRIDGE binding (today's real state) still returns the honest 501", async () => {
		const res = await call(new Request("https://bridge.wave.online/ndi"), {
			BRIDGE_FORWARD_ENABLED: "true",
			NDI_BRIDGE: undefined,
		});
		expect(res.status).toBe(501);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.error).toBe("NDI_BRIDGE_NOT_ACTIVATED");
	});

	it("flag OFF but a binding present → still 501 (both conditions required to activate)", async () => {
		const stub: ContainerBinding = { fetch: vi.fn(async () => new Response("container", { status: 200 })) };
		const res = await call(new Request("https://bridge.wave.online/ndi"), {
			BRIDGE_FORWARD_ENABLED: "false",
			NDI_BRIDGE: stub,
		});
		expect(res.status).toBe(501);
		expect(stub.fetch).not.toHaveBeenCalled();
	});

	it("flag ON + real binding present → forwards verbatim to the container (shape works, no lie)", async () => {
		const inbound = new Request("https://bridge.wave.online/ndi/play", { method: "POST" });
		const stub: ContainerBinding = {
			fetch: vi.fn(async (r: Request) => new Response(`forwarded:${r.method}`, { status: 200 })),
		};
		const res = await call(inbound, { BRIDGE_FORWARD_ENABLED: "true", NDI_BRIDGE: stub });
		expect(res.status).toBe(200);
		expect(await res.text()).toBe("forwarded:POST");
		expect(stub.fetch).toHaveBeenCalledOnce();
	});

	it("activating NDI does NOT auto-activate SRT (per-protocol bindings stay independent)", async () => {
		const ndiStub: ContainerBinding = { fetch: vi.fn(async () => new Response("ndi", { status: 200 })) };
		const res = await call(new Request("https://bridge.wave.online/srt"), {
			BRIDGE_FORWARD_ENABLED: "true",
			NDI_BRIDGE: ndiStub,
			SRT_BRIDGE: undefined,
		});
		expect(res.status).toBe(501);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.error).toBe("SRT_BRIDGE_NOT_ACTIVATED");
		expect(ndiStub.fetch).not.toHaveBeenCalled();
	});
});
