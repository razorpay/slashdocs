package server_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/mark3labs/mcp-go/mcp"

	"github.com/razorpay/slashdocs/api/internal/auth"
	"github.com/razorpay/slashdocs/api/internal/server"
)

func TestMCPMetricsLabelStatelessRequests(t *testing.T) {
	e := newMCPOAuthTestEnv(t)
	token := auth.NewMCPAccessToken(fixtureUser.ID, e.resource, oauthTestSigningMaterial, time.Minute)

	assertMetricDelta(t,
		"slashdocs_mcp_requests_total", map[string]string{"method": "server_discover", "outcome": "success"},
		"slashdocs_mcp_request_duration_seconds_count", map[string]string{"method": "server_discover", "outcome": "success"},
		func() {
			assertStatus(t, statelessMCPRequest(t, e, token, "server/discover", mcp.ProtocolVersion20260728), http.StatusOK)
		},
	)
	// A JSON-RPC error with a 4xx status is a protocol error, not a transport error.
	assertMetricDelta(t,
		"slashdocs_mcp_requests_total", map[string]string{"method": "unknown", "outcome": "protocol_error"},
		"slashdocs_mcp_request_duration_seconds_count", map[string]string{"method": "unknown", "outcome": "protocol_error"},
		func() {
			assertStatus(t, statelessMCPRequest(t, e, token, "unknown/method", mcp.ProtocolVersion20260728), http.StatusNotFound)
		},
	)
}

func TestMCPMetricsClassifyProtocolTransportAndToolOutcomes(t *testing.T) {
	e := newMCPOAuthTestEnv(t)
	token := auth.NewMCPAccessToken(fixtureUser.ID, e.resource, oauthTestSigningMaterial, time.Minute)

	assertMetricDelta(t,
		"slashdocs_mcp_requests_total", map[string]string{"method": "initialize", "outcome": "success"},
		"slashdocs_mcp_request_duration_seconds_count", map[string]string{"method": "initialize", "outcome": "success"},
		func() {
			rr := mcpPost(t, e, token, "", map[string]any{
				"jsonrpc": "2.0", "id": 1, "method": "initialize",
				"params": map[string]any{
					"protocolVersion": mcp.LATEST_LEGACY_PROTOCOL_VERSION,
					"capabilities":    map[string]any{},
					"clientInfo":      map[string]any{"name": "metrics-test", "version": "1"},
				},
			})
			assertStatus(t, rr, http.StatusOK)
		},
	)

	assertMCPMetricToolCall(t, e, token, "whoami", map[string]any{}, false, "success")
	assertMCPMetricToolCall(t, e, token, "get_document", map[string]any{}, true, "tool_error")
	assertMCPMetricToolCall(t, e, token, "get_document", map[string]any{"document_id": "doc_missing"}, true, "tool_error")

	attackerTool := "attacker_tool_7f3a9"
	unknownRequestLabels := map[string]string{"method": "tools_call", "outcome": "protocol_error"}
	unknownToolLabels := map[string]string{"tool": "unknown", "outcome": "protocol_error", "actor_type": "user"}
	unknownToolDurationLabels := map[string]string{"tool": "unknown", "outcome": "protocol_error"}
	requestBefore := scrapeMetric(t, "slashdocs_mcp_requests_total", unknownRequestLabels)
	requestDurationBefore := scrapeMetric(t, "slashdocs_mcp_request_duration_seconds_count", unknownRequestLabels)
	toolBefore := scrapeMetric(t, "slashdocs_mcp_tool_calls_total", unknownToolLabels)
	toolDurationBefore := scrapeMetric(t, "slashdocs_mcp_tool_call_duration_seconds_count", unknownToolDurationLabels)
	rr := mcpPost(t, e, token, "", map[string]any{
		"jsonrpc": "2.0", "id": 20, "method": "tools/call",
		"params": map[string]any{"name": attackerTool, "arguments": map[string]any{}},
	})
	assertStatus(t, rr, http.StatusOK)
	if !strings.Contains(rr.Body.String(), `"error"`) {
		t.Fatalf("unknown tool did not produce protocol error: %s", rr.Body.String())
	}
	assertMetricValue(t, "slashdocs_mcp_requests_total", unknownRequestLabels, requestBefore+1)
	assertMetricValue(t, "slashdocs_mcp_request_duration_seconds_count", unknownRequestLabels, requestDurationBefore+1)
	assertMetricValue(t, "slashdocs_mcp_tool_calls_total", unknownToolLabels, toolBefore+1)
	assertMetricValue(t, "slashdocs_mcp_tool_call_duration_seconds_count", unknownToolDurationLabels, toolDurationBefore+1)

	assertTransportMetric(t, e, "auth_error", func() *responseRecorderAlias {
		return do(t, e.h, http.MethodPost, "/mcp", "not-json", map[string]string{"Content-Type": "application/json"})
	}, http.StatusUnauthorized)
	assertTransportMetric(t, e, "origin_rejected", func() *responseRecorderAlias {
		return rawMCPRequest(t, e, http.MethodPost, token, "https://attacker.example", "{}", "application/json", true)
	}, http.StatusForbidden)
	assertTransportMetric(t, e, "payload_too_large", func() *responseRecorderAlias {
		// The server caps MCP bodies at 301 MiB (50 MiB HTML cap x worst-case
		// JSON escaping plus envelope); one byte over must be rejected before parsing.
		req := httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader("{}"))
		req.ContentLength = (301 << 20) + 1
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Accept", "application/json, text/event-stream")
		req.Header.Set("Mcp-Protocol-Version", mcp.LATEST_LEGACY_PROTOCOL_VERSION)
		rr := httptest.NewRecorder()
		e.h.ServeHTTP(rr, req)
		return rr
	}, http.StatusRequestEntityTooLarge)

	unknownMethod := "attacker/method/3b17"
	unknownMethodLabels := map[string]string{"method": "unknown", "outcome": "protocol_error"}
	unknownBefore := scrapeMetric(t, "slashdocs_mcp_requests_total", unknownMethodLabels)
	unknownDurationBefore := scrapeMetric(t, "slashdocs_mcp_request_duration_seconds_count", unknownMethodLabels)
	unknown := mcpPost(t, e, token, "", map[string]any{
		"jsonrpc": "2.0", "id": 21, "method": unknownMethod, "params": map[string]any{},
	})
	assertStatus(t, unknown, http.StatusOK)
	assertMetricValue(t, "slashdocs_mcp_requests_total", unknownMethodLabels, unknownBefore+1)
	assertMetricValue(t, "slashdocs_mcp_request_duration_seconds_count", unknownMethodLabels, unknownDurationBefore+1)

	metrics := do(t, server.MetricsHandler(), http.MethodGet, "/metrics", "", nil)
	assertStatus(t, metrics, http.StatusOK)
	for _, unbounded := range []string{attackerTool, unknownMethod, fixtureUser.ID, fixtureUser.Email} {
		if strings.Contains(metrics.Body.String(), unbounded) {
			t.Errorf("MCP metrics leaked unbounded label value %q", unbounded)
		}
	}
}

