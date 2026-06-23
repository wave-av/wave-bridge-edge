# wave-srt-egress container — the SRT EGRESS sender, hosted on CF Containers (egress matrix #73).
#
# DIRECTION — this is EGRESS (MoQ/file → SRT caller push-out), the REVERSE of containers/srt/Dockerfile
# (which builds the SRT↔MoQ INGRESS adapter). Egress is the FAVORABLE direction: a sender pushes OUT
# (outbound), and CF Containers reach the net only outbound — so SRT egress is hostable here even though
# SRT ingress is not (no public UDP ingress on CF Containers).
#
# SCAFFOLD STAGE — this image carries ONLY the honest-501 control-plane server (server.mjs). The real
# push path bundles ffmpeg + libsrt (caller mode): `ffmpeg -i <objectUrl> -f mpegts srt://…?mode=caller`.
# That toolchain is added when this arms (see docs/runbook-srt-egress-arm.md ◆ steps) — NOT here, so the
# scaffold image stays tiny and builds fast. libsrt is BSD (no license gate, unlike NDI/Vizrt).
#
# This image is built at DEPLOY time once the wrangler [[containers]] SrtContainer block is uncommented
# (image = ./containers/srt/Dockerfile would be repointed at this egress Dockerfile, or this becomes the
# container's entrypoint). The PR gate runs `wrangler deploy --dry-run` and does NOT build it.
#
# Secret-free: no R2 creds live here (single-writer A-DO invariant — the DO/driver owns R2). The egress
# stage only PULLs the short-lived signed objectUrl it is handed on each /egress request.
FROM node:24-slim

WORKDIR /app
# Just the proven control-plane server. No package.json / npm install — server.mjs has no dependencies.
# When this arms, the ffmpeg + libsrt sender toolchain is layered in (multi-stage, mirroring
# containers/srt/Dockerfile's libsrt build + containers/ffmpeg/Dockerfile's ffmpeg build).
COPY server.mjs ./

# Egress control plane (Worker reaches this via the CF Container binding). The only network egress is the
# OUTBOUND signed-GET pull of objectUrl + the OUTBOUND srt:// caller push — both outbound, container-OK.
EXPOSE 8080/tcp
ENV PORT=8080
# Drop privileges: run as the built-in non-root `node` user (uid 1000). 8080 is non-privileged and the
# scaffold server writes nothing to disk — so root is never needed.
USER node
ENTRYPOINT ["node", "server.mjs"]
