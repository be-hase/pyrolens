package main

import (
	"bytes"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"testing/fstest"
)

const indexHTML = "<!doctype html><title>pyrolens</title>"

// The shape of a built dist/: the shell, a hashed bundle, a plain asset.
func testDist() fstest.MapFS {
	return fstest.MapFS{
		"index.html":             {Data: []byte(indexHTML)},
		"assets/index-abc123.js": {Data: []byte("console.log(1)")},
		"favicon.svg":            {Data: []byte("<svg/>")},
	}
}

// recorderProxy stands in for the reverse proxy, remembering what reached it.
type recorderProxy struct {
	called bool
	path   string
}

func (p *recorderProxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	p.called = true
	p.path = r.URL.Path
	w.WriteHeader(http.StatusTeapot)
}

func newTestHandler() (http.Handler, *recorderProxy) {
	proxy := &recorderProxy{}
	return newHandler(testDist(), []byte(indexHTML), proxy), proxy
}

func get(t *testing.T, h http.Handler, target string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, target, nil))
	return rec
}

func post(t *testing.T, h http.Handler, target string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, target, nil))
	return rec
}

// quietLogs keeps the proxy's error logging out of the test output.
func quietLogs(t *testing.T) {
	t.Helper()
	out := log.Writer()
	log.SetOutput(io.Discard)
	t.Cleanup(func() { log.SetOutput(out) })
}

func TestEnvOr(t *testing.T) {
	t.Setenv("PYROLENS_TEST", "")
	if got := envOr("PYROLENS_TEST", "fallback"); got != "fallback" {
		t.Errorf("empty env: got %q, want the fallback", got)
	}
	t.Setenv("PYROLENS_TEST", "set")
	if got := envOr("PYROLENS_TEST", "fallback"); got != "set" {
		t.Errorf("got %q, want %q", got, "set")
	}
}

func TestHealthz(t *testing.T) {
	h, _ := newTestHandler()
	rec := get(t, h, "/healthz")
	if rec.Code != http.StatusOK {
		t.Errorf("status: got %d, want 200", rec.Code)
	}
	if rec.Body.String() != "ok\n" {
		t.Errorf("body: got %q, want %q", rec.Body.String(), "ok\n")
	}
}

func TestServesSPAShellForDeepLinks(t *testing.T) {
	h, proxy := newTestHandler()
	// Every view is a history route with no file behind it; a 404 here would
	// break reloading and link sharing, which is the point of the URL state.
	for _, path := range []string{
		"/",
		"/comparison",
		"/diff?leftQuery=%7B%7D",
		"/tag-explorer",
		"/deep/unknown/route",
	} {
		rec := get(t, h, path)
		if rec.Code != http.StatusOK {
			t.Errorf("%s: status got %d, want 200", path, rec.Code)
		}
		if rec.Body.String() != indexHTML {
			t.Errorf("%s: did not serve the SPA shell", path)
		}
		if got := rec.Header().Get("Content-Type"); got != "text/html; charset=utf-8" {
			t.Errorf("%s: content-type got %q", path, got)
		}
		// The shell names the hashed bundle, so a cached one outlives a deploy.
		if got := rec.Header().Get("Cache-Control"); got != "no-cache" {
			t.Errorf("%s: cache-control got %q, want no-cache", path, got)
		}
	}
	if proxy.called {
		t.Error("a UI route reached the proxy")
	}
}

func TestServesRealFiles(t *testing.T) {
	h, _ := newTestHandler()
	rec := get(t, h, "/favicon.svg")
	if rec.Code != http.StatusOK {
		t.Fatalf("status: got %d, want 200", rec.Code)
	}
	if rec.Body.String() != "<svg/>" {
		t.Errorf("body: got %q, want the file's contents", rec.Body.String())
	}
	if got := rec.Header().Get("Cache-Control"); got != "" {
		t.Errorf("unhashed file got cache-control %q, want none", got)
	}
}