func TestGrafanaDashboardIncludesMCPMonitoring(t *testing.T) {
	_, filename, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("could not resolve test source path")
	}
	root := filepath.Clean(filepath.Join(filepath.Dir(filename), "..", "..", ".."))
	sourcePath := filepath.Join(root, "monitoring", "grafana", "slashdocs-dashboard.libsonnet")
	jsonPath := filepath.Join(root, "monitoring", "grafana", "slashdocs-dashboard.json")
	source, err := os.ReadFile(sourcePath)
	if err != nil {
		t.Fatalf("read Grafana source: %v", err)
	}
	rendered, err := os.ReadFile(jsonPath)
	if err != nil {
		t.Fatalf("read rendered Grafana dashboard: %v", err)
	}
	var dashboard struct {
		Panels []struct {
			Title   string `json:"title"`
			Targets []struct {
				Expression string `json:"expr"`
			} `json:"targets"`
		} `json:"panels"`
	}
	if err := json.Unmarshal(rendered, &dashboard); err != nil {
		t.Fatalf("rendered Grafana dashboard is invalid JSON: %v", err)
	}

	for _, required := range []string{
		"slashdocs_mcp_requests_total",
		"slashdocs_mcp_request_duration_seconds_bucket",
		"slashdocs_mcp_tool_calls_total",
		"slashdocs_mcp_tool_call_duration_seconds_bucket",
		"MCP request rate",
		"MCP protocol/transport error ratio",
		"MCP tool error ratio",
		"MCP protocol requests",
		"MCP tool latency p50/p95",
	} {
		if !strings.Contains(string(source), required) {
			t.Errorf("Grafana source missing %q", required)
		}
		if !strings.Contains(string(rendered), required) {
			t.Errorf("rendered Grafana dashboard missing %q", required)
		}
	}
	for title, metric := range map[string]string{
		"MCP protocol/transport error ratio": `slashdocs_mcp_requests_total{outcome!="success"}`,
		"MCP tool error ratio":               `slashdocs_mcp_tool_calls_total{outcome!="success"}`,
	} {
		found := false
		for _, panel := range dashboard.Panels {
			if panel.Title != title {
				continue
			}
			for _, target := range panel.Targets {
				if strings.Contains(target.Expression, metric) {
					found = true
				}
			}
		}
		if !found {
			t.Errorf("rendered Grafana panel %q is not derived from %q", title, metric)
		}
	}
	for _, boundedGrouping := range []string{"by (method, outcome)", "by (tool, outcome)", "by (le, tool)"} {
		if !strings.Contains(string(source), boundedGrouping) {
			t.Errorf("Grafana source missing bounded MCP grouping %q", boundedGrouping)
		}
	}
}

