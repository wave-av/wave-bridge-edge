# wave-bridge-edge/containers/dante — Dante bridge container for Cloudflare Containers.
#
# DEP (Dante Embedded Platform) ships as an OCI runtime bundle, NOT a Docker image:
#   - dep/dante_package/runc         — statically-linked runc binary (Go, ~10MB)
#   - dep/dante_package/bundle/      — OCI runtime spec (config.json + rootfs/)
#   - dep/dante_package/dante_data/  — squashfs rootfs images (active + fallback)
#
# To run it under Docker / Cloudflare Containers we wrap it in a thin Debian outer
# layer that has squashfs-tools (for image mount) + the DEP bundle + our Go adapter.
# At container start, the entrypoint:
#   1. Mounts the squashfs rootfs (active image, fallback on corruption)
#   2. Activates the DEP license against the WAVE-issued token (Audinate's cloud)
#   3. Runs runc to start the DEP container instance
#   4. Starts our Go adapter on :8080 (health + gateway proxy + observability)
#
# The DEP OCI tarball is fetched at build-time by buildkit's secret-mount (so the
# license-protected artifact never lives in a layer); SHA256 is verified post-fetch.
#
# Build:
#   export WAVE_AUDINATE_DEP_X86_64_URL=https://dev.audinate.com/downloads/dep/container/x86_64/latest/
#   export DOCKER_BUILDKIT=1
#   docker build \
#     --secret id=dna_cookie,src=$HOME/.wave/secrets/dna-cookie.txt \
#     -t wave-av/wave-dante-bridge:1.5.4.3 \
#     containers/dante

# ── Stage 1: Go adapter build ─────────────────────────────────────────────────
FROM golang:1.24-bookworm AS adapter-builder

WORKDIR /src
COPY adapter/go.mod adapter/go.sum* ./
RUN go mod download || true

COPY adapter/ ./
# Static binary; trims debug info; bridges deploy to scratch-adjacent rootfs.
RUN CGO_ENABLED=0 GOOS=linux go build \
      -ldflags="-s -w -X main.version=1.5.4.3+wave" \
      -o /out/wave-dante-bridge \
      ./cmd/bridge

# ── Stage 2: DEP container bundle fetch + verify ──────────────────────────────
# Audinate's portal sits behind a Salesforce/Auth0 SSO cookie; we mount the
# cookie file as a build-time secret so it never lands in a layer. The pinned
# SHA256 (from dev.audinate.com/.../dep_for_x86_64.htm) is verified before the
# tarball is extracted, fail-closed if mismatched.
FROM debian:bookworm-slim AS dep-fetcher

ARG DEP_VERSION=1.5.4.3
ARG DEP_URL=https://dev.audinate.com/downloads/dep/container/x86_64/latest/
ARG DEP_SHA256=7de270af282dfbcace8ded3c3797525de836ddc412b0cbc5977de38d778ad1e0

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN --mount=type=secret,id=dna_cookie,target=/run/secrets/dna_cookie \
    set -eu; \
    curl --fail --silent --show-error --location \
      --cookie /run/secrets/dna_cookie \
      -o /tmp/dep.tgz \
      "${DEP_URL}"; \
    actual=$(sha256sum /tmp/dep.tgz | cut -d' ' -f1); \
    if [ "${actual}" != "${DEP_SHA256}" ]; then \
      echo "DEP SHA256 mismatch: expected ${DEP_SHA256}, got ${actual}" >&2; \
      exit 1; \
    fi; \
    mkdir -p /opt; \
    tar -xzf /tmp/dep.tgz -C /opt; \
    rm /tmp/dep.tgz; \
    test -d /opt/dep/dante_package; \
    test -x /opt/dep/dante_package/runc; \
    test -x /opt/dep/dante_package/dep.sh; \
    test -f /opt/dep/dante_package/dante_data/images/active

# ── Stage 3: final runtime image ──────────────────────────────────────────────
FROM debian:bookworm-slim

# DEP needs: squashfs tooling (mount the rootfs image), iproute2 + iptables
# (the bundle's network namespace setup), util-linux (mount helpers), tini
# (PID-1 reaper since we run multi-process: runc + our Go adapter).
RUN apt-get update && apt-get install -y --no-install-recommends \
    squashfs-tools \
    iproute2 \
    iptables \
    util-linux \
    tini \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Copy the verified DEP bundle.
COPY --from=dep-fetcher /opt/dep /opt/dep

# Copy our Go control-plane adapter.
COPY --from=adapter-builder /out/wave-dante-bridge /usr/local/bin/wave-dante-bridge

# Activation will happen at first boot via the CLI Dante Activator binary
# (./dante_activator) reading WAVE_AUDINATE_LICENSE_KEY from env. We do NOT
# bake the token into the image — secrets stay as wrangler-secret-bound env.
WORKDIR /opt/dep/dante_package

# Entrypoint launches the DEP runtime in the background, then runs the Go
# adapter in the foreground. tini reaps zombies if either dies.
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

EXPOSE 8080

# Security note: this container intentionally runs as root.
# DEP's runc bundle requires CAP_SYS_ADMIN to manage cgroups + network
# namespaces for the nested 'dante' runc container. The Go adapter is
# privilege-sensitive (it never touches the network namespace setup) but
# lives at PID 2 under the same uid because runc needs to fork it from the
# entrypoint that already has the necessary capabilities. Dropping uid here
# would break runc list / runc start.
#
# Defense-in-depth: the Cloudflare Containers runtime drops capabilities at
# the host level beyond what we declare in the deployment manifest, so a
# compromise inside the container can't escape the CF sandbox.
#
# nosemgrep: dockerfile.security.missing-user-entrypoint.missing-user-entrypoint
#
# tini -- entrypoint.sh: tini becomes PID 1 (reaps DEP's children); entrypoint
# brings up the Dante container, then execs the Go adapter so the adapter sits
# at PID 2 (still gets SIGTERM from Cloudflare Containers shutdown).
ENTRYPOINT ["/usr/sbin/tini", "--", "/usr/local/bin/entrypoint.sh"]
