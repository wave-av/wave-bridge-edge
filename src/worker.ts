// wave-bridge-edge — routes protocol traffic from the gateway to the right
// CF Container. Scaffolded for Wave-1 SRT spike; SRT and NDI both return a typed,
// honest 501 (`not_activated`) until their container images + CF Containers land;
// every other protocol returns the generic 501. No route fabricates transport.
import { handleSrt, type BridgeEnv } from "./srt";
import { handleNdi } from "./ndi";

export default {
	async fetch(request: Request, env: BridgeEnv): Promise<Response> {
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
		// SRT route (Wave 1). Honest typed 501 today; forward-shape behind a default-off flag (see srt.ts).
		if (url.pathname === "/srt" || url.pathname.startsWith("/srt/")) {
			return handleSrt(request, env);
		}
		// NDI route. Same honest-501 contract as /srt, gated additionally on Vizrt redistribution (#169).
		if (url.pathname === "/ndi" || url.pathname.startsWith("/ndi/")) {
			return handleNdi(request, env);
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
> Any-to-any broadcast-protocol bridge (Layer 2 of the WAVE Protocol Plane). EARLY scaffold: routes
> Worker traffic to CF Containers running native protocol binaries (SRT + NDI typed today; OMT/Dante
> still on the generic 501). ALL protocol routes currently return 501 — none are live or metered yet.
> /srt returns a typed 501 "not_activated" (scope srt:read|srt:write) until the container image is
> pushed and CF Containers is enabled. /ndi returns the same typed 501 (scope ndi:read|ndi:write)
> additionally gated on Vizrt NDI Advanced SDK redistribution clearance (#169). Part of WAVE — the
> open video API for people and AI agents.

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
