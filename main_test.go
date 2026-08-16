package main

import (
	"bytes"
	"compress/gzip"
	"flag"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
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

// readPasswordFile is the pure part of mustReadPasswordFile: the latter
// can't be tested against a missing file since it calls log.Fatalf, which
// ends the test binary.
func TestReadPasswordFile(t *testing.T) {
	cases := []struct {
		name    string
		content string
		want    string
	}{
		{"trims the one trailing newline a k8s secret mount ends with", "s3cr3t\n", "s3cr3t"},
		{"trims only one, leaving an interior/second newline alone", "s3cr3t\n\n", "s3cr3t\n"},
		{"no trailing newline at all", "s3cr3t", "s3cr3t"},
		{"CRLF secret file trims \\r\\n as one line ending, not leaving a stray \\r", "s3cr3t\r\n", "s3cr3t"},
		{"CRLF file, interior line ending preserved: only the trailing one is trimmed", "line1\r\nline2\r\n", "line1\r\nline2"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			path := t.TempDir() + "/password"
			if err := os.WriteFile(path, []byte(c.content), 0o600); err != nil {
				t.Fatal(err)
			}
			got, err := readPasswordFile(path)
			if err != nil {
				t.Fatalf("readPasswordFile: %v", err)
			}
			if got != c.want {
				t.Errorf("readPasswordFile(%q): got %q, want %q", c.content, got, c.want)
			}
		})
	}
}

func TestReadPasswordFileMissingIsError(t *testing.T) {
	if _, err := readPasswordFile(t.TempDir() + "/does-not-exist"); err == nil {
		t.Error("expected an error for a missing password file, got nil")
	}
}

