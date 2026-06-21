// wave-bridge-edge — MoQ-route suite (WB-6 / E4). /bridge is the ONE strand that runs hosted.
//
// What these prove:
//   (a) With NO MOQ_BRIDGE container binding, /bridge returns a TYPED, HONEST 501
//       `MOQ_BRIDGE_NOT_ACTIVATED` — status "not_activated", metered:false, live:false, an accurate
//       Retry-After, and the canonical moq:read/moq:write scope. It NEVER fabricates a round-trip.
//   (b) Method maps to the canonical scope: GET → moq:read, mutating verbs → moq:write.
//   (c) When the container IS bound, /bridge forwards to it and passes the receipt straight through —
//       the container (containers/moq) is what actually round-trips through the live relay.
//   (d) The round-trip size is bounded at the edge (defence in depth).
//   (e) /health and /llms.txt are unaffected; /llms.txt is honest that SRT/NDI stay 501.

import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/worker";
import type { MoqEnv } from "../src/moq";

// Mock the CF Containers helper so the activated-forward path is testable without a real DO runtime.
const containerFetch = vi.fn(async (r: Request) => {
	const url = new URL(r.url);
	return Response.json(
		{ ok: true, service: "wave-moq-bridge", sent: Number(url.searchParams.get("n")), received: Number(url.searchParams.get("n")) },
		{ status: 200 },
	);
});
vi.mock("@cloudflare/containers", () => ({
	Container: class {},
	getContainer: () => ({ fetch: containerFetch }),
}));

type WorkerEnv = Parameters<typeof worker.fetch>[1];
const baseEnv = env as unknown as MoqEnv;

async function call(req: Request, overrides: Partial<MoqEnv> = {}): Promise<Response> {
	return worker.fetch(req, { ...baseEnv, ...overrides } as WorkerEnv);
}

// A binding is "present" when it exposes idFromName (what moqActivated checks). Minimal stub.
const boundEnv = { MOQ_BRIDGE: { idFromName: () => ({}) } as unknown as MoqEnv["MOQ_BRIDGE"] };

afterEach(() => containerFetch.mockClear());

describe("MoQ /bridge — honest 501 when the container is not bound", () => {
	it("GET /bridge with no MOQ_BRIDGE returns 501 not_activated, moq:read scope, Retry-After, nothing live", async () => {
		const res = await call(new Request("https://bridge.wave.online/bridge"), { MOQ_BRIDGE: undefined });
		expect(res.status).toBe(501);
		expect(res.headers.get("retry-after")).toBe("3600");
		expect(res.headers.get("cache-control")).toBe("no-store");
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.error).toBe("MOQ_BRIDGE_NOT_ACTIVATED");
		expect(body.protocol).toBe("moq");
		expect(body.status).toBe("not_activated");
		expect(body.metered).toBe(false);
		expect(body.live).toBe(false);
		expect(body.required_scope).toBe("moq:read");
		expect(Array.isArray(body.blockers)).toBe(true);
		expect(containerFetch).not.toHaveBeenCalled();
	});

	it("POST /bridge maps to the canonical moq:write scope", async () => {
		const res = await call(new Request("https://bridge.wave.online/bridge", { method: "POST" }), { MOQ_BRIDGE: undefined });
		expect(res.status).toBe(501);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.required_scope).toBe("moq:write");
	});
});

describe("MoQ /bridge — forwards to the container when bound (the real hosted path)", () => {
	it("forwards to the container and passes its receipt through with 200", async () => {
		const res = await call(new Request("https://bridge.wave.online/bridge?n=50"), boundEnv);
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.service).toBe("wave-moq-bridge");
		expect(body.ok).toBe(true);
		expect(containerFetch).toHaveBeenCalledOnce();
		// The edge clamps n into [1,1000] before handing it to the container.
		const forwarded = new URL((containerFetch.mock.calls[0][0] as Request).url);
		expect(forwarded.searchParams.get("n")).toBe("50");
	});

	it("bounds the round-trip size at the edge (n=99999 → clamped to 1000)", async () => {
		await call(new Request("https://bridge.wave.online/bridge?n=99999"), boundEnv);
		const forwarded = new URL((containerFetch.mock.calls[0][0] as Request).url);
		expect(forwarded.searchParams.get("n")).toBe("1000");
	});
});

describe("other routes unaffected by the MoQ wiring", () => {
	it("/health stays healthy", async () => {
		const res = await call(new Request("https://bridge.wave.online/health"));
		expect(res.status).toBe(200);
		expect(((await res.json()) as Record<string, unknown>).service).toBe("wave-bridge-edge");
	});

	it("/llms.txt is served and stays honest that SRT/NDI are 501", async () => {
		const res = await call(new Request("https://bridge.wave.online/llms.txt"));
		expect(res.status).toBe(200);
		const text = await res.text();
		expect(text).toContain("501");
		expect(text).toContain("LIVE"); // /bridge (MoQ) is advertised live
	});
});
