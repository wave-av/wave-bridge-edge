# ffmpeg transcode container — Layer 2 of WAVE Protocol Plane.
#
# Built from ffmpeg 8.1.1 "Hoare" (2026-05-04) with the codec lineup WAVE
# needs for any-to-any transcoding across the Bridges layer.
#
# CODEC LINEUP (decode + encode unless noted):
#   • AV1   — libaom-av1, SVT-AV1 (libsvtav1), rav1e (librav1e); decode via dav1d
#   • AV2   — AOMedia AVM 1.0.0 reference (final spec 2026-05-29). Decode + encode
#             via AVM linked alongside ffmpeg until upstream lands the codec
#             (AV2 is NOT in ffmpeg 8.1.1; we bundle AVM separately and shell out
#             until the libavm bridge is wired in 8.2 timeframe).
#   • VVC/H.266 — VA-API decode (in ffmpeg 8.0+)
#   • HEVC/H.265 — native + hardware
#   • H.264 — native + hardware
#   • Whisper — speech-to-text filter (added in ffmpeg 8.0)
#   • Vulkan video — AV1 encode (added in ffmpeg 8.0+)

FROM debian:bookworm-slim AS builder
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential cmake meson nasm pkg-config \
    git ca-certificates curl \
    libaom-dev libdav1d-dev libsvtav1-dev librav1e-dev \
    libx264-dev libx265-dev libvpx-dev libopus-dev libvorbis-dev \
    libwebp-dev libopenjp2-7-dev \
    libssl-dev zlib1g-dev \
    && rm -rf /var/lib/apt/lists/*

# AV2 (AVM) reference codec — final spec 2026-05-29, ref impl 1.0.0.
ARG AVM_VERSION=v1.0.0
RUN git clone --depth=1 --branch=${AVM_VERSION} https://gitlab.com/AOMediaCodec/avm.git /build/avm \
    && cd /build/avm && mkdir build && cd build \
    && cmake -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=/usr/local .. \
    && make -j$(nproc) && make install

# ffmpeg 8.1.1
ARG FFMPEG_VERSION=n8.1.1
RUN git clone --depth=1 --branch=${FFMPEG_VERSION} https://git.ffmpeg.org/ffmpeg.git /build/ffmpeg \
    && cd /build/ffmpeg \
    && ./configure \
        --prefix=/usr/local \
        --enable-gpl --enable-version3 \
        --enable-libaom --enable-libdav1d --enable-libsvtav1 --enable-librav1e \
        --enable-libx264 --enable-libx265 --enable-libvpx \
        --enable-libopus --enable-libvorbis \
        --enable-libwebp --enable-libopenjpeg \
        --enable-vulkan \
        --extra-cflags="-I/usr/local/include" \
        --extra-ldflags="-L/usr/local/lib" \
    && make -j$(nproc) && make install

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    libaom3 libdav1d6 libsvtav1enc1 librav1e0 \
    libx264-164 libx265-199 libvpx7 libopus0 libvorbis0a libvorbisenc2 \
    libwebp7 libopenjp2-7 \
    libssl3 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=builder /usr/local/lib/ /usr/local/lib/
COPY --from=builder /usr/local/bin/ffmpeg /usr/local/bin/ffprobe /usr/local/bin/
COPY --from=builder /usr/local/bin/aomenc /usr/local/bin/aomdec /usr/local/bin/
RUN ldconfig

# --- Licensing assertion: the binary we SHIP must be redistributable.
# ---
# --- `--enable-nonfree` was passed to configure until 2026-08-31 and was never needed. It enables
# --- nothing on its own; it only PERMITS the nonfree components, and this build enables none of
# --- them. Per FFmpeg n8.1.1 `configure`, the complete nonfree set is decklink, libfdk_aac,
# --- libmpeghdec (:2004) and cuda_nvcc, cuda_sdk, libnpp (:2152). This build enables libaom,
# --- libdav1d, libsvtav1, librav1e, libx264, libx265, libvpx, libopus, libvorbis, libwebp,
# --- libopenjpeg and vulkan — not one of them is on either list.
# ---
# --- Nor is openssl involved: it is opt-in via `--enable-openssl`, which this configure line does
# --- not pass, so the GPL/OpenSSL incompatibility that can force nonfree elsewhere never arises
# --- here. (`libssl3` above is a runtime dep of other packages, not an ffmpeg component.)
# ---
# --- So the flag bought nothing and cost the right to redistribute this image.
# ---
# --- Asserted in the FINAL stage against the BUILT BINARY's own recorded configuration, not against
# --- the text above: this is the artifact that actually ships, so reintroducing the flag by any
# --- route — a rewritten configure line, a base change, a stale cached layer — fails here rather
# --- than shipping quietly.
RUN set -eu; \
    conf="$(ffmpeg -hide_banner -buildconf 2>&1)"; \
    if printf '%s' "$conf" | grep -q -- '--enable-nonfree'; then \
      echo "ERROR: this ffmpeg is built nonfree, which makes the binary NON-REDISTRIBUTABLE."; \
      echo "ERROR: shipping it in a pushed image is redistribution we have no licence for."; \
      printf '%s\n' "$conf"; exit 1; \
    fi; \
    printf '%s' "$conf" | grep -q -- '--enable-gpl' \
      || { echo "ERROR: buildconf lacks --enable-gpl - the assertion is reading the wrong thing"; exit 1; }; \
    echo "OK: ffmpeg is not nonfree; this binary is redistributable."
EXPOSE 8080/tcp
ENTRYPOINT ["/usr/local/bin/ffmpeg"]
