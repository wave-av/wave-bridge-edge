// wave-moq-bridge — the MoQ strand hosted as a CF Container (WB-6 / E4).
//
// HONESTY CONTRACT — this server runs the PROVEN MoQ strand, byte-for-byte. On a /bridge request it
// spawns `node moq-strand.mjs sub` + `node moq-strand.mjs pub` (exactly as the proven on-prem MoQ
// round-trip harness does) and pushes N opaque units through the LIVE relay at moq.wave.online.
// Every unit goes container → Cloudflare (real WebSocket/QUIC) → container and back. Nothing is
// fabricated: if the relay is unreachable the round-trip FAILS and /bridge returns a non-ok receipt.
//
// This is the cloud anchor of the WAVE Bridge's MoQ strand — the hosted endpoint a Worker-fronted
// client reaches. It does NOT claim to host SRT/RIST: CF Containers have no public UDP ingress, so
// those strands stay on-prem (and honest-501 at the edge). MoQ is the one strand that genuinely runs
// hosted, because it crosses to Cloudflare over outbound WebSocket — which is exactly what works here.
import http from 'node:http';
import { spawn } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';

const HERE = dirname(fileURLToPath(import.meta.url));
const STRAND = join(HERE, 'moq-strand.mjs');
const PORT = Number(process.env.PORT ?? 8080);
const RELAY = process.env.WAVE_MOQ_RELAY ?? 'wss://moq.wave.online';
const FILL = 64;
const MAX_N = 1000; // bound a single round-trip so one request can't run unbounded.

// Wire framing for the stdio hop to moq-strand (length-delimited opaque bodies), identical to
// roundtrip-test.mjs. Body layout: [u32 seq][u64 stamp][fill] — stamp is an integrity echo.
function encodeUnit(seq, stamp, fill) {
  const body = Buffer.allocUnsafe(4 + 8 + fill.length);
  body.writeUInt32BE(seq, 0);
  body.writeBigUInt64BE(stamp, 4);
  fill.copy(body, 12);
  const out = Buffer.allocUnsafe(4 + body.length);
  out.writeUInt32BE(body.length, 0);
  body.copy(out, 4);
  return out;
}
function makeFramer(onFrame) {
  let acc = Buffer.alloc(0);
  return (chunk) => {
    acc = acc.length ? Buffer.concat([acc, chunk]) : chunk;
    for (;;) {
      if (acc.length < 4) return;
      const len = acc.readUInt32BE(0);
      if (acc.length < 4 + len) return;
      onFrame(acc.subarray(4, 4 + len));
      acc = acc.subarray(4 + len);
    }
  };
}
const waitReady = (proc, name, ms = 15000) =>
  new Promise((res, rej) => {
    let buf = '';
    const to = setTimeout(() => rej(new Error(`${name} never ready`)), ms);
    proc.stderr.on('data', (d) => {
      buf += d;
      if (buf.includes('MOQ_STRAND_READY')) {
        clearTimeout(to);
        res();
      }
    });
    proc.on('exit', (code) => rej(new Error(`${name} exited early (code ${code})`)));
  });

/**
 * Run one real round-trip of N units through the live relay and return a structured receipt.
 * Spawns the proven strand unchanged; resolves as soon as all N return (or a hard timeout).
 */
