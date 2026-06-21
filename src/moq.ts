// MoQ route handler for wave-bridge-edge (WB-6 / E4) — the one strand that genuinely runs hosted.
//
// Unlike /srt and /ndi (which stay honest-501 because CF Containers have no public UDP ingress), the
// MoQ strand reaches the live relay at moq.wave.online over an OUTBOUND WebSocket — which works from
// inside a CF Container. So /bridge forwards to a real container running the PROVEN strand
// (containers/moq), which round-trips real objects through Cloudflare and returns a receipt.
//
// Honesty: this is live only when the MOQ_BRIDGE container binding is actually present. If it is
// absent (e.g. a plan/account without CF Containers), the handler FAIL-CLOSES to a typed 501 — it
// never fabricates a round-trip. No flag flip can make an absent container answer.
import { Container, getContainer } from '@cloudflare/containers';

/** Durable-Object-backed container running containers/moq/server.mjs (the proven MoQ strand). */
export class MoqContainer extends Container {
  defaultPort = 8080;
  sleepAfter = '5m';
}

export interface MoqEnv {
  /** CF Container binding for the hosted MoQ strand. Present once the [[containers]] block is
   *  provisioned on a CF-Containers-enabled account; absent → honest typed 501. */
  MOQ_BRIDGE?: DurableObjectNamespace<MoqContainer>;
}

const MOQ_SCOPES = { read: 'moq:read', write: 'moq:write' } as const;
/** A bounded round-trip is a few seconds; absence is an account/plan gate, not a transient blip. */
const MOQ_RETRY_AFTER_SECONDS = 3600;

function moqActivated(env: MoqEnv): boolean {
  return typeof env.MOQ_BRIDGE?.idFromName === 'function';
}

function notActivatedBody(method: string) {
  return {
    error: 'MOQ_BRIDGE_NOT_ACTIVATED',
    protocol: 'moq',
    status: 'not_activated',
    metered: false,
    live: false,
    required_scope: method === 'GET' || method === 'HEAD' ? MOQ_SCOPES.read : MOQ_SCOPES.write,
    blockers: ['provision the [[containers]] MOQ_BRIDGE binding on a CF-Containers-enabled account'],
    docs: 'https://bridge.wave.online/llms.txt',
  };
}

/**
 * Handle /bridge (and /bridge/*). When the MoQ container is bound, forward verbatim to it: the
 * container runs the proven strand and round-trips through the live relay, returning the receipt.
 * When unbound, honest typed 501 — no fabricated transport.
 */
export async function handleMoqBridge(request: Request, env: MoqEnv): Promise<Response> {
  if (!moqActivated(env)) {
    return Response.json(notActivatedBody(request.method), {
      status: 501,
      headers: { 'retry-after': String(MOQ_RETRY_AFTER_SECONDS), 'cache-control': 'no-store' },
    });
  }
  const url = new URL(request.url);
  // Bound the round-trip size at the edge too (defence in depth; the container also caps at 1000).
  const n = Math.max(1, Math.min(1000, Number(url.searchParams.get('n') ?? 100)));
  // One container instance per call spreads load across the autoscale pool (mux pattern).
  const container = getContainer(env.MOQ_BRIDGE!, crypto.randomUUID());
  const res = await container.fetch(new Request(`http://moq/bridge?n=${n}`, { method: 'GET' }));
  // Pass the container's receipt straight through (200 on ok, 502 on a failed round-trip).
  return new Response(res.body, {
    status: res.status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

export const __testing = { MOQ_SCOPES, MOQ_RETRY_AFTER_SECONDS, moqActivated, notActivatedBody };
