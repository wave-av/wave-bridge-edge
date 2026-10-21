import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/worker";
import { routeOf, scrub } from "../src/obs";

function capture() {
	const lines: string[] = [];
	const push = (s: unknown) => lines.push(String(s));
	vi.spyOn(console, "log").mockImplementation(push);
	vi.spyOn(console, "warn").mockImplementation(push);
	vi.spyOn(console, "error").mockImplementation(push);
	return { lines, events: () => lines.filter((l) => l.startsWith("{")).map((l) => JSON.parse(l) as Record<string, unknown>) };
}
afterEach(() => vi.restoreAllMocks());

describe("bridge_request log (src/obs.ts)", () => {
	it("logs one line with rid, route, status and the typed 501 code; echoes x-request-id; never the query", async () => {
		const cap = capture();
		const res = await worker.fetch(new Request("https://bridge.wave.online/srt/abc?token=zzz", { headers: { "x-request-id": "req-bridge-01" } }), env as never);
		expect(res.status).toBe(501);
		expect(res.headers.get("x-request-id")).toBe("req-bridge-01");
		const ev = cap.events().find((e) => e.evt === "bridge_request")!;
		expect(ev).toMatchObject({ rid: "req-bridge-01", route: "srt", status: 501, level: "warn" });
		expect(String(ev.error)).toMatch(/^[A-Z_]+$/);
		expect(cap.lines.join("")).not.toContain("token=zzz");
	});

	it("/health logs route health at info", async () => {
		const cap = capture();
		await worker.fetch(new Request("https://bridge.wave.online/health"), env as never);
		expect(cap.events().find((e) => e.evt === "bridge_request")).toMatchObject({ route: "health", status: 200, level: "info" });
	});

	it("routeOf uses a closed list; scrub masks URLs and bearer tokens", () => {
		expect(routeOf("/bridge/x")).toBe("bridge");
		expect(routeOf("/wp-admin")).toBe("other");
		expect(routeOf("/")).toBe("landing");
		expect(scrub("Bearer abc https://x.example/y")).toBe("bearer [redacted] [url]");
	});
});
