// bridge.wave.online — WAVE Bridge front-door. Layer 2 (Bridges) of the WAVE Protocol Plane: the
// on-ramp that translates legacy broadcast transports (SRT, NDI, Dante, OMT) into one WAVE-native
// MoQ stream. STORY: the real, provable-today miracle isn't "any protocol works" (only the MoQ
// strand is hosted) — it's that this on-ramp never needs an inbound port. A CF Container has no
// public UDP/TCP ingress, so the MoQ strand only ever dials OUT to the live relay at
// moq.wave.online — the one direction every facility firewall already allows, no ticket required.
// Every other transport is wired behind the same gateway and answers with an honest, typed 501
// (never a fabricated stream) until its container ships. See packs/bridge.md in wave-story-engine
// for the full WOW self-score.
import { shell } from "@wave-av/spoke-chassis";
import { TOKENS_CSS } from "./tokens.css";

export const LANDING_INNER = `<h1>WAVE <span class="acc">Bridge</span></h1>
<p class="sub">Skip the firewall ticket — your feed just dials out.</p>
<p class="sub" style="margin-top:.4rem">For a century a broadcast signal died at the edge of the facility: SRT boxes, an NDI subnet, Dante cabling, OMT — every one of them reachable only from inside the same building, and getting one onto the open internet meant a capture card, a dedicated circuit, a VPN someone babysits, or the request every broadcast engineer dreads: an inbound firewall exception. WAVE Bridge doesn't ask for that door. It only ever dials <span class="acc">out</span> — the one direction every facility firewall already allows.</p>
<div class="box" style="margin:1.2rem 0;padding:1.1rem 1.3rem">
<div class="flow">
<div class="fnode"><strong>broadcast gear</strong><span class="dim">SRT · NDI · Dante · OMT</span></div>
<div class="farrow">▼ <span class="dim">inside the building — no inbound port required</span></div>
<div class="fnode"><strong>bridge.wave.online</strong><span class="dim">Worker — dials outbound only</span></div>
<div class="farrow">▼ <span class="dim">outbound, the one direction every firewall already allows</span></div>
<div class="fnode"><strong>moq.wave.online</strong><span class="dim">live relay — one WAVE-native stream</span></div>
</div>
<p class="dim" style="margin:.8rem 0 0">metered + routed through api.wave.online</p>
</div>
<style>
.flow{display:flex;flex-direction:column;gap:.5rem}
.fnode{border:1px solid var(--line);border-left:3px solid var(--acc);border-radius:8px;padding:.7rem .9rem;display:flex;flex-direction:column;gap:.15rem}
.fnode strong{font-size:.95rem}
.farrow{color:var(--acc);font-size:.85rem;text-align:center}
</style>
<div class="row"><span class="k">hosted today</span><span><span class="acc">GET/POST</span> <span class="acc">/bridge</span> <span class="dim">→ MoQ strand, dials the relay outbound</span></span></div>
<div class="row"><span class="k">wired, honest 501</span><span><span class="warn">/srt</span> <span class="warn">/ndi</span> <span class="warn">/omt</span> <span class="dim">— typed <code>not_activated</code>, never a fabricated stream</span></span></div>
<div class="row"><span class="k">auth</span><span class="warn">Authorization: Bearer &lt;key&gt;</span> <span class="dim">(via gateway)</span></div>
<div class="row"><span class="k">health</span><span class="dim">GET /health</span></div>
<div class="row" style="margin-top:.8rem"><a class="btn" href="/skill.md">Get started →</a></div>
<p class="sub" style="margin-top:1.4rem">Bridge is Layer 2 of the WAVE Protocol Plane — the seam between a hundred years of broadcast hardware and the rest of WAVE. The moment a feed crosses it, it's WAVE-native: metered per stream through the gateway, recorded and played out through egress, delivered to both people and AI agents through the same open video API. Every transport that lands here inherits the same outbound-only on-ramp — no new firewall conversation, ever.</p>
<p class="sub" style="margin-top:.6rem"><span class="acc">Honest by design</span> — every transport that isn't hosted yet says so in a machine-readable 501 with a real blockers list; this bridge never claims a stream it cannot carry.</p>`;

export function landingPage(): string {
  return shell({
    product: "Bridge",
    title: "WAVE Bridge — skip the firewall ticket, your feed just dials out.",
    description: "WAVE Bridge translates broadcast transports (SRT, NDI, Dante, OMT) into one WAVE-native MoQ stream, dialing out to the live relay — no inbound port, no firewall ticket. Layer 2 of the WAVE Protocol Plane.",
    url: "https://bridge.wave.online",
    keywords: "broadcast bridge, SRT, NDI, Dante, OMT, MoQ, WAVE, protocol plane, firewall, on-ramp",
    inner: LANDING_INNER,
    tokensCss: TOKENS_CSS,
    accentHex: "#65bdff",
    ldHost: "bridge.wave.online",
    ldTagline: "Skip the firewall ticket — your feed just dials out onto WAVE.",
    cta: {
      primaryLabel: "See it live → curl bridge.wave.online/health",
      primaryHref: "https://bridge.wave.online/health",
      salesLabel: "Talk to sales",
      salesHref: "https://wave.online/enterprise",
    },
  });
}
