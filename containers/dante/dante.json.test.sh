#!/usr/bin/env bash
# wave-bridge-edge/containers/dante/dante.json.test.sh
#
# Smoke-tests `dante.json.template` rendering. Runs the same envsubst pipeline
# the container's entrypoint.sh uses, then validates the output is well-formed
# JSON and carries the WAVE product identity at the values Audinate expects to
# match against the license key.
#
# Designed to run in CI (no DEP runtime, no network) — pure rendering + JSON-parse
# check. Catches: missing envsubst tool, broken template, missing keys, accidental
# manfId/modelId drift, wrong types (e.g. webSocketPort emitted as string).

set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
TEMPLATE="${HERE}/dante.json.template"
OUT="$(mktemp -t dante-json.XXXXXX.json)"
trap 'rm -f "${OUT}"' EXIT

if [ ! -f "${TEMPLATE}" ]; then
  echo "FAIL: template missing at ${TEMPLATE}" >&2
  exit 1
fi

if ! command -v envsubst >/dev/null 2>&1; then
  echo "FAIL: envsubst not on PATH (install gettext / gettext-base)" >&2
  exit 1
fi

# Render with the same env-var contract entrypoint.sh uses.
WAVE_DANTE_IFACE="${WAVE_DANTE_IFACE:-eth0}" \
WAVE_DANTE_WS_PORT="${WAVE_DANTE_WS_PORT:-49999}" \
  envsubst < "${TEMPLATE}" > "${OUT}"

# 1. Must parse as JSON (catches missing closing brace, stray substitution, etc.).
python3 -c "import json, sys; json.load(open('${OUT}'))" || {
  echo "FAIL: rendered output is not valid JSON. Body:" >&2
  cat "${OUT}" >&2
  exit 1
}

# 2. Field-level checks: WAVE's product identity + network shape.
python3 - <<PY
import json, sys, os

with open(os.environ["OUT"]) as f:
    d = json.load(f)

fails = []

# product.manfId must match Audinate-assigned WAVE Online manufacturer ID.
mfg = d.get("product", {}).get("manfId")
if mfg != "0x31313234313139":
    fails.append(f"product.manfId mismatch: got {mfg!r}, expected 0x31313234313139 (WAVE Online ISV)")

# product.modelId must be the registered WAVEBRDG value — drift here means a
# product config went out under a different identity than what Audinate
# licensed against, which causes silent activation failure.
mdl = d.get("product", {}).get("modelId")
if mdl != "0x5741564542524447":
    fails.append(f"product.modelId mismatch: got {mdl!r}, expected 0x5741564542524447 (WAVEBRDG)")

# product.modelName + devicePrefix surface in Dante Controller — keep them stable.
if d.get("product", {}).get("modelName") != "WAVE Dante Bridge":
    fails.append("product.modelName must be 'WAVE Dante Bridge'")
if d.get("product", {}).get("devicePrefix") != "wave-":
    fails.append("product.devicePrefix must be 'wave-'")

# network.webSocketPort MUST be numeric (Activator parses as int) — envsubst on
# a missing var returns empty, which would emit `:` and break JSON. With our
# default 49999 we should always get a number here.
port = d.get("network", {}).get("webSocketPort")
if not isinstance(port, int):
    fails.append(f"network.webSocketPort must be int, got {type(port).__name__}={port!r}")

# network.interfaces must be a non-empty list. CF Containers default is eth0;
# AWS EC2 example was ens5. Either name is structurally valid; we just refuse
# empty (which would happen if the env override was set to '').
ifaces = d.get("network", {}).get("interfaces")
if not isinstance(ifaces, list) or not ifaces or not all(isinstance(i, str) and i for i in ifaces):
    fails.append(f"network.interfaces must be a non-empty list of non-empty strings, got {ifaces!r}")

if fails:
    print("FAIL: dante.json render checks:", file=sys.stderr)
    for f in fails:
        print(f"  - {f}", file=sys.stderr)
    sys.exit(1)

print(f"OK: dante.json renders cleanly ({len(json.dumps(d))} bytes)")
print(f"    manfId={mfg}, modelId={mdl}")
print(f"    iface={ifaces[0]}, webSocketPort={port}")
PY
