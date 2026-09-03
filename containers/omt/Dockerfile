# OMT (Open Media Transport) bridge — open-spec, no license barrier.
#
# CORRECTED 2026-05-29: OMT is .NET-first. The canonical reference impl is
# libomtnet (.NET Standard 2.0, C#). There's a libomt C wrapper (also C#
# internally) for native integrations, and libvmx (C) for the VMX video codec.
#
# Container topology:
#   • .NET 8 runtime (LTS) — to host libomtnet
#   • libvmx (C library) — VMX codec native build
#   • Go control plane adapter — talks to gateway, manages lifecycle
#   • C# bridge — receives Go IPC and drives libomtnet/libvmx
#
# Refs:
#   • https://github.com/openmediatransport/libomtnet (.NET reference)
#   • https://github.com/openmediatransport/libomt (C wrapper)
#   • https://github.com/openmediatransport/libvmx (VMX codec)
#   • https://www.openmediatransport.org/

# --- Stage 1: build libvmx C library + libomtnet .NET assemblies
FROM mcr.microsoft.com/dotnet/sdk:8.0-bookworm-slim AS dotnet-builder
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential cmake git ca-certificates pkg-config \
    && rm -rf /var/lib/apt/lists/*

# libvmx — VMX video codec (C library used by OMT)
ARG LIBVMX_REF=main
RUN git clone --depth=1 --branch=${LIBVMX_REF} https://github.com/openmediatransport/libvmx.git /build/libvmx \
    && cd /build/libvmx && mkdir build && cd build \
    && cmake -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=/usr/local .. \
    && make -j$(nproc) && make install

# libomtnet — .NET reference impl
ARG LIBOMTNET_REF=main
RUN git clone --depth=1 --branch=${LIBOMTNET_REF} https://github.com/openmediatransport/libomtnet.git /build/libomtnet \
    && cd /build/libomtnet && dotnet publish -c Release -o /usr/local/lib/libomtnet/

# --- Stage 2: build Go control-plane adapter
FROM golang:1.26-bookworm AS go-builder
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential pkg-config ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /build/bridge
COPY adapter/ ./
RUN go build -trimpath -ldflags="-s -w" -o /usr/local/bin/wave-omt-bridge ./cmd/bridge

# --- Stage 3: runtime — .NET 8 runtime + libvmx + Go adapter
FROM mcr.microsoft.com/dotnet/aspnet:8.0-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=dotnet-builder /usr/local/lib/libvmx* /usr/local/lib/
COPY --from=dotnet-builder /usr/local/lib/libomtnet/ /usr/local/lib/libomtnet/
COPY --from=go-builder /usr/local/bin/wave-omt-bridge /usr/local/bin/
RUN ldconfig
EXPOSE 8080/tcp
ENTRYPOINT ["/usr/local/bin/wave-omt-bridge"]
