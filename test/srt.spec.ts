// wave-bridge-edge — SRT-route honesty + forward-shape suite (task #286).
//
// What these prove (the NO-VAPORWARE contract):
//   (a) /srt and /srt/* return a TYPED, HONEST 501 `SRT_BRIDGE_NOT_ACTIVATED` — status "not_activated",
//       metered:false, live:false, an accurate Retry-After, and the canonical srt:read/srt:write scope
//       (NOT "srt:stream"). It NEVER claims a live SRT transport.
//   (b) Method maps to the canonical gateway scope: GET/HEAD → srt:read, mutating verbs → srt:write.
//   (c) The forward SHAPE FAIL-CLOSES: even with BRIDGE_FORWARD_ENABLED="true", with NO SRT_BRIDGE
//       binding (the only real state today) it still returns the honest 501 — no fabricated stream.
//   (d) The forward branch only fires when a REAL container binding is present (a stub here), proving
//       the shape is wired correctly without lying when the binding is absent.
//   (e) Other protocols still get the generic BRIDGE_NOT_IMPLEMENTED 501; health/llms.txt unaffected.

import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/worker";
import { __testing } from "../src/srt";
import type { BridgeEnv } from "../src/srt";

// Mock the CF Containers helper so the activated-forward path (getContainer(ns,id).fetch()) is testable
// without a real DO runtime — mirrors test/moq.spec.ts. A "bound" binding is one exposing idFromName.
const containerFetch = vi.fn(async (r: Request) => new Response(`forwarded:${r.method}`, { status: 200 }));
vi.mock("@cloudflare/containers", () => ({
	Container: class {},
	getContainer: () => ({ fetch: containerFetch }),
}));

type WorkerEnv = Parameters<typeof worker.fetch>[1];
const baseEnv = env as unknown as BridgeEnv;
/** Minimal DurableObjectNamespace stub — present when it exposes idFromName (what bindingPresent checks). */
const boundBinding = { idFromName: () => ({}) } as unknown as NonNullable<BridgeEnv["SRT_BRIDGE"]>;

afterEach(() => containerFetch.mockClear());

async function call(req: Request, overrides: Partial<BridgeEnv> = {}): Promise<Response> {
	return worker.fetch(req, { ...baseEnv, ...overrides } as WorkerEnv);
}

describe("SRT route — honest 501 (not activated)", () => {
	it("GET /srt returns 501 not_activated with srt:read scope + Retry-After, claiming nothing live", async () => {
		const res = await call(new Request("https://bridge.wave.online/srt"));
		expect(res.status).toBe(501);
		expect(res.headers.get("retry-after")).toBe("86400");
		expect(res.headers.get("cache-control")).toBe("no-store");
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.error).toBe("SRT_BRIDGE_NOT_ACTIVATED");
		expect(body.protocol).toBe("srt");
		expect(body.status).toBe("not_activated");
		// The whole point: must NOT claim a live, metered transport while it returns 501.
		expect(body.metered).toBe(false);
		expect(body.live).toBe(false);
		expect(body.required_scope).toBe("srt:read");
		expect(Array.isArray(body.blockers)).toBe(true);
	});

	it("POST /srt/ingest maps to the canonical srt:write scope", async () => {
		const res = await call(new Request("https://bridge.wave.online/srt/ingest", { method: "POST" }));
		expect(res.status).toBe(501);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.required_scope).toBe("srt:write");
	});

	it("never advertises a 'srt:stream' scope (canonical vocabulary is read/write)", async () => {
		const res = await call(new Request("https://bridge.wave.online/srt/foo"));
		const text = await res.text();
		expect(text).not.toContain("srt:stream");
	});
});

describe("SRT forward shape — fail-closed, never fabricates transport", () => {
	it("flag ON but NO SRT_BRIDGE binding (today's real state) still returns the honest 501", async () => {
		const res = await call(new Request("https://bridge.wave.online/srt"), {
			BRIDGE_FORWARD_ENABLED: "true",
			SRT_BRIDGE: undefined,
		});
		expect(res.status).toBe(501);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.error).toBe("SRT_BRIDGE_NOT_ACTIVATED");
	});

	it("flag OFF but a binding present → still 501 (both conditions required to activate)", async () => {
		const res = await call(new Request("https://bridge.wave.online/srt"), {
			BRIDGE_FORWARD_ENABLED: "false",
			SRT_BRIDGE: boundBinding,
		});
		expect(res.status).toBe(501);
		expect(containerFetch).not.toHaveBeenCalled();
	});

	it("flag ON + real binding present → forwards verbatim to the container (shape works, no lie)", async () => {
		const inbound = new Request("https://bridge.wave.online/srt/play", { method: "POST" });
		const res = await call(inbound, { BRIDGE_FORWARD_ENABLED: "true", SRT_BRIDGE: boundBinding });
		expect(res.status).toBe(200);
		expect(await res.text()).toBe("forwarded:POST");
		expect(containerFetch).toHaveBeenCalledOnce();
	});
});

describe("SRT forward — honest 503 backpressure on pool exhaustion (never a raw 500)", () => {
	it("converts the container's RETURNED exhaustion 500 into a typed 503 with retry-after", async () => {
		containerFetch.mockImplementationOnce(async () =>
			new Response(
				"Failed to start container: Maximum number of running container instances exceeded. Try again later",
				{ status: 500 },
			),
		);
		const res = await call(new Request("https://bridge.wave.online/srt"), {
			BRIDGE_FORWARD_ENABLED: "true",
			SRT_BRIDGE: boundBinding,
		});
		expect(res.status).toBe(503);
		expect(res.headers.get("retry-after")).toBe(String(__testing.SRT_UNAVAILABLE_RETRY_AFTER_SECONDS));
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.error).toBe("SRT_BRIDGE_UNAVAILABLE");
		expect(body.status).toBe("unavailable");
		expect(body.live).toBe(false);
	});

	it("converts a THROWN cold-start failure into the same honest 503", async () => {
		containerFetch.mockImplementationOnce(async () => {
			throw new Error("container failed to start");
		});
		const res = await call(new Request("https://bridge.wave.online/srt"), {
			BRIDGE_FORWARD_ENABLED: "true",
			SRT_BRIDGE: boundBinding,
		});
		expect(res.status).toBe(503);
		expect(((await res.json()) as Record<string, unknown>).error).toBe("SRT_BRIDGE_UNAVAILABLE");
	});

	it("srtUnavailableResponse() carries status 503, retry-after 5, and the typed error body", async () => {
		const res = __testing.srtUnavailableResponse();
		expect(res.status).toBe(503);
		expect(res.headers.get("retry-after")).toBe("5");
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.error).toBe("SRT_BRIDGE_UNAVAILABLE");
	});
});

describe("other routes are unaffected", () => {
	it("an unimplemented protocol still returns the generic BRIDGE_NOT_IMPLEMENTED 501", async () => {
		// /ndi now has its own typed handler (ndi.spec.ts) — pick a protocol that doesn't yet.
		const res = await call(new Request("https://bridge.wave.online/dante/whatever"));
		expect(res.status).toBe(501);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.error).toBe("BRIDGE_NOT_IMPLEMENTED");
		expect(body.protocol).toBe("dante");
	});

	it("/health stays healthy", async () => {
		const res = await call(new Request("https://bridge.wave.online/health"));
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.ok).toBe(true);
		expect(body.service).toBe("wave-bridge-edge");
	});

	it("/llms.txt is served and is honest that routes are 501", async () => {
		const res = await call(new Request("https://bridge.wave.online/llms.txt"));
		expect(res.status).toBe(200);
		expect(await res.text()).toContain("501");
	});
});
