# NDI bridge — Newtek NDI Library + Go adapter that bridges NDI ↔ MoQ tracks.
#
# ⚠️ LICENSE GATE: NDI SDK redistribution for server-side container use is gated
# on Newtek/Vizrt commercial-license clearance (wave-foundation task #142). This
# Dockerfile builds the ADAPTER ONLY — NDI Library binary is fetched at runtime
# from a Newtek-authorized URL via NDI_SDK_URL once licensing closes.
#
# Until then this image health-passes but emits NotImplemented on protocol paths.

FROM golang:1.23-bookworm AS builder
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential pkg-config ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /build/bridge
COPY adapter/ ./
RUN go build -trimpath -ldflags="-s -w" -o /usr/local/bin/wave-ndi-bridge ./cmd/bridge

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates libavahi-client3 libavahi-common3 \
    && rm -rf /var/lib/apt/lists/*
# NDI Library binary fetched at runtime (license-clearance pending).
# When NDI_SDK_URL + NDI_SDK_SHA256 env vars are set, entry script downloads + verifies.
COPY --from=builder /usr/local/bin/wave-ndi-bridge /usr/local/bin/
COPY entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/entrypoint.sh
# NDI traffic uses mDNS (UDP 5353) for discovery + arbitrary high ports for streams.
# In production these get bridged via the Local Agent (host-mode wave-agent).
EXPOSE 5353/udp 8080/tcp
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["/usr/local/bin/wave-ndi-bridge"]
