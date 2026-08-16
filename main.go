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
	"net"
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

// securityHeaderWriter (re-)establishes pyrolens's security headers at the
// moment a response is actually written, rather than once before the
// handler runs. Setting them upfront used to be enough — until an upstream
// 1xx response proved it wasn't: httputil.ReverseProxy's Got1xxResponse
// trace copies the 1xx's own headers into this ResponseWriter's header map
// (which by then already held our CSP/nosniff), writes the informational
// response, and then clears the ENTIRE map — clearing ours along with
// whatever the 1xx carried. The final response then goes out with neither
// header, so a malicious upstream could defeat the exact defense the CSP
// exists for just by prefixing its HTML with a bare 103, and an LB that
// emits 1xx of its own would degrade it by accident. Re-setting the headers
// here, unconditionally, immediately before every final (>=200) WriteHeader
// closes that: whatever happened to the map before this point — a 1xx, a
// clear, ModifyResponse's own filtering — this is the last write, so ours
// are the values that reach the browser.
type securityHeaderWriter struct {
	http.ResponseWriter
	wroteHeader bool
}

func (w *securityHeaderWriter) WriteHeader(code int) {
	if code < 200 {
		// No informational response ever reaches the browser. The UI never
		// uses 100-continue or Early Hints, an outbound Expect header
		// cannot survive the request-header allowlist regardless, and
		// swallowing this also keeps whatever headers the 1xx carried from
		// ever landing in the shared map in the first place — nothing here
		// for the trace's later clear() to erase along with.
		return
	}
	if !w.wroteHeader {
		w.wroteHeader = true
		h := w.ResponseWriter.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Content-Security-Policy", contentSecurityPolicy)
	}
	w.ResponseWriter.WriteHeader(code)
}

func (w *securityHeaderWriter) Write(b []byte) (int, error) {
	if !w.wroteHeader {
		w.WriteHeader(http.StatusOK) // implicit 200: route it through the same guarantee
	}
	return w.ResponseWriter.Write(b)
}

// Unwrap lets http.ResponseController reach the wrapped ResponseWriter's
// optional interfaces (Flush, Hijack, ...) straight through this one —
// same reasoning, and the same requirement, as statusWriter.Unwrap below.
func (w *securityHeaderWriter) Unwrap() http.ResponseWriter {
	return w.ResponseWriter
}

func withSecurityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		next.ServeHTTP(&securityHeaderWriter{ResponseWriter: w}, r)
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

// allowedRequestHeaders is copied, verbatim and only when present, from the
// inbound request onto the fresh outbound header set newProxy's director
// builds. This is exactly what src/api/client.ts sends: Content-Type on
// every call, X-Scope-OrgID whenever it sets one — including deliberately
// empty, the multitenancy probe (see the director for why presence, not
// non-emptiness, is what "sent" means here) — and Accept-Encoding so the
// upstream's compressed body can stream straight through. Everything else a
// browser attaches to a same-origin request — Cookie, User-Agent, Referer,
// Origin, the sec-* fingerprint headers — has no business at Pyroscope. One
// outbound header rides outside this allowlist entirely and is not ours to
// filter: net/http.Transport itself re-adds a fixed "Te: trailers" whenever
// the original inbound request carried one, independent of the director —
// a stdlib mechanic, not caller-controlled data, and one a browser's fetch
// cannot produce anyway.
var allowedRequestHeaders = []string{"Content-Type", "X-Scope-OrgID", "Accept-Encoding"}

// allowedResponseHeaders is the response-header allowlist proxy.ModifyResponse
// enforces below. Everything else is dropped before the response reaches the
// browser — Set-Cookie above all, since an upstream (or a load balancer in
// front of it) must never set a cookie on pyrolens's own origin.
var allowedResponseHeaders = map[string]bool{
	"Content-Type":     true,
	"Content-Length":   true,
	"Content-Encoding": true,
	"Vary":             true,
}

