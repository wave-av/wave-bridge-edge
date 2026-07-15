// wave-bridge-edge — routes protocol traffic from the gateway to the right CF Container.
// /bridge (MoQ) is LIVE: it runs the proven MoQ strand in a CF Container that round-trips real
// objects through the live moq.wave.online relay. /srt and /ndi remain honest typed 501 — CF
// Containers have no public UDP ingress, so those strands can't run hosted yet. No route fabricates
// transport: each fail-closes to its typed 501 unless its specific container binding is present.
import { handleSrt, type BridgeEnv } from "./srt";
import { handleNdi } from "./ndi";
import { handleOmt } from "./omt";
import { handlePlayout } from "./ffmpeg";
import { handleEgress } from "./egress";
import { handleMoqBridge, MoqContainer, type MoqEnv } from "./moq";
import { SrtContainer, FfmpegContainer, NdiContainer, OmtContainer } from "./containers";

// CF Container Durable Object classes must be re-exported from the Worker entry so wrangler can bind them.
// MoqContainer is LIVE; the egress-strand classes (#134) are INERT — their [[migrations]] new_sqlite_classes
// entries exist so the worker parses/dry-run-deploys, but their [[containers]] binding blocks stay COMMENTED.
export { MoqContainer, SrtContainer, FfmpegContainer, NdiContainer, OmtContainer };

export default {
	async fetch(request: Request, env: BridgeEnv & MoqEnv): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === "/health") {
			return Response.json({
				ok: true,
				service: "wave-bridge-edge",
				layer: "bridges",
				version: "dev",
			});
		}
		if (url.pathname === "/sitemap.xml") {
			return new Response(SITEMAP_XML, {
				headers: { "content-type": "application/xml; charset=utf-8", "cache-control": "public, max-age=3600" },
			});
		}
		if (url.pathname === "/llms.txt") {
			return new Response(LLMS_TXT, {
				headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=3600" },
			});
		}
		// srt.wave.online root — was a bare orange-cloud placeholder (530, no origin). The wildcard
		// route (wrangler.toml) puts this worker in front of the host, which alone kills the 530.
		// Serve a static, HONEST "preview / not yet live" page here — it makes no promise of working
		// ingest. Every other path on this host (e.g. /srt) still falls through below to the same
		// real handlers (handleSrt's honest 501), so activation state is unchanged.
		if (url.hostname === "srt.wave.online" && url.pathname === "/") {
			return new Response(SRT_PREVIEW_HTML, {
				headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=300" },
			});
		}
		// MoQ route — LIVE. Forwards to the CF Container running the proven strand, which round-trips
		// real objects through moq.wave.online. Fail-closes to typed 501 if MOQ_BRIDGE is unbound.
		if (url.pathname === "/bridge" || url.pathname.startsWith("/bridge/")) {
			return handleMoqBridge(request, env);
		}
		// SRT route (Wave 1). Honest typed 501 today; forward-shape behind a default-off flag (see srt.ts).
		if (url.pathname === "/srt" || url.pathname.startsWith("/srt/")) {
			return handleSrt(request, env);
		}
		// NDI route. Same honest-501 contract as /srt, gated additionally on Vizrt redistribution (#169).
		if (url.pathname === "/ndi" || url.pathname.startsWith("/ndi/")) {
			return handleNdi(request, env);
			}
			if (url.pathname === "/omt" || url.pathname.startsWith("/omt/")) {
				return handleOmt(request, env);
			}
			if (url.pathname === "/playout" || url.pathname.startsWith("/playout/")) {
				return handlePlayout(request, env);
		}
		// Realtime → baseband EGRESS entry (#73). POST a RealtimeEgressSource descriptor; the route drives
		// the recorded-playout → transport seam, fail-closing to the existing honest 501s (no fake stream).
		if (url.pathname === "/egress" || url.pathname.startsWith("/egress/")) {
			return handleEgress(request, env);
		}
		// All other protocols are not implemented yet — generic honest 501.
		return Response.json(
			{ error: "BRIDGE_NOT_IMPLEMENTED", protocol: url.pathname.split("/")[1] ?? "unknown" },
			{ status: 501 },
		);
	},
};

// Agent-discovery surface (llms.txt convention) — the machine-readable "what is this" that
// autonomous agents fetch first. This bridge is early scaffold; said so honestly.
const LLMS_TXT = `# WAVE — Bridge Edge
> Any-to-any broadcast-protocol bridge (Layer 2 of the WAVE Protocol Plane). Routes Worker traffic to
> CF Containers running native protocol binaries. /bridge (MoQ) is LIVE: it runs the proven MoQ strand
> in a CF Container that round-trips real objects through the live moq.wave.online relay (on-prem →
> Cloudflare → on-prem) and returns an integrity receipt. /srt and /ndi remain typed 501 — CF
> Containers have no public UDP ingress, so those strands cannot run hosted yet (architectural, not a
> flag): /srt (scope srt:read|srt:write); /ndi (scope ndi:read|ndi:write) also gated on Vizrt NDI
> Advanced SDK redistribution (#169). /omt (scope omt:read|omt:write) is open-spec (no license gate) and
> /playout (scope playout:read|playout:write) is the RECORDED-first ffmpeg file->transport stage — both
> typed 501 until their containers/{omt,ffmpeg} images + bindings land. Dante still on the generic 501.
> /egress is the realtime->baseband ENTRY: POST a RealtimeEgressSource { mode, org, sessionId, target,
> objectUrl? } and it drives the recorded-playout->transport seam, fail-closing to the same honest 501s
> (recorded->FFMPEG_PLAYOUT_NOT_ACTIVATED today; live mode deferred to the realtime->MoQ republish shim).
> Part of WAVE — the open
> video API for people and AI agents.

## Start here
- Product: https://bridge.wave.online
- Docs: https://docs.wave.online
- API reference: https://dev.wave.online/reference

## Notes
- Operated by WAVE Online, LLC.
`;

// Crawlable public surfaces on this host. The protocol bridge routes are auth-gated / not crawlable.
const SITEMAP_XML = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://bridge.wave.online/llms.txt</loc></url>
</urlset>
`;

// srt.wave.online landing page — static and HONEST. Makes no promise of working ingest; says plainly
// that the endpoint is a preview / not yet live, and points to the live WAVE surface. This is the
// ONLY content served at srt.wave.online/; /srt/* on this host still hits handleSrt's real 501.
const SRT_PREVIEW_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>SRT ingest — preview</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 640px;
    margin: 4rem auto; padding: 0 1.5rem; color: #111; line-height: 1.5; }
  h1 { font-size: 1.5rem; }
  a { color: #0645ad; }
  .badge { display: inline-block; background: #fff3cd; color: #664d03; border: 1px solid #ffe69c;
    border-radius: 4px; padding: .15rem .5rem; font-size: .85rem; font-weight: 600; }
</style>
</head>
<body>
<h1>SRT ingest &mdash; preview</h1>
<p><span class="badge">preview</span> This SRT ingest endpoint is <strong>not yet live</strong>. It is
an early preview of what's coming to WAVE's protocol bridge &mdash; no stream is accepted here today.</p>
<p>For the live WAVE platform, visit <a href="https://wave.online">wave.online</a>.</p>
</body>
</html>
`;