async function runRoundtrip(n) {
  const NS = `bridge-edge-${process.pid}-${Math.trunc(performance.now())}`;
  const TRACK = 't0';
  const got = new Map(); // seq -> { stamp, e2e_ms }
  const sendAt = new Map(); // seq -> performance.now() at publish
  const t0 = performance.now();

  const sub = spawn('node', [STRAND, 'sub', NS, TRACK], { stdio: ['ignore', 'pipe', 'pipe'] });
  sub.stdout.on('data', makeFramer((body) => {
    const seq = body.readUInt32BE(0);
    const stamp = body.readBigUInt64BE(4);
    const s = sendAt.get(seq);
    got.set(seq, { stamp, e2e_ms: s != null ? performance.now() - s : null });
  }));
  // Capture each strand's stderr so a failure surfaces the strand's own FATAL/log lines in the receipt
  // instead of an opaque "sub exited early" (actionable-error / fail-loud). The strand never logs the
  // token or joinToken (the bearer goes only to the gateway; ws errors carry no URL), so this is safe.
  let subErr = '';
  sub.stderr.on('data', (d) => { subErr += d; });
  const tail = (s) => s.trim().split('\n').slice(-6).join(' | ') || '(no stderr)';
  try {
    await waitReady(sub, 'sub');
  } catch (e) {
    throw new Error(`${e?.message ?? e} :: sub stderr: ${tail(subErr)}`);
  }

  const pub = spawn('node', [STRAND, 'pub', NS, TRACK], { stdio: ['pipe', 'ignore', 'pipe'] });
  let pubErr = '';
  pub.stderr.on('data', (d) => { pubErr += d; });
  try {
    await waitReady(pub, 'pub');
  } catch (e) {
    throw new Error(`${e?.message ?? e} :: pub stderr: ${tail(pubErr)}`);
  }

  const sent = new Map();
  for (let i = 0; i < n; i++) {
    const stamp = BigInt(1000000 + i * 333); // deterministic integrity echo
    sent.set(i, stamp);
    sendAt.set(i, performance.now());
    pub.stdin.write(encodeUnit(i, stamp, Buffer.alloc(FILL, i & 0xff)));
  }
  pub.stdin.end();

  // Resolve as soon as every unit has returned, else cap the wait (cloud round-trip drain).
  await new Promise((resolve) => {
    const deadline = Date.now() + Math.min(30000, 5000 + n * 20);
    const poll = setInterval(() => {
      if (got.size >= n || Date.now() > deadline) {
        clearInterval(poll);
        resolve();
      }
    }, 50);
  });
  sub.kill();
  pub.kill();

  let ok = 0;
  let badStamp = 0;
  let e2eSum = 0;
  let e2eCount = 0;
  for (const [seq, stamp] of sent) {
    const r = got.get(seq);
    if (!r) continue;
    if (r.stamp === stamp) ok++;
    else badStamp++;
    if (r.e2e_ms != null) {
      e2eSum += r.e2e_ms;
      e2eCount++;
    }
  }
  const received = got.size;
  const missing = n - received;
  return {
    ok: ok === n && received === n,
    service: 'wave-moq-bridge',
    relay: RELAY,
    sent: n,
    received,
    integrity_ok: ok,
    bad_stamp: badStamp,
    missing,
    e2e_mean_ms: e2eCount ? Number((e2eSum / e2eCount).toFixed(2)) : null,
    wall_ms: Number((performance.now() - t0).toFixed(1)),
    note: 'every unit crossed Cloudflare (moq.wave.online) and returned; integrity = stamp echo',
  };
}

// --- SOAK MODE (WB-6 Slice 2a / #314) ---------------------------------------------------------
// De-risk gate BEFORE encode work: prove the relay sustains an hours-long real-time publish, not just
// a bounded MAX_N=1000 synthetic burst. Fully additive — a new `/soak` route; `/bridge` above and its
// MAX_N burst path are byte-identical to before this change. Synthetic objects only, same
// [u32 seq][u64 stamp][fill] framing as the proven burst path; reuses moq-strand.mjs unchanged.
const SOAK_DEFAULT_SECONDS = 60;
const SOAK_MAX_SECONDS = 3600; // safety cap so a soak request can't run unbounded
const SOAK_TRACKS = {
  a0: { label: 'audio', unitBytes: 200, rate: 50 },   // 200B @ 50/sec
  v0: { label: 'video', unitBytes: 20 * 1024, rate: 15 }, // 20KB @ 15/sec
};

/**
 * Run a sustained pub+sub soak across both synthetic tracks for `seconds`, through the live relay
 * with the real join flow (WAVE_MOQ_JOIN/WAVE_MOQ_TOKEN unchanged from moq-strand.mjs), and return a
 * structured JSON receipt: per-track sent/received/loss/e2e-latency, reconnects, and whether the
 * session survived the full requested duration.
 *
 * KNOWN GAP: moq-strand.mjs's `resolveConnectUrl` mints one join-token at connect time and has NO
 * re-mint/reconnect path — if the relay's join-token TTL is shorter than `seconds`, the socket will
 * close mid-soak with nothing here to recover it. That is exactly the gap this soak is meant to
 * expose (see `join_token_remint_supported` / `exited_early` in the receipt), not something this
 * change silently papers over.
 */
