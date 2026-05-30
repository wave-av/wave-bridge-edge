// wave-srt-bridge — SRT ↔ MoQ adapter, sidecar to wave-bridge-edge Worker.
//
// Listens on SRT_UDP_PORT for SRT ingest, validates the gateway-issued scope
// token via the bound Worker hostname, and re-emits decoded frames as MoQ
// tracks on the configured upstream.
//
// This file is a SCAFFOLD — protocol implementation is Wave 1 work tracked
// in the bridge roadmap. Build smoke-passes; runtime emits NotImplemented.
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

var errNotImplemented = errors.New("wave-srt-bridge: protocol path not yet implemented")

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	logger.Info("wave-srt-bridge starting", "version", "0.0.0-scaffold")

	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true,"service":"wave-srt-bridge","protocol":"srt","stage":"scaffold"}`))
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
	logger.Info("wave-srt-bridge shutting down")
	_ = server.Shutdown(context.Background())
}
