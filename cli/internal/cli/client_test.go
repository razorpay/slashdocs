package cli

import (
	"bytes"
	"compress/gzip"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"math/rand"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
)

func TestClientFollowsAndSavesPermanentServerMove(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	t.Setenv("SLASHDOCS_NO_KEYCHAIN", "1")
	t.Setenv("SLASHDOCS_SERVER", "")
	t.Setenv("SLASHDOCS_TOKEN", "")
	moved := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		if r.Header.Get("Authorization") != "Bearer tok" || r.Method != http.MethodPost || string(body) != `{"a":1}` {
			http.Error(w, "lost the request on redirect", http.StatusUnauthorized)
			return
		}
		writeTestString(t, w, `{}`)
	}))
	t.Cleanup(moved.Close)
	// Another host name, so Go removes the credentials on the redirect.
	movedURL := strings.Replace(moved.URL, "127.0.0.1", "localhost", 1)
	old := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, movedURL+r.URL.RequestURI(), http.StatusPermanentRedirect) //nolint:gosec // G710: test server.
	}))
	t.Cleanup(old.Close)
	oldName, movedName := ctxName(old.URL), ctxName(movedURL)
	if err := saveConfig(Config{ActiveContext: oldName, Contexts: map[string]*Context{
		oldName: {Server: old.URL, Credential: map[string]any{"token": "tok"}, Pulled: map[string]string{"doc_1": "ver_1"}},
	}}); err != nil {
		t.Fatal(err)
	}

	c, err := client(&globals{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := c.doJSON(http.MethodPost, "/v1/things", map[string]int{"a": 1}); err != nil {
		t.Fatalf("request through the move failed: %v", err)
	}

	cfg, err := loadConfig()
	if err != nil {
		t.Fatal(err)
	}
	cx := cfg.Contexts[movedName]
	if cfg.ActiveContext != movedName || cfg.Contexts[oldName] != nil || cx == nil || cx.Server != movedURL || cx.Pulled["doc_1"] != "ver_1" {
		t.Fatalf("config after move = %+v", cfg)
	}
	if got := credentialToken(movedName, cx.Credential); got != "tok" {
		t.Fatalf("moved token = %q", got)
	}
}

func TestClientKeepsServerFromEnvironmentOnMove(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	moved := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { writeTestString(t, w, `{}`) }))
	t.Cleanup(moved.Close)
	old := httptest.NewServer(http.RedirectHandler(moved.URL+"/v1/me", http.StatusPermanentRedirect))
	t.Cleanup(old.Close)
	t.Setenv("SLASHDOCS_SERVER", old.URL)

	c, err := client(&globals{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := c.do(http.MethodGet, "/v1/me", nil, ""); err != nil {
		t.Fatal(err)
	}
	if cfg, _ := loadConfig(); len(cfg.Contexts) != 0 || c.Base != old.URL {
		t.Fatalf("a server set by the environment must not be saved: base=%s config=%+v", c.Base, cfg)
	}
}

// discovery modes of the test server.
const (
	discoveryNone     = iota // 404, as on a server that predates discovery fields
	discoveryCanGzip         // decodes gzip but does not ask for it
	discoveryAsksGzip        // asks clients to compress
)

func gzipTestServer(t *testing.T, mode int, got chan<- *http.Request, bodies chan<- []byte) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/.well-known/slashdocs.json" {
			switch mode {
			case discoveryCanGzip:
				writeTestString(t, w, `{"name":"slashdocs","request_encodings":["gzip"],"compress_requests":false}`)
			case discoveryAsksGzip:
				writeTestString(t, w, `{"name":"slashdocs","request_encodings":["gzip"],"compress_requests":true}`)
			default:
				http.NotFound(w, r)
			}
			return
		}
		raw, _ := io.ReadAll(r.Body)
		got <- r
		bodies <- raw
		writeTestString(t, w, `{}`)
	}))
	t.Cleanup(srv.Close)
	return srv
}

func gunzipTest(t *testing.T, raw []byte) string {
	t.Helper()
	zr, err := gzip.NewReader(bytes.NewReader(raw))
	if err != nil {
		t.Fatalf("body is not gzip: %v", err)
	}
	out, err := io.ReadAll(zr)
	if err != nil {
		t.Fatal(err)
	}
	return string(out)
}

