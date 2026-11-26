package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

const (
	testBrandLogo    = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 2"><path d="M0 0h10v2H0z"/></svg>`
	testBrandShell   = `<!doctype html><html><head><link rel="icon" type="image/svg+xml" href="/favicon.svg" /><title>slashdocs</title></head><body></body></html>`
	testBrandAccent  = "#C94A00"
	testBrandProduct = `Acme <Artifacts>`
)

func mustParseBrand(t *testing.T, settings BrandSettings) Brand {
	t.Helper()
	b, err := ParseBrand(settings)
	if err != nil {
		t.Fatalf("ParseBrand: %v", err)
	}
	return b
}

func TestParseBrandRejectsInvalidSettings(t *testing.T) {
	for _, tc := range []struct {
		name     string
		settings BrandSettings
		want     string
	}{
		{"accent is not #rrggbb", BrandSettings{AccentColor: "orange"}, "accent color"},
		{"accent is CSS injection", BrandSettings{AccentColor: "#fff;}body{display:none"}, "accent color"},
		{"name spans lines", BrandSettings{Name: "a\nb"}, "one line"},
		{"logo is not XML", BrandSettings{Logo: []byte("PNG\x00")}, "not well-formed"},
		{"logo is HTML", BrandSettings{Logo: []byte(`<html><body/></html>`)}, "want <svg>"},
		{"logo has a DOCTYPE", BrandSettings{Logo: []byte(`<!DOCTYPE svg [<!ENTITY x "y">]><svg/>`)}, "DOCTYPE"},
		{"logo is too large", BrandSettings{Logo: []byte("<svg>" + strings.Repeat(" ", maxBrandSVGBytes) + "</svg>")}, "more than"},
		{"dark logo without logo", BrandSettings{LogoDark: []byte(testBrandLogo)}, "needs a logo"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := ParseBrand(tc.settings)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("err = %v, want one containing %q", err, tc.want)
			}
		})
	}
}

func TestBrandLeavesShellUnchangedWithoutSettings(t *testing.T) {
	b := mustParseBrand(t, BrandSettings{})
	if got := string(b.applyToShell([]byte(testBrandShell))); got != testBrandShell {
		t.Fatalf("shell changed without a brand:\n%s", got)
	}
	if b.ProductName() != "slashdocs" {
		t.Fatalf("ProductName = %q, want slashdocs", b.ProductName())
	}
}

func TestBrandAppliesNameLogoFaviconAndAccentToShell(t *testing.T) {
	b := mustParseBrand(t, BrandSettings{
		Name:        testBrandProduct,
		Logo:        []byte(testBrandLogo),
		LogoDark:    []byte(testBrandLogo),
		AccentColor: testBrandAccent,
	})
	got := string(b.applyToShell([]byte(testBrandShell)))
	logoURL := b.assetURL(brandLogoPath)
	for _, want := range []string{
		"<title>Acme &lt;Artifacts&gt;</title>",
		// Without a favicon the logo stands in for it.
		`href="` + logoURL + `"`,
		// json.Marshal escapes < and >, so the name cannot close the script.
		`"name":"Acme \u003cArtifacts\u003e"`,
		`"logo":"` + logoURL + `"`,
		`"logoDark":"/brand/logo-dark.svg?v=`,
		"--color-accent:#c94a00",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("shell lacks %q:\n%s", want, got)
		}
	}
	if strings.Contains(got, `href="/favicon.svg"`) {
		t.Errorf("shell still links the slashdocs favicon:\n%s", got)
	}
}

func TestBrandFaviconTakesPrecedenceOverLogo(t *testing.T) {
	favicon := `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>`
	b := mustParseBrand(t, BrandSettings{Logo: []byte(testBrandLogo), Favicon: []byte(favicon)})
	got := string(b.applyToShell([]byte(testBrandShell)))
	if want := `href="` + b.assetURL(brandFaviconPath) + `"`; !strings.Contains(got, want) {
		t.Fatalf("shell lacks %q:\n%s", want, got)
	}
}

func TestServeBrandAssetIsSandboxedSVG(t *testing.T) {
	b := mustParseBrand(t, BrandSettings{Logo: []byte(testBrandLogo)})
	r := gin.New()
	r.GET("/brand/*file", b.serveBrandAsset)

	rr := httptest.NewRecorder()
	r.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/brand/logo.svg?v=x", nil))
	if rr.Code != http.StatusOK || rr.Body.String() != testBrandLogo {
		t.Fatalf("status = %d, body = %q", rr.Code, rr.Body.String())
	}
	for header, want := range map[string]string{
		"Content-Type":           "image/svg+xml",
		"X-Content-Type-Options": "nosniff",
	} {
		if got := rr.Header().Get(header); got != want {
			t.Errorf("%s = %q, want %q", header, got, want)
		}
	}
	if csp := rr.Header().Get("Content-Security-Policy"); !strings.HasPrefix(csp, "sandbox;") {
		t.Errorf("Content-Security-Policy = %q, want a sandbox", csp)
	}

	for _, path := range []string{"/brand/logo-dark.svg", "/brand/favicon.svg", "/brand/../index.html"} {
		rr := httptest.NewRecorder()
		r.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, path, nil))
		if rr.Code != http.StatusNotFound {
			t.Errorf("%s: status = %d, want 404", path, rr.Code)
		}
	}
}

func TestMCPServerInstructionsNameTheBrand(t *testing.T) {
	if got := mcpServerInstructions(Brand{}); got != mcpInstructions {
		t.Errorf("unbranded instructions changed: %q", got)
	}
	b := mustParseBrand(t, BrandSettings{Name: "Acme Artifacts"})
	if got := mcpServerInstructions(b); !strings.HasPrefix(got, "Acme Artifacts is this organization's name for its slashdocs server") {
		t.Errorf("branded instructions = %q", got)
	}
}
