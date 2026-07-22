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
/** Transient pool-exhaustion / cold-start failure clears in seconds — not the account-gate horizon. */
const MOQ_UNAVAILABLE_RETRY_AFTER_SECONDS = 5;
/**
 * Size of the container-instance ring. MUST match `max_instances` for MoqContainer in wrangler.toml.
 * Requests hash onto a FIXED set of `moq-bridge-{0..N-1}` DO names so warm instances are REUSED and
 * the pool cap is never exceeded. A fresh id per call (crypto.randomUUID) instead spins a new cold
 * instance every time and pins all N slots within one `sleepAfter` window — the exact cause of the
 * "Maximum number of running container instances exceeded" 500 this ring fixes.
 */
const MOQ_POOL_SIZE = 3;

function moqActivated(env: MoqEnv): boolean {
  return typeof env.MOQ_BRIDGE?.idFromName === 'function';
}

/** Stable DO name for one shard of the bounded container ring (never more than MOQ_POOL_SIZE alive). */
function moqContainerId(): string {
  return `moq-bridge-${Math.floor(Math.random() * MOQ_POOL_SIZE)}`;
}

/** Honest typed receipt for a transient container failure (pool exhausted / cold-start) — not a raw 500. */
function unavailableBody() {
  return {
    error: 'MOQ_BRIDGE_UNAVAILABLE',
    protocol: 'moq',
    status: 'unavailable',
    metered: false,
    live: false,
    blockers: ['the hosted MoQ container pool is momentarily saturated or cold-starting; retry shortly'],
    docs: 'https://bridge.wave.online/llms.txt',
  };
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
  // Route onto the FIXED container ring so warm instances are reused and the pool cap (max_instances)
  // is never exceeded. A random-per-call id here leaks a fresh cold instance every request → pool
  // exhaustion → "Maximum number of running container instances exceeded".
  const container = getContainer(env.MOQ_BRIDGE!, moqContainerId());
  let res: Response;
  try {
    res = await container.fetch(new Request(`http://moq/bridge?n=${n}`, { method: 'GET' }));
  } catch (err) {
    // Container failed to START (pool momentarily saturated / cold-start error). Return an honest typed
    // receipt with a short retry-after — never leak the raw runtime exception as a bare 500.
    return Response.json(unavailableBody(), {
      status: 503,
      headers: {
        'retry-after': String(MOQ_UNAVAILABLE_RETRY_AFTER_SECONDS),
        'cache-control': 'no-store',
      },
    });
  }
  // Pass the container's receipt straight through (200 on ok, 502 on a failed round-trip).
  return new Response(res.body, {
    status: res.status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

export const __testing = { MOQ_SCOPES, MOQ_RETRY_AFTER_SECONDS, moqActivated, notActivatedBody };