func TestClientSendsGzipBodiesOnlyWhenServerAsks(t *testing.T) {
	for _, mode := range []int{discoveryAsksGzip, discoveryCanGzip, discoveryNone} {
		advertise := mode == discoveryAsksGzip
		got, bodies := make(chan *http.Request, 4), make(chan []byte, 4)
		srv := gzipTestServer(t, mode, got, bodies)
		c := &Client{Base: srv.URL, HTTP: apiHTTPClient}

		if _, err := c.doJSON(http.MethodPost, "/v1/things", map[string]string{"html": "<p>x</p>"}); err != nil {
			t.Fatal(err)
		}
		req, raw := <-got, <-bodies
		if req.Header.Get("Content-Type") != "application/json" {
			t.Fatalf("Content-Type = %q", req.Header.Get("Content-Type"))
		}
		marshaled, err := json.Marshal(map[string]string{"html": "<p>x</p>"})
		if err != nil {
			t.Fatal(err)
		}
		wantJSON := string(marshaled)
		if advertise {
			if req.Header.Get("Content-Encoding") != "gzip" || gunzipTest(t, raw) != wantJSON+"\n" && gunzipTest(t, raw) != wantJSON {
				t.Fatalf("gzip JSON request: encoding=%q body=%q", req.Header.Get("Content-Encoding"), raw)
			}
		} else if req.Header.Get("Content-Encoding") != "" || string(raw) != wantJSON {
			t.Fatalf("plain JSON request: encoding=%q body=%q", req.Header.Get("Content-Encoding"), raw)
		}

		if _, err := c.multipart("/v1/documents", map[string]string{"title": "T"}, "file", "d.html", []byte("<html>doc</html>")); err != nil {
			t.Fatal(err)
		}
		req, raw = <-got, <-bodies
		if !strings.HasPrefix(req.Header.Get("Content-Type"), "multipart/form-data; boundary=") {
			t.Fatalf("multipart Content-Type = %q", req.Header.Get("Content-Type"))
		}
		text := string(raw)
		if advertise {
			if req.Header.Get("Content-Encoding") != "gzip" {
				t.Fatalf("multipart Content-Encoding = %q", req.Header.Get("Content-Encoding"))
			}
			text = gunzipTest(t, raw)
		} else if req.Header.Get("Content-Encoding") != "" {
			t.Fatalf("plain multipart has Content-Encoding %q", req.Header.Get("Content-Encoding"))
		}
		if !strings.Contains(text, "<html>doc</html>") || !strings.Contains(text, `name="title"`) {
			t.Fatalf("multipart body = %q", text)
		}
	}
}

func TestClientResendsGzipBodyAfterRedirect(t *testing.T) {
	got, bodies := make(chan *http.Request, 4), make(chan []byte, 4)
	target := gzipTestServer(t, discoveryAsksGzip, got, bodies)
	old := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/.well-known/slashdocs.json" {
			writeTestString(t, w, `{"request_encodings":["gzip"],"compress_requests":true}`)
			return
		}
		http.Redirect(w, r, target.URL+r.URL.RequestURI(), http.StatusPermanentRedirect) //nolint:gosec // G710: test server.
	}))
	t.Cleanup(old.Close)
	c := &Client{Base: old.URL, HTTP: apiHTTPClient}
	if _, err := c.doJSON(http.MethodPost, "/v1/things", map[string]int{"a": 1}); err != nil {
		t.Fatal(err)
	}
	if req, raw := <-got, <-bodies; req.Header.Get("Content-Encoding") != "gzip" || strings.TrimSpace(gunzipTest(t, raw)) != `{"a":1}` {
		t.Fatalf("redirected request: encoding=%q body=%q", req.Header.Get("Content-Encoding"), raw)
	}
}

