// pyrolens serves the built single-page app and reverse-proxies the
// Pyroscope query API, so the whole UI runs from one binary:
//
//	pyrolens -pyroscope-url http://pyroscope:4040
package main

import (
	"bytes"
	"compress/gzip"
	"context"
	"embed"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"mime"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"
)

//go:embed all:dist
var distFS embed.FS

// Set by the linker at release time (-X main.version=...).
var version = "dev"

const querierPrefix = "/querier.v1.QuerierService/"

// The querier RPCs the UI calls, and nothing else. Each one is registered as
// its own route below, so what the browser can reach upstream is a decision
// stated here rather than a side effect of whatever the Pyroscope server
// happens to expose. Adding a call in src/api/client.ts means adding it here
// too — that coupling is the point.
//
// This replaced a pair of path prefixes. "/pyroscope/*" was one of them and
// the UI has never called it, but a real Pyroscope serves its legacy HTTP API
// there — /pyroscope/ingest included, which answers POST. That turned a
// read-only viewer into a write path: anything that could reach this binary
// could store profiles under any tenant. Verified by ingesting through the
// proxy and reading the service back out of Pyroscope.
var querierMethods = []string{
	"Diff",
	"LabelNames",
	"LabelValues",
	"SelectMergeStacktraces",
	"SelectSeries",
	"Series",
}

// Connect-JSON is POST-only, and the client sends nothing else.
const maxRequestBody = 16 << 20

// How long a termination signal waits for in-flight queries. Long enough for
// a normal merge to finish, short enough to stay inside a container runtime's
// default grace period — a profile query that outlives it is still cut off,
// which is why the timeouts above it are not the drain budget.
const shutdownGrace = 25 * time.Second

// Sent on every response. The proxy renders bytes from the Pyroscope server
// on this origin, so a CSP here is what stops upstream-controlled HTML from
// running with the UI's origin, and nosniff removes the MIME-confusion path
// around the embedded assets. The SPA needs no inline script; React's style
// props are applied through CSSOM, not style attributes, and every request it
// makes is same-origin.
const contentSecurityPolicy = "default-src 'self'; img-src 'self' data:; " +
	"style-src 'self' 'unsafe-inline'; connect-src 'self'; " +
	"frame-ancestors 'none'; base-uri 'none'; object-src 'none'"

func withSecurityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Content-Security-Policy", contentSecurityPolicy)
		next.ServeHTTP(w, r)
	})
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

// compressibleExt is the set of embedded-asset extensions gzip meaningfully
// shrinks. The bundle is the point (~310 KB down to ~99 KB); the rest ride
// along for free since compressing them costs one startup-time pass either
// way. Images already in a compressed format are deliberately left out —
// gzipping them again only spends CPU to grow them.
var compressibleExt = map[string]bool{
	".js":   true,
	".css":  true,
	".html": true,
	".svg":  true,
	".json": true,
	".txt":  true,
}

// extOf returns a fs.FS path's extension including the dot. fs.FS paths are
// always "/"-separated regardless of host OS, so this is used instead of
// path/filepath, whose Ext is platform-specific on Windows.
func extOf(p string) string {
	if i := strings.LastIndex(p, "."); i >= 0 {
		return p[i:]
	}
	return ""
}

// contentTypeFor mirrors what http.ServeContent derives for the identity
// response (both go through mime.TypeByExtension), so a client sees the same
// Content-Type whichever encoding it ends up with.
func contentTypeFor(p string) string {
	if ct := mime.TypeByExtension(extOf(p)); ct != "" {
		return ct
	}
	return "application/octet-stream"
}

// serveGzip answers with a precompressed variant through the same
// http.ServeContent machinery the identity path goes through (http.FileServer
// calls it internally), so a gzip response gets the same semantics as the
// file it was derived from: Range applies to the gzip bytes (correct per RFC
// 9110 — a range request addresses the selected representation, and the
// encoding is part of that), If-None-Match is honored, and HEAD suppresses
// the body instead of a manual w.Write reporting phantom bytes to the access
// log. The caller sets Content-Type before calling this, since ServeContent
// only sniffs when the header is still unset, and passes an empty name and a
// zero modtime so no validator is added — matching the identity path, which
// serves out of an embed.FS with no modtime of its own.
func serveGzip(w http.ResponseWriter, r *http.Request, gz []byte) {
	w.Header().Set("Content-Encoding", "gzip")
	http.ServeContent(w, r, "", time.Time{}, bytes.NewReader(gz))
}

