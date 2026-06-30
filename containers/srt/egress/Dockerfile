# wave-srt-egress container — the SRT EGRESS sender, hosted on CF Containers (egress matrix #73 / #53).
#
# DIRECTION — this is EGRESS (MoQ/file → SRT caller push-out), the REVERSE of containers/srt/Dockerfile
# (which builds the SRT↔MoQ INGRESS adapter). Egress is the FAVORABLE direction: a sender pushes OUT
# (outbound), and CF Containers reach the net only outbound — so SRT egress is hostable here even though
# SRT ingress is not (no public UDP ingress on CF Containers). This is THE architecturally-viable SRT
# activation path; the ingress Go adapter (containers/srt/adapter) can never run hosted on CF Containers.
#
# ARMED STAGE (#53) — this image now carries a REAL sender: ffmpeg (built --enable-libsrt) + libsrt
# v1.5.5 (pinned to match containers/srt/Dockerfile's ingress vendor for parity). On a /egress (or
# forwarded /srt) request, server.mjs PULLs the short-lived signed objectUrl (outbound GET) and pushes it
# to the customer's srt:// listener via `ffmpeg -i <objectUrl> -c copy -f mpegts srt://…?mode=caller`,
# returning a real receipt (ffmpeg exit + bytes). libsrt is BSD (no license gate, unlike NDI/Vizrt).
#
# Built at DEPLOY time by wrangler (wrangler.toml [[containers]] SrtContainer image points here); the PR
# gate / `npm run check` runs `wrangler deploy --dry-run`, which builds the image but deploys nothing.
#
# Secret-free: no R2 creds live here (single-writer A-DO invariant — the DO/driver owns R2). The egress
# stage only PULLs the short-lived signed objectUrl it is handed on each request.

# ---- builder: vendor libsrt v1.5.5 (mirror containers/srt/Dockerfile pin) + build ffmpeg --enable-libsrt
FROM debian:bookworm-slim AS builder
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential cmake nasm pkg-config git ca-certificates \
    libssl-dev zlib1g-dev libx264-dev \
    && rm -rf /var/lib/apt/lists/*

# libsrt v1.5.5 (2024-04-28) — same pin as the ingress adapter Dockerfile for vendor parity. libsrt's
# canonical build is cmake (its `./configure` is a tclsh wrapper that isn't present in a slim image).
ARG LIBSRT_VERSION=v1.5.5
RUN git clone --depth=1 --branch=${LIBSRT_VERSION} https://github.com/Haivision/srt.git /build/srt
WORKDIR /build/srt
RUN cmake -DCMAKE_INSTALL_PREFIX=/usr/local -DCMAKE_BUILD_TYPE=Release \
        -DENABLE_APPS=OFF -DENABLE_SHARED=ON -DENABLE_STATIC=OFF . \
    && make -j"$(nproc)" && make install && ldconfig

# ffmpeg n8.1.1 "Hoare" — scoped to what SRT egress needs: MPEG-TS mux + libsrt protocol + H.264/AAC
# (libx264 encode + native aac) for the transcode fallback when `-c copy` can't passthrough. NOT the full
# AV1/AV2 transcode lineup (that is containers/ffmpeg's job); this image stays lean + fast to build.
ARG FFMPEG_VERSION=n8.1.1
ENV PKG_CONFIG_PATH=/usr/local/lib/pkgconfig
RUN git clone --depth=1 --branch=${FFMPEG_VERSION} https://git.ffmpeg.org/ffmpeg.git /build/ffmpeg
WORKDIR /build/ffmpeg
RUN ./configure \
        --prefix=/usr/local \
        --enable-gpl --enable-version3 \
        --enable-libsrt --enable-libx264 \
        --enable-protocol=srt,file,https,tcp,tls \
        --disable-doc --disable-debug \
        --extra-cflags="-I/usr/local/include" \
        --extra-ldflags="-L/usr/local/lib" \
    && make -j"$(nproc)" && make install

# ---- runtime: node control plane (server.mjs) + the ffmpeg/libsrt sender it spawns.
# node:24-bookworm-slim shares bookworm's libc/libssl with the builder above (no cross-release ABI drift).
FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates libssl3 libx264-164 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=builder /usr/local/lib/libsrt* /usr/local/lib/
COPY --from=builder /usr/local/bin/ffmpeg /usr/local/bin/ffprobe /usr/local/bin/
RUN ldconfig

WORKDIR /app
# Just the proven control-plane server. No package.json / npm install — server.mjs has no npm deps.
COPY server.mjs ./

# Egress control plane (Worker reaches this via the CF Container binding). The only network egress is the
# OUTBOUND signed-GET pull of objectUrl + the OUTBOUND srt:// caller push — both outbound, container-OK.
EXPOSE 8080/tcp
ENV PORT=8080
# Drop privileges: run as the built-in non-root `node` user (uid 1000). 8080 is non-privileged and the
# sender streams through ffmpeg pipes (writes nothing to disk) — so root is never needed.
USER node
ENTRYPOINT ["node", "server.mjs"]