func TestServerFeaturesAreRefetchedWhenTheBaseChanges(t *testing.T) {
	discovery := func(compress bool, hits *int) *httptest.Server {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			*hits++
			writeTestString(t, w, fmt.Sprintf(`{"compress_requests": %t, "request_encodings": ["gzip"]}`, compress))
		}))
		t.Cleanup(srv.Close)
		return srv
	}
	var firstHits, secondHits int
	first, second := discovery(false, &firstHits), discovery(true, &secondHits)

	c := &Client{Base: first.URL, HTTP: http.DefaultClient}
	if a, b := c.compressesBodies(), c.compressesBodies(); a || b {
		t.Fatal("first server asked for gzip")
	}
	if firstHits != 1 {
		t.Fatalf("first server discovery hits = %d, want 1", firstHits)
	}
	c.Base = second.URL
	if a, b := c.compressesBodies(), c.compressesBodies(); !a || !b {
		t.Fatal("features were not refetched for the new base")
	}
	if secondHits != 1 {
		t.Fatalf("second server discovery hits = %d, want 1", secondHits)
	}
}

// gzipLeakMarkers are strings a body-scanning firewall would match; none may appear in the wire bytes of these bodies.
var gzipLeakMarkers = []string{"<script>alert(1)</script>", "alert(1)", "cat /etc/passwd"}

// base64Text returns n bytes of base64-looking text with the markers in the middle.
func base64Text(rng *rand.Rand, n int) string {
	mid := " " + gzipLeakMarkers[0] + " " + gzipLeakMarkers[2] + " "
	fill := func(k int) string {
		raw := make([]byte, k)
		_, _ = rng.Read(raw)
		return base64.StdEncoding.EncodeToString(raw)[:k]
	}
	left := (n - len(mid)) / 2
	return fill(left) + mid + fill(n-len(mid)-left)
}

func TestClientGzipHidesMarkersInTypicalBodies(t *testing.T) {
	rng := rand.New(rand.NewSource(7)) //nolint:gosec // G404: fixed seed keeps the test data reproducible.
	mid := gzipLeakMarkers[0] + " " + gzipLeakMarkers[2]
	cases := map[string]string{
		"ascii-10":   `{"a":"b"}`,
		"ascii-60":   `{"body":"` + gzipLeakMarkers[2] + `"}`,
		"ascii-200":  `{"body":"reply: ` + mid + strings.Repeat(" ok", 40) + `"}`,
		"utf8-hindi": "नमस्ते दोस्त, यह एक टिप्पणी है 😀🎉 " + mid + " धन्यवाद 🙏",
		"b64-50":     base64Text(rng, 50),
		"b64-4k":     base64Text(rng, 4<<10),
		"b64-64k":    base64Text(rng, 64<<10),
		"html-300k": "<html><body><img src=\"data:image/png;base64," + base64Text(rng, 300<<10) +
			"\"></body></html><script>alert(1)</script> cat /etc/passwd",
	}
	for name, text := range cases {
		t.Run(name, func(t *testing.T) {
			got, bodies := make(chan *http.Request, 2), make(chan []byte, 2)
			srv := gzipTestServer(t, discoveryAsksGzip, got, bodies)
			c := &Client{Base: srv.URL, HTTP: apiHTTPClient}

			check := func(kind string, req *http.Request, raw []byte, want func(plain string) bool) {
				t.Helper()
				if req.Header.Get("Content-Encoding") != "gzip" {
					t.Fatalf("%s: Content-Encoding = %q", kind, req.Header.Get("Content-Encoding"))
				}
				for _, m := range gzipLeakMarkers {
					if bytes.Contains(raw, []byte(m)) {
						t.Fatalf("%s: wire bytes contain %q", kind, m)
					}
				}
				if !want(gunzipTest(t, raw)) {
					t.Fatalf("%s: body does not decompress to the original", kind)
				}
			}

			if _, err := c.doJSON(http.MethodPost, "/v1/comments", map[string]string{"body": text}); err != nil {
				t.Fatal(err)
			}
			req, raw := <-got, <-bodies
			check("json", req, raw, func(plain string) bool {
				var back map[string]string
				return json.Unmarshal([]byte(plain), &back) == nil && back["body"] == text
			})

			if _, err := c.multipart("/v1/documents", map[string]string{"title": "T"}, "file", "d.html", []byte(text)); err != nil {
				t.Fatal(err)
			}
			req, raw = <-got, <-bodies
			check("multipart", req, raw, func(plain string) bool { return strings.Contains(plain, text) })
		})
	}
}

