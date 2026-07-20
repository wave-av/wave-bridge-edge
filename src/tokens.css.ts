// Bridge (bridge.wave.online) — accent claimed from design-system/accent-wheel.md ("Bridge (any↔any
// gateway)" — infrastructure/edge lane).
export const ACCENT_OKLCH = "oklch(0.78 0.15 250)";
export const ACCENT_HEX = "#65bdff";
export const TOKENS_CSS = `:root{--bg:#0b0f14;--fg:#cfe3f7;--dim:#5b7287;--acc:${ACCENT_OKLCH};--warn:#e6b450}
::selection{background:var(--acc);color:var(--bg)}`;
