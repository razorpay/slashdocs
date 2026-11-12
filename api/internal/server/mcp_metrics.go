package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"sync"
	"time"

	"github.com/mark3labs/mcp-go/mcp"
	mcpserver "github.com/mark3labs/mcp-go/server"
)

const maxMCPMetricProbeBytes = 64 * 1024

var mcpMetricMethods = map[mcp.MCPMethod]string{
	mcp.MethodInitialize:              "initialize",
	mcp.MethodNotificationInitialized: "notifications_initialized",
	mcp.MethodPing:                    "ping",
	mcp.MethodToolsList:               "tools_list",
	mcp.MethodToolsCall:               "tools_call",
	mcp.MethodServerDiscover:          "server_discover",
}

type mcpMetricContextKey struct{}

type mcpMetricObservation struct {
	started time.Time
	actor   string

	mu              sync.Mutex
	requestObserved bool
	toolObserved    bool
}

func newMCPMetricObservation(started time.Time, actor string) *mcpMetricObservation {
	return &mcpMetricObservation{started: started, actor: actor}
}

func mcpObservation(ctx context.Context) *mcpMetricObservation {
	observation, _ := ctx.Value(mcpMetricContextKey{}).(*mcpMetricObservation)
	return observation
}

func (o *mcpMetricObservation) observeRequest(method, outcome string) {
	if o == nil {
		return
	}
	o.mu.Lock()
	if o.requestObserved {
		o.mu.Unlock()
		return
	}
	o.requestObserved = true
	duration := time.Since(o.started)
	o.mu.Unlock()
	observeMCPRequest(method, outcome, duration)
}

func (o *mcpMetricObservation) hasObservedRequest() bool {
	if o == nil {
		return false
	}
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.requestObserved
}

func (o *mcpMetricObservation) observeTool(tool, outcome string, duration time.Duration) {
	if o == nil {
		return
	}
	o.mu.Lock()
	if o.toolObserved {
		o.mu.Unlock()
		return
	}
	o.toolObserved = true
	actor := o.actor
	o.mu.Unlock()
	observeMCPToolCall(tool, outcome, actor, duration)
}

func (o *mcpMetricObservation) hasObservedTool() bool {
	if o == nil {
		return false
	}
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.toolObserved
}

type mcpMetricRecorder struct {
	knownTools map[string]struct{}
}

func newMCPMetricRecorder() *mcpMetricRecorder {
	return &mcpMetricRecorder{knownTools: make(map[string]struct{})}
}

func (r *mcpMetricRecorder) setKnownTools(tools map[string]*mcpserver.ServerTool) {
	for name := range tools {
		r.knownTools[name] = struct{}{}
	}
}

func (r *mcpMetricRecorder) toolLabel(name string) string {
	if _, ok := r.knownTools[name]; ok {
		return name
	}
	return "unknown"
}

func (r *mcpMetricRecorder) hooks() *mcpserver.Hooks {
	hooks := &mcpserver.Hooks{}
	hooks.AddOnSuccess(func(ctx context.Context, _ any, method mcp.MCPMethod, message, result any) {
		observation := mcpObservation(ctx)
		if observation == nil {
			return
		}
		observation.observeRequest(mcpMetricMethod(method), "success")
		if method != mcp.MethodToolsCall || observation.hasObservedTool() {
			return
		}
		request, _ := message.(*mcp.CallToolRequest)
		tool := "unknown"
		if request != nil {
			tool = r.toolLabel(request.Params.Name)
		}
		observation.observeTool(tool, mcpToolResultOutcome(result), time.Since(observation.started))
	})
	hooks.AddOnError(func(ctx context.Context, _ any, method mcp.MCPMethod, message any, _ error) {
		observation := mcpObservation(ctx)
		if observation == nil {
			return
		}
		observation.observeRequest(mcpMetricMethod(method), "protocol_error")
		if method != mcp.MethodToolsCall || observation.hasObservedTool() {
			return
		}
		request, _ := message.(*mcp.CallToolRequest)
		tool := "unknown"
		if request != nil {
			tool = r.toolLabel(request.Params.Name)
		}
		observation.observeTool(tool, "protocol_error", time.Since(observation.started))
	})
	return hooks
}

func (r *mcpMetricRecorder) toolMiddleware(next mcpserver.ToolHandlerFunc) mcpserver.ToolHandlerFunc {
	return func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		started := time.Now()
		result, err := next(ctx, request)
		outcome := "success"
		switch {
		case err != nil:
			outcome = "protocol_error"
		case result != nil && result.IsError:
			outcome = "tool_error"
		}
		if observation := mcpObservation(ctx); observation != nil {
			observation.observeTool(r.toolLabel(request.Params.Name), outcome, time.Since(started))
		}
		return result, err
	}
}

func mcpToolResultOutcome(result any) string {
	switch value := result.(type) {
	case *mcp.CallToolResult:
		if value != nil && value.IsError {
			return "tool_error"
		}
	case mcp.CallToolResult:
		if value.IsError {
			return "tool_error"
		}
	}
	return "success"
}