// gzipAssets walks dist once at startup and precompresses every compressible
// file, so the request path never spends CPU compressing — only on choosing
// which bytes to write. A file gzip does not shrink (too small, or an
// extension that slipped into compressibleExt while already holding
// compressed bytes) is left out of the map, and the identity path serves it
// instead.
func gzipAssets(dist fs.FS) map[string][]byte {
	assets := make(map[string][]byte)
	fs.WalkDir(dist, ".", func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() || !compressibleExt[extOf(p)] {
			return nil
		}
		data, err := fs.ReadFile(dist, p)
		if err != nil {
			return nil
		}
		var buf bytes.Buffer
		gw, err := gzip.NewWriterLevel(&buf, gzip.BestCompression)
		if err != nil {
			return nil
		}
		gw.Write(data)
		gw.Close()
		if buf.Len() < len(data) {
			assets[p] = buf.Bytes()
		}
		return nil
	})
	return assets
}

// acceptsGzip reports whether the request's Accept-Encoding lists gzip. A
// token match on the comma-separated list is enough for the one alternative
// encoding this server offers, done case-insensitively since the token is
// case-insensitive per RFC 9110. The qvalue is parsed as a float rather than
// string-compared against "0", since "0.0" and "0.000" are equally legal
// spellings of "never" that a literal match on "0" would miss and treat as
// accept — sending a browser bytes it declared it cannot handle. A qvalue
// that fails to parse is treated as accept, matching the tolerant reading of
// the rest of this function.
func acceptsGzip(r *http.Request) bool {
	for _, part := range strings.Split(r.Header.Get("Accept-Encoding"), ",") {
		name, params, _ := strings.Cut(strings.TrimSpace(part), ";")
		if !strings.EqualFold(strings.TrimSpace(name), "gzip") {
			continue
		}
		if q, ok := strings.CutPrefix(strings.TrimSpace(params), "q="); ok {
			if qv, err := strconv.ParseFloat(q, 64); err == nil && qv <= 0 {
				continue
			}
		}
		return true
	}
	return false
}

// newProxy builds the reverse proxy to the Pyroscope server.
func newProxy(target *url.URL) *httputil.ReverseProxy {
	proxy := httputil.NewSingleHostReverseProxy(target)
	director := proxy.Director
	proxy.Director = func(req *http.Request) {
		director(req)
		// Name-based routing (ingresses, Grafana Cloud) needs the upstream's
		// own Host, which the default director leaves untouched.
		req.Host = target.Host
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.ResponseHeaderTimeout = 2 * time.Minute
	proxy.Transport = transport
	proxy.ErrorHandler = func(w http.ResponseWriter, r *http.Request, err error) {
		// The detail is for whoever runs the server; the browser gets a
		// sentence, since it may be showing it to someone else's user.
		log.Printf("proxy error: %s %s: %v", r.Method, r.URL.Path, err)
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			http.Error(w, "request body too large", http.StatusRequestEntityTooLarge)
			return
		}
		http.Error(w, "upstream pyroscope unreachable", http.StatusBadGateway)
	}
	return proxy
}

