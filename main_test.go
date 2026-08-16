package main

import (
	"bytes"
	"compress/gzip"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"testing/fstest"
)

// Padded well past gzip's own header/footer overhead and repetitive, so its
// gzip form is actually smaller — the bare shell tag is too short for that to
// hold, which would silently drop it out of gzipAssets' map and make the
// compression tests exercise nothing.
var indexHTML = "<!doctype html><title>pyrolens</title><!-- " +
	strings.Repeat("padding ", 40) + "-->"

// Same reasoning as indexHTML: long and repetitive enough for gzip to help.
var testJS = strings.Repeat("console.log(1);", 50)

// The shape of a built dist/: the shell, a hashed bundle, a plain asset.
func testDist() fstest.MapFS {
	return fstest.MapFS{
		"index.html":             {Data: []byte(indexHTML)},
		"assets/index-abc123.js": {Data: []byte(testJS)},
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
	dist := testDist()
	return newHandler(dist, []byte(indexHTML), gzipAssets(dist), proxy), proxy
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

func getWithHeader(t *testing.T, h http.Handler, target, key, value string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, target, nil)
	req.Header.Set(key, value)
	h.ServeHTTP(rec, req)
	return rec
}

// gunzip fails the test rather than returning an error, since every caller
// only wants to compare the decompressed bytes.
func gunzip(t *testing.T, body []byte) string {
	t.Helper()
	gr, err := gzip.NewReader(bytes.NewReader(body))
	if err != nil {
		t.Fatalf("body was not valid gzip: %v", err)
	}
	got, err := io.ReadAll(gr)
	if err != nil {
		t.Fatalf("reading gunzipped body: %v", err)
	}
	return string(got)
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

func TestBoolEnvOr(t *testing.T) {
	t.Setenv("PYROLENS_TEST_BOOL", "")
	if got := boolEnvOr("PYROLENS_TEST_BOOL"); got {
		t.Errorf("empty env: got %v, want false", got)
	}
	t.Setenv("PYROLENS_TEST_BOOL", "true")
	if got := boolEnvOr("PYROLENS_TEST_BOOL"); !got {
		t.Errorf("got %v, want true", got)
	}
	t.Setenv("PYROLENS_TEST_BOOL", "0")
	if got := boolEnvOr("PYROLENS_TEST_BOOL"); got {
		t.Errorf("got %v, want false", got)
	}
}

// parseBoolEnv is the pure part of boolEnvOr's parsing: boolEnvOr itself
// can't be tested against an unparseable value since it calls log.Fatalf,
// which ends the test binary.
func TestParseBoolEnv(t *testing.T) {
	cases := []struct {
		value  string
		wantV  bool
		wantOK bool
	}{
		{"", false, true}, // unset means "off", not an error
		{"true", true, true},
		{"1", true, true},
		{"false", false, true},
		{"0", false, true},
		{"yes", false, false}, // not one of strconv.ParseBool's forms
		{"YES", false, false},
	}
	for _, c := range cases {
		v, ok := parseBoolEnv(c.value)
		if v != c.wantV || ok != c.wantOK {
			t.Errorf("parseBoolEnv(%q): got (%v, %v), want (%v, %v)", c.value, v, ok, c.wantV, c.wantOK)
		}
	}
}

// captureLog swaps the default logger's output for a buffer for the
// duration of the test, the same trick quietLogs uses to silence it.
func captureLog(t *testing.T) *bytes.Buffer {
	t.Helper()
	var buf bytes.Buffer
	out := log.Writer()
	flags := log.Flags()
	log.SetOutput(&buf)
	log.SetFlags(0)
	t.Cleanup(func() {
		log.SetOutput(out)
		log.SetFlags(flags)
	})
	return &buf
}

func TestAccessLogLine(t *testing.T) {
	buf := captureLog(t)
	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusTeapot)
		io.WriteString(w, "hi")
	})
	h := withAccessLog(inner)

	// The query string can carry a tenant's label matchers, so it must never
	// reach the log even though the path (no secrets in this app) does.
	req := httptest.NewRequest(http.MethodPost,
		"/querier.v1.QuerierService/Series?labelSelector=%7Btenant%3D%22secret-corp%22%7D", nil)
	req.Header.Set("X-Scope-OrgID", "tenant-a")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	line := buf.String()
	for _, want := range []string{"POST", "/querier.v1.QuerierService/Series", "418", "tenant=tenant-a"} {
		if !strings.Contains(line, want) {
			t.Errorf("log line %q missing %q", line, want)
		}
	}
	if strings.Contains(line, "secret-corp") {
		t.Errorf("log line leaked the query string: %q", line)
	}
}

