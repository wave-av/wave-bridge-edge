// obs.ts — structured logs for wave-bridge-edge (deep logging + diagnostics rule, Oct 20).
// One `bridge_request` JSON line per request: request id, method, route (the protocol segment from a
// closed list, never the raw path or query), status, latency, and on 4xx/5xx the typed error code
// (e.g. SRT_BRIDGE_NOT_ACTIVATED). Thrown errors and swallowed container-start failures log their class +
// a scrubbed message. Never logged: bodies, headers, tokens, query strings, org/session ids.

const SAFE_ID = /^[A-Za-z0-9._:-]{8,128}$/;
const ROUTES = new Set(["bridge", "srt", "ndi", "omt", "playout", "egress", "health", "_wave", "sitemap.xml", "llms.txt", "favicon.svg", "robots.txt"]);

export function requestIdOf(req: Request): string {
	const inbound = req.headers.get("x-request-id");
	if (inbound && SAFE_ID.test(inbound)) return inbound;
	const ray = req.headers.get("cf-ray");
	if (ray && SAFE_ID.test(ray)) return ray;
	return crypto.randomUUID();
}

export function routeOf(pathname: string): string {
	if (pathname === "/" || pathname === "/index.html") return "landing";
	const seg = pathname.split("/")[1] ?? "";
	return ROUTES.has(seg) ? seg : "other";
}

export function scrub(s: unknown): string {
	return String(s ?? "")
		.replace(/(["'`]).*?\1/g, "$1…$1")
		.replace(/https?:\/\/\S+/g, "[url]")
		.replace(/bearer\s+\S+/gi, "bearer [redacted]")
		.replace(/[A-Za-z0-9+/=_.-]{24,}/g, "[redacted]")
		.slice(0, 160);
}

export function errorFields(e: unknown): { err_name: string; err_msg: string } {
	const err = e as { name?: unknown; message?: unknown } | null;
	return { err_name: String(err?.name ?? "Error").slice(0, 40), err_msg: scrub(err?.message ?? e) };
}

export function logEvent(evt: string, fields: Record<string, unknown>, level: "info" | "warn" | "error" = "info"): void {
	try {
		const line = JSON.stringify({ evt, level, service: "wave-bridge-edge", ...fields });
		if (level === "error") console.error(line);
		else if (level === "warn") console.warn(line);
		else console.log(line);
	} catch {
		/* logging never breaks the request */
	}
}

export async function errorCodeOf(res: Response): Promise<string | undefined> {
	try {
		if (!(res.headers.get("content-type") || "").includes("json")) return undefined;
		const text = await res.clone().text();
		if (text.length > 4096) return undefined;
		const e = (JSON.parse(text) as { error?: unknown }).error;
		const code = typeof e === "string" ? e : e && typeof e === "object" ? (e as { code?: unknown }).code : undefined;
		return typeof code === "string" && /^[A-Za-z0-9_.:-]{1,80}$/.test(code) ? code : undefined;
	} catch {
		return undefined;
	}
}