// newHandler routes the query API to Pyroscope and everything else to the
// embedded UI, whose shell is `index`. gzipped holds the precompressed
// variants keyed by their dist-relative path (gzipAssets), index.html's
// entry included, so the shell and the on-disk files share one lookup.
func newHandler(dist fs.FS, index []byte, gzipped map[string][]byte, proxy http.Handler) http.Handler {
	fileServer := http.FileServer(http.FS(dist))

	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprintln(w, "ok")
	})

	// One route per RPC, method included, so the mux does the matching: a verb
	// the client never sends is a 405 and an RPC the UI does not call is a 404,
	// both before anything reaches the proxy. Exact paths also settle path
	// traversal — an encoded "%2e%2e%2f" decodes into the method name and
	// matches no route.
	forward := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r.Body = http.MaxBytesReader(w, r.Body, maxRequestBody)
		proxy.ServeHTTP(w, r)
	})
	for _, method := range querierMethods {
		mux.Handle("POST "+querierPrefix+method, forward)
	}
	// Anything else under the service prefix is an API path, so answer like
	// one instead of falling through to the SPA shell.
	mux.HandleFunc(querierPrefix, http.NotFound)

	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		// Serve real files as-is; anything unknown falls back to the SPA
		// shell so history-based routes (/comparison, /diff, ...) deep-link.
		path := strings.TrimPrefix(r.URL.Path, "/")
		if path != "" {
			if f, err := dist.Open(path); err == nil {
				f.Close()
				// Vite content-hashes everything under assets/, so those
				// files never change under the same name.
				if strings.HasPrefix(path, "assets/") {
					w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
				}
				// index.html is excluded here even though gzipped holds an
				// entry for it: a direct request for it must fall through to
				// fileServer below for FileServer's canonical redirect to
				// "./", the same as the identity path. Answering it here
				// instead skipped that redirect and served 200 with no
				// Cache-Control at all, so an intermediary could cache a
				// stale shell past a redeploy.
				if gz, ok := gzipped[path]; ok && path != "index.html" {
					// A cache sitting in front of this (a CDN, a corporate
					// proxy) must key on the request header once identity and
					// gzip bytes can both come back for the same path, or it
					// risks handing a client the wrong one.
					w.Header().Set("Vary", "Accept-Encoding")
					if acceptsGzip(r) {
						w.Header().Set("Content-Type", contentTypeFor(path))
						serveGzip(w, r, gz)
						return
					}
				}
				fileServer.ServeHTTP(w, r)
				return
			}
			// A missing file must 404, not masquerade as the SPA shell —
			// stale HTML would otherwise load as a text/html "script" (or a
			// broken icon mask). Everything under assets/ is a file by
			// construction; elsewhere, view routes carry no extension, so a
			// dot in the last segment marks a file request.
			last := path[strings.LastIndex(path, "/")+1:]
			if strings.HasPrefix(path, "assets/") || strings.Contains(last, ".") {
				http.NotFound(w, r)
				return
			}
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-cache")
		if gz, ok := gzipped["index.html"]; ok {
			w.Header().Set("Vary", "Accept-Encoding")
			if acceptsGzip(r) {
				// Content-Type is already set above, so serveGzip's
				// ServeContent call won't try to sniff it.
				serveGzip(w, r, gz)
				return
			}
		}
		w.Write(index)
	})
	return withSecurityHeaders(mux)
}

// parseBoolEnv parses a boolean env var's raw value. An empty value means
// "unset" and is reported as ok — the flag's own default applies — but a
// non-empty value strconv.ParseBool rejects is reported back as !ok, so the
// caller can fail loudly instead of an operator's typo silently landing on
// false. Split out from boolEnvOr so this parsing logic is testable without
// the log.Fatalf a real misconfiguration deserves.
func parseBoolEnv(value string) (v bool, ok bool) {
	if value == "" {
		return false, true
	}
	v, err := strconv.ParseBool(value)
	return v, err == nil
}

// boolEnvOr parses an env var as a flag default the way envOr does for
// strings. An unset variable is false, matching -log-requests' own default;
// a set one that is not a recognized boolean is a startup-time misconfig, not
// a silent no-op — LOG_REQUESTS=yes turning logging off with no diagnostic is
// the failure this guards against.
func boolEnvOr(key string) bool {
	v, ok := parseBoolEnv(os.Getenv(key))
	if !ok {
		log.Fatalf("%s=%q is not a valid boolean (accepted: 1, t, T, TRUE, true, True, 0, f, F, FALSE, false, False)", key, os.Getenv(key))
	}
	return v
}

// statusWriter captures what a handler actually sent, since
// http.ResponseWriter does not hand that back to a wrapper around it.
type statusWriter struct {
	http.ResponseWriter
	status int
	bytes  int
}

func (w *statusWriter) WriteHeader(status int) {
	w.status = status
	w.ResponseWriter.WriteHeader(status)
}

func (w *statusWriter) Write(b []byte) (int, error) {
	if w.status == 0 {
		w.status = http.StatusOK // a handler that never calls WriteHeader sent a 200
	}
	n, err := w.ResponseWriter.Write(b)
	w.bytes += n
	return n, err
}

