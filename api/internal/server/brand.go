package server

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"html"
	"io"
	"net/http"
	"regexp"
	"strings"

	"github.com/gin-gonic/gin"
)

// DefaultProductName is the product name a deployment shows without a brand.
const DefaultProductName = "slashdocs"

// maxBrandSVGBytes bounds a brand logo or favicon. A wordmark or icon is a few
// kilobytes; the limit only stops an operator from shipping a raster in an SVG.
const maxBrandSVGBytes = 256 << 10

var brandAccentPattern = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)

// BrandSettings is the raw operator configuration for a deployment's brand.
// Every field is optional; an empty BrandSettings keeps the slashdocs look.
type BrandSettings struct {
	// Name replaces "slashdocs" as the product name in the page title, link
	// previews, the MCP server name and the MCP install buttons.
	Name string
	// Logo is an SVG that replaces the header wordmark. LogoDark is the same
	// logo for the dark theme; without it, Logo is used in both themes.
	Logo, LogoDark []byte
	// Favicon is an SVG for the browser tab. Without it, Logo is used.
	Favicon []byte
	// AccentColor is a #rrggbb color for buttons, links and focus rings.
	AccentColor string
}

// Brand is a validated BrandSettings, ready to serve.
type Brand struct {
	name        string
	accentColor string
	assets      map[string]brandAsset
}

type brandAsset struct {
	body    []byte
	version string
}

const (
	brandLogoPath     = "logo.svg"
	brandLogoDarkPath = "logo-dark.svg"
	brandFaviconPath  = "favicon.svg"
)

// ParseBrand validates settings. Each SVG must be a well-formed SVG document
// without a DOCTYPE and at most 256 KiB, so a misconfigured file stops the
// server at boot rather than showing a broken header.
func ParseBrand(settings BrandSettings) (Brand, error) {
	b := Brand{name: strings.TrimSpace(settings.Name), assets: map[string]brandAsset{}}
	if strings.ContainsAny(b.name, "\r\n") || len(b.name) > 80 {
		return Brand{}, errors.New("brand name must be one line of at most 80 bytes")
	}
	if settings.AccentColor != "" {
		if !brandAccentPattern.MatchString(settings.AccentColor) {
			return Brand{}, fmt.Errorf("brand accent color must look like #rrggbb (got %q)", settings.AccentColor)
		}
		b.accentColor = strings.ToLower(settings.AccentColor)
	}
	for _, file := range []struct {
		path, label string
		body        []byte
	}{
		{brandLogoPath, "logo", settings.Logo},
		{brandLogoDarkPath, "dark logo", settings.LogoDark},
		{brandFaviconPath, "favicon", settings.Favicon},
	} {
		if file.body == nil {
			continue
		}
		if err := validateBrandSVG(file.body); err != nil {
			return Brand{}, fmt.Errorf("brand %s: %w", file.label, err)
		}
		sum := sha256.Sum256(file.body)
		b.assets[file.path] = brandAsset{body: file.body, version: hex.EncodeToString(sum[:6])}
	}
	if _, ok := b.assets[brandLogoDarkPath]; ok {
		if _, ok := b.assets[brandLogoPath]; !ok {
			return Brand{}, errors.New("brand dark logo needs a logo")
		}
	}
	return b, nil
}

func validateBrandSVG(body []byte) error {
	if len(body) == 0 {
		return errors.New("file is empty")
	}
	if len(body) > maxBrandSVGBytes {
		return fmt.Errorf("file is %d bytes, more than %d", len(body), maxBrandSVGBytes)
	}
	decoder := xml.NewDecoder(bytes.NewReader(body))
	for {
		token, err := decoder.Token()
		if err == io.EOF {
			return errors.New("file has no <svg> element")
		}
		if err != nil {
			return fmt.Errorf("file is not well-formed XML: %w", err)
		}
		switch t := token.(type) {
		case xml.Directive:
			return errors.New("file must not contain a DOCTYPE or other directive")
		case xml.StartElement:
			if t.Name.Local != "svg" {
				return fmt.Errorf("root element is <%s>, want <svg>", t.Name.Local)
			}
			return nil
		}
	}
}