func TestDoResponseGzipsBodiesWhenServerAsks(t *testing.T) {
	got, bodies := make(chan *http.Request, 1), make(chan []byte, 1)
	srv := gzipTestServer(t, discoveryAsksGzip, got, bodies)
	c := &Client{Base: srv.URL, HTTP: apiHTTPClient}

	if _, _, err := c.doResponse(http.MethodPost, "/v1/things", strings.NewReader(`{"html":"<script>alert(1)</script>"}`), "application/json"); err != nil {
		t.Fatal(err)
	}
	req, raw := <-got, <-bodies
	if req.Header.Get("Content-Encoding") != "gzip" || gunzipTest(t, raw) != `{"html":"<script>alert(1)</script>"}` {
		t.Fatalf("encoding=%q body=%q", req.Header.Get("Content-Encoding"), raw)
	}
}

// A server whose setting was switched off after the CLI read discovery refuses
// gzip bodies with 415; the CLI sends the body again plain and stops
// compressing.
func TestClientSendsPlainAfterTheServerRefusesGzip(t *testing.T) {
	var encodings []string
	var bodies []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/.well-known/slashdocs.json" {
			writeTestString(t, w, `{"request_encodings":["gzip"],"compress_requests":true}`)
			return
		}
		raw, _ := io.ReadAll(r.Body)
		encodings = append(encodings, r.Header.Get("Content-Encoding"))
		if r.Header.Get("Content-Encoding") != "" {
			w.WriteHeader(http.StatusUnsupportedMediaType)
			writeTestString(t, w, `{"error":{"code":"unsupported_encoding","message":"unsupported content encoding"}}`)
			return
		}
		bodies = append(bodies, string(raw))
		writeTestString(t, w, `{}`)
	}))
	t.Cleanup(srv.Close)
	c := &Client{Base: srv.URL, HTTP: apiHTTPClient}

	if _, err := c.doJSON(http.MethodPost, "/v1/things", map[string]int{"a": 1}); err != nil {
		t.Fatal(err)
	}
	if _, err := c.doJSON(http.MethodPost, "/v1/things", map[string]int{"a": 2}); err != nil {
		t.Fatal(err)
	}
	if want := []string{"gzip", "", ""}; !slices.Equal(encodings, want) {
		t.Fatalf("encodings = %q, want %q", encodings, want)
	}
	if strings.TrimSpace(bodies[0]) != `{"a":1}` {
		t.Fatalf("resent body = %q", bodies[0])
	}

	encodings, bodies = nil, nil
	c = &Client{Base: srv.URL, HTTP: apiHTTPClient}
	if _, err := c.multipart("/v1/documents", map[string]string{"title": "T"}, "file", "t.html", []byte("<p>x</p>")); err != nil {
		t.Fatal(err)
	}
	if want := []string{"gzip", ""}; !slices.Equal(encodings, want) {
		t.Fatalf("upload encodings = %q, want %q", encodings, want)
	}
	if !strings.Contains(bodies[0], "<p>x</p>") {
		t.Fatalf("resent upload = %q", bodies[0])
	}
}

// A 415 for a wrong Content-Type is not about compression: the CLI does not
// resend the body and keeps compressing.
func TestClientKeepsCompressingAfterAMediaType415(t *testing.T) {
	var encodings []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/.well-known/slashdocs.json" {
			writeTestString(t, w, `{"request_encodings":["gzip"],"compress_requests":true}`)
			return
		}
		encodings = append(encodings, r.Header.Get("Content-Encoding"))
		w.WriteHeader(http.StatusUnsupportedMediaType)
		writeTestString(t, w, `{"error":{"code":"unsupported_media_type","message":"content-type must be application/json"}}`)
	}))
	t.Cleanup(srv.Close)
	c := &Client{Base: srv.URL, HTTP: apiHTTPClient}

	for range 2 {
		if _, err := c.doJSON(http.MethodPost, "/v1/things", map[string]int{"a": 1}); err == nil {
			t.Fatal("expected the 415 to be returned")
		}
	}
	if want := []string{"gzip", "gzip"}; !slices.Equal(encodings, want) {
		t.Fatalf("encodings = %q, want %q", encodings, want)
	}
}
