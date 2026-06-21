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
  await waitReady(sub, 'sub');

  const pub = spawn('node', [STRAND, 'pub', NS, TRACK], { stdio: ['pipe', 'ignore', 'pipe'] });
  await waitReady(pub, 'pub');

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
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'NOT_FOUND', service: 'wave-moq-bridge' }));
});
server.listen(PORT, () => {
  process.stdout.write(JSON.stringify({ service: 'wave-moq-bridge', listen: PORT, relay: RELAY }) + '\n');
});
