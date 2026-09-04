// wave-bridge-edge — chassis surface wiring (spoke-chassis 0.16.x funnel + nav account CTA).
//
// What these prove:
//   (a) The landing shell carries the nav account CTA pair (Sign in / Get API key), the funnel marker,
//       the canon accent only (#21BCE7 present, retired #00ccf9 absent) and the footer truth strip.
//   (b) Every asset the shell references under /_wave/* is SERVED by this worker (consent.js, cta.js,
//       nav.js) instead of falling through to the generic BRIDGE_NOT_IMPLEMENTED 501.
//   (c) The funnel beacon accepts POST /_wave/e (204, never blocks) and /_wave/funnel.json reports presence.
//   (d) /robots.txt and /favicon.svg resolve; protocol routes and the generic 501 are untouched.

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/worker";

type WorkerEnv = Parameters<typeof worker.fetch>[1];

async function call(path: string, init?: RequestInit): Promise<Response> {
	return worker.fetch(new Request(`https://bridge.wave.online${path}`, init), env as unknown as WorkerEnv);
}

describe("landing shell — chassis 0.16 surfaces", () => {
	it("renders the nav account CTA pair, the funnel marker and the canon accent only", async () => {
		const res = await call("/");
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(html).toContain('href="https://console.wave.online/login"');
		expect(html).toContain('href="https://console.wave.online/signup"');
		expect(html).toContain("Get API key");
		expect(html).toContain('<meta name="wave-funnel" content="1">');
		expect(html.toLowerCase()).toContain("#21bce7");
		expect(html.toLowerCase()).not.toContain("00ccf9");
		expect(html).toContain("WAVE Online, LLC");
		expect(html).not.toContain("SOC 2");
		expect(html).not.toContain("99.99");
	});

	it("serves every /_wave/* script the shell references", async () => {
		for (const path of ["/_wave/consent.js", "/_wave/cta.js", "/_wave/nav.js"]) {
			const res = await call(path);
			expect(res.status, path).toBe(200);
			expect(res.headers.get("content-type"), path).toMatch(/javascript/);
		}
	});

	it("accepts the funnel beacon and reports funnel presence", async () => {
		const beacon = await call("/_wave/e", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ e: "$pageview", p: "/" }),
		});
		expect(beacon.status).toBe(204);
		const presence = await call("/_wave/funnel.json");
		expect(presence.status).toBe(200);
		const body = (await presence.json()) as { funnel: string; steps: string[] };
		expect(body.funnel).toBe("1");
		expect(body.steps).toEqual(["page_view", "cta_click"]);
	});

	it("serves /robots.txt and /favicon.svg from the chassis", async () => {
		expect((await call("/robots.txt")).status).toBe(200);
		const fav = await call("/favicon.svg");
		expect(fav.status).toBe(200);
		expect(fav.headers.get("content-type")).toContain("image/svg+xml");
	});

	it("leaves the generic protocol 501 untouched", async () => {
		const res = await call("/rist");
		expect(res.status).toBe(501);
		expect(((await res.json()) as { error: string }).error).toBe("BRIDGE_NOT_IMPLEMENTED");
	});
});
