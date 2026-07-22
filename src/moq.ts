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
import { resolvePoolSize, poolContainerId, isContainerStartFailure } from '@wave-av/container-pool';

/** Durable-Object-backed container running containers/moq/server.mjs (the proven MoQ strand). */
export class MoqContainer extends Container<MoqEnv> {
  defaultPort = 8080;
  sleepAfter = '5m';

  // Forward the relay JOIN-mint config into the container's process env so the spawned strand
  // (containers/moq/server.mjs → `spawn('node', …)` inherits process.env) can exchange the durable org
  // bearer for a short-lived relay join-token (#27 — the relay flipped to auth default-ON, so a tokenless
  // strand 401s and /bridge round-trips fail 502). The field initializer runs right after super(), before
  // any lazy container start. The bearer is env-only, never logged, and is sent by the strand ONLY to the
  // https gateway — never to the relay.
  envVars = {
    WAVE_MOQ_JOIN: this.env.WAVE_MOQ_JOIN ?? '',
    WAVE_MOQ_TOKEN: this.env.WAVE_MOQ_TOKEN ?? '',
    WAVE_MOQ_GATEWAY: this.env.WAVE_MOQ_GATEWAY ?? 'https://api.wave.online',
  };
}

export interface MoqEnv {
  /** CF Container binding for the hosted MoQ strand. Present once the [[containers]] block is
   *  provisioned on a CF-Containers-enabled account; absent → honest typed 501. */
  MOQ_BRIDGE?: DurableObjectNamespace<MoqContainer>;
  /** Warm-pool size: how many stable container shards requests hash across. Tunable WITHOUT a code
   *  deploy (a `wrangler secret`/var change) so capacity scales with client load. MUST stay ≤ the
   *  MoqContainer `max_instances` in wrangler.toml (which is the hard ceiling + recycle headroom).
   *  Absent/invalid → DEFAULT_POOL_SIZE (from @wave-av/container-pool). */
  MOQ_POOL_SIZE?: string;
  /** '1'|'true'|'on' → the strand exchanges WAVE_MOQ_TOKEN at the gateway for a short-lived relay
   *  join-token (#27). Forwarded into the container process env by MoqContainer. Empty/absent → legacy. */
  WAVE_MOQ_JOIN?: string;
  /** Durable org bearer (Worker SECRET, set via `wrangler secret put`) the strand presents to the gateway
   *  mint endpoint. Env-only, never logged, never sent to the relay. Absent → join mode fail-closes. */
  WAVE_MOQ_TOKEN?: string;
  /** Gateway origin that mints the join-token. Defaults to https://api.wave.online. */
  WAVE_MOQ_GATEWAY?: string;
}

const MOQ_SCOPES = { read: 'moq:read', write: 'moq:write' } as const;
/** A bounded round-trip is a few seconds; absence is an account/plan gate, not a transient blip. */
const MOQ_RETRY_AFTER_SECONDS = 3600;
/** Transient pool-exhaustion / cold-start failure clears in seconds — not the account-gate horizon. */
const MOQ_UNAVAILABLE_RETRY_AFTER_SECONDS = 5;
/**
 * WARM-POOL SCALING MODEL (the durable answer to "how do we scale with clients?").
 *
 * A CF Container instance is addressed by a string id → one Durable-Object-backed instance, capped by
 * `max_instances` in wrangler.toml. Requests hash across a FIXED set of stable ids `moq-bridge-{0..N-1}`,
 * so warm instances are REUSED (low latency) and the number alive is BOUNDED by N — never leaked. This
 * replaces the original `crypto.randomUUID()` id-per-request, which spun a brand-new instance every call
 * and pinned all slots within one `sleepAfter` window → the "Maximum number of running container
 * instances exceeded" 500. With stable ids, an instance staying warm is REUSE (good), not a zombie.
 *
 * Scale knobs (no code change needed to grow):
 *   • MOQ_POOL_SIZE (env var)      — warm shards = concurrent round-trips served. Bump as clients grow.
 *   • max_instances (wrangler.toml) — HARD ceiling. Set to pool size + recycle HEADROOM so the platform
 *                                     can start a replacement instance while an old one drains (the lack
 *                                     of headroom is what made the original wedge unrecoverable).
 * At saturation the handler returns honest 503 BACKPRESSURE (retry-after), never a raw 500 — so a load
 * spike degrades gracefully instead of erroring. This same pattern is the fleet standard for every
 * container product (see the fleet-scaling audit task).
 *
 * The pool-size clamp / stable-id / pool-exhaustion helpers live in @wave-av/container-pool (shared
 * across every spoke) — see the import above. Only the spoke-specific 503 body/retry-after stay local.
 */

function moqActivated(env: MoqEnv): boolean {
  return typeof env.MOQ_BRIDGE?.idFromName === 'function';
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

/** Build the honest 503 backpressure Response (shared by the throw path and the returned-5xx path). */
function unavailableResponse(): Response {
  return Response.json(unavailableBody(), {
    status: 503,
    headers: {
      'retry-after': String(MOQ_UNAVAILABLE_RETRY_AFTER_SECONDS),
      'cache-control': 'no-store',
    },
  });
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
  // Route onto the warm pool so warm instances are reused and the pool cap (max_instances) is never
  // exceeded. A random-per-call id here leaks a fresh cold instance every request → pool exhaustion →
  // "Maximum number of running container instances exceeded". Pool size is env-tunable (scale knob).
  const container = getContainer(env.MOQ_BRIDGE!, poolContainerId('moq-bridge', resolvePoolSize(env.MOQ_POOL_SIZE)));
  let res: Response;
  try {
    res = await container.fetch(new Request(`http://moq/bridge?n=${n}`, { method: 'GET' }));
  } catch {
    // Container failed to START by THROWING (cold-start error). Honest 503 backpressure — never a raw 500.
    return unavailableResponse();
  }
  // CF Containers signals pool exhaustion by RETURNING a 5xx (it does not throw), so inspect the body:
  // the hosted strand only ever returns 200/502, so a 5xx carrying the runtime marker is the platform
  // saturating → convert to honest 503 backpressure. Read the body once, then reconstruct the response.
  const bodyText = await res.text();
  if (isContainerStartFailure(res.status, bodyText)) {
    return unavailableResponse();
  }
  // Pass the container's receipt straight through (200 on ok, 502 on a failed round-trip).
  return new Response(bodyText, {
    status: res.status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

export const __testing = {
  MOQ_SCOPES,
  MOQ_RETRY_AFTER_SECONDS,
  MOQ_UNAVAILABLE_RETRY_AFTER_SECONDS,
  moqActivated,
  notActivatedBody,
  unavailableBody,
};
