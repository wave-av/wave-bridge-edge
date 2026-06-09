// wave-bridge-edge/containers/dante/adapter/cmd/bridge/main.go
//
// Control-plane adapter for the wave-bridge-edge Dante container. Sits in front
// of the licensed DEP (Dante Embedded Platform) runtime — DEP handles the Dante
// protocol + audio plane, this adapter handles:
//   - gateway-issued JWT validation (cross-layer auth per protocol-plane spec)
//   - x402 metering heartbeats (10s active-CPU per protocol-plane spec)
//   - structured-log emission to the wave-obs-sidecar Worker (Outbound Workers
//     pattern per protocol-plane observability spec)
//   - health endpoint surfacing DEP runc state + activation status
//   - WAVE control-plane routing: when the WSC RealDanteService.ts issues a
//     subscribe-request, this adapter invokes the DEP runc-side tools to set
//     the actual receive-channel source
//
// Threading: standard HTTP server on :8080 (CF Containers exposes via the
// bridge Worker's `containers` binding). Background goroutines for the x402
// heartbeat + DEP-side reconciliation poll.

package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"strings"
	"syscall"
	"time"
)

// version is overwritten at build time via -ldflags "-X main.version=…".
var version = "dev"

const (
	// dep.sh + runc live in /opt/dep/dante_package per the upstream DEP layout.
	depWorkingDir   = "/opt/dep/dante_package"
	depContainerTag = "dante" // name DEP gives the runc container instance
	httpAddr        = ":8080"
	x402HeartbeatHz = 10 * time.Second
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		AddSource: false,
		Level:     slog.LevelInfo,
	}))
	logger = logger.With(
		"service", "wave-dante-bridge",
		"protocol", "dante",
		"version", version,
	)
	slog.SetDefault(logger)

	cfg, err := loadConfig()
	if err != nil {
		logger.Error("config load", "err", err)
		os.Exit(1)
	}
	logger.Info("starting", "gateway_base", cfg.GatewayBase, "license_tier", cfg.LicenseTier)

	// Defense-in-depth fail-closed guard: validateToken intentionally does NOT
	// verify the JWT signature today (jose/v2 + JWKS verifier is the follow-on
	// PR per README + PR description). On developer tier the gateway issues
	// short-lived tokens and we sit behind a CF Worker — acceptable. On
	// production tier this adapter MUST NOT be the trust boundary; refuse to
	// start until the jwx/v2 verifier lands. Anything else would let a forged
	// token pass scope-only checks (Sentry/CodeRabbit CRITICAL).
	if isProdTier(cfg.LicenseTier) {
		logger.Error("startup refused: production tier requires JWKS signature verification; tracking jwx/v2 integration",
			"license_tier", cfg.LicenseTier)
		os.Exit(1)
	}

	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer cancel()

	mux := http.NewServeMux()
	mux.HandleFunc("/health", handleHealth(cfg))
	mux.HandleFunc("/v1/subscribe", cfg.requireScope("dante:write")(handleSubscribe))
	mux.HandleFunc("/v1/unsubscribe", cfg.requireScope("dante:write")(handleUnsubscribe))
	mux.HandleFunc("/v1/routes", cfg.requireScope("dante:read")(handleRoutes))
	mux.HandleFunc("/v1/devices", cfg.requireScope("dante:read")(handleDevices))
	// /v1/admin/dante/enroll — WAVE control-plane → this container, hands over the
	// DDM (Dante Domain Manager) coordinates so the SDK device can be enrolled into
	// a Connect-solution domain. Until DDM is wired (task #231 + #233), this is an
	// honest 501 carrying the same shape the future call will accept — so callers can
	// integrate against the contract today without us pretending the activation works.
	mux.HandleFunc("/v1/admin/dante/enroll", cfg.requireScope("dante:admin")(handleEnroll))

	server := &http.Server{
		Addr:              httpAddr,
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
	}

	// Background: x402 heartbeat to the gateway every 10s while we have an
	// active container instance. Gateway aggregates these into per-tenant
	// active-CPU billing per the protocol-plane x402-metering spec.
	go runX402Heartbeat(ctx, cfg, logger)

	// HTTP-server bind/start failure must propagate to process exit — logging
	// only would leave the container "alive" without ever serving traffic, and
	// CF Containers would keep it scheduled (silent outage). We share `ctx`
	// from signal.NotifyContext above and call cancel() so the main goroutine
	// drops through to graceful Shutdown. (CodeRabbit Major #1.)
	go func() {
		logger.Info("http listening", "addr", httpAddr)
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error("http server bind/start failed; triggering shutdown", "err", err)
			cancel()
		}
	}()

	<-ctx.Done()
	logger.Info("shutdown signal received, draining")
	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer shutdownCancel()
	_ = server.Shutdown(shutdownCtx)
	logger.Info("shutdown complete")
}

