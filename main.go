// pyrolens serves the built single-page app and reverse-proxies the
// Pyroscope query API, so the whole UI runs from one binary:
//
//	pyrolens -pyroscope-url http://pyroscope:4040
package main

import (
	"context"
	"embed"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/signal"
	"path"
	"strings"
	"syscall"
	"time"
)

//go:embed all:dist
var distFS embed.FS

// Set by the linker at release time (-X main.version=...).
var version = "dev"

// Paths forwarded to the Pyroscope server. Everything else is the SPA.
var proxyPrefixes = []string{
	"/querier.v1.QuerierService/",
	"/pyroscope/",
}

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

// isCanonicalPath reports whether p is already in cleaned form. A trailing
// slash is allowed, since path.Clean strips one and "/pyroscope/" needs it.
func isCanonicalPath(p string) bool {
	clean := path.Clean(p)
	if clean != "/" && strings.HasSuffix(p, "/") {
		clean += "/"
	}
	return clean == p
}

// newHandler routes the query API to Pyroscope and everything else to the
// embedded UI, whose shell is `index`.
func newHandler(dist fs.FS, index []byte, proxy http.Handler) http.Handler {
	fileServer := http.FileServer(http.FS(dist))

	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprintln(w, "ok")
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		for _, prefix := range proxyPrefixes {
			if strings.HasPrefix(r.URL.Path, prefix) {
				// Belt and braces, not a fix for a live hole. ServeMux cleans
				// the *escaped* path, so "%2e%2e%2f" survives it and arrives
				// here decoded as real ".." segments, which a plain prefix
				// test accepts; the proxy then forwards the original encoding.
				// Measured against Pyroscope 2.2.1 that reaches nothing — its
				// router normalises and answers 301 with a relative Location,
				// so no body comes back and a POST is not re-issued. It would
				// matter only behind a hop that normalises and serves instead
				// (some ingress configurations), which is unverified. Cheap
				// enough to just require a canonical path.
				if !isCanonicalPath(r.URL.Path) {
					http.Error(w, "bad request", http.StatusBadRequest)
					return
				}
				r.Body = http.MaxBytesReader(w, r.Body, 16<<20)
				proxy.ServeHTTP(w, r)
				return
			}
		}
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
		w.Write(index)
	})
	return withSecurityHeaders(mux)
}

func main() {
	listen := flag.String("listen", envOr("LISTEN", ":4041"), "address to listen on (env: LISTEN)")
	pyroscopeURL := flag.String("pyroscope-url", envOr("PYROSCOPE_URL", "http://localhost:4040"), "Pyroscope server base URL (env: PYROSCOPE_URL)")
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

	server := &http.Server{
		Addr:              *listen,
		Handler:           newHandler(dist, index, newProxy(target)),
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
