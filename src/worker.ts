// wave-bridge-edge — routes protocol traffic from the gateway to the right
// CF Container. Scaffolded for Wave-1 SRT spike; deferred routes return 501.
export default {
	async fetch(request: Request): Promise<Response> {
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
> Worker traffic to CF Containers running native protocol binaries (SRT spike first; NDI/OMT/Dante
> planned, license-gated). Most routes currently return 501. Part of WAVE — the open video API for
> people and AI agents.

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
