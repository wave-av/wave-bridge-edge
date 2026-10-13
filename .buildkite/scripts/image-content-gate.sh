#!/usr/bin/env bash
# Buildkite step image-content-gate: replaces GitHub Actions image-content-gate.yml `ndi` (build
# containers/ndi, then prove no NDI runtime is in the flattened filesystem or in any single layer).
# The gates are the verbatim `run:` bodies under .buildkite/gates/ (see lib/common.sh for the contract).
# shellcheck source-path=SCRIPTDIR source=lib/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"
bk_require_buildkite

# The docker CLI on PATH reaches the job's own Docker daemon. No registry
# credential exists in this job: the build pulls public base images only, and nothing is pushed.
if bk_require_tools docker tar grep find; then
  bk_gate 'build the image to be gated' image-content-gate.ndi.02-build-the-image-to-be-gated.gate
  if [[ "$_bk_last_rc" -eq 0 ]]; then
    bk_gate 'scan the flattened filesystem AND every individual layer' image-content-gate.ndi.03-scan-flattened-filesystem-and-every-layer.gate
  else
    # GH runs the scan only after a successful build; a failed build already failed this step.
    bk_skip 'scan the flattened filesystem AND every individual layer (the build failed)'
  fi
  docker image rm -f wave-ndi-bridge:ci >/dev/null 2>&1 || true
else
  bk_gate_fail 'docker missing from the image'
fi
bk_gates_summary
