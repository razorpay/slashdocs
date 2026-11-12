package server

import (
	"errors"
	"fmt"
	"net/url"
	"strings"

	"github.com/razorpay/slashdocs/internal/render"
)

// ErrUnsafeRenderOrigin marks the one render-origin validation failure that
// the explicit local-development escape hatch may override. Invalid origins
// must remain fatal even when that escape hatch is set.
var ErrUnsafeRenderOrigin = errors.New("app and render origins are not isolated by hostname")

// ValidateRenderOrigin refuses an app/render origin pair that shares a
// hostname. Uploaded HTML is untrusted; scheme and port do not isolate
// host-scoped cookies, so rendering it on the app host lets a
// malicious document script against the app itself (session cookies, API
// calls). Startup code may downgrade this error to a loud warning when
// SLASHDOCS_ALLOW_UNSAFE_RENDER_ORIGIN=true opts into the risk (dev/demo only).
func ValidateRenderOrigin(appOrigin, renderOrigin string) error {
	appCanonical, appOK := canonicalHTTPOrigin(appOrigin)
	if !appOK {
		return fmt.Errorf("SLASHDOCS_APP_ORIGIN (%q) is not a valid HTTP origin", appOrigin)
	}
	renderCanonical, renderOK := canonicalHTTPOrigin(renderOrigin)
	if !renderOK {
		return fmt.Errorf("SLASHDOCS_RENDER_ORIGIN (%q) is not a valid HTTP origin", renderOrigin)
	}
	appURL, _ := url.Parse(appCanonical)
	renderURL, _ := url.Parse(renderCanonical)
	appHostname := strings.TrimSuffix(appURL.Hostname(), ".")
	renderHostname := strings.TrimSuffix(renderURL.Hostname(), ".")
	if appHostname != renderHostname {
		return nil
	}
	return fmt.Errorf("%w: SLASHDOCS_RENDER_ORIGIN (%q) must use a different hostname from SLASHDOCS_APP_ORIGIN: the server routes renders by Host, so a scheme or port difference alone cannot isolate untrusted document HTML. Serve renders from a separate hostname, or set SLASHDOCS_ALLOW_UNSAFE_RENDER_ORIGIN=true to accept this risk in non-production setups", ErrUnsafeRenderOrigin, renderOrigin)
}

// BuildBridgeSourceHash is the bridge source fingerprint, linked at build
// time.
var BuildBridgeSourceHash string

// ValidateEmbeddedBridge rejects production startup when the generated iframe
// bridge is absent, stale, or corrupt. Supported server builds link
// BuildBridgeSourceHash from a fingerprint covering every TypeScript source
// under frontend/bridge/, so a change to any bridge module invalidates an
// outdated bundle.
func ValidateEmbeddedBridge() error {
	return render.ValidateBridge(BuildBridgeSourceHash)
}

func printableHTML(userHTML []byte) []byte {
	const printBootstrap = `<style id="slashdocs-print-style">[data-slashdocs-comment-id],.slashdocs-comment-highlight{background:transparent!important;box-shadow:none!important}@media print{html,body{overflow:visible!important;height:auto!important}}</style><script id="slashdocs-print-bootstrap">addEventListener("load",function(){setTimeout(function(){window.print()},150)},{once:true});</script>`
	s := string(userHTML)
	lower := strings.ToLower(s)
	if idx := strings.LastIndex(lower, "</body>"); idx >= 0 {
		return []byte(s[:idx] + printBootstrap + s[idx:])
	}
	return []byte(s + printBootstrap)
}
