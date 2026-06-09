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
# Fail-loud on dependency resolution errors — `|| true` previously masked
# legit go.mod problems and pushed failure into the `go build` step where it
# surfaces as a confusing compile error (CodeRabbit Minor #4).
RUN go mod download

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
# Pin the URL to the explicit versioned path (CodeRabbit Major #5). Audinate's
# portal currently serves both /latest/ and per-version sub-paths; the per-
# version directory is the immutable anchor. If a future build needs a Audinate
# rev that only lives under /latest/, override via --build-arg DEP_URL_PATH=latest
# AND bump DEP_SHA256 to the matching artifact. SHA256 stays the authoritative
# fail-close gate either way.
ARG DEP_URL_PATH=${DEP_VERSION}
ARG DEP_URL=https://dev.audinate.com/downloads/dep/container/x86_64/${DEP_URL_PATH}/
ARG DEP_SHA256=7de270af282dfbcace8ded3c3797525de836ddc412b0cbc5977de38d778ad1e0

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Pipefail before the pipe so a curl/sha256sum partial failure isn't masked by
# the subsequent step (Hadolint DL4006).
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# Local-artifact mode: if a tarball is available in the build context (Jake
# drops it at ~/.wave/dante-sdk/<file> + the build script COPYs it in under a
# known name), use it instead of fetching from dev.audinate.com. This bypasses
# the Auth0/DNA-Portal cookie dependency for builds where the operator has
# already downloaded the SDK. The SHA256 pin still gates either path so a
# wrong/tampered tarball fails-close.
#
# Toggle via --build-arg DEP_LOCAL_TARBALL=dep-1.5.4.3-x86_64.tar.gz at build
# time. When unset (default), the URL fetch path runs.
ARG DEP_LOCAL_TARBALL=""

# Stage the local tarball into a stable path (no-op when DEP_LOCAL_TARBALL is empty).
# COPY accepts a wildcard so a missing source file doesn't break the build when
# the operator opts for the URL path. The dep-fetch stage below detects presence
# via `test -s`.
COPY --chmod=0444 ${DEP_LOCAL_TARBALL:-Dockerfile} /tmp/dep-local-tarball

RUN --mount=type=secret,id=dna_cookie,target=/run/secrets/dna_cookie \
    set -eu; \
    if [ -s /tmp/dep-local-tarball ] && [ -n "${DEP_LOCAL_TARBALL}" ]; then \
      echo "DEP fetch: local artifact (${DEP_LOCAL_TARBALL})"; \
      cp /tmp/dep-local-tarball /tmp/dep.tgz; \
    else \
      echo "DEP fetch: ${DEP_URL}"; \
      curl --fail --silent --show-error --location \
        --cookie /run/secrets/dna_cookie \
        -o /tmp/dep.tgz \
        "${DEP_URL}"; \
    fi; \
    actual=$(sha256sum /tmp/dep.tgz | cut -d' ' -f1); \
    if [ "${actual}" != "${DEP_SHA256}" ]; then \
      echo "DEP SHA256 mismatch: expected ${DEP_SHA256}, got ${actual}" >&2; \
      exit 1; \
    fi; \
    mkdir -p /opt; \
    tar -xzf /tmp/dep.tgz -C /opt; \
    rm /tmp/dep.tgz /tmp/dep-local-tarball; \
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
    gettext-base \
    && rm -rf /var/lib/apt/lists/*

# Copy the verified DEP bundle.
COPY --from=dep-fetcher /opt/dep /opt/dep

# Copy our Go control-plane adapter.
COPY --from=adapter-builder /out/wave-dante-bridge /usr/local/bin/wave-dante-bridge

# dante.json template — WAVE's product identity (manfId/modelId) + network shape.
# entrypoint.sh envsubsts this at boot so the interface name + websocket port can
# be overridden per deployment without rebuilding the image.
COPY dante.json.template /usr/local/share/wave/dante.json.template

# envsubst lives in gettext-base; pull it in alongside the runtime deps below.

# Activation will happen at first boot via the CLI Dante Activator binary
# (./dante_activator) reading WAVE_AUDINATE_LICENSE_KEY from env. We do NOT
# bake the token into the image — secrets stay as wrangler-secret-bound env.
WORKDIR /opt/dep/dante_package

# Entrypoint launches the DEP runtime in the background, then runs the Go
# adapter in the foreground. tini reaps zombies if either dies.
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

EXPOSE 8080

# HEALTHCHECK uses the Go adapter's /health endpoint (handleHealth). DEP-side
# runc state + activation are reported inside the JSON body, so a 200 here means
# the adapter is up; the body distinguishes "ready" from "DEP-not-running" so
# CF Containers can route traffic away from a half-booted instance.
# Trivy DS-0026 / Checkov CKV_DOCKER_2.
HEALTHCHECK --interval=15s --timeout=3s --start-period=35s --retries=3 \
  CMD curl --fail --silent --show-error --max-time 2 http://127.0.0.1:8080/health \
      > /dev/null || exit 1
RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

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
# tini -- entrypoint.sh: tini becomes PID 1 (reaps DEP's children); entrypoint
# brings up the Dante container, then execs the Go adapter so the adapter sits
# at PID 2 (still gets SIGTERM from Cloudflare Containers shutdown).
#
# nosemgrep: dockerfile.security.missing-user-entrypoint.missing-user-entrypoint
ENTRYPOINT ["/usr/sbin/tini", "--", "/usr/local/bin/entrypoint.sh"]