// newProxy builds the reverse proxy to the Pyroscope server. authUser and
// authPass are empty when the operator configured no upstream credentials;
// resolvePyroscopeAuth is what guarantees they are either both set or both
// empty, so checking either one here is enough to know which case this is.
func newProxy(target *url.URL, authUser, authPass string) *httputil.ReverseProxy {
	hasAuth := authUser != "" || authPass != ""
	proxy := httputil.NewSingleHostReverseProxy(target)
	director := proxy.Director
	proxy.Director = func(req *http.Request) {
		director(req)
		// Name-based routing (ingresses, Grafana Cloud) needs the upstream's
		// own Host, which the default director leaves untouched.
		req.Host = target.Host

		// querierMethods (the RPC allowlist near the top of this file)
		// decides which PATHS reach the upstream; this decides which
		// HEADERS do. A transparent proxy that forwards whatever arrived
		// would carry a fronting SSO's session Cookie, browser fingerprint
		// headers and the visitor's own Authorization straight to
		// Pyroscope — all of it meant for pyrolens's origin, none of it
		// Pyroscope's business. Building the outbound set from scratch,
		// rather than deleting our way to safe, is what keeps that true as
		// this file grows: a header nobody thought to allow is refused by
		// default, not forwarded by default. Adding a header the UI needs
		// means adding it to allowedRequestHeaders; that coupling is the
		// point.
		//
		// Copied by PRESENCE, not by non-emptiness: client.ts's
		// checkMultitenancy sends an explicitly empty X-Scope-OrgID on
		// purpose — that IS the multitenancy probe, and Pyroscope tells
		// single- from multi-tenant mode apart by whether the header
		// arrived at all, not by its value. A `Header.Get(h) != ""` copy
		// drops it, so the probe silently reads back as single-tenant
		// instead of being refused.
		out := http.Header{}
		for _, h := range allowedRequestHeaders {
			key := http.CanonicalHeaderKey(h)
			if vals, ok := req.Header[key]; ok {
				out[key] = vals
			}
		}
		req.Header = out
		// ReverseProxy clones the inbound request wholesale, Trailer field
		// included, so a non-browser client (fetch has no request trailers,
		// but nothing stops a script) could otherwise attach arbitrary
		// trailer metadata that rides to the upstream past the header
		// allowlist entirely. Nil it out the same way the header map itself
		// was replaced above.
		req.Trailer = nil

		// The credential here is the deployment's, never the visitor's: an
		// unauthenticated caller's own Authorization never made it into the
		// fresh header set above, and this is the only place one is added.
		if hasAuth {
			req.SetBasicAuth(authUser, authPass)
		}

		// ReverseProxy appends to X-Forwarded-For after the director runs,
		// unless the key is present with a nil value — its documented way
		// to suppress the append. A fresh header map alone does not stop
		// this on its own; the visitor's address stays off the wire to
		// Pyroscope the same as everything else above.
		req.Header["X-Forwarded-For"] = nil
	}
	proxy.ModifyResponse = func(resp *http.Response) error {
		// The mirror of the outbound allowlist above: what the browser
		// learns about the upstream response is a decision too, not
		// whatever the upstream happened to send. WWW-Authenticate is
		// dropped along with everything else not on the allowlist — with
		// Authorization never forwarded, a browser auth prompt could never
		// succeed anyway. The status and body pass through untouched, so a
		// 401 still reads as a 401 in the UI. pyrolens's own security
		// headers are NOT added here — this filters resp.Header, one layer
		// below the ResponseWriter map securityHeaderWriter guards — they
		// are (re)established at the moment the response is actually
		// written, since an upstream 1xx in between can otherwise erase
		// them (see securityHeaderWriter's comment).
		for h := range resp.Header {
			if !allowedResponseHeaders[h] {
				resp.Header.Del(h)
			}
		}
		return nil
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

// errInvalidPyroscopeURL is returned verbatim, never wrapped around the raw
// value or the parse error: url.Error embeds the string it failed to parse,
// and that string can be "https://user:pass@%" — a password included. main's
// only use of it is log.Fatal, so keeping it static is what keeps the
// password off stderr (and out of whatever aggregates it from there).
var errInvalidPyroscopeURL = errors.New("-pyroscope-url (or PYROSCOPE_URL) is not a valid absolute URL")

// parsePyroscopeURL parses the configured Pyroscope base URL. Split out from
// main so the no-echo behavior above is directly testable: a test can assert
// the returned error never contains a secret from a deliberately malformed
// input, which log.Fatal itself can't be asked without exiting the test
// binary.
func parsePyroscopeURL(raw string) (*url.URL, error) {
	target, err := url.Parse(raw)
	if err != nil || target.Scheme == "" || target.Host == "" {
		return nil, errInvalidPyroscopeURL
	}
	return target, nil
}

// readPasswordFile reads path and returns its contents with exactly one
// trailing line ending trimmed — preferring "\r\n" over "\n" so a
// CRLF-written secret does not leave a trailing "\r" baked into the
// password (every request then fails auth with nothing pointing at the
// invisible byte). A Kubernetes-mounted secret file ends with one line
// ending that is not part of the secret; an interior one stays, since that
// is the operator's own concern, not this program's to second-guess.
// Returns the error instead of calling log.Fatalf itself so the parsing is
// testable without exiting the test binary; mustReadPasswordFile is the one
// Fatalf call site, matching parseBoolEnv/boolEnvOr.
func readPasswordFile(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	if trimmed, ok := strings.CutSuffix(string(data), "\r\n"); ok {
		return trimmed, nil
	}
	return strings.TrimSuffix(string(data), "\n"), nil
}

// mustReadPasswordFile reads a configured password file or stops the
// process: an unreadable secret mount is a startup problem, not one to
// discover on the first proxied request.
func mustReadPasswordFile(path string) string {
	password, err := readPasswordFile(path)
	if err != nil {
		log.Fatalf("reading -pyroscope-password-file %q: %v", path, err)
	}
	return password
}

// pyroscopeAuthSources bundles every place a username or password can come
// from — flags already merged with their env vars, and a password file
// already read off disk — so resolvePyroscopeAuth can be a pure function.
// Nothing in it touches the filesystem or exits the process, which is what
// makes the full source matrix table-testable.
type pyroscopeAuthSources struct {
	flagUser     string // -pyroscope-username / PYROSCOPE_USERNAME, "" if neither set
	flagPassword string // -pyroscope-password / PYROSCOPE_PASSWORD, "" if neither set

	// passwordFilePath is used only for error messages; passwordFileSet
	// distinguishes "no file configured" from "configured but produced an
	// empty password" together with passwordFileContent.
	passwordFilePath    string
	passwordFileSet     bool
	passwordFileContent string
}

// resolvePyroscopeAuth combines every credential source into the single
// username/password pair (if any) the proxy authenticates upstream requests
// with, and returns target with any userinfo stripped — always, even when
// userinfo did not win — so nothing downstream can observe credentials
// through code that assumes a bare host.
//
// A username and its password must come from the SAME source. Flags (and,
// for the password half only, the password file — the two are just two
// spellings of a flag-sourced password) beat the URL's own userinfo
// entirely the moment any of them is set, rather than filling in whichever
// half the flags left blank from userinfo: there is no rule for which
// pairing that would mean, and a silent partial merge is exactly the kind of
// thing that fails open. Every failure is returned as an error rather than
// through log.Fatalf, so main is the only exit point and every branch here
// is table-testable.
func resolvePyroscopeAuth(target *url.URL, src pyroscopeAuthSources) (resolvedTarget *url.URL, user, pass string, hasAuth bool, err error) {
	if src.flagPassword != "" && src.passwordFileSet {
		return nil, "", "", false, fmt.Errorf("-pyroscope-password and -pyroscope-password-file are both set; only one can supply the password")
	}
	if src.passwordFileSet && src.passwordFileContent == "" {
		return nil, "", "", false, fmt.Errorf("-pyroscope-password-file %q is empty", src.passwordFilePath)
	}

	stripped := *target
	stripped.User = nil

	flagPassword, passwordSource := src.flagPassword, "-pyroscope-password"
	if src.passwordFileSet {
		flagPassword, passwordSource = src.passwordFileContent, "-pyroscope-password-file"
	}

	var source string
	switch {
	case src.flagUser != "" || flagPassword != "":
		user, pass, source = src.flagUser, flagPassword, "flag"
		if target.User != nil {
			log.Print("-pyroscope-username/-pyroscope-password/-pyroscope-password-file are set; they take precedence over the URL's own userinfo")
		}
	case target.User != nil:
		user = target.User.Username()
		pass, _ = target.User.Password()
		if user == "" && pass == "" {
			// A URL like "http://@host": userinfo is syntactically present
			// but empty. Nothing was actually configured.
			return &stripped, "", "", false, nil
		}
		source = "url"
	default:
		return &stripped, "", "", false, nil
	}

	usernameOrigin := "-pyroscope-username"
	if source == "url" {
		usernameOrigin = "the URL's userinfo"
	}
	if strings.Contains(user, ":") {
		return nil, "", "", false, fmt.Errorf("pyroscope basic auth username (from %s) must not contain ':': that is the separator between username and password, so a colon in the username would change which characters land on which side", usernameOrigin)
	}

	if (user == "") != (pass == "") {
		switch {
		case source == "flag" && user == "":
			return nil, "", "", false, fmt.Errorf("pyroscope basic auth is missing -pyroscope-username: %s set a password, but username and password must come from the same source, so the URL's own userinfo is not used to fill in the username", passwordSource)
		case source == "flag":
			return nil, "", "", false, fmt.Errorf("pyroscope basic auth is missing a password: -pyroscope-username is set, but neither -pyroscope-password nor -pyroscope-password-file is; username and password must come from the same source, so the URL's own userinfo is not used to fill in the password")
		case user == "":
			return nil, "", "", false, fmt.Errorf("pyroscope basic auth is half-configured: the URL's userinfo has a password with no username")
		default:
			return nil, "", "", false, fmt.Errorf("pyroscope basic auth is half-configured: the URL's userinfo has a username with no password")
		}
	}

	return &stripped, user, pass, true, nil
}

// isLoopbackHost reports whether host — a URL's Host, which may include a
// port — names localhost or a loopback address: the one case where plain
// HTTP does not send whatever it carries across a network someone else can
// observe.
func isLoopbackHost(host string) bool {
	h := host
	if hostOnly, _, err := net.SplitHostPort(host); err == nil {
		h = hostOnly
	}
	if h == "localhost" {
		return true
	}
	ip := net.ParseIP(h)
	return ip != nil && ip.IsLoopback()
}

// plaintextAuthWarning returns a startup warning when configured credentials
// would cross the network as plain HTTP to a non-loopback host, where
// anything on that path can read them off the wire, and "" otherwise. This
// does not refuse to start: local testing against a plain-HTTP Pyroscope
// with auth turned on anyway is a legitimate thing to do, so the response is
// a loud warning, not a rejection.
func plaintextAuthWarning(target *url.URL, hasAuth bool) string {
	if !hasAuth || target.Scheme != "http" || isLoopbackHost(target.Host) {
		return ""
	}
	return "pyroscope basic auth is configured, but -pyroscope-url uses plain http (not https) to a non-loopback host: credentials will cross the network unencrypted"
}

// startupLogLine is main's own startup message, split out so its shape — and
// specifically that it never carries a password — is directly testable
// without running the process that owns flag.CommandLine.
func startupLogLine(listen string, target *url.URL, hasAuth bool) string {
	note := ""
	if hasAuth {
		note = " (basic auth)"
	}
	return fmt.Sprintf("pyrolens listening on %s, proxying to %s%s", listen, target.Redacted(), note)
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

// cliFlags holds every flag main reads, so registerFlags can build them
// against either the process' real flag.CommandLine or, in a test, a
// throwaway FlagSet used only to inspect the -h output.
type cliFlags struct {
	listen                *string
	pyroscopeURL          *string
	pyroscopeUsername     *string
	pyroscopePassword     *string
	pyroscopePasswordFile *string
	logRequests           *bool
	showVersion           *bool
}

// registerFlags declares every flag on flagSet. The three that can carry a
// secret — -pyroscope-url (userinfo), -pyroscope-username,
// -pyroscope-password — are registered with a fixed, non-secret default
// ("", or nothing for the URL) rather than envOr(...): flag.PrintDefaults
// prints every non-empty default, so baking a secret straight into one would
// put it on stderr for -h, an unrecognized flag, or any argv typo under
// ExitOnError. main applies each one's env fallback itself, after
// flag.Parse, and only when the flag was left at its safe empty default.
func registerFlags(flagSet *flag.FlagSet) *cliFlags {
	return &cliFlags{
		listen:                flagSet.String("listen", envOr("LISTEN", ":4041"), "address to listen on (env: LISTEN)"),
		pyroscopeURL:          flagSet.String("pyroscope-url", "", "Pyroscope server base URL; defaults to http://localhost:4040 (env: PYROSCOPE_URL)"),
		pyroscopeUsername:     flagSet.String("pyroscope-username", "", "basic auth username for the Pyroscope server, e.g. a Grafana Cloud stack ID (env: PYROSCOPE_USERNAME)"),
		pyroscopePassword:     flagSet.String("pyroscope-password", "", "basic auth password for the Pyroscope server (env: PYROSCOPE_PASSWORD)"),
		pyroscopePasswordFile: flagSet.String("pyroscope-password-file", envOr("PYROSCOPE_PASSWORD_FILE", ""), "path to a file holding the basic auth password, for mounted secrets; mutually exclusive with -pyroscope-password (env: PYROSCOPE_PASSWORD_FILE)"),
		logRequests:           flagSet.Bool("log-requests", boolEnvOr("LOG_REQUESTS"), "log one line per request: method, path, status, duration, bytes (env: LOG_REQUESTS)"),
		showVersion:           flagSet.Bool("version", false, "print the version and exit"),
	}
}

func main() {
	flags := registerFlags(flag.CommandLine)
	flag.Parse()

	if *flags.showVersion {
		fmt.Println("pyrolens", version)
		return
	}

	rawURL := *flags.pyroscopeURL
	if rawURL == "" {
		rawURL = envOr("PYROSCOPE_URL", "http://localhost:4040")
	}
	target, err := parsePyroscopeURL(rawURL)
	if err != nil {
		log.Fatal(err)
	}

	flagUser := *flags.pyroscopeUsername
	if flagUser == "" {
		flagUser = os.Getenv("PYROSCOPE_USERNAME")
	}
	flagPassword := *flags.pyroscopePassword
	if flagPassword == "" {
		flagPassword = os.Getenv("PYROSCOPE_PASSWORD")
	}

	passwordFilePath := *flags.pyroscopePasswordFile
	passwordFileSet := passwordFilePath != ""
	var passwordFileContent string
	// A contradiction (both -pyroscope-password and -pyroscope-password-file
	// set) is reported by resolvePyroscopeAuth regardless of the file's
	// contents, so skip reading it here: a missing or unreadable file would
	// otherwise report the wrong problem ahead of the real one.
	if passwordFileSet && flagPassword == "" {
		passwordFileContent = mustReadPasswordFile(passwordFilePath)
	}

	target, authUser, authPass, hasAuth, err := resolvePyroscopeAuth(target, pyroscopeAuthSources{
		flagUser:            flagUser,
		flagPassword:        flagPassword,
		passwordFilePath:    passwordFilePath,
		passwordFileSet:     passwordFileSet,
		passwordFileContent: passwordFileContent,
	})
	if err != nil {
		log.Fatal(err)
	}
	if warning := plaintextAuthWarning(target, hasAuth); warning != "" {
		log.Print("WARNING: " + warning)
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

	handler := newHandler(dist, index, gzipped, newProxy(target, authUser, authPass))
	if *flags.logRequests {
		handler = withAccessLog(handler)
	}
	server := &http.Server{
		Addr:              *flags.listen,
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       time.Minute,
		WriteTimeout:      5 * time.Minute,
		IdleTimeout:       2 * time.Minute,
	}
	log.Print(startupLogLine(*flags.listen, target, hasAuth))
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