async function runSoak(seconds) {
  const ns = `soak-${process.pid}`;
  const t0 = performance.now();
  const stopping = { value: false };
  const state = {};
  const pairs = {};

  const tail = (s) => s.trim().split('\n').slice(-6).join(' | ') || '(no stderr)';

  async function startTrack(trackId, spec) {
    const st = { sent: 0, got: new Map(), sendAt: new Map(), reconnects: 0, exitedEarly: false, label: spec.label };
    state[trackId] = st;

    const sub = spawn('node', [STRAND, 'sub', ns, trackId], { stdio: ['ignore', 'pipe', 'pipe'] });
    sub.stdout.on('data', makeFramer((body) => {
      const seq = body.readUInt32BE(0);
      const stamp = body.readBigUInt64BE(4);
      const s = st.sendAt.get(seq);
      st.got.set(seq, { stamp, e2e_ms: s != null ? performance.now() - s : null });
    }));
    let subErr = '';
    sub.stderr.on('data', (d) => { subErr += d; });
    sub.on('exit', () => { if (!stopping.value) { st.reconnects++; st.exitedEarly = true; } });
    try {
      await waitReady(sub, `sub:${trackId}`);
    } catch (e) {
      throw new Error(`${trackId} sub: ${e?.message ?? e} :: sub stderr: ${tail(subErr)}`);
    }

    const pub = spawn('node', [STRAND, 'pub', ns, trackId], { stdio: ['pipe', 'ignore', 'pipe'] });
    let pubErr = '';
    pub.stderr.on('data', (d) => { pubErr += d; });
    pub.on('exit', () => { if (!stopping.value) { st.reconnects++; st.exitedEarly = true; } });
    try {
      await waitReady(pub, `pub:${trackId}`);
    } catch (e) {
      throw new Error(`${trackId} pub: ${e?.message ?? e} :: pub stderr: ${tail(pubErr)}`);
    }

    pairs[trackId] = { sub, pub };

    const intervalMs = 1000 / spec.rate;
    const fill = Buffer.alloc(spec.unitBytes - 12, trackId.charCodeAt(0) & 0xff);
    st.timer = setInterval(() => {
      if (stopping.value || pub.stdin.destroyed) return;
      const seq = st.sent++;
      const stamp = BigInt(Date.now());
      st.sendAt.set(seq, performance.now());
      try {
        pub.stdin.write(encodeUnit(seq, stamp, fill));
      } catch {
        // pipe closing mid-write is expected right at teardown; loss surfaces in the receipt.
      }
    }, intervalMs);
  }

  for (const [id, spec] of Object.entries(SOAK_TRACKS)) {
    await startTrack(id, spec);
  }

  await new Promise((r) => setTimeout(r, seconds * 1000));
  stopping.value = true;
  for (const st of Object.values(state)) clearInterval(st.timer);
  // drain grace period so the last in-flight objects land before teardown
  await new Promise((r) => setTimeout(r, 1500));
  for (const { pub } of Object.values(pairs)) {
    try { pub.stdin.end(); } catch { /* already gone */ }
  }
  await new Promise((r) => setTimeout(r, 500));
  for (const { sub, pub } of Object.values(pairs)) {
    sub.kill();
    pub.kill();
  }

  const wall_s = Number(((performance.now() - t0) / 1000).toFixed(2));
  const tracks = {};
  let reconnectsTotal = 0;
  let survived = true;
  for (const [id, spec] of Object.entries(SOAK_TRACKS)) {
    const st = state[id];
    const e2es = [];
    let received = 0;
    for (const [, v] of st.got) {
      received++;
      if (v.e2e_ms != null) e2es.push(v.e2e_ms);
    }
    e2es.sort((a, b) => a - b);
    const pct = (p) => (e2es.length ? Number(e2es[Math.min(e2es.length - 1, Math.floor(e2es.length * p))].toFixed(2)) : null);
    tracks[id] = {
      label: spec.label,
      sent: st.sent,
      received,
      loss_pct: st.sent ? Number((100 * (1 - received / st.sent)).toFixed(3)) : null,
      e2e_p50_ms: pct(0.5),
      e2e_p99_ms: pct(0.99),
      reconnects: st.reconnects,
      exited_early: st.exitedEarly,
    };
    reconnectsTotal += st.reconnects;
    if (st.exitedEarly) survived = false;
  }

  return {
    ok: Object.values(tracks).every((t) => t.sent > 0 && !t.exited_early),
    service: 'wave-moq-bridge-soak',
    relay: RELAY,
    namespace: ns,
    duration_requested_s: seconds,
    duration_actual_s: wall_s,
    tracks,
    reconnects_total: reconnectsTotal,
    survived_full_duration: survived,
    join_token_remint_supported: false,
    note: 'moq-strand.mjs mints one join-token at connect and has NO re-mint/reconnect path; if the ' +
      'relay join-token TTL < duration_requested_s, expect exited_early=true / reconnects>0 above.',
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://container');
  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: 'wave-moq-bridge', stage: 'live', relay: RELAY }));
    return;
  }
  if (url.pathname === '/bridge') {
    const n = Math.max(1, Math.min(MAX_N, Number(url.searchParams.get('n') ?? 100)));
    try {
      const receipt = await runRoundtrip(n);
      res.writeHead(receipt.ok ? 200 : 502, { 'content-type': 'application/json' });
      res.end(JSON.stringify(receipt));
    } catch (err) {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, service: 'wave-moq-bridge', relay: RELAY, error: String(err?.message ?? err) }));
    }
    return;
  }
  if (url.pathname === '/soak') {
    const seconds = Math.max(
      1,
      Math.min(SOAK_MAX_SECONDS, Number(url.searchParams.get('seconds') ?? process.env.SOAK_SECONDS ?? SOAK_DEFAULT_SECONDS))
    );
    try {
      const receipt = await runSoak(seconds);
      res.writeHead(receipt.ok ? 200 : 502, { 'content-type': 'application/json' });
      res.end(JSON.stringify(receipt));
    } catch (err) {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, service: 'wave-moq-bridge-soak', relay: RELAY, error: String(err?.message ?? err) }));
    }
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'NOT_FOUND', service: 'wave-moq-bridge' }));
});
server.listen(PORT, () => {
  process.stdout.write(JSON.stringify({ service: 'wave-moq-bridge', listen: PORT, relay: RELAY }) + '\n');
});
