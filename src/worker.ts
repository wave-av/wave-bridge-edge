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
		return Response.json(
			{ error: "BRIDGE_NOT_IMPLEMENTED", protocol: url.pathname.split("/")[1] ?? "unknown" },
			{ status: 501 },
		);
	},
};
