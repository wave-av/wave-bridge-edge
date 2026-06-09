// wave-bridge-edge — Workers-pool test config (mirrors the estate convention; see
// wave-spoke-template/vitest.config.ts). Runs the SRT-route suite inside the real workerd runtime
// via @cloudflare/vitest-pool-workers, loading the deployed wrangler.toml so the test env matches
// production bindings/vars. The deployed wrangler.toml keeps the [[containers]] srt-bridge binding
// COMMENTED OUT (image unpushed + CF Containers off), so there is no SRT_BRIDGE binding in tests —
// which is exactly the real "not activated" state the suite asserts.
//
// pool-workers v0.16 (Vitest 4) registers the Workers pool as a Vite plugin via cloudflareTest().

import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./wrangler.toml" },
		}),
	],
	test: {
		include: ["test/**/*.spec.ts"],
	},
});
