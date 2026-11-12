// Package render wraps untrusted document HTML in the page that hosts it for
// the slashdocs app: a sandboxed iframe and the bridge that connects the
// document to comments, the theme, and document KV. The server and
// `slashdocs local` use it.
package render

import (
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"html/template"
	"strings"
)

// bridgeFS embeds a tracked placeholder so plain Go builds remain valid before
// the frontend toolchain generates bridge_dist/bridge.js.
//
//go:embed all:bridge_dist
var bridgeFS embed.FS

func readEmbeddedBridgeAsset(name string) string {
	source, err := bridgeFS.ReadFile("bridge_dist/" + name)
	if err != nil {
		return ""
	}
	return string(source)
}

var (
	bridgeJSSource         = readEmbeddedBridgeAsset("bridge.js")
	bridgeSourceHash       = strings.TrimSpace(readEmbeddedBridgeAsset("bridge.source.sha256"))
	bridgeBundleHash       = strings.TrimSpace(readEmbeddedBridgeAsset("bridge.sha256"))
	errMissingBridgeBundle = errors.New("sandbox bridge bundle is missing; run `make frontend` before building the server")
	errMissingBridgeHash   = errors.New("sandbox bridge integrity metadata is missing or invalid; run `make frontend` before building the server")
	errUnlinkedBridgeBuild = errors.New("sandbox bridge source fingerprint is missing from the binary; build the server with `make backend`")
	errStaleBridgeBundle   = errors.New("sandbox bridge bundle is stale; run `make frontend` and rebuild the server")
	errCorruptBridgeBundle = errors.New("sandbox bridge bundle failed its integrity check; run `make frontend` and rebuild the server")
)

// ValidateBridge rejects an embedded bridge that is absent, stale, or
// corrupt. sourceHash is the fingerprint of every TypeScript source under
// frontend/bridge/ at build time, so a change to any bridge module
// invalidates an outdated bundle.
func ValidateBridge(sourceHash string) error {
	return validateEmbeddedBridgeSource(bridgeJSSource, bridgeSourceHash, bridgeBundleHash, sourceHash)
}

func validateEmbeddedBridgeSource(source, generatedSourceHash, generatedBundleHash, expectedSourceHash string) error {
	if strings.TrimSpace(source) == "" {
		return errMissingBridgeBundle
	}
	if !validSHA256(generatedSourceHash) || !validSHA256(generatedBundleHash) {
		return errMissingBridgeHash
	}
	if !validSHA256(expectedSourceHash) {
		return errUnlinkedBridgeBuild
	}
	if !strings.EqualFold(generatedSourceHash, expectedSourceHash) {
		return fmt.Errorf("%w: generated from %s, building from %s", errStaleBridgeBundle, generatedSourceHash, expectedSourceHash)
	}
	sum := sha256.Sum256([]byte(source))
	if !strings.EqualFold(generatedBundleHash, hex.EncodeToString(sum[:])) {
		return errCorruptBridgeBundle
	}
	return nil
}

func validSHA256(value string) bool {
	if len(value) != sha256.Size*2 {
		return false
	}
	_, err := hex.DecodeString(value)
	return err == nil
}

// wrapperTmpl renders the sandboxed iframe that hosts untrusted user HTML.
// Using html/template ensures the srcdoc attribute value is correctly escaped
// (including </script> sequences inside inline scripts).
var wrapperTmpl = template.Must(template.New("wrapper").Parse(`<!doctype html><html><head><meta charset="utf-8"><title>slashdocs render</title><style>html,body{margin:0;height:100%;overflow:hidden}#slashdocs-doc{border:0;width:100%;height:100vh}</style><script>try{var u=new URL(location.href);if(u.searchParams.has("token")){u.searchParams.delete("token");history.replaceState(null,"",u.pathname+(u.search||"")+u.hash)}}catch(e){}</script></head><body><iframe id="slashdocs-doc" sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox" srcdoc="{{.SrcDoc}}"></iframe><script>window.__SLASHDOCS_APP_ORIGIN__={{.AppOriginJS}};{{.BridgeJS}}</script></body></html>`))

type wrapperData struct {
	// SrcDoc is the raw user HTML. html/template escapes it for the
	// double-quoted srcdoc attribute context (including </script> inside
	// inline scripts), so no manual escaping is needed.
	SrcDoc      string
	AppOriginJS template.JS
	BridgeJS    template.JS
}