// Unwrap lets http.ResponseController reach the wrapped ResponseWriter's
// optional interfaces (Flush, Hijack, ...) straight through this one.
// httputil.ReverseProxy flushes a chunked upstream response per write via
// exactly that mechanism, so without Unwrap it silently gets
// http.ErrNotSupported and -log-requests turns per-write flushing off.
func (w *statusWriter) Unwrap() http.ResponseWriter {
	return w.ResponseWriter
}

// withAccessLog logs one line per request: method, path, status, duration
// and response size, which is enough to answer "why is the UI slow" or
// "which tenant is hammering Pyroscope" without it being on by default. The
// query string is never logged even though the URL is the whole app's state
// — that state is exactly the tenant's label matchers and time range, and
// this server sees more than one tenant, so printing it would put one
// tenant's query values in a log another operator might read. The path
// alone carries no query data.
func withAccessLog(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		sw := &statusWriter{ResponseWriter: w}
		next.ServeHTTP(sw, r)
		status := sw.status
		if status == 0 {
			status = http.StatusOK // nothing was ever written either
		}
		// EscapedPath, not Path: Path is percent-decoded, so a path like
		// "/x%0aFAKE%20LINE" would put a literal newline into the log and
		// forge a second line. The server is unauthenticated, so anyone who
		// can reach it can reach this log line.
		line := fmt.Sprintf("%s %s %d %s %dB", r.Method, r.URL.EscapedPath(), status, time.Since(start), sw.bytes)
		if strings.HasPrefix(r.URL.Path, querierPrefix) {
			tenant := r.Header.Get("X-Scope-OrgID")
			if tenant == "" {
				tenant = "-"
			}
			line += " tenant=" + tenant
		}
		log.Print(line)
	})
}

func main() {
	listen := flag.String("listen", envOr("LISTEN", ":4041"), "address to listen on (env: LISTEN)")
	pyroscopeURL := flag.String("pyroscope-url", envOr("PYROSCOPE_URL", "http://localhost:4040"), "Pyroscope server base URL (env: PYROSCOPE_URL)")
	logRequests := flag.Bool("log-requests", boolEnvOr("LOG_REQUESTS"), "log one line per request: method, path, status, duration, bytes (env: LOG_REQUESTS)")
	showVersion := flag.Bool("version", false, "print the version and exit")
	flag.Parse()

	if *showVersion {
		fmt.Println("pyrolens", version)
		return
	}

	target, err := url.Parse(*pyroscopeURL)
	if err != nil || target.Scheme == "" || target.Host == "" {
		log.Fatalf("invalid -pyroscope-url %q", *pyroscopeURL)
	}

	dist, err := fs.Sub(distFS, "dist")
	if err != nil {
		log.Fatal(err)
	}
	index, err := fs.ReadFile(dist, "index.html")
	if err != nil {
		log.Fatalf("embedded UI missing (build it with `yarn build` before `go build`): %v", err)
	}
	// Precompressed once here rather than per-request: the bundle is the
	// same bytes on every request this process serves, so there is nothing
	// to gain from redoing the work later.
	gzipped := gzipAssets(dist)

	handler := newHandler(dist, index, gzipped, newProxy(target))
	if *logRequests {
		handler = withAccessLog(handler)
	}
	server := &http.Server{
		Addr:              *listen,
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       time.Minute,
		WriteTimeout:      5 * time.Minute,
		IdleTimeout:       2 * time.Minute,
	}
	log.Printf("pyrolens listening on %s, proxying to %s", *listen, target.Redacted())
	errc := make(chan error, 1)
	go func() { errc <- server.ListenAndServe() }()

	// The binary runs as PID 1 in the container, so it handles termination
	// itself: finish in-flight queries instead of dropping them mid-response.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	select {
	case err := <-errc:
		log.Fatal(err)
	case <-ctx.Done():
		// Hand the signal back to the default disposition straight away, so a
		// second Ctrl-C during a slow drain kills the process instead of being
		// swallowed by a handler that only re-cancels a finished context.
		stop()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), shutdownGrace)
		defer cancel()
		if err := server.Shutdown(shutdownCtx); err != nil {
			log.Printf("shutdown: %v", err)
		}
	}
}
