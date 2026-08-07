// pyrolens serves the built single-page app and reverse-proxies the
// Pyroscope query API, so the whole UI runs from one binary:
//
//	pyrolens -pyroscope-url http://pyroscope:4040
package main

import (
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
	"strings"
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

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
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
		log.Printf("proxy error: %s %s: %v", r.Method, r.URL.Path, err)
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			http.Error(w, "request body too large", http.StatusRequestEntityTooLarge)
			return
		}
		http.Error(w, "upstream pyroscope unreachable", http.StatusBadGateway)
	}

	dist, err := fs.Sub(distFS, "dist")
	if err != nil {
		log.Fatal(err)
	}
	index, err := fs.ReadFile(dist, "index.html")
	if err != nil {
		log.Fatalf("embedded UI missing (build it with `yarn build` before `go build`): %v", err)
	}
	fileServer := http.FileServer(http.FS(dist))

	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		fmt.Fprintln(w, "ok")
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		for _, prefix := range proxyPrefixes {
			if strings.HasPrefix(r.URL.Path, prefix) {
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
			// A missing asset must 404, not masquerade as the SPA shell —
			// stale HTML would otherwise load a text/html "script".
			if strings.HasPrefix(path, "assets/") {
				http.NotFound(w, r)
				return
			}
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-cache")
		w.Write(index)
	})

	server := &http.Server{
		Addr:              *listen,
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       time.Minute,
		WriteTimeout:      5 * time.Minute,
		IdleTimeout:       2 * time.Minute,
	}
	log.Printf("pyrolens listening on %s, proxying to %s", *listen, target.Redacted())
	log.Fatal(server.ListenAndServe())
}