func TestHashedAssetsAreImmutable(t *testing.T) {
	h, _ := newTestHandler()
	rec := get(t, h, "/assets/index-abc123.js")
	if rec.Code != http.StatusOK {
		t.Fatalf("status: got %d, want 200", rec.Code)
	}
	want := "public, max-age=31536000, immutable"
	if got := rec.Header().Get("Cache-Control"); got != want {
		t.Errorf("cache-control: got %q, want %q", got, want)
	}
}

func TestMissingFileIsNotFound(t *testing.T) {
	h, _ := newTestHandler()
	// Falling back to the shell here would hand the browser HTML with a
	// script's content type, and the page would fail in a way that looks
	// like a bad deploy rather than a stale cache. Same for a mistyped icon:
	// its CSS mask would silently load HTML instead of failing visibly.
	for _, path := range []string{
		"/assets/index-stale.js",
		"/icons/typo.svg",
		"/missing.svg",
		// Under assets/ everything is a file, extension or not: falling back
		// here would serve HTML for a hashed bundle a stale page asked for.
		"/assets/index-stale",
		"/assets/",
	} {
		rec := get(t, h, path)
		if rec.Code != http.StatusNotFound {
			t.Errorf("%s: status got %d, want 404", path, rec.Code)
		}
		if strings.Contains(rec.Body.String(), "<title>pyrolens</title>") {
			t.Errorf("%s: a missing file was served the SPA shell", path)
		}
	}
}

func TestProxiesQueryPaths(t *testing.T) {
	for _, path := range []string{
		"/querier.v1.QuerierService/LabelNames",
		"/querier.v1.QuerierService/LabelValues",
		"/querier.v1.QuerierService/Series",
		"/querier.v1.QuerierService/SelectSeries",
		"/querier.v1.QuerierService/SelectMergeStacktraces",
		"/querier.v1.QuerierService/Diff",
	} {
		h, proxy := newTestHandler()
		post(t, h, path)
		if !proxy.called {
			t.Errorf("%s: was not proxied", path)
			continue
		}
		if proxy.path != path {
			t.Errorf("%s: proxy saw %q", path, proxy.path)
		}
	}

	// "/pyroscope/*" is deliberately not routed: a real Pyroscope serves its
	// legacy HTTP API there, /pyroscope/ingest included, and the UI has never
	// called any of it. Forwarding it turned a read-only viewer into a write
	// path.
	for _, path := range []string{
		"/pyroscope",
		"/pyroscope/",
		"/pyroscope/render",
		"/pyroscope/ingest",
		"/api/pyroscope/render",
		"/",
	} {
		h, proxy := newTestHandler()
		post(t, h, path)
		if proxy.called {
			t.Errorf("%s: reached the proxy but is a UI path", path)
		}
	}
}

func TestSecurityHeaders(t *testing.T) {
	h, _ := newTestHandler()
	// Every response, not just the shell: the proxy puts upstream-controlled
	// bytes on this origin, which is what the CSP is there to contain.
	for _, path := range []string{"/", "/healthz", "/favicon.svg"} {
		rec := get(t, h, path)
		if got := rec.Header().Get("X-Content-Type-Options"); got != "nosniff" {
			t.Errorf("%s: nosniff got %q", path, got)
		}
		csp := rec.Header().Get("Content-Security-Policy")
		for _, want := range []string{"default-src 'self'", "frame-ancestors 'none'"} {
			if !strings.Contains(csp, want) {
				t.Errorf("%s: csp %q is missing %q", path, csp, want)
			}
		}
	}
}

func TestOnlyTheMethodsTheUIUsesAreProxied(t *testing.T) {
	// Each RPC the UI calls is its own route, so the mux refuses everything
	// else before the proxy sees it.
	for _, target := range []string{
		// Real querier RPCs this UI has no use for.
		"/querier.v1.QuerierService/ProfileTypes",
		"/querier.v1.QuerierService/AnalyzeQuery",
		"/querier.v1.QuerierService/",
		// Traversal falls out of the same routing: the encoding decodes into
		// the method name and matches no route.
		"/querier.v1.QuerierService/%2e%2e%2fadmin",
		"/querier.v1.QuerierService/%2e%2e%2f%2e%2e%2fingest",
		"/querier.v1.QuerierService/Series%2f..%2fingest",
	} {
		h, proxy := newTestHandler()
		rec := post(t, h, target)
		if proxy.called {
			t.Errorf("%s: reached the proxy", target)
		}
		if rec.Code != http.StatusNotFound {
			t.Errorf("%s: status got %d, want 404", target, rec.Code)
		}
	}
}

