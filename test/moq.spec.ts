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
import { __testing } from "../src/moq";
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

describe("MoQ /bridge — warm-pool sizing (the scale knob)", () => {
	it("routes onto a bounded, stable pool of moq-bridge-{0..N-1} ids (never a random per-call id)", () => {
		const { moqContainerId } = __testing;
		const ids = new Set(Array.from({ length: 200 }, () => moqContainerId(3)));
		// Every id is one of exactly 3 stable shards — no per-call leak.
		expect([...ids].sort()).toEqual(["moq-bridge-0", "moq-bridge-1", "moq-bridge-2"]);
	});

	it("pool size is env-tunable without a code deploy, clamped to a sane range", () => {
		const { moqPoolSize, MOQ_POOL_SIZE_DEFAULT, MOQ_POOL_SIZE_MAX } = __testing;
		expect(moqPoolSize({} as MoqEnv)).toBe(MOQ_POOL_SIZE_DEFAULT); // unset → default
		expect(moqPoolSize({ MOQ_POOL_SIZE: "16" } as MoqEnv)).toBe(16); // honoured
		expect(moqPoolSize({ MOQ_POOL_SIZE: "0" } as MoqEnv)).toBe(MOQ_POOL_SIZE_DEFAULT); // <1 → default
		expect(moqPoolSize({ MOQ_POOL_SIZE: "nonsense" } as MoqEnv)).toBe(MOQ_POOL_SIZE_DEFAULT); // NaN → default
		expect(moqPoolSize({ MOQ_POOL_SIZE: "99999" } as MoqEnv)).toBe(MOQ_POOL_SIZE_MAX); // clamped
	});
});

describe("MoQ /bridge — honest 503 backpressure on pool exhaustion (never a raw 500)", () => {
	it("converts the container's RETURNED exhaustion 500 into a typed 503 with retry-after", async () => {
		containerFetch.mockImplementationOnce(async () =>
			new Response(
				"Failed to start container: Maximum number of running container instances exceeded. Try again later",
				{ status: 500 },
			),
		);
		const res = await call(new Request("https://bridge.wave.online/bridge?n=1"), boundEnv);
		expect(res.status).toBe(503);
		expect(res.headers.get("retry-after")).toBe(String(__testing.MOQ_UNAVAILABLE_RETRY_AFTER_SECONDS));
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.error).toBe("MOQ_BRIDGE_UNAVAILABLE");
		expect(body.status).toBe("unavailable");
		expect(body.live).toBe(false);
	});

	it("converts a THROWN cold-start failure into the same honest 503", async () => {
		containerFetch.mockImplementationOnce(async () => {
			throw new Error("container failed to start");
		});
		const res = await call(new Request("https://bridge.wave.online/bridge?n=1"), boundEnv);
		expect(res.status).toBe(503);
		expect(((await res.json()) as Record<string, unknown>).error).toBe("MOQ_BRIDGE_UNAVAILABLE");
	});

	it("does NOT mask the app's own 502 (failed round-trip) as backpressure", async () => {
		containerFetch.mockImplementationOnce(async () =>
			Response.json({ ok: false, service: "wave-moq-bridge", missing: 5 }, { status: 502 }),
		);
		const res = await call(new Request("https://bridge.wave.online/bridge?n=5"), boundEnv);
		expect(res.status).toBe(502); // passed straight through — a real app receipt, not exhaustion
		expect(((await res.json()) as Record<string, unknown>).ok).toBe(false);
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