// TestResolvePyroscopeAuth is the full source matrix: username from a flag,
// the URL, or absent, crossed with password from a flag, a password file,
// the URL, or absent, plus the two contradictions (both password sources
// set; a password file that reads as empty) and the cross-source
// misdirection case finding 8 called out (a plausible token-rotation setup
// — URL username, file password — must name the file, not just say
// "username with no password").
func TestResolvePyroscopeAuth(t *testing.T) {
	cases := []struct {
		name        string
		rawURL      string
		src         pyroscopeAuthSources
		wantErr     string // substring; "" means no error is expected
		wantUser    string
		wantPass    string
		wantHasAuth bool
	}{
		{
			name:   "no source at all: no auth",
			rawURL: "http://pyroscope:4040",
		},
		{
			name:        "username+password: flag",
			rawURL:      "http://pyroscope:4040",
			src:         pyroscopeAuthSources{flagUser: "bob", flagPassword: "flagpass"},
			wantUser:    "bob",
			wantPass:    "flagpass",
			wantHasAuth: true,
		},
		{
			name:        "username: flag, password: file",
			rawURL:      "http://pyroscope:4040",
			src:         pyroscopeAuthSources{flagUser: "bob", passwordFileSet: true, passwordFileContent: "filepass"},
			wantUser:    "bob",
			wantPass:    "filepass",
			wantHasAuth: true,
		},
		{
			name:        "username+password: URL userinfo alone",
			rawURL:      "http://alice:urlpass@pyroscope:4040",
			wantUser:    "alice",
			wantPass:    "urlpass",
			wantHasAuth: true,
		},
		{
			name:        "flags win over URL userinfo entirely",
			rawURL:      "http://alice:urlpass@pyroscope:4040",
			src:         pyroscopeAuthSources{flagUser: "bob", flagPassword: "flagpass"},
			wantUser:    "bob",
			wantPass:    "flagpass",
			wantHasAuth: true,
		},
		{
			name:        "a file-sourced password also wins over URL userinfo",
			rawURL:      "http://alice:urlpass@pyroscope:4040",
			src:         pyroscopeAuthSources{flagUser: "bob", passwordFileSet: true, passwordFileContent: "filepass"},
			wantUser:    "bob",
			wantPass:    "filepass",
			wantHasAuth: true,
		},
		{
			name:    "both -pyroscope-password and -pyroscope-password-file set: contradiction",
			rawURL:  "http://pyroscope:4040",
			src:     pyroscopeAuthSources{flagUser: "bob", flagPassword: "flagpass", passwordFileSet: true, passwordFileContent: "filepass"},
			wantErr: "-pyroscope-password-file",
		},
		{
			name:    "empty password file: error names the path",
			rawURL:  "http://pyroscope:4040",
			src:     pyroscopeAuthSources{flagUser: "bob", passwordFileSet: true, passwordFilePath: "/etc/secret/token", passwordFileContent: ""},
			wantErr: "/etc/secret/token",
		},
		{
			name:    "username: flag, password: absent",
			rawURL:  "http://pyroscope:4040",
			src:     pyroscopeAuthSources{flagUser: "bob"},
			wantErr: "missing a password",
		},
		{
			name:    "username: absent, password: flag",
			rawURL:  "http://pyroscope:4040",
			src:     pyroscopeAuthSources{flagPassword: "flagpass"},
			wantErr: "-pyroscope-username",
		},
		{
			// The scenario finding 8 called out: a plausible token-rotation
			// setup where the URL supplies the stable username and the file
			// supplies a rotated password. This must not be reported as a
			// generic "username with no password" — the username IS set,
			// just not on a source that combines with the file.
			name:    "username: URL, password: file — names the file, not a generic message",
			rawURL:  "http://alice@pyroscope:4040",
			src:     pyroscopeAuthSources{passwordFileSet: true, passwordFilePath: "/etc/secret/token", passwordFileContent: "filepass"},
			wantErr: "-pyroscope-password-file",
		},
		{
			name:    "username: URL, password: absent",
			rawURL:  "http://alice@pyroscope:4040",
			wantErr: "username with no password",
		},
		{
			name:    "username: absent, password: URL",
			rawURL:  "http://:urlpass@pyroscope:4040",
			wantErr: "password with no username",
		},
		{
			name:    "a colon in a flag-sourced username is rejected",
			rawURL:  "http://pyroscope:4040",
			src:     pyroscopeAuthSources{flagUser: "a:b", flagPassword: "pw"},
			wantErr: "-pyroscope-username",
		},
		{
			name:    "a colon in a URL-sourced username is rejected",
			rawURL:  "http://a%3Ab:pw@pyroscope:4040", // %3A decodes to ':'
			wantErr: "URL's userinfo",
		},
		{
			name:   "syntactically-empty URL userinfo (http://@host) is no auth, not an error",
			rawURL: "http://@pyroscope:4040",
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			quietLogs(t) // a "flags win" notice may fire; not under test here
			target, err := url.Parse(c.rawURL)
			if err != nil {
				t.Fatal(err)
			}

			resolved, user, pass, hasAuth, err := resolvePyroscopeAuth(target, c.src)
			if c.wantErr != "" {
				if err == nil {
					t.Fatalf("expected an error containing %q, got nil", c.wantErr)
				}
				if !strings.Contains(err.Error(), c.wantErr) {
					t.Errorf("error %q does not contain %q", err.Error(), c.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if user != c.wantUser || pass != c.wantPass || hasAuth != c.wantHasAuth {
				t.Errorf("got user=%q pass=%q hasAuth=%v, want user=%q pass=%q hasAuth=%v",
					user, pass, hasAuth, c.wantUser, c.wantPass, c.wantHasAuth)
			}
			if resolved.User != nil {
				t.Errorf("resolved target still carried userinfo: %v", resolved.User)
			}
		})
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

// The startup log line already went through target.Redacted() for the
// password an operator embeds in -pyroscope-url; this checks the same holds
// for a password that arrives instead through -pyroscope-username/-password
// or -pyroscope-password-file, none of which Redacted() ever sees.
func TestStartupLogLineNeverCarriesAPassword(t *testing.T) {
	cases := []struct {
		name         string
		rawURL       string
		src          pyroscopeAuthSources
		wantAuthNote bool
	}{
		{"no auth", "http://pyroscope:4040", pyroscopeAuthSources{}, false},
		{"flags only", "http://pyroscope:4040", pyroscopeAuthSources{flagUser: "flag-user", flagPassword: "s3cr3t-flag"}, true},
		{"userinfo only", "http://url-user:s3cr3t-url@pyroscope:4040", pyroscopeAuthSources{}, true},
		{"flags win over userinfo", "http://url-user:s3cr3t-url@pyroscope:4040", pyroscopeAuthSources{flagUser: "flag-user", flagPassword: "s3cr3t-flag"}, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			quietLogs(t) // resolvePyroscopeAuth may log a "flags win" notice; not under test here
			target, err := url.Parse(c.rawURL)
			if err != nil {
				t.Fatal(err)
			}
			resolved, _, _, hasAuth, err := resolvePyroscopeAuth(target, c.src)
			if err != nil {
				t.Fatalf("resolvePyroscopeAuth: %v", err)
			}
			if hasAuth != c.wantAuthNote {
				t.Fatalf("hasAuth: got %v, want %v", hasAuth, c.wantAuthNote)
			}

			buf := captureLog(t)
			log.Print(startupLogLine(":4041", resolved, hasAuth))
			line := buf.String()

			for _, secret := range []string{"s3cr3t-flag", "s3cr3t-url"} {
				if strings.Contains(line, secret) {
					t.Errorf("log line %q leaked a password", line)
				}
			}
			if strings.Contains(line, "(basic auth)") != c.wantAuthNote {
				t.Errorf("log line %q: basic-auth marker present=%v, want %v",
					line, strings.Contains(line, "(basic auth)"), c.wantAuthNote)
			}
		})
	}
}

// registerFlags bakes each secret-bearing flag's default as a fixed, safe
// literal rather than envOr(...), specifically so flag.PrintDefaults (what
// -h, an unrecognized flag, or any argv typo under ExitOnError triggers)
// never has a secret to print. This renders the same usage output -h would,
// against a throwaway FlagSet, with the envs set to values that must not
// appear in it.
func TestRegisterFlagsUsageNeverPrintsSecretsFromEnv(t *testing.T) {
	t.Setenv("PYROSCOPE_USERNAME", "should-not-appear-user")
	t.Setenv("PYROSCOPE_PASSWORD", "should-not-appear-pass")
	t.Setenv("PYROSCOPE_URL", "https://user:should-not-appear-urlpass@pyroscope.example")

	flagSet := flag.NewFlagSet("pyrolens", flag.ContinueOnError)
	var buf bytes.Buffer
	flagSet.SetOutput(&buf)
	registerFlags(flagSet)
	flagSet.PrintDefaults()

	out := buf.String()
	for _, secret := range []string{"should-not-appear-user", "should-not-appear-pass", "should-not-appear-urlpass"} {
		if strings.Contains(out, secret) {
			t.Errorf("usage output leaked %q:\n%s", secret, out)
		}
	}
}

// parsePyroscopeURL is the pure, no-echo half of main's URL validation;
// log.Fatal itself can't be asked this without exiting the test binary.
func TestParsePyroscopeURLRejectsMalformedURLWithoutEchoingIt(t *testing.T) {
	// A malformed authority with embedded userinfo: url.Parse fails on the
	// bare "%" and, unguarded, a %q of the raw input (or of err, which
	// embeds it) would put "s3cr3t-pw" on stderr.
	_, err := parsePyroscopeURL("https://user:s3cr3t-pw@%")
	if err == nil {
		t.Fatal("expected an error for a malformed URL")
	}
	if strings.Contains(err.Error(), "s3cr3t-pw") {
		t.Errorf("error echoed the secret: %v", err)
	}
}

func TestParsePyroscopeURLAcceptsAValidURL(t *testing.T) {
	target, err := parsePyroscopeURL("https://pyroscope.example:4040")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if target.Host != "pyroscope.example:4040" {
		t.Errorf("got host %q, want pyroscope.example:4040", target.Host)
	}
}

func TestParsePyroscopeURLRejectsURLWithNoSchemeOrHost(t *testing.T) {
	// url.Parse itself accepts this as a valid relative reference; it just
	// isn't usable as a proxy target.
	if _, err := parsePyroscopeURL("/just/a/path"); err == nil {
		t.Error("expected an error for a URL with no scheme/host")
	}
}

func TestIsLoopbackHost(t *testing.T) {
	cases := []struct {
		host string
		want bool
	}{
		{"localhost", true},
		{"localhost:4040", true},
		{"127.0.0.1", true},
		{"127.0.0.1:4040", true},
		{"::1", true},
		{"[::1]:4040", true},
		{"pyroscope.example", false},
		{"pyroscope.example:4040", false},
	}
	for _, c := range cases {
		if got := isLoopbackHost(c.host); got != c.want {
			t.Errorf("isLoopbackHost(%q): got %v, want %v", c.host, got, c.want)
		}
	}
}

// The four combinations finding 3 called for: auth × {http, https} ×
// {loopback, non-loopback}. Rejecting the plaintext case outright would
// break legitimate local testing, so this is a warning, checked here by its
// presence/absence rather than its exact wording.
func TestPlaintextAuthWarning(t *testing.T) {
	cases := []struct {
		name    string
		rawURL  string
		hasAuth bool
		want    bool
	}{
		{"auth + http + non-loopback: warns", "http://pyroscope.example:4040", true, true},
		{"auth + http + loopback: no warning (local testing)", "http://localhost:4040", true, false},
		{"auth + https + non-loopback: no warning", "https://pyroscope.example:4040", true, false},
		{"no auth + http + non-loopback: no warning", "http://pyroscope.example:4040", false, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			target, err := url.Parse(c.rawURL)
			if err != nil {
				t.Fatal(err)
			}
			if got := plaintextAuthWarning(target, c.hasAuth) != ""; got != c.want {
				t.Errorf("got warning=%v, want %v", got, c.want)
			}
		})
	}
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
	h := newHandler(dist, []byte(indexHTML), gzipAssets(dist), newProxy(target, "", ""))

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
	h := newHandler(dist, []byte(indexHTML), gzipAssets(dist), newProxy(target, "", ""))

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
	h := newHandler(dist, []byte(indexHTML), gzipAssets(dist), newProxy(target, "", ""))

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

// newAuthTestProxy wires newProxy straight to a recording upstream (bypassing
// newHandler's routing, which is covered elsewhere) so these tests can
// inspect exactly what the upstream received. gotHeaders reports the last
// request's headers as the upstream saw them.
func newAuthTestProxy(t *testing.T, authUser, authPass string) (proxy http.Handler, gotHeaders func() http.Header) {
	t.Helper()
	var last http.Header
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		last = r.Header.Clone()
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(upstream.Close)
	target, err := url.Parse(upstream.URL)
	if err != nil {
		t.Fatal(err)
	}
	return newProxy(target, authUser, authPass), func() http.Header { return last }
}

func TestProxyDirectorSetsBasicAuthWhenConfigured(t *testing.T) {
	proxy, gotHeaders := newAuthTestProxy(t, "grafana-stack-1", "api-token")
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/querier.v1.QuerierService/LabelNames", nil)
	proxy.ServeHTTP(rec, req)

	upstreamReq := &http.Request{Header: http.Header{"Authorization": {gotHeaders().Get("Authorization")}}}
	user, pass, ok := upstreamReq.BasicAuth()
	if !ok || user != "grafana-stack-1" || pass != "api-token" {
		t.Errorf("upstream Authorization: got user=%q pass=%q ok=%v, want grafana-stack-1/api-token", user, pass, ok)
	}
}

func TestProxyDirectorNoAuthorizationWhenNotConfigured(t *testing.T) {
	proxy, gotHeaders := newAuthTestProxy(t, "", "")
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/querier.v1.QuerierService/LabelNames", nil)
	proxy.ServeHTTP(rec, req)

	if got := gotHeaders().Get("Authorization"); got != "" {
		t.Errorf("upstream Authorization: got %q, want none (no auth configured, no inbound header)", got)
	}
}

func TestProxyDirectorReplacesInboundAuthorizationWhenConfigured(t *testing.T) {
	proxy, gotHeaders := newAuthTestProxy(t, "grafana-stack-1", "api-token")
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/querier.v1.QuerierService/LabelNames", nil)
	// An unauthenticated visitor's own header must not reach an authenticated
	// upstream verbatim — forwarding it would let them probe the upstream
	// with credentials of their own choosing.
	req.Header.Set("Authorization", "Bearer whatever-the-client-sent")
	proxy.ServeHTTP(rec, req)

	got := gotHeaders().Get("Authorization")
	upstreamReq := &http.Request{Header: http.Header{"Authorization": {got}}}
	user, pass, ok := upstreamReq.BasicAuth()
	if !ok || user != "grafana-stack-1" || pass != "api-token" {
		t.Errorf("upstream Authorization: got %q, want the configured basic auth to overwrite the inbound header", got)
	}
}

// The UI's own client (src/api/client.ts) never sends Authorization, so an
// inbound one is by definition not ours. Forwarding it would leak an SSO
// bearer token to a third party when pyrolens sits behind an
// oauth2-proxy-style frontend, or let an anonymous caller relay arbitrary
// credentials at an authenticated upstream — so it is stripped outright, not
// passed through, even when no upstream credentials are configured. It never
// makes it into the fresh header set the director builds in the first place.
func TestProxyDirectorStripsInboundAuthorizationWhenNotConfigured(t *testing.T) {
	proxy, gotHeaders := newAuthTestProxy(t, "", "")
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/querier.v1.QuerierService/LabelNames", nil)
	req.Header.Set("Authorization", "Bearer whatever-the-client-sent")
	proxy.ServeHTTP(rec, req)

	if got := gotHeaders().Get("Authorization"); got != "" {
		t.Errorf("upstream Authorization: got %q, want it stripped entirely", got)
	}
}

// The header-shaped version of TestOnlyTheMethodsTheUIUsesAreProxied: a
// transparent proxy would carry a fronting SSO's session Cookie,
// User-Agent/Referer fingerprinting, and anything else a browser happens to
// attach, straight to Pyroscope. Only what src/api/client.ts actually sends
// — Content-Type and X-Scope-OrgID — reaches the upstream, and
// X-Forwarded-For (which ReverseProxy would otherwise append on its own,
// hence the non-default RemoteAddr below) is suppressed outright.
func TestProxyDirectorForwardsOnlyAllowlistedRequestHeaders(t *testing.T) {
	proxy, gotHeaders := newAuthTestProxy(t, "", "")
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/querier.v1.QuerierService/LabelNames", nil)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Scope-OrgID", "tenant-a")
	req.Header.Set("Cookie", "session=fronting-sso-secret")
	req.Header.Set("User-Agent", "some-browser/1.0")
	req.Header.Set("Referer", "https://pyrolens.example/diff")
	req.Header.Set("X-Custom-Junk", "whatever-a-browser-or-intermediary-attached")
	req.RemoteAddr = "203.0.113.7:12345" // a real address, so XFF would otherwise be appended
	proxy.ServeHTTP(rec, req)

	got := gotHeaders()
	for _, want := range []struct{ name, value string }{
		{"Content-Type", "application/json"},
		{"X-Scope-OrgID", "tenant-a"},
	} {
		if v := got.Get(want.name); v != want.value {
			t.Errorf("%s: got %q, want %q", want.name, v, want.value)
		}
	}
	for _, absent := range []string{"Cookie", "User-Agent", "Referer", "X-Custom-Junk", "X-Forwarded-For"} {
		if v := got.Get(absent); v != "" {
			t.Errorf("%s reached the upstream: %q", absent, v)
		}
	}
}

// client.ts's checkMultitenancy deliberately sends X-Scope-OrgID explicitly
// empty — that IS the multitenancy probe, since Pyroscope tells single- from
// multi-tenant mode apart by whether the header arrived at all, not by its
// value. Header.Values (not Get, which can't tell "absent" from
// "present-but-empty") is what makes that distinction visible here: a
// `Header.Get(h) != ""` copy condition drops the header entirely, which is
// trivially "not empty" by Get's own report but is exactly the bug this
// guards — the fake Pyroscope the e2e suite drives refuses an empty
// X-Scope-OrgID under multitenancy (e2e/fake-pyroscope.mjs), and never got
// the chance to.
func TestProxyDirectorForwardsExplicitlyEmptyXScopeOrgID(t *testing.T) {
	proxy, gotHeaders := newAuthTestProxy(t, "", "")
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/querier.v1.QuerierService/LabelNames", nil)
	req.Header.Set("X-Scope-OrgID", "")
	proxy.ServeHTTP(rec, req)

	vals := gotHeaders().Values("X-Scope-OrgID")
	if len(vals) != 1 || vals[0] != "" {
		t.Errorf("X-Scope-OrgID at the upstream: got %#v, want it present with one empty value", vals)
	}
}

// req.Trailer rides outside the header allowlist entirely: ReverseProxy
// clones the inbound request wholesale, Trailer field included, so a
// non-browser client (fetch has no request trailers, but nothing stops a
// script) could otherwise attach arbitrary trailer metadata that reaches the
// upstream unfiltered. Calling proxy.Director directly, rather than
// constructing a real chunked request with trailers through the full proxy
// (fiddly — trailers are a Transfer-Encoding-level concern, not something
// httptest.NewRequest models), is enough to pin that the director nils it.
func TestProxyDirectorNilsRequestTrailer(t *testing.T) {
	target, err := url.Parse("http://pyroscope.example:4040")
	if err != nil {
		t.Fatal(err)
	}
	proxy := newProxy(target, "", "")

	req := httptest.NewRequest(http.MethodPost, "/querier.v1.QuerierService/LabelNames", nil)
	req.Trailer = http.Header{"X-Injected-Trailer": {"whatever-a-non-browser-client-attached"}}
	proxy.Director(req)

	if req.Trailer != nil {
		t.Errorf("request Trailer survived the director: %v", req.Trailer)
	}
}

// Pins the full wiring end to end: resolvePyroscopeAuth's output has to flow
// into newProxy for the request to reach the upstream authenticated, so a
// stub (main always calling newProxy(target, "", "")) could no longer pass
// every test in this file undetected.
func TestResolvedCredentialsReachTheUpstreamThroughNewProxy(t *testing.T) {
	var gotAuthorization string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuthorization = r.Header.Get("Authorization")
		w.WriteHeader(http.StatusOK)
	}))
	defer upstream.Close()

	rawTarget, err := url.Parse(upstream.URL)
	if err != nil {
		t.Fatal(err)
	}
	// The credentials arrive the way an operator's -pyroscope-url would
	// carry them: as userinfo, resolved the same way main resolves it.
	rawTarget.User = url.UserPassword("grafana-stack-1", "api-token")

	target, authUser, authPass, hasAuth, err := resolvePyroscopeAuth(rawTarget, pyroscopeAuthSources{})
	if err != nil {
		t.Fatalf("resolvePyroscopeAuth: %v", err)
	}
	if !hasAuth {
		t.Fatal("expected auth to be configured from the URL's userinfo")
	}

	proxy := newProxy(target, authUser, authPass)
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/querier.v1.QuerierService/LabelNames", nil)
	proxy.ServeHTTP(rec, req)

	upstreamReq := &http.Request{Header: http.Header{"Authorization": {gotAuthorization}}}
	user, pass, ok := upstreamReq.BasicAuth()
	if !ok || user != "grafana-stack-1" || pass != "api-token" {
		t.Errorf("upstream saw user=%q pass=%q ok=%v, want the credentials resolvePyroscopeAuth resolved", user, pass, ok)
	}
}