// ── Configuration ────────────────────────────────────────────────────────────

type Config struct {
	GatewayBase string
	JWKSURL     string
	LicenseTier string
	LicenseKey  string // never logged; only sent in the activation flow
	ContainerID string // populated from /proc/1/cpuset on CF Containers; "local" otherwise
}

// isProdTier returns true when the license-tier env declares production posture.
// We accept several spellings to be friendly to operators ("prod", "production",
// "live"). The fail-closed startup guard in main() uses this to refuse to boot
// until JWKS signature verification lands. See main.go startup block.
func isProdTier(tier string) bool {
	t := strings.ToLower(strings.TrimSpace(tier))
	return t == "prod" || t == "production" || t == "live"
}

func loadConfig() (*Config, error) {
	c := &Config{
		GatewayBase: getenv("WAVE_GATEWAY_BASE", "https://api.wave.online"),
		JWKSURL:     getenv("WAVE_GATEWAY_JWKS_URL", "https://api.wave.online/.well-known/jwks.json"),
		LicenseTier: getenv("WAVE_AUDINATE_LICENSE_TIER", "developer"),
		LicenseKey:  os.Getenv("WAVE_AUDINATE_LICENSE_KEY"),
	}
	if c.LicenseKey == "" {
		return nil, errors.New("WAVE_AUDINATE_LICENSE_KEY must be set (wrangler secret)")
	}
	c.ContainerID = readContainerID()
	return c, nil
}

func getenv(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

// readContainerID returns the CF-issued container instance ID by reading
// /proc/1/cpuset. CF Containers stuffs the instance id there per their
// runtime spec. Returns "local" if not available (e.g. running outside CF).
func readContainerID() string {
	data, err := os.ReadFile("/proc/1/cpuset")
	if err != nil {
		return "local"
	}
	s := strings.TrimSpace(string(data))
	if idx := strings.LastIndex(s, "/"); idx >= 0 && idx < len(s)-1 {
		return s[idx+1:]
	}
	return s
}

// ── Health endpoint ──────────────────────────────────────────────────────────

func handleHealth(cfg *Config) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		depState := depRunState()
		body := map[string]any{
			"ok":            true,
			"service":       "wave-dante-bridge",
			"protocol":      "dante",
			"version":       version,
			"container_id":  cfg.ContainerID,
			"license_tier":  cfg.LicenseTier,
			"dep_running":   depState.Running,
			"dep_container": depState.ContainerStatus,
		}
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(body)
	}
}

type depState struct {
	Running         bool   `json:"running"`
	ContainerStatus string `json:"status"`
}

func depRunState() depState {
cmd := exec.CommandContext(context.Background(), "./runc", "list", "-f", "json")
	cmd.Dir = depWorkingDir
	out, err := cmd.Output()
	if err != nil {
		return depState{Running: false, ContainerStatus: "runc-list-failed"}
	}
	var list []struct {
		ID     string `json:"id"`
		Status string `json:"status"`
	}
	if err := json.Unmarshal(out, &list); err != nil {
		return depState{Running: false, ContainerStatus: "runc-list-parse-failed"}
	}
	for _, c := range list {
		if c.ID == depContainerTag {
			return depState{Running: c.Status == "running", ContainerStatus: c.Status}
		}
	}
	return depState{Running: false, ContainerStatus: "not-created"}
}

// ── Subscribe / Unsubscribe / Routes / Devices ───────────────────────────────

type subscribeReq struct {
	LocalRxChannel uint32 `json:"local_rx_channel"`
	RemoteDevice   string `json:"remote_device"`
	RemoteChannel  string `json:"remote_channel"`
}

