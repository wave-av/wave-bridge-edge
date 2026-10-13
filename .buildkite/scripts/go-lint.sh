#!/usr/bin/env bash
# Buildkite step go-lint: replaces GitHub Actions go-lint.yml `go-lint`, a 4-cell matrix over the Go
# container adapters (gofmt, then go vet). The cells run one after another in this one guest; every
# cell's gates run even after a failure (GH used fail-fast: false).
# The gates are the verbatim `run:` bodies under .buildkite/gates/ (see lib/common.sh for the contract).
# shellcheck source-path=SCRIPTDIR source=lib/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"
bk_require_buildkite

# GH: actions/setup-go `stable`. Here: the CI image's pinned Go. GOTOOLCHAIN=local so a go.mod
# `toolchain` line can never make the job download a different toolchain; the build and module caches
# are job-local.
if bk_require_tools go gofmt; then
  _gocache=""
  bk_mktemp_dir _gocache
  GOTOOLCHAIN=local
  GOCACHE="$_gocache/build"
  GOMODCACHE="$_gocache/mod"
  GOFLAGS=-mod=readonly
  export GOTOOLCHAIN GOCACHE GOMODCACHE GOFLAGS
  printf '%s\n' "$(go version)"
  for cell in ffmpeg ndi omt srt; do
    bk_gate "containers/${cell}/adapter: gofmt" "go-lint.go-lint.${cell}.03-gofmt.gate"
    bk_gate "containers/${cell}/adapter: go vet" "go-lint.go-lint.${cell}.04-go-vet.gate"
  done
else
  bk_gate_fail 'Go toolchain (go, gofmt) missing from the image'
fi
bk_gates_summary
