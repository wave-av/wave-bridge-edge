// Pulls in the `cloudflare:test` module declaration shipped by @cloudflare/vitest-pool-workers.
// It lives behind the package's "./types" subpath (NOT its root types), so we reference it
// path-specifically. The suite casts the `env` export to the worker's own BridgeEnv at the boundary.
/// <reference types="@cloudflare/vitest-pool-workers/types" />