// bridgePrelude queues document API calls until the bridge loads. Documents
// written before the rename call window.aidocs, so it is an alias.
const bridgePrelude = `<script id="slashdocs-bootstrap">(function(){if(window.slashdocs&&window.slashdocs.kv&&window.slashdocs.github&&window.slashdocs.github.connect)return;var q=[],gq=[],handlers={kvchange:[]};function enqueue(op,args){return new Promise(function(resolve,reject){q.push({op:op,args:Array.prototype.slice.call(args),resolve:resolve,reject:reject});});}function github(input){return new Promise(function(resolve,reject){gq.push({input:input,resolve:resolve,reject:reject});});}function githubConnect(){window.__slashdocsGitHubConnectQueued=true;}function off(event,handler){if(event!=="kvchange")return;handlers.kvchange=handlers.kvchange.filter(function(h){return h!==handler;});}function on(event,handler){if(event==="kvchange"&&typeof handler==="function"){handlers.kvchange.push(handler);return function(){off(event,handler);};}}window.__slashdocsKVQueue=q;window.__slashdocsGitHubQueue=gq;window.__slashdocsKVHandlers=handlers;window.slashdocs=window.aidocs=Object.assign(window.slashdocs||{},{kv:{get:function(){return enqueue("get",arguments);},all:function(){return enqueue("all",arguments);},set:function(){return enqueue("set",arguments);},delete:function(){return enqueue("delete",arguments);},patch:function(){return enqueue("patch",arguments);},undo:function(){return enqueue("undo",arguments);},redo:function(){return enqueue("redo",arguments);}},github:{getRawContent:github,connect:githubConnect},on:on,off:off});})();</script>`

func userHTMLWithBridgePrelude(userHTML []byte) string {
	s := string(userHTML)
	lower := strings.ToLower(s)
	for _, tag := range []string{"head", "html"} {
		if end := findStartTagEnd(lower, tag); end >= 0 {
			return s[:end+1] + bridgePrelude + s[end+1:]
		}
	}
	if idx := strings.Index(lower, "<!doctype"); idx >= 0 {
		if end := strings.IndexByte(lower[idx:], '>'); end >= 0 {
			insertAt := idx + end + 1
			return s[:insertAt] + bridgePrelude + s[insertAt:]
		}
	}
	return bridgePrelude + s
}

func findStartTagEnd(lowerHTML, tag string) int {
	needle := "<" + tag
	for offset := 0; offset < len(lowerHTML); {
		idx := strings.Index(lowerHTML[offset:], needle)
		if idx < 0 {
			return -1
		}
		idx += offset
		next := idx + len(needle)
		if next < len(lowerHTML) {
			switch lowerHTML[next] {
			case '>', '/', ' ', '\t', '\n', '\r', '\f':
			default:
				offset = next
				continue
			}
		}
		end := strings.IndexByte(lowerHTML[next:], '>')
		if end < 0 {
			return -1
		}
		return next + end
	}
	return -1
}

func appOriginScriptValue(appOrigin string) template.JS {
	originJSON, err := json.Marshal(appOrigin)
	if err != nil {
		panic(err) // encoding a string as JSON cannot fail
	}
	//nolint:gosec // G203: json.Marshal produces a quoted JS string literal with script-breaking characters escaped.
	return template.JS(originJSON)
}

func embeddedBridgeScript() template.JS {
	//nolint:gosec // G203: bridgeJSSource is a build-time embedded repository asset, never user-controlled input.
	return template.JS(bridgeJSSource)
}

// Wrap returns the full wrapper page that embeds userHTML inside a sandboxed
// iframe. The bridge sends its messages only to appOrigin.
func Wrap(userHTML []byte, appOrigin string) []byte {
	data := wrapperData{
		SrcDoc:      userHTMLWithBridgePrelude(userHTML),
		AppOriginJS: appOriginScriptValue(appOrigin),
		BridgeJS:    embeddedBridgeScript(),
	}
	var sb strings.Builder
	if err := wrapperTmpl.Execute(&sb, data); err != nil {
		// Fallback: should never happen with a valid template.
		return []byte("<!doctype html><html><body>render error</body></html>")
	}
	return []byte(sb.String())
}

// CSP is the Content-Security-Policy of a wrapper page. Documents can load
// any resource, but only appOrigin can frame them.
func CSP(appOrigin string) string {
	return "default-src 'none'; img-src * data: blob:; media-src * data: blob:; font-src * data: blob:; style-src * 'unsafe-inline'; script-src * 'unsafe-inline' 'unsafe-eval'; connect-src *; frame-src *; worker-src * blob:; object-src 'none'; frame-ancestors " + appOrigin
}