func mcpMetricMethod(method mcp.MCPMethod) string {
	if label := mcpMetricMethods[method]; label != "" {
		return label
	}
	return "unknown"
}

// mcpRequestBody lets the MCP transport perform its required single buffering
// pass while enforcing the authenticated payload limit. Only a small prefix is
// retained separately for fallback labels on messages the SDK rejects before
// request hooks run.
type mcpRequestBody struct {
	io.ReadCloser
	limit     int64
	remaining int64
	probe     bytes.Buffer
	tooLarge  bool
	readErr   error
}

func newMCPRequestBody(body io.ReadCloser, limit int64) *mcpRequestBody {
	return &mcpRequestBody{ReadCloser: body, limit: limit, remaining: limit}
}

func (b *mcpRequestBody) Read(p []byte) (int, error) {
	if b.tooLarge {
		return 0, &http.MaxBytesError{Limit: b.limit}
	}
	maxRead := b.remaining + 1
	if int64(len(p)) > maxRead {
		p = p[:int(maxRead)]
	}
	n, err := b.ReadCloser.Read(p)
	accepted := n
	if int64(n) > b.remaining {
		accepted = int(b.remaining)
		b.tooLarge = true
		err = &http.MaxBytesError{Limit: b.limit}
	} else if err != nil && err != io.EOF {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			b.tooLarge = true
		} else {
			b.readErr = err
		}
	}
	b.remaining -= int64(accepted)
	if accepted > 0 && b.probe.Len() < maxMCPMetricProbeBytes {
		probeBytes := accepted
		if available := maxMCPMetricProbeBytes - b.probe.Len(); probeBytes > available {
			probeBytes = available
		}
		_, _ = b.probe.Write(p[:probeBytes])
	}
	return accepted, err
}

func (b *mcpRequestBody) metricMethod() string {
	if b == nil {
		return "unknown"
	}
	decoder := json.NewDecoder(bytes.NewReader(b.probe.Bytes()))
	token, err := decoder.Token()
	if err != nil || token != json.Delim('{') {
		return "unknown"
	}
	for decoder.More() {
		key, err := decoder.Token()
		if err != nil {
			return "unknown"
		}
		if key == "method" {
			var method mcp.MCPMethod
			if err := decoder.Decode(&method); err != nil {
				return "unknown"
			}
			return mcpMetricMethod(method)
		}
		var discard json.RawMessage
		if err := decoder.Decode(&discard); err != nil {
			return "unknown"
		}
	}
	return "unknown"
}

type mcpResponseWriter struct {
	http.ResponseWriter
	requestBody *mcpRequestBody
	status      int
}

func newMCPResponseWriter(w http.ResponseWriter, requestBody *mcpRequestBody) *mcpResponseWriter {
	return &mcpResponseWriter{ResponseWriter: w, requestBody: requestBody}
}

func (w *mcpResponseWriter) WriteHeader(status int) {
	if w.status != 0 {
		return
	}
	if w.requestBody != nil && w.requestBody.tooLarge {
		w.rejectTooLarge()
		return
	}
	if w.requestBody != nil && w.requestBody.readErr != nil {
		w.rejectReadError()
		return
	}
	w.status = status
	w.ResponseWriter.WriteHeader(status)
}

func (w *mcpResponseWriter) Write(p []byte) (int, error) {
	if w.requestBody != nil && w.requestBody.tooLarge {
		w.rejectTooLarge()
		return len(p), nil
	}
	if w.requestBody != nil && w.requestBody.readErr != nil {
		w.rejectReadError()
		return len(p), nil
	}
	if w.status == 0 {
		w.WriteHeader(http.StatusOK)
	}
	return w.ResponseWriter.Write(p)
}

func (w *mcpResponseWriter) rejectTooLarge() {
	if w.status != 0 {
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.status = http.StatusRequestEntityTooLarge
	w.ResponseWriter.WriteHeader(w.status)
	_, _ = io.WriteString(w.ResponseWriter, "MCP request body is too large\n")
}

func (w *mcpResponseWriter) rejectReadError() {
	if w.status != 0 {
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.status = http.StatusBadRequest
	w.ResponseWriter.WriteHeader(w.status)
	_, _ = io.WriteString(w.ResponseWriter, "could not read MCP request body\n")
}

func (w *mcpResponseWriter) Status() int {
	if w.status == 0 {
		return http.StatusOK
	}
	return w.status
}

func mcpFallbackRequestLabels(method string, body *mcpRequestBody, status int, jsonRPCError bool) (string, string) {
	if method != http.MethodPost {
		if status >= http.StatusOK && status < http.StatusMultipleChoices {
			return "transport", "success"
		}
		return "transport", "transport_error"
	}
	metricMethod := body.metricMethod()
	switch {
	case status == http.StatusAccepted:
		return metricMethod, "success"
	case jsonRPCError && status >= http.StatusBadRequest && status < http.StatusInternalServerError:
		return metricMethod, "protocol_error"
	case status < http.StatusOK || status >= http.StatusMultipleChoices:
		return metricMethod, "transport_error"
	default:
		return metricMethod, "protocol_error"
	}
}
