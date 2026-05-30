# ffmpeg bridge container

ffmpeg 8.1.1 "Hoare" (2026-05-04) + AOMedia AVM 1.0.0 (AV2 reference, final spec 2026-05-29).

## Codec lineup

| Codec | Decoder | Encoder | Notes |
|---|---|---|---|
| **AV2** | AVM 1.0.0 (AOMedia) | AVM 1.0.0 | NEW — final spec 2026-05-29. ~40% bandwidth reduction vs AV1. Not in ffmpeg upstream until ~8.2; we shell out to AVM CLI tools (`aomenc`, `aomdec`) until libavm bridge lands |
| **AV1** | dav1d | libaom-av1, SVT-AV1, rav1e, NVenc, QSV, Vulkan | Vulkan AV1 encode added in ffmpeg 8.0 |
| **VVC/H.266** | native + VA-API | — | VA-API decode added in ffmpeg 8.0 |
| **HEVC/H.265** | native + hardware | libx265, hardware | |
| **H.264** | native + hardware | libx264, hardware | |
| **VP9/VP8** | libvpx | libvpx | |
| **Opus** | native | libopus | |
| **Vorbis** | native | libvorbis | |
| **WebP** | libwebp | libwebp | |
| **JPEG 2000** | libopenjpeg | libopenjpeg | |
| **Whisper STT** | — | filter (text out) | added in ffmpeg 8.0 |

## Why AV2 day-one

AOMedia AV2 final spec dropped 2026-05-29. Google + VideoLAN demoed real-time decoding at CES 2026. Reference encoder hit 1.0.0. ~40% bandwidth reduction vs AV1 with AR/VR + split-screen + screen-content optimizations.

WAVE supports AV2 from day one as an early-adopter signal. Real-world workflow today:

```
input → ffmpeg (decode source) → temp YUV → aomenc (AV2 encode) → output
```

The AV2 path is slower than other codecs (reference encoder, no hardware acceleration yet) but produces files at AV2 bitrates. When ffmpeg 8.2 (or whatever upstream version) lands libavm support, this shells out to `ffmpeg -c:v libavm ...` natively.

## Why these binaries

- `ffmpeg` — primary transcode + filter pipeline
- `ffprobe` — stream inspection (used by bridge control plane for content-type negotiation)
- `aomenc` / `aomdec` — AV2 reference codec until ffmpeg bridges libavm

## Why no x265/H.265 hardware-only

We bundle the open-source libx265 because hardware codec availability varies per CF Container instance class. Software fallback ensures every transcode path works on every instance.

## Sources

- ffmpeg 8.1.1 — https://ffmpeg.org/download.html
- AOMedia AVM (AV2 reference) — https://gitlab.com/AOMediaCodec/avm
- AV2 spec announcement — https://aomedia.org/
- libsrt (sibling container) — https://github.com/Haivision/srt (v1.5.5)
