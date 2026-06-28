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
import { selectEgress, selectRecordedPlayout, handleEgress, __testing, type RealtimeEgressSource } from "../src/egress";
import { handleSrt, type BridgeEnv, type ContainerBinding } from "../src/srt";
import { handleNdi } from "../src/ndi";
import { handleOmt } from "../src/omt";
import { handlePlayout } from "../src/ffmpeg";
import worker from "../src/worker";

type WorkerEnv = Parameters<typeof worker.fetch>[1];

const baseEnv = env as unknown as BridgeEnv;

function source(overrides: Partial<RealtimeEgressSource> = {}): RealtimeEgressSource {
	return {
		mode: "recorded",
		org: "org_demo",
		sessionId: "sess_demo",
		objectUrl: "https://r2.example/org_demo/realtime-recordings/sess_demo/recording.webm?sig=x",
		target: "srt",
		destUrl: "srt://listener.example:9000?mode=caller",
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

	it("(a) target 'omt' resolves to the existing handleOmt (open-spec, no license gate)", () => {
		const handler = selectEgress(source({ target: "omt" }).target, baseEnv);
		expect(handler).toBe(handleOmt);
	});
});

describe("selectRecordedPlayout — RECORDED-first source stage (contract ADR)", () => {
	it("recorded + objectUrl routes to the ffmpeg file-playout handler (handlePlayout)", () => {
		const handler = selectRecordedPlayout(source({ mode: "recorded" }), baseEnv);
		expect(handler).toBe(handlePlayout);
	});

	it("live mode has no playout route here (deferred — needs the realtime→MoQ republish shim)", () => {
		const handler = selectRecordedPlayout(source({ mode: "live", objectUrl: undefined, moqTrack: "org/sess/cam" }), baseEnv);
		expect(handler).toBeUndefined();
	});

	it("recorded WITHOUT a signed objectUrl → no playout route (never pretends a path exists)", () => {
		const handler = selectRecordedPlayout(source({ mode: "recorded", objectUrl: undefined }), baseEnv);
		expect(handler).toBeUndefined();
	});

	it("the playout stage fail-closes to its own honest 501 when FFMPEG_BRIDGE is unbound, no throw", async () => {
		const handler = selectRecordedPlayout(source(), baseEnv);
		expect(handler).toBeDefined();
		const res = await handler!(new Request("https://bridge.wave.online/playout"), baseEnv);
		expect(res.status).toBe(501);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.error).toBe("FFMPEG_PLAYOUT_NOT_ACTIVATED");
		expect(body.live).toBe(false);
		expect(body.metered).toBe(false);
		expect(body.required_scope).toBe("playout:read");
	});

	it("playout flag ON but FFMPEG_BRIDGE absent (the only real state) still 501 — gate not weakened", async () => {
		const handler = selectRecordedPlayout(source(), baseEnv);
		const res = await handler!(new Request("https://bridge.wave.online/playout"), {
			...baseEnv,
			BRIDGE_FORWARD_ENABLED: "true",
			FFMPEG_BRIDGE: undefined,
		});
		expect(res.status).toBe(501);
		expect(((await res.json()) as Record<string, unknown>).error).toBe("FFMPEG_PLAYOUT_NOT_ACTIVATED");
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

	it("omt target with no OMT_BRIDGE → honest OMT 501, no throw (open-spec, still fail-closed)", async () => {
		const handler = selectEgress("omt", baseEnv);
		const res = await handler!(new Request("https://bridge.wave.online/omt"), baseEnv);
		expect(res.status).toBe(501);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.error).toBe("OMT_BRIDGE_NOT_ACTIVATED");
		expect(body.live).toBe(false);
		expect(body.metered).toBe(false);
	});

	it("omt flag ON but OMT_BRIDGE absent (the only real state) still 501 — seam never weakens omtActivated", async () => {
		const handler = selectEgress("omt", baseEnv);
		const res = await handler!(new Request("https://bridge.wave.online/omt"), {
			...baseEnv,
			BRIDGE_FORWARD_ENABLED: "true",
			OMT_BRIDGE: undefined,
		});
		expect(res.status).toBe(501);
		expect(((await res.json()) as Record<string, unknown>).error).toBe("OMT_BRIDGE_NOT_ACTIVATED");
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

	it("(c) OMT egress route → omt:read on GET / omt:write on POST, never omt:stream", async () => {
		const handler = selectEgress("omt", baseEnv);
		const getRes = await handler!(new Request("https://bridge.wave.online/omt"), baseEnv);
		expect(((await getRes.json()) as Record<string, unknown>).required_scope).toBe("omt:read");
		const postRes = await handler!(new Request("https://bridge.wave.online/omt/play", { method: "POST" }), baseEnv);
		const text = await postRes.text();
		expect(JSON.parse(text).required_scope).toBe("omt:write");
		expect(text).not.toContain("omt:stream");
	});
});

describe("worker /omt and /playout routes are honest-501 end-to-end (the matrix is wired)", () => {
	it("GET /omt → 501 OMT_BRIDGE_NOT_ACTIVATED via the worker", async () => {
		const res = await worker.fetch(new Request("https://bridge.wave.online/omt"), baseEnv as WorkerEnv);
		expect(res.status).toBe(501);
		expect(((await res.json()) as Record<string, unknown>).error).toBe("OMT_BRIDGE_NOT_ACTIVATED");
	});

	it("GET /playout → 501 FFMPEG_PLAYOUT_NOT_ACTIVATED via the worker", async () => {
		const res = await worker.fetch(new Request("https://bridge.wave.online/playout"), baseEnv as WorkerEnv);
		expect(res.status).toBe(501);
		expect(((await res.json()) as Record<string, unknown>).error).toBe("FFMPEG_PLAYOUT_NOT_ACTIVATED");
	});

	it("/srt and /bridge routing is unchanged (matrix extension did not disturb existing routes)", async () => {
		const srt = await worker.fetch(new Request("https://bridge.wave.online/srt"), baseEnv as WorkerEnv);
		expect(((await srt.json()) as Record<string, unknown>).error).toBe("SRT_BRIDGE_NOT_ACTIVATED");
	});
});

describe("handleEgress — the realtime→baseband egress ENTRY route (#73 P1.5)", () => {
	function post(body: unknown): Request {
		return new Request("https://bridge.wave.online/egress", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
	}

	it("a recorded descriptor → routes through the ffmpeg playout front-end → honest 501, no throw", async () => {
		const res = await handleEgress(post(source({ target: "srt" })), baseEnv);
		expect(res.status).toBe(501);
		const body = (await res.json()) as Record<string, unknown>;
		// recorded mode routes FIRST through handlePlayout (the ACCEPTED ADR), which fail-closes here.
		expect(body.error).toBe("FFMPEG_PLAYOUT_NOT_ACTIVATED");
		expect(body.live).toBe(false);
		expect(body.metered).toBe(false);
	});

	it("recorded descriptor for EVERY routable target still lands on the honest playout 501 (no fake stream)", async () => {
		// SRT dials a destUrl; NDI/OMT announce by name (no dial-out URL → destUrl omitted for them).
		const byTarget = {
			srt: source({ target: "srt", destUrl: "srt://listener.example:9000?mode=caller" }),
			ndi: source({ target: "ndi", destUrl: undefined, destName: "WAVE Egress" }),
			omt: source({ target: "omt", destUrl: undefined, destName: "WAVE Egress" }),
		} as const;
		for (const target of ["srt", "ndi", "omt"] as const) {
			const res = await handleEgress(post(byTarget[target]), baseEnv);
			expect(res.status).toBe(501);
			expect(((await res.json()) as Record<string, unknown>).error).toBe("FFMPEG_PLAYOUT_NOT_ACTIVATED");
		}
	});

	it("live mode → typed 501 EGRESS_LIVE_MODE_NOT_AVAILABLE (deferred shim, never faked)", async () => {
		const res = await handleEgress(post(source({ mode: "live", objectUrl: undefined, moqTrack: "org/sess/cam" })), baseEnv);
		expect(res.status).toBe(501);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.error).toBe("EGRESS_LIVE_MODE_NOT_AVAILABLE");
		expect(body.live).toBe(false);
		expect(body.metered).toBe(false);
		expect(res.headers.get("retry-after")).toBe("86400");
	});

	it("non-POST → typed 405 with Allow: POST (the descriptor is a body)", async () => {
		const res = await handleEgress(new Request("https://bridge.wave.online/egress"), baseEnv);
		expect(res.status).toBe(405);
		expect(res.headers.get("allow")).toBe("POST");
		expect(((await res.json()) as Record<string, unknown>).error).toBe("EGRESS_METHOD_NOT_ALLOWED");
	});

	it("malformed JSON → typed 400 EGRESS_BAD_REQUEST, no throw", async () => {
		const req = new Request("https://bridge.wave.online/egress", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{ not json",
		});
		const res = await handleEgress(req, baseEnv);
		expect(res.status).toBe(400);
		expect(((await res.json()) as Record<string, unknown>).error).toBe("EGRESS_BAD_REQUEST");
	});

	it.each([
		["missing mode", { org: "o", sessionId: "s", target: "srt", objectUrl: "https://r2/x" }, "mode must be 'recorded' or 'live'"],
		["bad target", { mode: "recorded", org: "o", sessionId: "s", target: "rtmp", objectUrl: "https://r2/x" }, "target must be one of srt|ndi|omt"],
		["recorded missing objectUrl", { mode: "recorded", org: "o", sessionId: "s", target: "srt" }, "recorded mode requires a signed objectUrl"],
		["missing org", { mode: "recorded", sessionId: "s", target: "srt", objectUrl: "https://r2/x" }, "org is required"],
		["live missing moqTrack", { mode: "live", org: "o", sessionId: "s", target: "srt" }, "live mode requires a moqTrack name"],
	])("invalid descriptor (%s) → 400 with actionable reason", async (_label, body, reason) => {
		const res = await handleEgress(post(body), baseEnv);
		expect(res.status).toBe(400);
		const parsed = (await res.json()) as Record<string, unknown>;
		expect(parsed.error).toBe("EGRESS_BAD_REQUEST");
		expect(parsed.reason).toBe(reason);
	});

	it("flag ON + FFMPEG_BRIDGE bound: recorded egress forwards to the playout container (seam doesn't bypass)", async () => {
		const stub: ContainerBinding = { fetch: vi.fn(async () => new Response("playout-fwd", { status: 200 })) };
		const res = await handleEgress(post(source({ target: "srt" })), {
			...baseEnv,
			BRIDGE_FORWARD_ENABLED: "true",
			FFMPEG_BRIDGE: stub,
		});
		expect(res.status).toBe(200);
		expect(stub.fetch).toHaveBeenCalledOnce();
		expect(await res.text()).toBe("playout-fwd");
	});

	it("end-to-end via worker.fetch: POST /egress recorded → honest playout 501 (route is wired)", async () => {
		const res = await worker.fetch(post(source({ target: "srt" })), baseEnv as WorkerEnv);
		expect(res.status).toBe(501);
		expect(((await res.json()) as Record<string, unknown>).error).toBe("FFMPEG_PLAYOUT_NOT_ACTIVATED");
	});

	it("end-to-end via worker.fetch: GET /egress → 405 (the entry route only accepts POST)", async () => {
		const res = await worker.fetch(new Request("https://bridge.wave.online/egress"), baseEnv as WorkerEnv);
		expect(res.status).toBe(405);
		expect(((await res.json()) as Record<string, unknown>).error).toBe("EGRESS_METHOD_NOT_ALLOWED");
	});
});

describe("(e) wrangler-inert guard — the seam arms NOTHING", () => {
	const wrangler = wranglerToml;

	it("the live MoQ [[containers]] binding (class_name MoqContainer) is intact", () => {
		expect(wrangler).toMatch(/\[\[containers\]\]\s*\nclass_name\s*=\s*"MoqContainer"/);
	});

	it("the SRT_BRIDGE binding stays COMMENTED (inert)", () => {
		// The SRT block now mirrors the live MoQ schema (class_name SrtContainer + a durable_objects
		// binding `name = "SRT_BRIDGE"`). An ACTIVE binding would be `name = "SRT_BRIDGE"` at column 0;
		// the only occurrence must be inside a comment (`# name = "SRT_BRIDGE"`). No uncommented line.
		expect(wrangler).not.toMatch(/^\s*name\s*=\s*"SRT_BRIDGE"/m);
		expect(wrangler).toMatch(/#\s*name\s*=\s*"SRT_BRIDGE"/);
		// The container class for SRT must also stay commented (no uncommented SrtContainer binding).
		expect(wrangler).not.toMatch(/^\s*class_name\s*=\s*"SrtContainer"/m);
	});

	it("the NDI_BRIDGE binding stays COMMENTED (inert)", () => {
		expect(wrangler).not.toMatch(/^\s*binding\s*=\s*"NDI_BRIDGE"/m);
		expect(wrangler).toMatch(/#\s*binding\s*=\s*"NDI_BRIDGE"/);
	});

	it("the OMT_BRIDGE binding stays COMMENTED (inert)", () => {
		expect(wrangler).not.toMatch(/^\s*binding\s*=\s*"OMT_BRIDGE"/m);
		expect(wrangler).toMatch(/#\s*binding\s*=\s*"OMT_BRIDGE"/);
	});

	it("the FFMPEG_BRIDGE binding stays COMMENTED (inert)", () => {
		expect(wrangler).not.toMatch(/^\s*binding\s*=\s*"FFMPEG_BRIDGE"/m);
		expect(wrangler).toMatch(/#\s*binding\s*=\s*"FFMPEG_BRIDGE"/);
	});

	it("the ONLY uncommented [[containers]] is the live MoQ block (no protocol egress binding leaked)", () => {
		// Every uncommented binding line (legacy `binding = "..."` OR durable_objects `name = "..."`)
		// must be a MoQ/durable-object binding, never SRT/NDI/OMT/FFMPEG. The SRT block now uses the
		// durable_objects `name = "SRT_BRIDGE"` schema, so catch both forms.
		const activeBindings = wrangler
			.split("\n")
			.filter((l) => /^\s*(binding|name)\s*=/.test(l) && !/^\s*#/.test(l));
		for (const line of activeBindings) {
			expect(line).not.toMatch(/"(SRT|NDI|OMT|FFMPEG)_BRIDGE"/);
		}
	});

	it("BRIDGE_FORWARD_ENABLED stays \"false\" (the operator-gate is closed)", () => {
		expect(wrangler).toMatch(/^BRIDGE_FORWARD_ENABLED\s*=\s*"false"/m);
	});
});

describe("destUrl — validated, SSRF-guarded egress destination (validate-untrusted-input-before-sink)", () => {
	const { validateSource } = __testing;
	function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
		return {
			mode: "recorded",
			org: "o",
			sessionId: "s",
			objectUrl: "https://r2/x",
			target: "srt",
			destUrl: "srt://listener.example:9000?mode=caller",
			...overrides,
		};
	}

	it("srt: a valid srt:// destUrl is accepted and normalized through", () => {
		const v = validateSource(body());
		expect(v.ok).toBe(true);
		if (v.ok) expect(v.source.destUrl).toBe("srt://listener.example:9000?mode=caller");
	});

	it("srt: a MISSING destUrl → 400 actionable reason (a wire sender needs an address)", () => {
		const v = validateSource(body({ destUrl: undefined }));
		expect(v.ok).toBe(false);
		if (!v.ok) expect(v.reason).toContain("srt egress requires a destUrl");
	});

	it("srt: a non-srt scheme (http/file/rtmp) → rejected before it can reach an ffmpeg sink", () => {
		for (const bad of ["http://h:9000", "file:///etc/passwd", "rtmp://h/app"]) {
			const v = validateSource(body({ destUrl: bad }));
			expect(v.ok).toBe(false);
			if (!v.ok) expect(v.reason).toContain("scheme not allowed");
		}
	});

	it("srt: SSRF guard rejects loopback / link-local hosts", () => {
		for (const bad of [
			"srt://localhost:9000",
			"srt://127.0.0.1:9000",
			"srt://0.0.0.0:9000",
			"srt://169.254.1.1:9000",
		]) {
			const v = validateSource(body({ destUrl: bad }));
			expect(v.ok).toBe(false);
			if (!v.ok) expect(v.reason).toContain("not allowed");
		}
	});

	it("srt: an out-of-range port → rejected (unparseable or out-of-range, never accepted)", () => {
		const v = validateSource(body({ destUrl: "srt://h:99999" }));
		expect(v.ok).toBe(false);
	});

	it("ndi/omt: announce by name → a destUrl with ANY scheme is rejected (no sink smuggling)", () => {
		for (const target of ["ndi", "omt"] as const) {
			const v = validateSource(body({ target, destUrl: "srt://h:9000" }));
			expect(v.ok).toBe(false);
			if (!v.ok) expect(v.reason).toContain("scheme not allowed");
		}
	});

	it("ndi/omt: no destUrl + optional destName is accepted", () => {
		for (const target of ["ndi", "omt"] as const) {
			const v = validateSource(body({ target, destUrl: undefined, destName: "WAVE Egress" }));
			expect(v.ok).toBe(true);
			if (v.ok) {
				expect(v.source.destUrl).toBeUndefined();
				expect(v.source.destName).toBe("WAVE Egress");
			}
		}
	});

	it("a non-string destName → 400", () => {
		const v = validateSource(body({ target: "ndi", destUrl: undefined, destName: 42 }));
		expect(v.ok).toBe(false);
		if (!v.ok) expect(v.reason).toContain("destName");
	});
});

describe("routing — protocol paths attach to the worker WITHOUT claiming the Core-Origin apex", () => {
	const wrangler = wranglerToml;

	it("path-scoped routes for /srt make the honest-501 independently reachable", () => {
		// The gap (#73): without a route, `curl bridge.wave.online/srt` hits the Core-Origin Next.js 404,
		// so the honest 501 is unreachable for a receipt. A path-scoped Worker Route fixes that.
		expect(wrangler).toMatch(/pattern\s*=\s*"bridge\.wave\.online\/srt\*"/);
		expect(wrangler).toMatch(/pattern\s*=\s*"bridge\.wave\.online\/srt\*",\s*zone_name\s*=\s*"wave\.online"/);
	});

	it("the /egress entry route is path-scoped so the realtime→egress honest-501 is independently reachable", () => {
		expect(wrangler).toMatch(/pattern\s*=\s*"bridge\.wave\.online\/egress\*",\s*zone_name\s*=\s*"wave\.online"/);
	});

	it("does NOT claim the bridge.wave.online apex (no custom_domain, no bare-host or /* pattern)", () => {
		// Claiming the whole hostname (custom_domain=true, or `bridge.wave.online` / `bridge.wave.online/*`)
		// would shadow the Core-Origin Next.js app. The routes must be path-scoped only.
		expect(wrangler).not.toMatch(/pattern\s*=\s*"bridge\.wave\.online"\s*,/);
		expect(wrangler).not.toMatch(/pattern\s*=\s*"bridge\.wave\.online\/\*"/);
		expect(wrangler).not.toMatch(/"bridge\.wave\.online"[^\n]*custom_domain\s*=\s*true/);
	});

	it("routes is a TOP-LEVEL key before the first [table] (config-no-silent-noop placement law)", () => {
		const routesIdx = wrangler.indexOf("\nroutes = [");
		const firstTableIdx = wrangler.search(/\n\[/); // first [table] or [[table]] header
		expect(routesIdx).toBeGreaterThan(-1);
		expect(routesIdx).toBeLessThan(firstTableIdx);
	});
});
