# Security Policy

## Reporting a Vulnerability

Please report security vulnerabilities privately via [GitHub Security Advisories](https://github.com/wave-av/wave-bridge-edge/security/advisories/new). Do **not** open a public issue or pull request for security concerns.

We aim to acknowledge reports within 2 business days and provide a disclosure timeline within 5 business days.

## Scope

This repository hosts the Layer-2 Bridges container plane of the [WAVE Protocol Plane](https://github.com/wave-av/wave-foundation/blob/master/frameworks/protocol-plane/README.md). Security concerns in scope:

- Container escape / privilege escalation in any vendored binary (libsrt, NDI Library, libomtnet/libvmx, ffmpeg, AVM)
- Protocol-level vulnerabilities (e.g., libsrt handshake parsing, ffmpeg demuxer issues)
- Adapter Go/C# code: auth bypass, scope/meter circumvention, request smuggling, SSRF
- Container deployment: secret exposure via env, image-tag bait-and-switch, supply-chain regressions
- Cross-layer attacks via the Local Agent or gateway control plane

Out of scope:

- Theoretical issues without proof-of-concept
- Issues in dependencies already disclosed and patched upstream
- Social engineering / physical access
