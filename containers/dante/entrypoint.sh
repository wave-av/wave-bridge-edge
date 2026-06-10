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

# ── dante.json generation ───────────────────────────────────────────────────
# Per the Dante SDK Connect Edition Getting Started page, DEP reads `dante.json`
# from its installation directory at activation/start. We carry the WAVE
# product identity + network shape in `dante.json.template` (committed in this
# repo) and envsubst at boot so the interface name + websocket port can be
# overridden per deployment without rebuilding the image. The manfId/modelId
# pair MUST match the WAVE_AUDINATE_LICENSE_KEY — they're hard-coded in the
# template since the license key issuance is paired to those exact values
# (see README "License posture").
DANTE_JSON_TEMPLATE="/usr/local/share/wave/dante.json.template"
DANTE_JSON="${DEP_DIR}/dante.json"

if [ -f "${DANTE_JSON_TEMPLATE}" ]; then
  log "rendering dante.json from template (WAVE_DANTE_IFACE=${WAVE_DANTE_IFACE:-eth0}, WAVE_DANTE_WS_PORT=${WAVE_DANTE_WS_PORT:-49999})"
  WAVE_DANTE_IFACE="${WAVE_DANTE_IFACE:-eth0}" \
  WAVE_DANTE_WS_PORT="${WAVE_DANTE_WS_PORT:-49999}" \
  envsubst < "${DANTE_JSON_TEMPLATE}" > "${DANTE_JSON}"
else
  log "WARNING: dante.json template missing at ${DANTE_JSON_TEMPLATE}; DEP will fall back to its own defaults (channel-zero device until enrolled in DDM)"
fi

# ── DEP startup ─────────────────────────────────────────────────────────────
cd "${DEP_DIR}"

# DEP's runtime requires /dev/cpuset + cgroup access. On CF Containers the
# kernel surface is restricted; the runc bundle's config.json declares the
# minimal devices it needs. If cgroups v2 is not available, runc will fail
# loudly here — surface the error verbatim to wrangler logs.
log "starting DEP runc container (DEP_VERSION=$(cat version 2>/dev/null || echo unknown))"
./dep.sh start &

# Fail-fast on a stuck DEP startup (CodeRabbit Major #6). dep.sh exits quickly
# after backgrounding runc; the actual `dante` container shows up in
# `./runc list` shortly after. Poll with a bounded retry, exit non-zero if it
# never appears — a half-booted adapter would otherwise quietly serve /health
# = degraded forever, defeating CF Containers' restart-on-fail.
DEP_BOOT_TIMEOUT_S="${DEP_BOOT_TIMEOUT_S:-30}"
deadline=$(( $(date +%s) + DEP_BOOT_TIMEOUT_S ))
while ! ./runc list 2>&1 | grep -qw dante; do
  if [ "$(date +%s)" -ge "${deadline}" ]; then
    log "ERROR: DEP container 'dante' did not appear in runc list within ${DEP_BOOT_TIMEOUT_S}s; refusing to start adapter"
    # Kill any straggler dep.sh children so CF Containers gets a clean exit.
    pkill -f dep.sh 2>/dev/null || true
    exit 1
  fi
  sleep 1
done
log "DEP container 'dante' is up"

# ── License activation ─────────────────────────────────────────────────────
# The CLI Dante Activator binary is bundled inside the DEP rootfs at
# /opt/dep/dante_package/tools/dante_activator. On first boot we activate
# against the WAVE_AUDINATE_LICENSE_KEY; subsequent boots no-op because the
# activation state persists in the dante_data/activation/ directory.
ACTIVATION_STATE="${DEP_DIR}/dante_data/activation/.activated"
if [ ! -f "${ACTIVATION_STATE}" ]; then
  log "activating DEP endpoint against Audinate cloud (one-time per container instance)"
  if [ -x "${DEP_DIR}/tools/dante_activator" ]; then
  timeout 30 "${DEP_DIR}/tools/dante_activator" activate \
    --license-key "${WAVE_AUDINATE_LICENSE_KEY}" \
    || { log "ERROR: activation failed; exiting"; exit 1; }
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
