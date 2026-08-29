// Bridge (bridge.wave.online) — accent claimed from design-system/accent-wheel.md ("Bridge (any↔any
// gateway)" — infrastructure/edge lane).
export const ACCENT_OKLCH = "oklch(0.78 0.15 250)";
export const ACCENT_HEX = "#65bdff";
import { buildTokensCss } from "@wave-av/spoke-chassis";
const TOKENS = buildTokensCss("dark", { accent: ACCENT_OKLCH });
export const TOKENS_CSS = `${TOKENS}`;
