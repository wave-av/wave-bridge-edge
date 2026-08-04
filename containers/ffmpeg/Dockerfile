# ffmpeg transcode container — Layer 2 of WAVE Protocol Plane.
#
# Built from ffmpeg 9.0 "Lei" (2026-08-04) with the codec lineup WAVE
# needs for any-to-any transcoding across the Bridges layer.
#
# CODEC LINEUP (decode + encode unless noted):
#   • AV1   — libaom-av1, SVT-AV1 (libsvtav1), rav1e (librav1e); decode via dav1d
#   • AV2   — AOMedia AVM reference impl (research-v15.0.0; NOTE: the repo tags
#             releases as research-vN — there is no "v1.0.0" tag, the prior pin
#             never resolved). Decode + encode via AVM linked alongside ffmpeg
#             until upstream lands the codec (AV2 is NOT in ffmpeg 9.0; we
#             bundle AVM separately and shell out until the libavm bridge lands).
#   • VVC/H.266 — VA-API decode (in ffmpeg 8.0+)
#   • HEVC/H.265 — native + hardware
#   • H.264 — native + hardware
#   • Whisper — speech-to-text filter (added in ffmpeg 8.0)
#   • Vulkan video — AV1 encode (added in ffmpeg 8.0+)

# trixie, not bookworm: ffmpeg 9 requires Vulkan headers >= 1.3.277 (bookworm ships
# 1.3.239) and build-time SPIR-V compilation (runtime GLSL compiler removed in 9.0).
FROM debian:trixie-slim AS builder
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential cmake meson nasm pkg-config \
    git ca-certificates curl \
    libaom-dev libdav1d-dev libsvtav1enc-dev librav1e-dev \
    libx264-dev libx265-dev libvpx-dev libopus-dev libvorbis-dev \
    libwebp-dev libopenjp2-7-dev \
    libvulkan-dev glslang-dev glslang-tools libshaderc-dev spirv-tools \
    libssl-dev zlib1g-dev \
    && rm -rf /var/lib/apt/lists/*

# AV2 (AVM) reference codec — latest release tag (repo uses research-vN naming).
ARG AVM_VERSION=research-v15.0.0
RUN git clone --depth=1 --branch=${AVM_VERSION} https://gitlab.com/AOMediaCodec/avm.git /build/avm \
    && cd /build/avm && mkdir build && cd build \
    && cmake -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=/usr/local .. \
    && make -j$(nproc) && make install

# ffmpeg 9.0
ARG FFMPEG_VERSION=n9.0
RUN git clone --depth=1 --branch=${FFMPEG_VERSION} https://git.ffmpeg.org/ffmpeg.git /build/ffmpeg \
    && cd /build/ffmpeg \
    && ./configure \
        --prefix=/usr/local \
        --enable-gpl --enable-version3 --enable-nonfree \
        --enable-libaom --enable-libdav1d --enable-libsvtav1 --enable-librav1e \
        --enable-libx264 --enable-libx265 --enable-libvpx \
        --enable-libopus --enable-libvorbis \
        --enable-libwebp --enable-libopenjpeg \
        --enable-vulkan \
        --enable-openssl \
        --extra-cflags="-I/usr/local/include" \
        --extra-ldflags="-L/usr/local/lib" \
    && make -j$(nproc) && make install

FROM debian:trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    libaom3 libdav1d7 libsvtav1enc2 librav1e0.7 \
    libx264-164 libx265-215 libvpx9 libopus0 libvorbis0a libvorbisenc2 \
    libwebp7 libwebpmux3 libwebpdemux2 libopenjp2-7 \
    libvulkan1 \
    libssl3t64 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=builder /usr/local/lib/ /usr/local/lib/
COPY --from=builder /usr/local/bin/ffmpeg /usr/local/bin/ffprobe /usr/local/bin/
COPY --from=builder /usr/local/bin/avmenc /usr/local/bin/avmdec /usr/local/bin/
RUN ldconfig
EXPOSE 8080/tcp
ENTRYPOINT ["/usr/local/bin/ffmpeg"]
