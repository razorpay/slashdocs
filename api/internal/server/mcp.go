package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"mime"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/mark3labs/mcp-go/mcp"
	mcpserver "github.com/mark3labs/mcp-go/server"

	"github.com/razorpay/slashdocs/api/internal/auth"
)

// JSON string escaping can expand a valid HTML document by up to 6x
// before the MCP envelope reaches the server (for example, for control bytes
// or clients that escape HTML characters). Keep enough authenticated
// transport headroom to preserve parity with the REST and CLI HTML limit.
const maxMCPRequestBytes int64 = maxHTMLBytes*6 + (1 << 20)

type mcpPrincipalContextKey struct{}

// registerMCPRoutes mounts the remote, bearer-authenticated MCP endpoint. It is
// kept separate from routes so transport construction and its security policy
// can be tested independently.
func registerMCPRoutes(engine *gin.Engine, deps dependencies) {
	engine.Any("/mcp", gin.WrapH(newMCPHTTPHandler(deps)))
}

// authenticateMCPRequest resolves the caller for one transport request,
// writing the full error response itself when the request cannot proceed.
// A nil return means the response has been written.
func authenticateMCPRequest(w http.ResponseWriter, r *http.Request, authenticator auth.MCPAuthenticator, unauthorizedChallenge func(*http.Request) string, started time.Time) *auth.Principal {
	if auth.BearerFromHeader(r.Header.Get("Authorization")) == "" {
		observeMCPRequest("transport", "auth_error", time.Since(started))
		mcpUnauthorized(w, r, unauthorizedChallenge)
		return nil
	}
	principal, err := authenticator.Authenticate(r)
	if err != nil && !errors.Is(err, auth.ErrUnauthorized) {
		slog.ErrorContext(r.Context(), "MCP authentication failed", "error", err)
		observeMCPRequest("transport", "transport_error", time.Since(started))
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusInternalServerError)
		_ = json.NewEncoder(w).Encode(errorResponse("internal", "internal server error", nil))
		return nil
	}
	if err != nil || principal == nil {
		observeMCPRequest("transport", "auth_error", time.Since(started))
		mcpUnauthorized(w, r, unauthorizedChallenge)
		return nil
	}
	return principal
}

// mcpInstructions tells agents that links and names from before the rename
// refer to this server, so a pasted aidocs link resolves here.
const mcpInstructions = "slashdocs was formerly named aidocs. Treat an aidocs URL, document, or command as a slashdocs one. " +
	"A document link ends in its ID (doc_...), which is the same on both names. Call get_authoring_guidelines before you create or update a document."

func newMCPHTTPHandler(deps dependencies) http.Handler {
	metrics := newMCPMetricRecorder()
	protocol := mcpserver.NewMCPServer(
		"slashdocs",
		BuildVersion,
		mcpserver.WithToolCapabilities(false),
		mcpserver.WithToolHandlerMiddleware(metrics.toolMiddleware),
		mcpserver.WithRecovery(),
		mcpserver.WithHooks(metrics.hooks()),
		mcpserver.WithInstructions(mcpInstructions),
	)
	api := mcpAPIAdapter{handlers: handlers{deps: deps}}
	registerMCPTools(protocol, api)
	metrics.setKnownTools(protocol.ListTools())
	transport := mcpserver.NewStreamableHTTPServer(
		protocol,
		mcpserver.WithStateLess(true),
		mcpserver.WithDisableStreaming(true),
	)
	authenticator := auth.MCPAuthenticator{
		Users:         deps.repository,
		ServiceTokens: deps.authenticator,
		SessionSecret: deps.sessionSecret,
		Resource:      api.handlers.mcpResource(),
	}
	unauthorizedChallenge := func(*http.Request) string { return mcpWWWAuthenticate(deps.appOrigin) }

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		started := time.Now()
		if origin := strings.TrimSpace(r.Header.Get("Origin")); origin != "" &&
			(deps.appOrigin == "" || !sameHTTPOrigin(origin, deps.appOrigin)) {
			observeMCPRequest("transport", "origin_rejected", time.Since(started))
			http.Error(w, "cross-origin MCP requests are not allowed", http.StatusForbidden)
			return
		}
		principal := authenticateMCPRequest(w, r, authenticator, unauthorizedChallenge, started)
		if principal == nil {
			return
		}
		var requestBody *mcpRequestBody
		if r.Method == http.MethodPost {
			if message := mcpTransportHeaderError(r); message != "" {
				observeMCPRequest("transport", "bad_request", time.Since(started))
				http.Error(w, message, http.StatusBadRequest)
				return
			}
			if r.ContentLength > maxMCPRequestBytes {
				observeMCPRequest("transport", "payload_too_large", time.Since(started))
				http.Error(w, "MCP request body is too large", http.StatusRequestEntityTooLarge)
				return
			}
			if r.Body != nil {
				requestBody = newMCPRequestBody(r.Body, maxMCPRequestBytes)
				r.Body = requestBody
			}
		}

		observation := newMCPMetricObservation(started, string(principal.Type))
		ctx := context.WithValue(r.Context(), mcpPrincipalContextKey{}, *principal)
		ctx = context.WithValue(ctx, mcpMetricContextKey{}, observation)
		response := newMCPResponseWriter(w, requestBody)
		transport.ServeHTTP(response, r.WithContext(ctx))
		if requestBody != nil && requestBody.tooLarge {
			response.rejectTooLarge()
			observation.observeRequest("transport", "payload_too_large")
			return
		}
		if requestBody != nil && requestBody.readErr != nil {
			response.rejectReadError()
			observation.observeRequest("transport", "bad_request")
			return
		}
		if !observation.hasObservedRequest() {
			method, outcome := mcpFallbackRequestLabels(r.Method, requestBody, response.Status())
			observation.observeRequest(method, outcome)
		}
	})
}

