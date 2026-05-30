# OMT bridge container

[Open Media Transport](https://www.openmediatransport.org/) bridge — open-spec, no license barrier.

## Upstream layout (verified 2026-05-29)

OMT is .NET-first. The repos that matter:

| Repo | Language | Role |
|---|---|---|
| [libomtnet](https://github.com/openmediatransport/libomtnet) | C# (.NET Standard 2.0) | Canonical OMT protocol reference |
| [libomt](https://github.com/openmediatransport/libomt) | C# (wraps libomtnet, exposes C ABI) | Native integration entry point |
| [libvmx](https://github.com/openmediatransport/libvmx) | C | VMX video codec used by OMT |
| [Examples](https://github.com/openmediatransport/Examples) | C++ | Sample integrations |
| [Metadata](https://github.com/openmediatransport/Metadata) | spec | Recommended metadata formats |

OMT also ships [omtplugin](https://github.com/openmediatransport/omtplugin) for OBS and [omtplayer](https://github.com/openmediatransport/omtplayer) / [omtcapture](https://github.com/openmediatransport/omtcapture) for Raspberry Pi 5 — useful as integration test counterparts.

## Container topology

```
+----------------------------+
| .NET 8 runtime             |
|  ├─ libomtnet (OMT proto)  |
|  └─ wave-omt-bridge.cs    |  ← C# bridge (Wave-1 deliverable)
+----------------------------+
| libvmx (C)                 |  ← VMX codec
+----------------------------+
| wave-omt-bridge (Go)       |  ← control plane: gateway IPC, lifecycle
+----------------------------+
```

The Go adapter handles:
- Gateway authentication (scope/meter/settle)
- Container lifecycle hooks (CF Containers control plane)
- Health endpoint (`/health` → `{ok:true,service,protocol,stage}`)
- IPC bridge to the C# OMT runtime (Unix socket or gRPC over loopback)

The C# bridge handles:
- OMT protocol bookkeeping via libomtnet
- VMX codec invocations via libvmx
- Frame conversion: OMT video frame → MoQ track payload

## Wave-1 deliverable

OMT-in → MoQ-out single-direction prototype. Round-trip is Wave-2. Sender, receiver, plus discovery integration via Local Agent (wave-agent host-mode, issue #4).

## Why .NET in a Linux container

- libomtnet is the **canonical** reference impl; recreating it natively means recreating multiple years of work
- .NET 8 has full Linux ARM64 + AMD64 support; CF Containers runs both
- Active-CPU pricing means the .NET runtime warmup is paid for once per cold-start, not per-stream
