// Pulls in the `cloudflare:test` module declaration shipped by @cloudflare/vitest-pool-workers.
// It lives behind the package's "./types" subpath (NOT its root types), so we reference it
// path-specifically. The suite casts the `env` export to the worker's own BridgeEnv at the boundary.
/// <reference types="@cloudflare/vitest-pool-workers/types" />

// Vite `?raw` imports (used by the #73 egress wrangler-inert guard) resolve to the file's text.
declare module "*?raw" {
	const content: string;
	export default content;
}