func TestAcceptsGzipQualityValuesAndCasing(t *testing.T) {
	cases := []struct {
		header string
		want   bool
	}{
		{"gzip", true},
		{"GZIP", true}, // the token is case-insensitive per RFC 9110
		{"gzip;q=0", false},
		{"gzip;q=0.0", false},   // legal zero qvalue, string-equal check to "0" used to miss this
		{"gzip;q=0.000", false}, // same, with more trailing zeros
		{"gzip;q=0.5", true},
		{"br, gzip;q=1.0", true},
		{"", false},
		{"identity", false},
	}
	for _, c := range cases {
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		if c.header != "" {
			req.Header.Set("Accept-Encoding", c.header)
		}
		if got := acceptsGzip(req); got != c.want {
			t.Errorf("Accept-Encoding=%q: got %v, want %v", c.header, got, c.want)
		}
	}
}

// A newline in the decoded path must never reach the log verbatim: the
// server is unauthenticated, so anyone who can reach it can forge a second
// log line an operator later reads as if pyrolens had written it.
func TestAccessLogPathIsEscapedAgainstInjection(t *testing.T) {
	buf := captureLog(t)
	h := withAccessLog(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest(http.MethodGet, "/x%0aFAKE%20LINE", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	trimmed := strings.TrimRight(buf.String(), "\n")
	if lines := strings.Split(trimmed, "\n"); len(lines) != 1 {
		t.Errorf("got %d log lines from one request, want 1: %q", len(lines), buf.String())
	}
}

func TestAccessLogOmitsTenantOutsideQuerierPaths(t *testing.T) {
	buf := captureLog(t)
	h := withAccessLog(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	get(t, h, "/favicon.svg")

	if strings.Contains(buf.String(), "tenant=") {
		t.Errorf("log line %q should not carry a tenant field outside querier paths", buf.String())
	}
}

func TestAccessLogDefaultStatusIsOK(t *testing.T) {
	buf := captureLog(t)
	// A handler that never calls WriteHeader (like the healthz one) sends an
	// implicit 200; the wrapper has to report that instead of a bare 0.
	h := withAccessLog(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		io.WriteString(w, "ok")
	}))

	get(t, h, "/healthz")

	if !strings.Contains(buf.String(), " 200 ") {
		t.Errorf("log line %q missing the implicit 200", buf.String())
	}
}

// httputil.ReverseProxy flushes a chunked upstream response through
// http.NewResponseController(w).Flush() on every write. statusWriter has to
// expose the wrapped writer's Flush through Unwrap or that call silently
// fails and -log-requests turns off per-write flushing without any error
// visible to the handler.
func TestStatusWriterUnwrapExposesFlush(t *testing.T) {
	h := withAccessLog(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if err := http.NewResponseController(w).Flush(); err != nil {
			t.Errorf("flush through the wrapped writer: %v", err)
		}
	}))
	get(t, h, "/healthz")
}