func mcpTransportHeaderError(r *http.Request) string {
	acceptsJSON, acceptsEvents := false, false
	for _, value := range strings.Split(r.Header.Get("Accept"), ",") {
		mediaType, _, err := mime.ParseMediaType(strings.TrimSpace(value))
		if err != nil {
			continue
		}
		acceptsJSON = acceptsJSON || mediaType == "application/json"
		acceptsEvents = acceptsEvents || mediaType == "text/event-stream"
	}
	if !acceptsJSON || !acceptsEvents {
		return "Accept must include application/json and text/event-stream"
	}
	if version := r.Header.Get("Mcp-Protocol-Version"); version != "" && !slices.Contains(mcp.ValidProtocolVersions, version) {
		return "unsupported MCP protocol version"
	}
	return ""
}

func mcpUnauthorized(w http.ResponseWriter, r *http.Request, challenge func(*http.Request) string) {
	value := "Bearer"
	if challenge != nil {
		if custom := strings.TrimSpace(challenge(r)); custom != "" {
			value = custom
		}
	}
	w.Header().Set("WWW-Authenticate", value)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusUnauthorized)
	_ = json.NewEncoder(w).Encode(errorResponse("unauthorized", "bearer authentication required", nil))
}

func mcpPrincipal(ctx context.Context) (auth.Principal, error) {
	principal, ok := ctx.Value(mcpPrincipalContextKey{}).(auth.Principal)
	if !ok || principal.Type == "" || principal.ID == "" {
		return auth.Principal{}, auth.ErrUnauthorized
	}
	return principal, nil
}

// mcpAPIAdapter invokes the REST handlers in an isolated Gin context so both
// transports share validation, authorization, and response semantics. MCP
// transport metrics and recovery are handled by the outer MCP server.
type mcpAPIAdapter struct{ handlers handlers }

type mcpAPIResponse struct {
	status      int
	contentType string
	body        []byte
}

