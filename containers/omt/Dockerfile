# OMT (Open Media Transport) bridge — open-spec, no license barrier.
# Bundles the OMT reference impl as a static binary + Go adapter.

FROM golang:1.23-bookworm AS builder
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential cmake pkg-config ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /build/bridge
COPY adapter/ ./
RUN go build -trimpath -ldflags="-s -w" -o /usr/local/bin/wave-omt-bridge ./cmd/bridge

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=builder /usr/local/bin/wave-omt-bridge /usr/local/bin/
EXPOSE 8080/tcp
ENTRYPOINT ["/usr/local/bin/wave-omt-bridge"]
