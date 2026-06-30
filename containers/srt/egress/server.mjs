// wave-srt-egress — the SRT EGRESS server, hosted as a CF Container (egress matrix #73 / #53).
//
// DIRECTION — this is the REVERSE of containers/srt/adapter (which does SRT INGRESS, baseband → MoQ).
// EGRESS is MoQ/file → a native SRT SENDER (caller), and it is the FAVORABLE direction: a sender pushes
// OUT (outbound), and CF Containers reach the net only outbound (containers/moq/README.md) — so unlike
// SRT ingress (which needs the public UDP ingress CF Containers lack), egress is genuinely hostable here.
//
// ARMED (#53) — this server now opens a REAL `srt://` caller session and pushes frames. On an egress
// request it spawns ffmpeg (built --enable-libsrt) to PULL the short-lived signed objectUrl (outbound
// HTTPS GET) and push it to the customer's SRT listener:
//   ffmpeg -i <objectUrl> -c copy -f mpegts srt://<host>:<port>?mode=caller&latency=200
// and returns a REAL receipt: { ok, bytes_sent, ffmpeg_exit } (200 on exit 0, 502 on a failed push). If
// the ffmpeg binary is somehow absent (a mis-built image), it FAIL-CLOSES to an honest 501 — never a fake
// success. `-c copy` remuxes when the recording codecs already fit MPEG-TS (H.264/AAC); else transcode.
//
// HONESTY: a 200 here means ffmpeg exited 0 having sent bytes — NOT a wire receipt by itself. The
// terminal proof (per docs/runbook-srt-egress-arm.md Step 7) is the first frame locking in `ffplay
// srt://…`; this server returns the byte/exit half of that receipt.
//
// SECURITY (validate-untrusted-input-before-sink / ssrf-guard-before-user-supplied-url-fetch): both URLs
// are UNTRUSTED and become ffmpeg I/O sinks. destUrl must be `srt://` to a real non-loopback host;
// objectUrl must be `https://` to a real non-loopback host. Loopback / link-local / unspecified hosts are
// rejected BEFORE ffmpeg is spawned. No R2 creds live here — only the short-lived signed objectUrl pulled.
//
// CONTRACT (per src/egress.ts + contract-rt-to-bridge-egress.md, RECORDED-first):
//   POST { objectUrl, target:"srt", destUrl, org, sessionId }   (canonical dial-OUT field is destUrl; the
//   legacy `srtUrl` is still read as a back-compat alias). The Worker forwards /srt VERBATIM to this
//   container (src/srt.ts → forwardToContainer), so the egress trigger is ANY non-/health path, not only
//   /egress — the body, not the path, carries the descriptor.
import http from 'node:http';
import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { access, constants } from 'node:fs/promises';

const PORT = Number(process.env.PORT ?? 8080);
const SERVICE = 'wave-srt-egress';
const FFMPEG = process.env.FFMPEG_BIN ?? '/usr/local/bin/ffmpeg';
const MAX_BODY = 64 * 1024; // descriptor is tiny JSON; bound it so a request can't buffer unbounded.
const PUSH_TIMEOUT_MS = Number(process.env.SRT_PUSH_TIMEOUT_MS ?? 5 * 60 * 1000); // hard cap a runaway push.

/** Read a bounded JSON body without buffering unboundedly. Returns {} on empty/oversize/invalid. */
async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) return {};
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return {};
  }
}

/** TRUE for loopback / link-local / unspecified hosts a sender must never be pointed at (SSRF guard). */
function isBlockedHost(host) {
  const h = host.toLowerCase();
  return (
    h === '' || h === 'localhost' || h === '0.0.0.0' || h === '::1' || h === '[::1]' ||
    h.startsWith('127.') || h.startsWith('169.254.')
  );
}

/** Validate the untrusted dial-OUT SRT URL. SRT URLs aren't WHATWG-"special", so parse the authority via
 *  an http shadow (scheme swapped for parsing only; the returned value keeps `srt:`). */
function validateDest(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return { ok: false, reason: 'destUrl is required' };
  const colon = raw.indexOf(':');
  if (colon <= 0) return { ok: false, reason: 'destUrl must be an absolute URL with a scheme' };
  if (raw.slice(0, colon + 1).toLowerCase() !== 'srt:')
    return { ok: false, reason: 'destUrl scheme must be srt: (e.g. srt://host:9000?mode=caller)' };
  let host, port;
  try {
    const shadow = new URL(`http:${raw.slice(colon + 1)}`);
    host = shadow.hostname;
    port = shadow.port;
  } catch {
    return { ok: false, reason: 'destUrl is not a parseable URL' };
  }
  if (isBlockedHost(host)) return { ok: false, reason: 'destUrl host is not allowed (loopback/link-local rejected)' };
  if (port !== '' && (Number(port) < 1 || Number(port) > 65535)) return { ok: false, reason: 'destUrl port out of range' };
  return { ok: true, destUrl: raw };
}