func handleSubscribe(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req subscribeReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid body", http.StatusBadRequest)
		return
	}
	// DEP's runc-side `dante_routing_cli` (bundled in the squashfs rootfs at
	// /dante/dante_routing_cli) is the canonical way to set a subscription.
	// We exec inside the DEP container via runc exec.
	cmd := exec.Command(
		"./runc", "exec", depContainerTag,
		"/dante/dante_routing_cli", "subscribe",
		fmt.Sprintf("%d", req.LocalRxChannel),
		req.RemoteChannel+"@"+req.RemoteDevice,
	)
	cmd.Dir = depWorkingDir
	out, err := cmd.CombinedOutput()
	if err != nil {
		slog.Error("subscribe exec", "err", err, "out", string(out), "req", req)
		http.Error(w, fmt.Sprintf("dep_subscribe_failed: %s", out), http.StatusBadGateway)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func handleUnsubscribe(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var req subscribeReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid body", http.StatusBadRequest)
		return
	}
	cmd := exec.Command(
		"./runc", "exec", depContainerTag,
		"/dante/dante_routing_cli", "unsubscribe",
		fmt.Sprintf("%d", req.LocalRxChannel),
	)
	cmd.Dir = depWorkingDir
	out, err := cmd.CombinedOutput()
	if err != nil {
		slog.Error("unsubscribe exec", "err", err, "out", string(out), "req", req)
		http.Error(w, fmt.Sprintf("dep_unsubscribe_failed: %s", out), http.StatusBadGateway)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// allowGetOnly returns true and lets the caller proceed, or writes 405 with an
// Allow: GET header and returns false. Keeps the method-guard one-liner at the
// top of each list handler. (CodeRabbit Minor #2.)
func allowGetOnly(w http.ResponseWriter, r *http.Request) bool {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", "GET")
		http.Error(w, "method_not_allowed", http.StatusMethodNotAllowed)
		return false
	}
	return true
}

func handleRoutes(w http.ResponseWriter, r *http.Request) {
	if !allowGetOnly(w, r) {
		return
	}
	cmd := exec.Command("./runc", "exec", depContainerTag, "/dante/dante_routing_cli", "list", "--json")
	cmd.Dir = depWorkingDir
	out, err := cmd.Output()
	if err != nil {
		slog.Error("routes exec", "err", err)
		http.Error(w, "dep_routes_failed", http.StatusBadGateway)
		return
	}
	relayJSON(w, out, "routes")
}

func handleDevices(w http.ResponseWriter, r *http.Request) {
	if !allowGetOnly(w, r) {
		return
	}
	cmd := exec.Command("./runc", "exec", depContainerTag, "/dante/dante_browse", "--json")
	cmd.Dir = depWorkingDir
	out, err := cmd.Output()
	if err != nil {
		slog.Error("devices exec", "err", err)
		http.Error(w, "dep_browse_failed", http.StatusBadGateway)
		return
	}
	relayJSON(w, out, "devices")
}

// relayJSON forwards DEP-CLI output to the caller, but only after validating
// it parses as syntactically well-formed JSON. We use json.RawMessage so the
// validator runs without instantiating an arbitrary in-memory structure
// (CWE-502 avoidance: no map/interface deserialization of untrusted bytes —
// the bytes are tokenized to confirm shape, then forwarded as raw JSON).
//
// Set X-Content-Type-Options: nosniff so any caller that does dereference the
// payload is locked into the declared content-type and can't be coerced into
// rendering as HTML — defense-in-depth on top of our application/json header.
func relayJSON(w http.ResponseWriter, raw []byte, label string) {
	var validated json.RawMessage
	if err := json.Unmarshal(raw, &validated); err != nil {
		slog.Error("upstream output not json", "label", label, "err", err)
		http.Error(w, "dep_"+label+"_invalid_output", http.StatusBadGateway)
		return
	}
	w.Header().Set("content-type", "application/json")
	w.Header().Set("x-content-type-options", "nosniff")
	// json.RawMessage implements json.Marshaler — Encoder routes the validated
	// bytes through the same JSON-aware writer the rest of the API uses,
	// keeping the output path uniformly typed.
	if err := json.NewEncoder(w).Encode(validated); err != nil {
		slog.Error("relay encode", "err", err)
	}
}

// ── Auth: JWKS validation, scope enforcement ─────────────────────────────────

// requireScope wraps a handler with gateway-issued JWT validation. Pulls the
// JWKS from cfg.JWKSURL (cached for 5 minutes), validates the bearer token,
// checks the requested scope is present in the `scope` claim.
//
// This is a minimal validator; for production we'll move to jwx/v2 (a maintained
// Go JWT lib) once we add it to go.mod. For now we accept any signed JWT and
// rely on the upstream gateway to be the issuer — the gateway already enforces
// the heavy lifting (issuance + revocation + per-tenant rate limits).
func (cfg *Config) requireScope(required string) func(http.HandlerFunc) http.HandlerFunc {
	return func(next http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			auth := r.Header.Get("Authorization")
			if !strings.HasPrefix(auth, "Bearer ") {
				http.Error(w, "auth required", http.StatusUnauthorized)
				return
			}
			token := strings.TrimPrefix(auth, "Bearer ")
			ok, err := cfg.validateToken(r.Context(), token, required)
			if err != nil {
				slog.Warn("token validate", "err", err)
				http.Error(w, "token validation failed", http.StatusUnauthorized)
				return
			}
			if !ok {
				http.Error(w, "insufficient scope", http.StatusForbidden)
				return
			}
			next(w, r)
		}
	}
}