// responseRecorderAlias keeps the transport-metric helper readable without
// introducing a second response abstraction alongside httptest.ResponseRecorder.
type responseRecorderAlias = httptest.ResponseRecorder

func assertMCPMetricToolCall(t *testing.T, e *mcpOAuthTestEnv, token, tool string, arguments map[string]any, wantError bool, outcome string) {
	t.Helper()
	requestLabels := map[string]string{"method": "tools_call", "outcome": "success"}
	toolLabels := map[string]string{"tool": tool, "outcome": outcome, "actor_type": "user"}
	requestBefore := scrapeMetric(t, "slashdocs_mcp_requests_total", requestLabels)
	requestDurationBefore := scrapeMetric(t, "slashdocs_mcp_request_duration_seconds_count", requestLabels)
	toolBefore := scrapeMetric(t, "slashdocs_mcp_tool_calls_total", toolLabels)
	toolDurationLabels := map[string]string{"tool": tool, "outcome": outcome}
	toolDurationBefore := scrapeMetric(t, "slashdocs_mcp_tool_call_duration_seconds_count", toolDurationLabels)

	result := callMCPToolHTTP(t, e, token, tool, arguments)
	if result.IsError != wantError {
		t.Fatalf("tool %s IsError = %v, want %v; text=%s", tool, result.IsError, wantError, result.Text)
	}
	assertMetricValue(t, "slashdocs_mcp_requests_total", requestLabels, requestBefore+1)
	assertMetricValue(t, "slashdocs_mcp_request_duration_seconds_count", requestLabels, requestDurationBefore+1)
	assertMetricValue(t, "slashdocs_mcp_tool_calls_total", toolLabels, toolBefore+1)
	assertMetricValue(t, "slashdocs_mcp_tool_call_duration_seconds_count", toolDurationLabels, toolDurationBefore+1)
}

func assertTransportMetric(t *testing.T, e *mcpOAuthTestEnv, outcome string, call func() *responseRecorderAlias, status int) {
	t.Helper()
	labels := map[string]string{"method": "transport", "outcome": outcome}
	before := scrapeMetric(t, "slashdocs_mcp_requests_total", labels)
	durationBefore := scrapeMetric(t, "slashdocs_mcp_request_duration_seconds_count", labels)
	rr := call()
	assertStatus(t, rr, status)
	assertMetricValue(t, "slashdocs_mcp_requests_total", labels, before+1)
	assertMetricValue(t, "slashdocs_mcp_request_duration_seconds_count", labels, durationBefore+1)
}

func assertMetricDelta(t *testing.T, counter string, counterLabels map[string]string, durationCounter string, durationLabels map[string]string, call func()) {
	t.Helper()
	before := scrapeMetric(t, counter, counterLabels)
	durationBefore := scrapeMetric(t, durationCounter, durationLabels)
	call()
	assertMetricValue(t, counter, counterLabels, before+1)
	assertMetricValue(t, durationCounter, durationLabels, durationBefore+1)
}

func assertMetricValue(t *testing.T, name string, labels map[string]string, want float64) {
	t.Helper()
	if got := scrapeMetric(t, name, labels); got != want {
		t.Fatalf("metric %s%v = %v, want %v", name, labels, got, want)
	}
}
