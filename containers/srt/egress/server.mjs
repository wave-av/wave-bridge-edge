// wave-srt-egress — the SRT EGRESS server, hosted as a CF Container (egress matrix #73).
//
// DIRECTION — this is the REVERSE of containers/srt/adapter (which does SRT INGRESS, baseband → MoQ).
// EGRESS is MoQ/file → a native SRT SENDER (caller), and it is the FAVORABLE direction: a sender pushes
// OUT (outbound), and CF Containers reach the net only outbound (containers/moq/README.md) — so unlike
// SRT ingress (which needs public UDP ingress CF Containers lack), egress is genuinely hostable here.
//
// HONESTY CONTRACT — this server is a SCAFFOLD. It does NOT yet open a real `srt://` session or push a
// single frame. On a /egress request it returns a TYPED, HONEST 501 `SRT_EGRESS_NOT_IMPLEMENTED`,
// echoing the descriptor it WOULD act on, so the wiring is provable without fabricating a stream. The
// real push path (ffmpeg → libsrt caller) is net-new and is built+proven only when this arms (see the
// runbook docs/runbook-srt-egress-arm.md). /health is live so the Worker's container binding can probe.
//
// CONTRACT (per src/egress.ts + contract-rt-to-bridge-egress.md, RECORDED-first):
//   POST /egress  { objectUrl, target:"srt", destUrl, org, sessionId }
//     → (FUTURE) fetch(objectUrl) [outbound signed R2 GET] | ffmpeg -i - -f mpegts srt://… [caller push]
//     → (TODAY)  501 SRT_EGRESS_NOT_IMPLEMENTED, echoing { target, has_object_url, has_dest_url }
//   FIELD NAME (#134): the dial-OUT address is `destUrl` — the SAME canonical field src/egress.ts validates
//   + forwards (it was historically `srtUrl` here, a contract drift). `srtUrl` is still read as a cheap
//   back-compat alias so an older caller doesn't silently lose its address, but `destUrl` is canonical.
//   No R2 creds live here (single-writer A-DO invariant: the DO/driver owns R2; this stage is pure
//   transcode/egress — it only PULLs the short-lived signed objectUrl it is handed).
import http from 'node:http';
import { Buffer } from 'node:buffer';

const PORT = Number(process.env.PORT ?? 8080);
const SERVICE = 'wave-srt-egress';
const MAX_BODY = 64 * 1024; // descriptor is tiny JSON; bound it so a request can't buffer unbounded.

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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://container');
  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    // stage:"scaffold" is the honest lifecycle marker — NOT "live". The Worker's binding probe sees this.
    res.end(JSON.stringify({ ok: true, service: SERVICE, protocol: 'srt', direction: 'egress', stage: 'scaffold' }));
    return;
  }
  if (url.pathname === '/egress') {
    const d = await readJson(req);
    // Canonical dial-OUT field is destUrl (#134); accept legacy srtUrl as a back-compat alias.
    const destUrl = typeof d.destUrl === 'string' ? d.destUrl : typeof d.srtUrl === 'string' ? d.srtUrl : undefined;
    // DESIGN (built+proven on arm — see runbook): with FFMPEG present this would be
    //   const src = await fetch(d.objectUrl);                       // outbound signed R2 GET
    //   ffmpeg -i pipe:0 -c copy -f mpegts srt://<destUrl>?mode=caller   // push OUT to the customer listener
    // and the receipt would be ffmpeg's exit + a first-frame `ffplay srt://…` lock. NONE of that runs yet.
    res.writeHead(501, { 'content-type': 'application/json', 'retry-after': '86400', 'cache-control': 'no-store' });
    res.end(JSON.stringify({
      ok: false,
      error: 'SRT_EGRESS_NOT_IMPLEMENTED',
      service: SERVICE,
      protocol: 'srt',
      direction: 'egress',
      status: 'not_implemented',
      live: false,
      metered: false,
      // Echo ONLY presence flags, never the signed URL itself (no secret/URL leak into logs/responses).
      received: {
        target: typeof d.target === 'string' ? d.target : null,
        has_object_url: typeof d.objectUrl === 'string',
        has_dest_url: typeof destUrl === 'string',
      },
      blockers: [
        'build + push containers/srt egress image (this scaffold has no ffmpeg/libsrt sender yet)',
        'enable CF Containers on the account',
        'uncomment the [[containers]] SrtContainer binding in wrangler.toml',
        'set BRIDGE_FORWARD_ENABLED=true',
      ],
    }));
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'NOT_FOUND', service: SERVICE }));
});

server.listen(PORT, () => {
  process.stdout.write(JSON.stringify({ service: SERVICE, listen: PORT, direction: 'egress', stage: 'scaffold' }) + '\n');
});
