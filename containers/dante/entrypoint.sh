#!/bin/sh
# wave-bridge-edge/containers/dante/entrypoint.sh
#
# Brings up the DEP container (Audinate runc bundle), waits for the Dante side
# to be alive, then execs the Go adapter as the foreground process. tini wraps
# us at PID 1 to reap zombies + propagate SIGTERM from CF Containers shutdown.

set -eu

DEP_DIR="/opt/dep/dante_package"
LOG_PREFIX="[wave-dante-bridge]"

log() { printf '%s %s\n' "${LOG_PREFIX}" "$*" >&2; }

# Required env (sourced from wrangler secrets — never baked into the image):
#   WAVE_AUDINATE_LICENSE_KEY    Audinate-issued per-endpoint license key
#   WAVE_GATEWAY_JWKS_URL        gateway public-key endpoint for inbound JWT validation
#   WAVE_GATEWAY_BASE            https://api.wave.online for x402 + observability
: "${WAVE_AUDINATE_LICENSE_KEY:?missing — set via wrangler secret put}"
: "${WAVE_GATEWAY_JWKS_URL:=https://api.wave.online/.well-known/jwks.json}"
: "${WAVE_GATEWAY_BASE:=https://api.wave.online}"

# ── DEP startup ─────────────────────────────────────────────────────────────
cd "${DEP_DIR}"

# DEP's runtime requires /dev/cpuset + cgroup access. On CF Containers the
# kernel surface is restricted; the runc bundle's config.json declares the
# minimal devices it needs. If cgroups v2 is not available, runc will fail
# loudly here — surface the error verbatim to wrangler logs.
log "starting DEP runc container (DEP_VERSION=$(cat version 2>/dev/null || echo unknown))"
./dep.sh start &
DEP_PID=$!

# Give DEP a few seconds to spin up its dante container. dep.sh exits quickly
# after backgrounding runc; the actual `dante` container shows up in
# `./runc list` shortly after.
sleep 3

if ! ./runc list 2>/dev/null | grep -qw dante; then
  log "WARNING: DEP container 'dante' not visible in runc list after 3s; continuing — adapter health endpoint will report state"
fi

# ── License activation ─────────────────────────────────────────────────────
# The CLI Dante Activator binary is bundled inside the DEP rootfs at
# /opt/dep/dante_package/tools/dante_activator. On first boot we activate
# against the WAVE_AUDINATE_LICENSE_KEY; subsequent boots no-op because the
# activation state persists in the dante_data/activation/ directory.
ACTIVATION_STATE="${DEP_DIR}/dante_data/activation/.activated"
if [ ! -f "${ACTIVATION_STATE}" ]; then
  log "activating DEP endpoint against Audinate cloud (one-time per container instance)"
  if [ -x "${DEP_DIR}/tools/dante_activator" ]; then
    "${DEP_DIR}/tools/dante_activator" activate \
      --license-key "${WAVE_AUDINATE_LICENSE_KEY}" \
      || { log "ERROR: activation failed; exiting"; exit 1; }
    touch "${ACTIVATION_STATE}"
  else
    log "WARNING: dante_activator not found at ${DEP_DIR}/tools/; activation skipped (developer-mode boot)"
  fi
fi

# ── Go adapter (foreground, PID 2) ─────────────────────────────────────────
log "starting Go adapter on :8080"
exec /usr/local/bin/wave-dante-bridge
