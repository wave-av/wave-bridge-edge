# SRT bridge — libsrt + Go adapter that bridges SRT UDP ↔ MoQ tracks.
# Pinned base image; multi-stage to keep final image small.

FROM golang:1.23-bookworm AS builder
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential cmake libssl-dev pkg-config \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /build
# Vendor libsrt at the latest stable tag (v1.5.5, 2024-04-28) for reproducibility.
# Notable fixes vs prior: token-bucket MAXREXMITBW controller, handshake buffer-overflow
# fix, srt_strerror() reentrancy fix, Windows ARM64 support (not used by us but tracks
# upstream platform parity), CMake 3.5+ compatibility, static OpenSSL build fixes.
ARG LIBSRT_VERSION=v1.5.5
RUN git clone --depth=1 --branch=${LIBSRT_VERSION} https://github.com/Haivision/srt.git
WORKDIR /build/srt
RUN ./configure --prefix=/usr/local && make -j$(nproc) && make install
WORKDIR /build/bridge
COPY adapter/ ./
RUN go build -trimpath -ldflags="-s -w" -o /usr/local/bin/wave-srt-bridge ./cmd/bridge

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates libssl3 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=builder /usr/local/lib/libsrt* /usr/local/lib/
COPY --from=builder /usr/local/bin/wave-srt-bridge /usr/local/bin/
RUN ldconfig
# SRT UDP default 9000-9100 + bridge HTTP control 8080
EXPOSE 9000-9100/udp 8080/tcp
ENTRYPOINT ["/usr/local/bin/wave-srt-bridge"]
