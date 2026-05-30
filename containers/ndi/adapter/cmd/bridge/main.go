// wave-ndi-bridge — NDI ↔ MoQ adapter, sidecar to wave-bridge-edge Worker.
//
// Listens on tcp/8080 for control plane, bridges NDI sources (discovered via
// Local Agent host-mode mDNS, NOT in-container mDNS) to MoQ tracks.
//
// SCAFFOLD STAGE — protocol path returns NotImplemented until (a) Newtek
// commercial license clearance (foundation task #142) lets us bundle NDI
// Library and (b) the wave-agent host-mode discovery flow lands (wave-agent
// issue #4). Build smoke-passes; runtime emits NotImplemented.
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
)

var errNotImplemented = errors.New("wave-ndi-bridge: protocol path gated on Newtek license + Local Agent integration")

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	logger.Info("wave-ndi-bridge starting", "version", "0.0.0-scaffold", "ndi_sdk_present", ndiSDKPresent())

	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true,"service":"wave-ndi-bridge","protocol":"ndi","stage":"scaffold"}`))
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
	logger.Info("wave-ndi-bridge shutting down")
	_ = server.Shutdown(context.Background())
}

func ndiSDKPresent() bool {
	_, err := os.Stat("/usr/local/lib/libndi.so")
	return err == nil
}
