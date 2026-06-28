// CF Container Durable-Object classes for the protocol egress strands (task #134).
//
// BINDING-SHAPE LAW — every container binding in this worker is a Durable-Object-backed CF Container,
// reached the SAME way the live MoQ strand is: a `Container` subclass, bound as a
// `DurableObjectNamespace<X>`, and dispatched via `getContainer(ns, id).fetch()`. A DurableObjectNamespace
// has NO top-level `.fetch` — gating activation on `typeof ns?.fetch === "function"` is therefore a
// permanent false (the bug #134 fixes). The honest gate is `typeof ns?.idFromName === "function"` (mirrors
// src/moq.ts), the method a DurableObjectNamespace actually exposes.
//
// INERT: these classes + their `[[migrations]] new_sqlite_classes` entries may exist (so the worker
// parses + dry-run-deploys), but the live `[[containers]]`/`[[durable_objects]]` binding blocks for each
// stay COMMENTED in wrangler.toml and BRIDGE_FORWARD_ENABLED stays "false". The classes are dormant until
// an operator provisions the image + binding AND flips the flag — no fabricated transport, no live arm.
//
// Each subclass mirrors MoqContainer (defaultPort 8080 + a sleepAfter idle window). The egress adapters
// (containers/{srt,ndi,omt,ffmpeg}) run on the same port the live MoQ container does.
import { Container } from "@cloudflare/containers";

/** SRT egress strand (containers/srt/egress): MoQ/file → native SRT CALLER push-out. libsrt is BSD. */
export class SrtContainer extends Container {
	defaultPort = 8080;
	sleepAfter = "5m";
}

/** ffmpeg file-playout stage (containers/ffmpeg): PULLs a finalized R2 object → demux/transcode → sender. */
export class FfmpegContainer extends Container {
	defaultPort = 8080;
	sleepAfter = "5m";
}

/** NDI egress strand (containers/ndi). libndi_advanced is RUNTIME-fetched once #169 redistribution clears. */
export class NdiContainer extends Container {
	defaultPort = 8080;
	sleepAfter = "5m";
}

/** OMT egress strand (containers/omt). Open-spec — no license gate (one fewer floor than NDI). */
export class OmtContainer extends Container {
	defaultPort = 8080;
	sleepAfter = "5m";
}