func (a mcpAPIAdapter) call(
	ctx context.Context,
	method, target, contentType string,
	body io.Reader,
	params gin.Params,
	handler gin.HandlerFunc,
) (mcpAPIResponse, error) {
	principal, err := mcpPrincipal(ctx)
	if err != nil {
		return mcpAPIResponse{}, err
	}
	req, err := http.NewRequestWithContext(ctx, method, target, body)
	if err != nil {
		return mcpAPIResponse{}, err
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	c.Request = req
	c.Params = params
	c.Set(principalContextKey, &principal)
	handler(c)
	return mcpAPIResponse{
		status:      recorder.Code,
		contentType: recorder.Header().Get("Content-Type"),
		body:        recorder.Body.Bytes(),
	}, nil
}

func (a mcpAPIAdapter) get(ctx context.Context, target string, params gin.Params, handler gin.HandlerFunc) (*mcp.CallToolResult, error) {
	response, err := a.call(ctx, http.MethodGet, target, "", nil, params, handler)
	return a.result(response, err, false)
}

func (a mcpAPIAdapter) delete(ctx context.Context, target string, params gin.Params, handler gin.HandlerFunc) (*mcp.CallToolResult, error) {
	response, err := a.call(ctx, http.MethodDelete, target, "", nil, params, handler)
	return a.result(response, err, false)
}

func (a mcpAPIAdapter) json(ctx context.Context, method, target string, value any, params gin.Params, handler gin.HandlerFunc) (*mcp.CallToolResult, error) {
	response, err := a.jsonResponse(ctx, method, target, value, params, handler)
	return a.result(response, err, false)
}

// jsonResponse issues a JSON API call and returns the raw response so a tool
// can chain follow-up calls (e.g. the default share after document creation).
func (a mcpAPIAdapter) jsonResponse(ctx context.Context, method, target string, value any, params gin.Params, handler gin.HandlerFunc) (mcpAPIResponse, error) {
	body, err := json.Marshal(value)
	if err != nil {
		return mcpAPIResponse{}, fmt.Errorf("could not encode request: %w", err)
	}
	return a.call(ctx, method, target, "application/json", bytes.NewReader(body), params, handler)
}

func (a mcpAPIAdapter) multipart(ctx context.Context, target string, fields map[string]string, html string, params gin.Params, handler gin.HandlerFunc) (*mcp.CallToolResult, error) {
	response, err := a.multipartResponse(ctx, target, fields, html, params, handler)
	return a.result(response, err, false)
}

func (a mcpAPIAdapter) multipartResponse(ctx context.Context, target string, fields map[string]string, html string, params gin.Params, handler gin.HandlerFunc) (mcpAPIResponse, error) {
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	for key, value := range fields {
		if err := writer.WriteField(key, value); err != nil {
			return mcpAPIResponse{}, fmt.Errorf("could not encode request: %w", err)
		}
	}
	file, err := writer.CreateFormFile("file", "document.html")
	if err != nil {
		return mcpAPIResponse{}, fmt.Errorf("could not encode request: %w", err)
	}
	if _, err := io.WriteString(file, html); err != nil {
		return mcpAPIResponse{}, fmt.Errorf("could not encode request: %w", err)
	}
	if err := writer.Close(); err != nil {
		return mcpAPIResponse{}, fmt.Errorf("could not encode request: %w", err)
	}
	return a.call(ctx, http.MethodPost, target, writer.FormDataContentType(), &body, params, handler)
}

func (a mcpAPIAdapter) html(ctx context.Context, target string, params gin.Params, handler gin.HandlerFunc) (*mcp.CallToolResult, error) {
	response, err := a.call(ctx, http.MethodGet, target, "", nil, params, handler)
	return a.result(response, err, true)
}

func (mcpAPIAdapter) result(response mcpAPIResponse, err error, plainText bool) (*mcp.CallToolResult, error) {
	if err != nil {
		return mcp.NewToolResultError(err.Error()), nil
	}
	if response.status < http.StatusOK || response.status >= http.StatusMultipleChoices {
		var payload any
		if json.Unmarshal(response.body, &payload) == nil && payload != nil {
			// Keep the complete API error envelope as structured content. In
			// particular, optimistic-concurrency errors carry the latest version
			// ID in error.details so an agent can recover safely.
			result := mcp.NewToolResultStructured(payload, string(response.body))
			result.IsError = true
			return result, nil
		}
		message := strings.TrimSpace(string(response.body))
		if message == "" {
			message = http.StatusText(response.status)
		}
		return mcp.NewToolResultError(fmt.Sprintf("HTTP %d: %s", response.status, message)), nil
	}
	if len(response.body) == 0 {
		return mcp.NewToolResultJSON(map[string]any{"ok": true})
	}
	if plainText || !strings.Contains(response.contentType, "application/json") {
		return mcp.NewToolResultText(string(response.body)), nil
	}
	var value any
	if err := json.Unmarshal(response.body, &value); err != nil {
		return mcp.NewToolResultError("could not decode server response: " + err.Error()), nil
	}
	return mcp.NewToolResultJSON(value)
}

func mcpParams(values ...string) gin.Params {
	params := make(gin.Params, 0, len(values)/2)
	for i := 0; i+1 < len(values); i += 2 {
		params = append(params, gin.Param{Key: values[i], Value: values[i+1]})
	}
	return params
}

func mcpRequired(request mcp.CallToolRequest, name string) (string, *mcp.CallToolResult) {
	value, err := request.RequireString(name)
	if err != nil {
		return "", mcp.NewToolResultError(err.Error())
	}
	return value, nil
}

func readOnlyOptions(options ...mcp.ToolOption) []mcp.ToolOption {
	return append(options,
		mcp.WithReadOnlyHintAnnotation(true),
		mcp.WithDestructiveHintAnnotation(false),
		mcp.WithIdempotentHintAnnotation(true),
		mcp.WithOpenWorldHintAnnotation(false),
	)
}

func mutationOptions(destructive, idempotent bool, options ...mcp.ToolOption) []mcp.ToolOption {
	return append(options,
		mcp.WithReadOnlyHintAnnotation(false),
		mcp.WithDestructiveHintAnnotation(destructive),
		mcp.WithIdempotentHintAnnotation(idempotent),
		mcp.WithOpenWorldHintAnnotation(false),
	)
}

func registerMCPTools(server *mcpserver.MCPServer, api mcpAPIAdapter) {
	registerMCPGeneralTools(server, api)
	registerMCPDocumentTools(server, api)
	registerMCPApprovalTools(server, api)
	registerMCPFolderTools(server, api)
	registerMCPServiceAccountTools(server, api)
}