func TestNoAccessLogWithoutTheMiddleware(t *testing.T) {
	buf := captureLog(t)
	// -log-requests is off by default: newHandler's own output must stay
	// quiet whether or not withAccessLog ever gets applied around it.
	h, _ := newTestHandler()
	get(t, h, "/healthz")

	if buf.Len() != 0 {
		t.Errorf("expected no log output with logging not enabled, got %q", buf.String())
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

func TestServesGzippedAssetWhenAccepted(t *testing.T) {
	h, _ := newTestHandler()
	rec := getWithHeader(t, h, "/assets/index-abc123.js", "Accept-Encoding", "gzip, deflate, br")
	if rec.Code != http.StatusOK {
		t.Fatalf("status: got %d, want 200", rec.Code)
	}
	if got := rec.Header().Get("Content-Encoding"); got != "gzip" {
		t.Errorf("content-encoding: got %q, want gzip", got)
	}
	if got := rec.Header().Get("Vary"); got != "Accept-Encoding" {
		t.Errorf("vary: got %q, want Accept-Encoding", got)
	}
	if got := gunzip(t, rec.Body.Bytes()); got != testJS {
		t.Errorf("gunzipped body: got %q, want the original file", got)
	}
	// Immutable caching applies the same whichever encoding went out.
	want := "public, max-age=31536000, immutable"
	if got := rec.Header().Get("Cache-Control"); got != want {
		t.Errorf("cache-control: got %q, want %q", got, want)
	}
	// The identity path derives Content-Type the same way (mime.TypeByExtension
	// through http.ServeContent), so compare against it instead of hardcoding a
	// string that could read differently depending on the host's mime config.
	identity := get(t, h, "/assets/index-abc123.js")
	if got, want := rec.Header().Get("Content-Type"), identity.Header().Get("Content-Type"); got != want {
		t.Errorf("content-type: got %q, want %q (the identity path's)", got, want)
	}
}

func TestServesIdentityAssetWithVaryHeader(t *testing.T) {
	h, _ := newTestHandler()
	// get() sends no Accept-Encoding at all.
	rec := get(t, h, "/assets/index-abc123.js")
	if rec.Code != http.StatusOK {
		t.Fatalf("status: got %d, want 200", rec.Code)
	}
	if got := rec.Header().Get("Content-Encoding"); got != "" {
		t.Errorf("content-encoding: got %q, want none", got)
	}
	// A gzip variant exists for this path even though this response is
	// identity, so a cache in front of pyrolens has to key on the request
	// header or it risks handing the next visitor the wrong encoding.
	if got := rec.Header().Get("Vary"); got != "Accept-Encoding" {
		t.Errorf("vary: got %q, want Accept-Encoding", got)
	}
	if rec.Body.String() != testJS {
		t.Errorf("body: got %q, want the original file", rec.Body.String())
	}
}

func TestServesGzippedSPAShellWhenAccepted(t *testing.T) {
	h, _ := newTestHandler()
	rec := getWithHeader(t, h, "/", "Accept-Encoding", "gzip")
	if rec.Code != http.StatusOK {
		t.Fatalf("status: got %d, want 200", rec.Code)
	}
	if got := rec.Header().Get("Content-Encoding"); got != "gzip" {
		t.Errorf("content-encoding: got %q, want gzip", got)
	}
	if got := rec.Header().Get("Cache-Control"); got != "no-cache" {
		t.Errorf("cache-control: got %q, want no-cache", got)
	}
	if got := rec.Header().Get("Content-Type"); got != "text/html; charset=utf-8" {
		t.Errorf("content-type: got %q", got)
	}
	if got := gunzip(t, rec.Body.Bytes()); got != indexHTML {
		t.Errorf("gunzipped body: got %q, want the shell", got)
	}
}

// The gzip path used to be a manual w.Write, which diverges from the
// identity path (http.FileServer, itself backed by http.ServeContent) on
// HEAD, Range and If-None-Match. Serving it through http.ServeContent too
// closes those gaps; these tests probe each one.

func TestGzipAssetHeadHasNoBody(t *testing.T) {
	h, _ := newTestHandler()
	req := httptest.NewRequest(http.MethodHead, "/assets/index-abc123.js", nil)
	req.Header.Set("Accept-Encoding", "gzip")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status: got %d, want 200", rec.Code)
	}
	if got := rec.Header().Get("Content-Encoding"); got != "gzip" {
		t.Errorf("content-encoding: got %q, want gzip", got)
	}
	if rec.Body.Len() != 0 {
		t.Errorf("HEAD response carried a body: %q", rec.Body.String())
	}
}

// A manual w.Write still reports its length through statusWriter even on a
// HEAD request, since the write happens regardless of method; ServeContent
// skips the write outright for HEAD, so the access log sees the truth.
func TestGzipAssetHeadLogsNoPhantomBytes(t *testing.T) {
	buf := captureLog(t)
	h, _ := newTestHandler()
	logged := withAccessLog(h)

	req := httptest.NewRequest(http.MethodHead, "/assets/index-abc123.js", nil)
	req.Header.Set("Accept-Encoding", "gzip")
	rec := httptest.NewRecorder()
	logged.ServeHTTP(rec, req)

	if !strings.Contains(buf.String(), " 0B") {
		t.Errorf("log line %q should report 0 bytes for a HEAD response", buf.String())
	}
}

func TestGzipAssetRange(t *testing.T) {
	h, _ := newTestHandler()
	full := getWithHeader(t, h, "/assets/index-abc123.js", "Accept-Encoding", "gzip")
	gz := full.Body.Bytes()
	if len(gz) < 4 {
		t.Fatalf("gzip body too short to exercise a range request: %d bytes", len(gz))
	}

	req := httptest.NewRequest(http.MethodGet, "/assets/index-abc123.js", nil)
	req.Header.Set("Accept-Encoding", "gzip")
	req.Header.Set("Range", "bytes=0-2")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	// The range addresses the gzip representation, per RFC 9110 — the
	// encoding is part of what was selected, not a transform applied after.
	if rec.Code != http.StatusPartialContent {
		t.Fatalf("status: got %d, want 206", rec.Code)
	}
	if got, want := rec.Body.Bytes(), gz[:3]; !bytes.Equal(got, want) {
		t.Errorf("range body: got %x, want the first 3 bytes of the gzip representation %x", got, want)
	}
	if got := rec.Header().Get("Content-Range"); !strings.HasPrefix(got, "bytes 0-2/") {
		t.Errorf("content-range: got %q", got)
	}
}

func TestIfNoneMatchStarBehavesTheSameAcrossEncodings(t *testing.T) {
	h, _ := newTestHandler()
	for _, enc := range []string{"", "gzip"} {
		req := httptest.NewRequest(http.MethodGet, "/assets/index-abc123.js", nil)
		if enc != "" {
			req.Header.Set("Accept-Encoding", enc)
		}
		req.Header.Set("If-None-Match", "*")
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)

		if rec.Code != http.StatusNotModified {
			t.Errorf("Accept-Encoding=%q: status got %d, want 304", enc, rec.Code)
		}
	}
}