func TestQuerierRoutesArePostOnly(t *testing.T) {
	// Connect-JSON is POST-only and the client sends nothing else, so any
	// other verb against a real RPC must not be forwarded. Which 4xx the mux
	// picks is its own business (405 when only the method differs, 404 when
	// the subtree handler answers first); that it refuses is ours.
	for _, verb := range []string{http.MethodGet, http.MethodDelete, http.MethodPut} {
		h, proxy := newTestHandler()
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest(verb, "/querier.v1.QuerierService/Series", nil))
		if proxy.called {
			t.Errorf("%s: reached the proxy", verb)
		}
		if rec.Code < 400 || rec.Code >= 500 {
			t.Errorf("%s: status got %d, want a 4xx", verb, rec.Code)
		}
	}
}
func TestProxyForwardsToUpstreamWithItsOwnHost(t *testing.T) {
	var gotHost, gotPath, gotQuery string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotHost, gotPath, gotQuery = r.Host, r.URL.Path, r.URL.RawQuery
		w.WriteHeader(http.StatusOK)
		io.WriteString(w, "upstream said so")
	}))
	defer upstream.Close()

	target, err := url.Parse(upstream.URL)
	if err != nil {
		t.Fatal(err)
	}
	h := newHandler(testDist(), []byte(indexHTML), newProxy(target))

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost,
		"http://pyrolens.example/querier.v1.QuerierService/LabelNames?x=1", nil)
	h.ServeHTTP(rec, req)

	// Name-based routing at the upstream (an ingress, Grafana Cloud) picks the
	// backend by Host; forwarding the browser's would reach the wrong one.
	if gotHost != target.Host {
		t.Errorf("upstream Host: got %q, want %q", gotHost, target.Host)
	}
	if gotPath != "/querier.v1.QuerierService/LabelNames" {
		t.Errorf("upstream path: got %q", gotPath)
	}
	if gotQuery != "x=1" {
		t.Errorf("upstream query: got %q, want %q", gotQuery, "x=1")
	}
	if rec.Code != http.StatusOK || rec.Body.String() != "upstream said so" {
		t.Errorf("response: got %d %q", rec.Code, rec.Body.String())
	}
}

func TestProxyErrorKeepsDetailOutOfTheBrowser(t *testing.T) {
	quietLogs(t)

	// A port nothing listens on: every request fails to connect.
	dead := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	deadURL := dead.URL
	dead.Close()
	target, err := url.Parse(deadURL)
	if err != nil {
		t.Fatal(err)
	}
	h := newHandler(testDist(), []byte(indexHTML), newProxy(target))

	rec := post(t, h, "/querier.v1.QuerierService/LabelNames")
	if rec.Code != http.StatusBadGateway {
		t.Errorf("status: got %d, want 502", rec.Code)
	}
	body := rec.Body.String()
	if !strings.Contains(body, "upstream pyroscope unreachable") {
		t.Errorf("body: got %q, want the plain explanation", body)
	}
	// The address and the dial error belong in the log, not on screen.
	for _, leak := range []string{target.Host, "connect", "dial"} {
		if strings.Contains(body, leak) {
			t.Errorf("body leaked %q: %q", leak, body)
		}
	}
}

func TestProxyRejectsOversizedBody(t *testing.T) {
	quietLogs(t)

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.Copy(io.Discard, r.Body)
	}))
	defer upstream.Close()
	target, err := url.Parse(upstream.URL)
	if err != nil {
		t.Fatal(err)
	}
	h := newHandler(testDist(), []byte(indexHTML), newProxy(target))

	body := bytes.Repeat([]byte("x"), 16<<20+1)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost,
		"/querier.v1.QuerierService/LabelNames", bytes.NewReader(body))
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Errorf("status: got %d, want 413", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "request body too large") {
		t.Errorf("body: got %q", rec.Body.String())
	}
}
