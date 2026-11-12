package server

import (
	"mime"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
	"golang.org/x/net/idna"

	"github.com/razorpay/slashdocs/api/internal/repo"
)

var roleRank = map[repo.Role]int{repo.RoleViewer: 1, repo.RoleCommenter: 2, repo.RoleEditor: 3, repo.RoleOwner: 4}

var httpHostnameIDNA = idna.New(idna.MapForLookup(), idna.StrictDomainName(false))

func atLeast(have repo.Role, need repo.Role) bool {
	return roleRank[have] >= roleRank[need]
}

func safeWebRedirect(redirect string) bool {
	if redirect == "" {
		return true
	}
	if strings.Contains(redirect, "\\") {
		return false
	}
	u, err := url.Parse(redirect)
	if err != nil || u.Scheme != "" || u.Host != "" || strings.Contains(u.Path, "\\") {
		return false
	}
	return strings.HasPrefix(u.EscapedPath(), "/") && !strings.HasPrefix(u.EscapedPath(), "//")
}

func validGrantRole(role repo.Role) bool {
	return role == repo.RoleViewer || role == repo.RoleCommenter || role == repo.RoleEditor
}

// ParseDefaultDocPermission maps the default-sharing vocabulary
// (viewer | commenter | editor | private) to a repo.Role. "private" is
// repo.RoleNone: no grant is applied. Callers own the unset/absent case and
// their own error wording; the second return is false for anything else.
func ParseDefaultDocPermission(value string) (repo.Role, bool) {
	switch role := repo.Role(value); role {
	case "private":
		return repo.RoleNone, true
	case repo.RoleViewer, repo.RoleCommenter, repo.RoleEditor:
		return role, true
	default:
		return repo.RoleNone, false
	}
}

func requireJSON(c *gin.Context) bool {
	mediaType, _, err := mime.ParseMediaType(c.GetHeader("Content-Type"))
	if err != nil || !strings.EqualFold(mediaType, "application/json") {
		c.JSON(http.StatusUnsupportedMediaType, errorResponse("unsupported_media_type", "content-type must be application/json", nil))
		return false
	}
	return true
}

func requireCommentJSON(c *gin.Context) bool {
	mediaType, _, err := mime.ParseMediaType(c.GetHeader("Content-Type"))
	if err == nil && (strings.EqualFold(mediaType, "application/json") || isCommentMentionsMediaType(mediaType)) {
		return true
	}
	c.JSON(http.StatusUnsupportedMediaType, errorResponse("unsupported_media_type", "content-type must be application/json or "+commentMentionsMediaType, nil))
	return false
}

func requireStructuredCommentMediaType(c *gin.Context) bool {
	mediaType, _, err := mime.ParseMediaType(c.GetHeader("Content-Type"))
	if err == nil && isCommentMentionsMediaType(mediaType) {
		return true
	}
	c.JSON(http.StatusUnsupportedMediaType, errorResponse("unsupported_media_type", "structured comment mentions require content-type "+commentMentionsMediaType, nil))
	return false
}

func isCommentMentionsMediaType(mediaType string) bool {
	return strings.EqualFold(mediaType, commentMentionsMediaType) || strings.EqualFold(mediaType, legacyCommentMentionsMediaType)
}

func requestHasBody(c *gin.Context) bool {
	r := c.Request
	return r.Body != nil && r.Body != http.NoBody && (r.ContentLength != 0 || len(r.TransferEncoding) > 0)
}

func hostMatchesOrigin(host, origin string) bool {
	u, err := url.Parse(origin)
	if err != nil || u.Host == "" || host == "" || strings.ContainsAny(host, "/\\ \t\r\n@") {
		return false
	}
	return sameHTTPOrigin(u.Scheme+"://"+host, origin)
}

func canonicalHTTPOrigin(origin string) (string, bool) {
	u, err := url.Parse(origin)
	if err != nil || u.Host == "" || u.User != nil {
		return "", false
	}

	scheme := strings.ToLower(u.Scheme)
	if scheme != "http" && scheme != "https" {
		return "", false
	}
	hostname, ok := canonicalHTTPHostname(u.Hostname())
	if !ok {
		return "", false
	}
	port, ok := canonicalHTTPPort(u.Port())
	if !ok {
		return "", false
	}
	if port == defaultHTTPPort(scheme) {
		port = ""
	}
	if port != "" {
		return scheme + "://" + net.JoinHostPort(hostname, port), true
	}
	if strings.Contains(hostname, ":") {
		hostname = "[" + hostname + "]"
	}
	return scheme + "://" + hostname, true
}

func canonicalHTTPHostname(hostname string) (string, bool) {
	if address, err := netip.ParseAddr(hostname); err == nil {
		return address.String(), true
	}
	ascii, err := httpHostnameIDNA.ToASCII(hostname)
	ascii = strings.TrimSuffix(ascii, ".")
	if err != nil || ascii == "" {
		return "", false
	}
	// The URL Standard parses a domain that ends in a numeric label as an
	// IPv4 address, accepting legacy forms such as 127.1 and 0x7f000001.
	// netip deliberately rejects those forms. Reject them here too instead of
	// comparing a spelling that browsers will silently normalize to another
	// origin (for example, 127.1 becomes 127.0.0.1).
	if hostEndsInNumber(ascii) {
		return "", false
	}
	return strings.ToLower(ascii), true
}

func hostEndsInNumber(hostname string) bool {
	hostname = strings.TrimSuffix(hostname, ".")
	last := hostname
	if dot := strings.LastIndexByte(hostname, '.'); dot >= 0 {
		last = hostname[dot+1:]
	}
	if len(last) >= 2 && strings.EqualFold(last[:2], "0x") {
		for _, char := range last[2:] {
			if !strings.ContainsRune("0123456789abcdefABCDEF", char) {
				return false
			}
		}
		return true
	}
	if last == "" {
		return false
	}
	for _, char := range last {
		if char < '0' || char > '9' {
			return false
		}
	}
	return true
}

func canonicalHTTPPort(port string) (string, bool) {
	if port == "" {
		return "", true
	}
	number, err := strconv.ParseUint(port, 10, 16)
	if err != nil {
		return "", false
	}
	return strconv.FormatUint(number, 10), true
}

func sameHTTPOrigin(a, b string) bool {
	ca, okA := canonicalHTTPOrigin(a)
	cb, okB := canonicalHTTPOrigin(b)
	return okA && okB && ca == cb
}

func defaultHTTPPort(scheme string) string {
	if scheme == "http" {
		return "80"
	}
	return "443"
}

func sanitizeHost(host string) string {
	if host == "" || strings.ContainsAny(host, "/\\ \t\r\n@") {
		return "localhost"
	}
	return host
}

func isLocalHost(host string) bool {
	host = strings.ToLower(sanitizeHost(host))
	return host == "localhost" || strings.HasPrefix(host, "localhost:") || host == "127.0.0.1" || strings.HasPrefix(host, "127.0.0.1:") || host == "[::1]" || strings.HasPrefix(host, "[::1]:")
}

func emailDomainAllowed(email string, allowed []string) bool {
	if len(allowed) == 0 {
		return true
	}
	at := strings.LastIndex(email, "@")
	if at < 0 || at == len(email)-1 {
		return false
	}
	domain := strings.ToLower(email[at+1:])
	for _, d := range allowed {
		if strings.EqualFold(domain, strings.TrimSpace(d)) {
			return true
		}
	}
	return false
}