// The response-direction mirror of the request-header allowlist test above:
// an upstream (or a load balancer in front of it) setting Set-Cookie must
// not plant a cookie on pyrolens's own origin, and anything else not on the
// allowlist is dropped the same way — only Content-Type (what the UI's
// fetch layer actually reads) survives.
func TestModifyResponseFiltersToAllowlistedResponseHeaders(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Set-Cookie", "sess=upstream-secret")
		w.Header().Set("X-Upstream-Junk", "whatever-pyroscope-happened-to-send")
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
	}))
	defer upstream.Close()
	target, err := url.Parse(upstream.URL)
	if err != nil {
		t.Fatal(err)
	}
	proxy := newProxy(target, "", "")

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/querier.v1.QuerierService/LabelNames", nil)
	proxy.ServeHTTP(rec, req)

	if got := rec.Header().Get("Content-Type"); got != "application/json" {
		t.Errorf("Content-Type: got %q, want application/json", got)
	}
	for _, absent := range []string{"Set-Cookie", "X-Upstream-Junk"} {
		if v := rec.Header().Get(absent); v != "" {
			t.Errorf("%s reached the browser: %q", absent, v)
		}
	}
}

// Regression test for the round-15 finding: httputil.ReverseProxy's
// Got1xxResponse trace copies an upstream 1xx's own headers into the shared
// ResponseWriter header map — which, before this fix, already held the CSP
// and nosniff withSecurityHeaders set up front — writes the informational
// response, then clears the ENTIRE map. The final response used to go out
// with neither header: a malicious upstream could defeat the CSP itself by
// prefixing its response with a bare 103, and an LB emitting 1xx of its own
// would degrade it by accident. This goes through newHandler (not a bare
// newProxy) since securityHeaderWriter lives at that layer.
func TestSecurityHeadersSurviveAnUpstream1xxResponse(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		// An informational response carrying junk this server must never
		// let through, immediately followed by the real one.
		w.Header().Set("Link", "</style.css>; rel=preload")
		w.Header().Set("Set-Cookie", "sess=upstream-secret")
		w.WriteHeader(http.StatusEarlyHints) // 103
		w.Header().Set("Content-Type", "text/html")
		w.WriteHeader(http.StatusOK)
		io.WriteString(w, "<html>hi</html>")
	}))
	defer upstream.Close()
	target, err := url.Parse(upstream.URL)
	if err != nil {
		t.Fatal(err)
	}
	dist := testDist()
	h := newHandler(dist, []byte(indexHTML), gzipAssets(dist), newProxy(target, "", ""))

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/querier.v1.QuerierService/LabelNames", nil)
	h.ServeHTTP(rec, req)

	// No informational response is observable at all: the recorder's final
	// (and only) status is the real one.
	if rec.Code != http.StatusOK {
		t.Fatalf("status: got %d, want 200", rec.Code)
	}
	if got := rec.Header().Get("Content-Security-Policy"); got == "" {
		t.Error("Content-Security-Policy is missing from the final response")
	}
	if got := rec.Header().Get("X-Content-Type-Options"); got != "nosniff" {
		t.Errorf("X-Content-Type-Options: got %q, want nosniff", got)
	}
	for _, absent := range []string{"Link", "Set-Cookie"} {
		if v := rec.Header().Get(absent); v != "" {
			t.Errorf("%s reached the client: %q", absent, v)
		}
	}
}