// Identity GET /index.html gets FileServer's canonical redirect to "./".
// The gzip fast-path used to answer this one directly with 200 and no
// Cache-Control, so a cache in front of pyrolens could serve a stale shell
// past a redeploy; it now has to fall through to the same redirect.
func TestIndexHTMLRedirectsRegardlessOfEncoding(t *testing.T) {
	h, _ := newTestHandler()
	for _, enc := range []string{"", "gzip"} {
		req := httptest.NewRequest(http.MethodGet, "/index.html", nil)
		if enc != "" {
			req.Header.Set("Accept-Encoding", enc)
		}
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)

		if rec.Code != http.StatusMovedPermanently {
			t.Errorf("Accept-Encoding=%q: status got %d, want 301", enc, rec.Code)
		}
		if got := rec.Header().Get("Content-Encoding"); got != "" {
			t.Errorf("Accept-Encoding=%q: content-encoding got %q, want none on a redirect", enc, got)
		}
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
	dist := testDist()
	h := newHandler(dist, []byte(indexHTML), gzipAssets(dist), newProxy(target))

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
	dist := testDist()
	h := newHandler(dist, []byte(indexHTML), gzipAssets(dist), newProxy(target))

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
	dist := testDist()
	h := newHandler(dist, []byte(indexHTML), gzipAssets(dist), newProxy(target))

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
