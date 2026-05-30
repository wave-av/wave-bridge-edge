// wave-omt-bridge — OMT (Open Media Transport) ↔ MoQ adapter.
//
// OMT is open-spec with no license barriers, making it a high-priority
// Wave-1 alongside SRT. This is the scaffold — real OMT-spec implementation
// is Wave-1 multi-week work tracked in the bridge roadmap.
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

var errNotImplemented = errors.New("wave-omt-bridge: protocol path not yet implemented")

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	logger.Info("wave-omt-bridge starting", "version", "0.0.0-scaffold")

	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true,"service":"wave-omt-bridge","protocol":"omt","stage":"scaffold"}`))
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
	logger.Info("wave-omt-bridge shutting down")
	_ = server.Shutdown(context.Background())
}
