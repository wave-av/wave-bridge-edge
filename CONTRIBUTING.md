# Contributing to wave-bridge-edge

Thanks for the interest. This repo is part of the [WAVE Protocol Plane](https://github.com/wave-av/wave-foundation/blob/master/frameworks/protocol-plane/README.md) — Layer-2 Bridges (CF Containers running native broadcast-protocol binaries).

## Before you start

1. Read the [Protocol Plane framework](https://github.com/wave-av/wave-foundation/blob/master/frameworks/protocol-plane/README.md) to understand where this repo sits in the 4-layer architecture.
2. Pick a protocol scope: `containers/srt/`, `containers/ndi/`, `containers/dante/`, `containers/omt/`, `containers/ffmpeg/`. PRs that touch multiple are fine if the change is cross-cutting (e.g., capabilities schema).
3. Track work via [Issues](https://github.com/wave-av/wave-bridge-edge/issues) — the roadmap issue #1 is the master tracker.

## Development

- Container images build locally with standard Docker (multi-stage). Verify your image health-passes (`/health` 200 + correct shape) before pushing.
- Go adapter code: `go fmt ./...` + `go vet ./...` are required to be clean.
- C# (OMT): `dotnet format` required to be clean.
- Don't bypass the foundation-gate: secret-scan and file-size are non-negotiable. Both are required-status-checks on master.

## PR checklist

- [ ] Branch from latest `master`
- [ ] CI green (foundation-gate / checks + skill-validate)
- [ ] If touching a protocol container: README.md inside that container dir explains the change
- [ ] If touching the upstream version: bump in Dockerfile + note in commit message