// ProductName is the brand name, or "slashdocs" without one.
func (b Brand) ProductName() string {
	if b.name == "" {
		return DefaultProductName
	}
	return b.name
}

// isBranded reports whether any brand setting differs from the slashdocs look.
func (b Brand) isBranded() bool {
	return b.name != "" || b.accentColor != "" || len(b.assets) > 0
}

func (b Brand) assetURL(path string) string {
	asset, ok := b.assets[path]
	if !ok {
		return ""
	}
	return "/brand/" + path + "?v=" + asset.version
}

// shellFragment is injected before </head> of the web app shell. It carries
// the brand to the frontend and sets the accent color before the first paint.
func (b Brand) shellFragment() []byte {
	var out bytes.Buffer
	config := map[string]string{"name": b.ProductName()}
	if logo := b.assetURL(brandLogoPath); logo != "" {
		config["logo"] = logo
	}
	if logoDark := b.assetURL(brandLogoDarkPath); logoDark != "" {
		config["logoDark"] = logoDark
	}
	// json.Marshal escapes <, > and &, so the value cannot close the script.
	encoded, err := json.Marshal(config)
	if err != nil {
		panic(err) // unreachable: a map of strings always encodes
	}
	out.WriteString("<script>window.__SLASHDOCS_BRAND__ = ")
	out.Write(encoded)
	out.WriteString(";</script>\n")
	if c := b.accentColor; c != "" {
		// The color is validated as #rrggbb, so it is safe in CSS. The darker and
		// muted shades follow from it, for the light and the dark theme.
		fmt.Fprintf(&out, "<style>:root{--color-accent:%[1]s;--color-accent-strong:color-mix(in oklab,%[1]s 82%%,black);"+
			"--color-accent-muted:color-mix(in oklab,%[1]s 12%%,white)}"+
			".dark{--color-accent:%[1]s;--color-accent-strong:color-mix(in oklab,%[1]s 82%%,black);"+
			"--color-accent-muted:color-mix(in oklab,%[1]s 24%%,#131415)}</style>\n", c)
	}
	return out.Bytes()
}

// applyToShell puts the brand into the web app shell: the generic title, the
// favicon and the fragment before </head>. Without a brand it returns index
// unchanged.
func (b Brand) applyToShell(index []byte) []byte {
	if !b.isBranded() {
		return index
	}
	index = bytes.Replace(index, []byte(shellTitle), []byte("<title>"+html.EscapeString(b.ProductName())+"</title>"), 1)
	favicon := b.assetURL(brandFaviconPath)
	if favicon == "" {
		favicon = b.assetURL(brandLogoPath)
	}
	if favicon != "" {
		index = bytes.Replace(index, []byte(`href="/favicon.svg"`), []byte(`href="`+favicon+`"`), 1)
	}
	return bytes.Replace(index, []byte("</head>"), append(b.shellFragment(), "</head>"...), 1)
}

// serveBrandAsset serves a brand SVG. The SVG is untrusted markup, so the
// response is sandboxed: a script inside it cannot run, even when the file is
// opened directly.
func (b Brand) serveBrandAsset(c *gin.Context) {
	asset, ok := b.assets[strings.TrimPrefix(c.Param("file"), "/")]
	if !ok {
		c.Status(http.StatusNotFound)
		return
	}
	c.Header("Content-Security-Policy", "sandbox; default-src 'none'; style-src 'unsafe-inline'")
	c.Header("X-Content-Type-Options", "nosniff")
	c.Header("Cache-Control", "public, max-age=86400")
	c.Data(http.StatusOK, "image/svg+xml", asset.body)
}
