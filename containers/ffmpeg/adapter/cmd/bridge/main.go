// wave-ffmpeg-bridge — ffmpeg control plane adapter for the WAVE Bridges layer.
//
// Spawns ffmpeg subprocesses for transcode jobs requested by the Worker side
// of wave-bridge-edge. Supports the full codec lineup documented in README.md
// (AV2/AV1/VVC/HEVC/H.264/VP9/Opus/Vorbis/WebP/JPEG2000/Whisper STT).
//
// SCAFFOLD STAGE — control plane returns 501 until job-queue + worker
// wiring lands. Health endpoint live + emits codec capabilities so the
// gateway can route transcode jobs to the right container instance.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"syscall"
)

var errNotImplemented = errors.New("wave-ffmpeg-bridge: job queue not yet wired")

type capabilities struct {
	OK       bool     `json:"ok"`
	Service  string   `json:"service"`
	FFmpeg   string   `json:"ffmpeg_version"`
	AVM      bool     `json:"avm_present"`
	Decoders []string `json:"decoders"`
	Encoders []string `json:"encoders"`
}

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	caps := probeCapabilities()
	logger.Info("wave-ffmpeg-bridge starting",
		"version", "0.0.0-scaffold",
		"ffmpeg", caps.FFmpeg,
		"avm_present", caps.AVM)

	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(caps)
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, errNotImplemented.Error(), http.StatusNotImplemented)
	})

	server := &http.Server{Addr: ":8080", Handler: mux}
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer cancel()
	go func() {
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error("http server", "err", err)
		}
	}()
	<-ctx.Done()
	logger.Info("wave-ffmpeg-bridge shutting down")
	_ = server.Shutdown(context.Background())
}

func probeCapabilities() capabilities {
	caps := capabilities{
		OK:      true,
		Service: "wave-ffmpeg-bridge",
		// Encoders/decoders kept in code rather than probed from ffmpeg at startup
		// because the lineup is the deploy contract (changes ship as image revs).
		Decoders: []string{
			"av2", "av1", "vvc", "hevc", "h264", "vp9", "vp8",
			"opus", "vorbis", "webp", "jpeg2000",
		},
		Encoders: []string{
			"av2", "libaom-av1", "libsvtav1", "librav1e",
			"libx264", "libx265", "libvpx",
			"libopus", "libvorbis", "libwebp", "libopenjpeg",
		},
	}
	if v, err := exec.Command("ffmpeg", "-version").Output(); err == nil {
		caps.FFmpeg = firstLine(v)
	}
	if _, err := os.Stat("/usr/local/bin/aomenc"); err == nil {
		caps.AVM = true
	}
	return caps
}

func firstLine(b []byte) string {
	for i, c := range b {
		if c == '\n' {
			return string(b[:i])
		}
	}
	return string(b)
}