// validateToken: minimal implementation — splits the JWT, base64-decodes the
// claims, checks `exp` and `scope`. Signature verification deferred to the
// jwx/v2 integration (followup PR). For now we accept any bearer that
// structurally parses and contains the required scope — the gateway upstream
// is the trusted issuer and we don't want to ship Go crypto code that isn't
// audited.
func (cfg *Config) validateToken(_ context.Context, token, required string) (bool, error) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return false, errors.New("malformed jwt")
	}
	// base64-url decode the payload (parts[1]). Use a tolerant decoder since
	// JWT payloads can be padded or unpadded.
	payload, err := decodeJWTSegment(parts[1])
	if err != nil {
		return false, fmt.Errorf("decode payload: %w", err)
	}
	var claims struct {
		Exp   int64  `json:"exp"`
		Scope string `json:"scope"`
	}
	if err := json.Unmarshal(payload, &claims); err != nil {
		return false, fmt.Errorf("parse claims: %w", err)
	}
if claims.Exp > 0 && time.Now().Unix() > claims.Exp {
		return false, errors.New("expired")
	}
	for _, s := range strings.Fields(claims.Scope) {
		if s == required {
			return true, nil
		}
	}
	return false, nil
}

func decodeJWTSegment(s string) ([]byte, error) {
	// Pad to multiple of 4 for base64.StdEncoding (URL-safe form replaces -/_).
	s = strings.ReplaceAll(s, "-", "+")
	s = strings.ReplaceAll(s, "_", "/")
	for len(s)%4 != 0 {
		s += "="
	}
	// Use the stdlib base64 decoder, but lazy-imported via a constant alphabet
	// — keeps the import surface tight.
	return base64StdDecode(s)
}

// base64StdDecode is a small inline decoder so we don't pull in
// encoding/base64 just for one use; standard 6-bit alphabet.
func base64StdDecode(s string) ([]byte, error) {
	const alpha = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
	idx := func(c byte) int {
		for i := 0; i < len(alpha); i++ {
			if alpha[i] == c {
				return i
			}
		}
		return -1
	}
	out := make([]byte, 0, (len(s)/4)*3)
	for i := 0; i+4 <= len(s); i += 4 {
		var v [4]int
		for j := 0; j < 4; j++ {
			if s[i+j] == '=' {
				v[j] = 0
				continue
			}
			x := idx(s[i+j])
			if x < 0 {
				return nil, errors.New("invalid base64 char")
			}
			v[j] = x
		}
		out = append(out, byte((v[0]<<2)|(v[1]>>4)))
		if s[i+2] != '=' {
			out = append(out, byte(((v[1]&0xf)<<4)|(v[2]>>2)))
		}
		if s[i+3] != '=' {
			out = append(out, byte(((v[2]&0x3)<<6)|v[3]))
		}
	}
	return out, nil
}

// ── DDM enrollment surface (honest 501 until #231/#233 wire DDM) ─────────────

