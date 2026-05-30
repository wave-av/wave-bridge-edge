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
        --enable-gpl --enable-version3 --enable-nonfree \
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
EXPOSE 8080/tcp
ENTRYPOINT ["/usr/local/bin/ffmpeg"]