/** Validate the untrusted source object URL — must be a real-host HTTPS signed GET (the R2 object). */
function validateObjectUrl(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return { ok: false, reason: 'objectUrl is required' };
  let u;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, reason: 'objectUrl is not a parseable URL' };
  }
  if (u.protocol !== 'https:') return { ok: false, reason: 'objectUrl scheme must be https:' };
  if (isBlockedHost(u.hostname)) return { ok: false, reason: 'objectUrl host is not allowed (loopback/link-local rejected)' };
  return { ok: true, objectUrl: raw };
}

let ffmpegReady = false; // probed once at startup; gates armed-vs-scaffold honesty.

/** Spawn ffmpeg to pull objectUrl and push to destUrl as MPEG-TS over SRT caller. Resolves a receipt.
 *  Never throws; a failed push resolves { ok:false }. bytes_sent is parsed from ffmpeg's progress feed. */
function pushSrt(objectUrl, destUrl) {
  return new Promise((resolve) => {
    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-i', objectUrl,
      '-c', 'copy',            // remux-only: H.264/AAC recordings pass straight into MPEG-TS (no re-encode).
      '-f', 'mpegts',
      '-progress', 'pipe:1',   // machine-readable progress on stdout → we read total_size for bytes_sent.
      destUrl,
    ];
    const child = spawn(FFMPEG, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let bytesSent = 0;
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), PUSH_TIMEOUT_MS);

    child.stdout.on('data', (b) => {
      const m = String(b).match(/total_size=(\d+)/g);
      if (m && m.length) bytesSent = Number(m[m.length - 1].split('=')[1]) || bytesSent;
    });
    child.stderr.on('data', (b) => {
      stderr += String(b);
      if (stderr.length > 8192) stderr = stderr.slice(-8192); // keep only the tail; bound memory.
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, code: -1, bytesSent, stderr: stderr || String(err.message) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, code, bytesSent, stderr });
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://container');
  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    // stage reflects REALITY: "armed" once the ffmpeg sender is present; "scaffold" if mis-built.
    res.end(JSON.stringify({ ok: true, service: SERVICE, protocol: 'srt', direction: 'egress', stage: ffmpegReady ? 'armed' : 'scaffold' }));
    return;
  }
  // The Worker forwards /srt VERBATIM here, so any non-/health request is an egress push. Only POST carries
  // a descriptor body; reject other verbs cheaply.
  if (req.method !== 'POST') {
    res.writeHead(405, { 'content-type': 'application/json', allow: 'POST' });
    res.end(JSON.stringify({ ok: false, error: 'METHOD_NOT_ALLOWED', service: SERVICE, allow: 'POST' }));
    return;
  }

  // FAIL-CLOSED: if the sender binary is missing (mis-built image), return the honest 501 — never fake it.
  if (!ffmpegReady) {
    res.writeHead(501, { 'content-type': 'application/json', 'retry-after': '86400', 'cache-control': 'no-store' });
    res.end(JSON.stringify({
      ok: false, error: 'SRT_EGRESS_NOT_IMPLEMENTED', service: SERVICE, protocol: 'srt', direction: 'egress',
      status: 'not_implemented', live: false, metered: false,
      blockers: ['ffmpeg --enable-libsrt sender binary missing from the image (rebuild containers/srt/egress)'],
    }));
    return;
  }

  const d = await readJson(req);
  // Canonical dial-OUT field is destUrl (#134); accept legacy srtUrl as a back-compat alias.
  const rawDest = typeof d.destUrl === 'string' ? d.destUrl : typeof d.srtUrl === 'string' ? d.srtUrl : undefined;
  const dv = validateDest(rawDest);
  const ov = validateObjectUrl(d.objectUrl);
  if (!dv.ok || !ov.ok) {
    res.writeHead(400, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({
      ok: false, error: 'EGRESS_BAD_REQUEST', service: SERVICE, protocol: 'srt', direction: 'egress',
      reason: !ov.ok ? ov.reason : dv.reason,
      received: { target: typeof d.target === 'string' ? d.target : null, has_object_url: typeof d.objectUrl === 'string', has_dest_url: typeof rawDest === 'string' },
    }));
    return;
  }

  const r = await pushSrt(ov.objectUrl, dv.destUrl);
  const status = r.ok ? 200 : 502;
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify({
    ok: r.ok,
    service: SERVICE,
    protocol: 'srt',
    direction: 'egress',
    live: true,
    transport: 'srt-caller',
    bytes_sent: r.bytesSent,
    ffmpeg_exit: r.code,
    // Echo ONLY presence flags, never the signed URL itself (no secret/URL leak into logs/responses).
    received: { target: typeof d.target === 'string' ? d.target : 'srt', has_object_url: true, has_dest_url: true },
    ...(r.ok ? {} : { error: 'SRT_EGRESS_PUSH_FAILED', detail: r.stderr.trim().slice(-2048) }),
  }));
});

// Probe the sender once at startup so /health and the egress gate tell the truth about what this image can do.
access(FFMPEG, constants.X_OK)
  .then(() => { ffmpegReady = true; })
  .catch(() => { ffmpegReady = false; })
  .finally(() => {
    server.listen(PORT, () => {
      process.stdout.write(JSON.stringify({ service: SERVICE, listen: PORT, direction: 'egress', stage: ffmpegReady ? 'armed' : 'scaffold' }) + '\n');
    });
  });