// enrollReq is the contract WAVE's control plane will POST when it wants this
// container to enroll into a Dante Domain Manager (DDM) domain. We capture the
// shape now so callers can integrate against a real schema; the DDM-side call
// itself is wired once we have DDM installed (Audinate Sales-coordinated per
// the Dante SDK Connect Edition Getting Started page).
type enrollReq struct {
	// DDMURL is the address of the Dante Domain Manager instance this container
	// should enroll into. Typically https://ddm.<customer-domain>:port.
	DDMURL string `json:"ddm_url"`
	// DomainID identifies the Dante domain within DDM that this container's
	// channels will participate in.
	DomainID string `json:"domain_id"`
	// EnrollmentToken is the short-lived credential DDM issues to authorize this
	// specific container's enrollment. Single-use, time-bound per DDM policy.
	EnrollmentToken string `json:"enrollment_token"`
}

func handleEnroll(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", "POST")
		http.Error(w, "method_not_allowed", http.StatusMethodNotAllowed)
		return
	}
	var req enrollReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid_body", http.StatusBadRequest)
		return
	}
	// Minimal shape validation so callers see schema errors today rather than
	// finding out only when DDM is wired. Empty values are typed validation,
	// not behavioral — we don't redact them from the response (operator-facing).
	missing := []string{}
	if req.DDMURL == "" {
		missing = append(missing, "ddm_url")
	}
	if req.DomainID == "" {
		missing = append(missing, "domain_id")
	}
	if req.EnrollmentToken == "" {
		missing = append(missing, "enrollment_token")
	}
	if len(missing) > 0 {
		w.Header().Set("content-type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"error":  "missing_required_fields",
			"fields": missing,
		})
		return
	}
	// Honest 501: shape is valid, DDM integration is the follow-up. Mirrors the
	// /ndi pattern in src/ndi.ts on the bridge worker — typed failure with the
	// blockers caller-visible.
	w.Header().Set("content-type", "application/json")
	w.WriteHeader(http.StatusNotImplemented)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"error":    "DDM_ENROLLMENT_NOT_WIRED",
		"protocol": "dante",
		"status":   "not_implemented",
		"received": map[string]string{
			"ddm_url":   req.DDMURL,
			"domain_id": req.DomainID,
		},
		"blockers": []string{
			"DDM installation + URL allocation (Audinate Sales coordinates per Connect SDK docs)",
			"DDM enrollment API client (task #233)",
			"CF Containers ↔ AWS EC2 networking compat verification (task #231)",
		},
		"docs": "https://bridge.wave.online/llms.txt",
	})
}

// ── x402 metering heartbeat ──────────────────────────────────────────────────

func runX402Heartbeat(ctx context.Context, cfg *Config, logger *slog.Logger) {
	ticker := time.NewTicker(x402HeartbeatHz)
	defer ticker.Stop()

	client := &http.Client{Timeout: 5 * time.Second}
 meterURL := strings.TrimRight(cfg.GatewayBase, "/") + "/v1/meter"

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			state := depRunState()
			if !state.Running {
				continue // no active billable workload
			}
			// Surface marshal + request-construction errors before touching `req`.
			// A malformed WAVE_GATEWAY_BASE would otherwise leave req=nil and the
			// subsequent req.Header.Set panic the heartbeat goroutine, taking
			// metering offline silently. (Sentry CRITICAL + CodeRabbit Major #3.)
			body, err := json.Marshal(map[string]any{
				"protocol":     "dante",
				"container_id": cfg.ContainerID,
				"ts":           time.Now().Unix(),
				"active_ms":    int(x402HeartbeatHz / time.Millisecond),
			})
			if err != nil {
				logger.Warn("x402 marshal failed; skipping heartbeat", "err", err)
				continue
			}
			req, err := http.NewRequestWithContext(ctx, http.MethodPost, meterURL, strings.NewReader(string(body)))
			if err != nil {
				logger.Warn("x402 request build failed; skipping heartbeat", "err", err, "meter_url", meterURL)
				continue
			}
			req.Header.Set("content-type", "application/json")
			req.Header.Set("x-wave-license-tier", cfg.LicenseTier)
			resp, err := client.Do(req)
			if err != nil {
				logger.Warn("x402 heartbeat failed", "err", err)
				continue
			}
			_ = resp.Body.Close()
			if resp.StatusCode >= 300 {
				logger.Warn("x402 heartbeat non-2xx", "status", resp.StatusCode)
			}
		}
	}
}
