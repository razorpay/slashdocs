package server

import (
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

var metricsRegistry = prometheus.NewRegistry()

// byteBuckets are the histogram buckets for request, response, and HTML sizes.
var byteBuckets = []float64{0, 512, 1024, 10 * 1024, 100 * 1024, 1024 * 1024, 5 * 1024 * 1024, 10 * 1024 * 1024}

var (
	httpRequestsTotal = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "slashdocs_http_requests_total",
		Help: "Total HTTP requests handled by the slashdocs server.",
	}, []string{"method", "route", "status"})
	httpRequestDuration = prometheus.NewHistogramVec(prometheus.HistogramOpts{
		Name:    "slashdocs_http_request_duration_seconds",
		Help:    "HTTP request latency by route.",
		Buckets: prometheus.DefBuckets,
	}, []string{"method", "route", "status"})
	httpRequestSizeBytes = prometheus.NewHistogramVec(prometheus.HistogramOpts{
		Name:    "slashdocs_http_request_size_bytes",
		Help:    "HTTP request body size by route.",
		Buckets: byteBuckets,
	}, []string{"method", "route"})
	httpResponseSizeBytes = prometheus.NewHistogramVec(prometheus.HistogramOpts{
		Name:    "slashdocs_http_response_size_bytes",
		Help:    "HTTP response body size by route.",
		Buckets: byteBuckets,
	}, []string{"method", "route", "status"})
	authAttemptsTotal = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "slashdocs_auth_attempts_total",
		Help: "Authentication attempts by kind and outcome.",
	}, []string{"kind", "outcome"})
	documentEventsTotal = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "slashdocs_document_events_total",
		Help: "Document lifecycle and interaction events.",
	}, []string{"event", "actor_type"})
	versionEventsTotal = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "slashdocs_version_events_total",
		Help: "Document version lifecycle and interaction events.",
	}, []string{"event", "actor_type"})
	commentEventsTotal = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "slashdocs_comment_events_total",
		Help: "Comment lifecycle events.",
	}, []string{"event", "status", "actor_type"})
	grantEventsTotal = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "slashdocs_grant_events_total",
		Help: "Document grant lifecycle events.",
	}, []string{"event", "role", "principal_type", "actor_type"})
	approvalEventsTotal = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "slashdocs_approval_events_total",
		Help: "Document approval lifecycle events.",
	}, []string{"event", "decision", "actor_type"})
	serviceAccountEventsTotal = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "slashdocs_service_account_events_total",
		Help: "Service account lifecycle and key events.",
	}, []string{"event", "actor_type"})
	renderEventsTotal = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "slashdocs_render_events_total",
		Help: "Render token and document render events.",
	}, []string{"event", "outcome"})
	htmlBytes = prometheus.NewHistogramVec(prometheus.HistogramOpts{
		Name:    "slashdocs_html_bytes",
		Help:    "Uploaded or downloaded HTML payload sizes.",
		Buckets: byteBuckets,
	}, []string{"operation"})
	mcpRequestsTotal = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "slashdocs_mcp_requests_total",
		Help: "MCP protocol requests by bounded method and outcome.",
	}, []string{"method", "outcome"})
	mcpRequestDuration = prometheus.NewHistogramVec(prometheus.HistogramOpts{
		Name:    "slashdocs_mcp_request_duration_seconds",
		Help:    "MCP protocol request latency by bounded method and outcome.",
		Buckets: prometheus.DefBuckets,
	}, []string{"method", "outcome"})
	mcpToolCallsTotal = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "slashdocs_mcp_tool_calls_total",
		Help: "MCP tool calls by registered tool, outcome, and actor type.",
	}, []string{"tool", "outcome", "actor_type"})
	mcpToolCallDuration = prometheus.NewHistogramVec(prometheus.HistogramOpts{
		Name:    "slashdocs_mcp_tool_call_duration_seconds",
		Help:    "MCP tool call latency by registered tool and outcome.",
		Buckets: prometheus.DefBuckets,
	}, []string{"tool", "outcome"})
	googleGroupRequests = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "slashdocs_google_group_requests_total",
		Help: "Cloud Identity requests by operation and low-cardinality outcome.",
	}, []string{"operation", "outcome"})
	googleGroupRequestDuration = prometheus.NewHistogramVec(prometheus.HistogramOpts{
		Name:    "slashdocs_google_group_request_duration_seconds",
		Help:    "Cloud Identity request latency by operation.",
		Buckets: prometheus.DefBuckets,
	}, []string{"operation"})
	googleGroupMembershipEvents = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "slashdocs_google_group_membership_events_total",
		Help: "Membership cache and refresh events.",
	}, []string{"event", "outcome"})
	googleGroupAuthorizationFailures = prometheus.NewCounter(prometheus.CounterOpts{
		Name: "slashdocs_google_group_authorization_failures_total",
		Help: "Authorization responses caused by unavailable Google Group membership.",
	})
	googleGroupOperations = prometheus.NewCounterVec(prometheus.CounterOpts{
		Name: "slashdocs_google_group_operations_total",
		Help: "Google Group search and grant resolution outcomes.",
	}, []string{"operation", "outcome"})
)

func init() {
	metricsRegistry.MustRegister(
		collectors.NewGoCollector(),
		collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}),
		httpRequestsTotal,
		httpRequestDuration,
		httpRequestSizeBytes,
		httpResponseSizeBytes,
		authAttemptsTotal,
		documentEventsTotal,
		versionEventsTotal,
		commentEventsTotal,
		grantEventsTotal,
		approvalEventsTotal,
		serviceAccountEventsTotal,
		renderEventsTotal,
		htmlBytes,
		mcpRequestsTotal,
		mcpRequestDuration,
		mcpToolCallsTotal,
		mcpToolCallDuration,
		googleGroupRequests,
		googleGroupRequestDuration,
		googleGroupMembershipEvents,
		googleGroupAuthorizationFailures,
		googleGroupOperations,
	)
}

// MetricsHandler serves Prometheus metrics. It is mounted on a separate,
// private listener (see cmd/slashdocs-server) so /metrics is never exposed on the
// public app port.
func MetricsHandler() http.Handler {
	mux := http.NewServeMux()
	mux.Handle("/metrics", promhttp.HandlerFor(metricsRegistry, promhttp.HandlerOpts{}))
	return mux
}

func prometheusMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		start := time.Now()
		if c.Request.ContentLength > 0 {
			httpRequestSizeBytes.WithLabelValues(c.Request.Method, routeLabel(c)).Observe(float64(c.Request.ContentLength))
		}
		c.Next()
		status := strconv.Itoa(c.Writer.Status())
		route := routeLabel(c)
		httpRequestsTotal.WithLabelValues(c.Request.Method, route, status).Inc()
		httpRequestDuration.WithLabelValues(c.Request.Method, route, status).Observe(time.Since(start).Seconds())
		if size := c.Writer.Size(); size >= 0 {
			httpResponseSizeBytes.WithLabelValues(c.Request.Method, route, status).Observe(float64(size))
		}
	}
}

func routeLabel(c *gin.Context) string {
	if p := c.FullPath(); p != "" {
		return p
	}
	return "unmatched"
}

func actorType(c *gin.Context) string {
	p := current(c)
	if p == nil || p.Type == "" {
		return "anonymous"
	}
	return string(p.Type)
}

func incAuth(kind, outcome string) { authAttemptsTotal.WithLabelValues(kind, outcome).Inc() }
func incDocument(event, actor string) {
	documentEventsTotal.WithLabelValues(event, actor).Inc()
}
func incVersion(event, actor string) { versionEventsTotal.WithLabelValues(event, actor).Inc() }
func incComment(event, status, actor string) {
	commentEventsTotal.WithLabelValues(event, status, actor).Inc()
}
func incGrant(event, role, principalType, actor string) {
	grantEventsTotal.WithLabelValues(event, role, principalType, actor).Inc()
}
func incApproval(event, decision, actor string) {
	approvalEventsTotal.WithLabelValues(event, decision, actor).Inc()
}
func addApprovals(event, decision, actor string, n int) {
	approvalEventsTotal.WithLabelValues(event, decision, actor).Add(float64(n))
}
func incServiceAccount(event, actor string) {
	serviceAccountEventsTotal.WithLabelValues(event, actor).Inc()
}
func incRender(event, outcome string) { renderEventsTotal.WithLabelValues(event, outcome).Inc() }
func observeHTML(operation string, size int) {
	htmlBytes.WithLabelValues(operation).Observe(float64(size))
}

func observeMCPRequest(method, outcome string, duration time.Duration) {
	mcpRequestsTotal.WithLabelValues(method, outcome).Inc()
	mcpRequestDuration.WithLabelValues(method, outcome).Observe(duration.Seconds())
}

func observeMCPToolCall(tool, outcome, actor string, duration time.Duration) {
	mcpToolCallsTotal.WithLabelValues(tool, outcome, actor).Inc()
	mcpToolCallDuration.WithLabelValues(tool, outcome).Observe(duration.Seconds())
}

func ObserveGoogleGroupRequest(operation, outcome string, elapsed time.Duration) {
	googleGroupRequests.WithLabelValues(operation, outcome).Inc()
	googleGroupRequestDuration.WithLabelValues(operation).Observe(elapsed.Seconds())
}

func observeGoogleGroupMembership(event, outcome string) {
	googleGroupMembershipEvents.WithLabelValues(event, outcome).Inc()
}

func incGoogleGroupAuthorizationFailure() { googleGroupAuthorizationFailures.Inc() }
func incGoogleGroupOperation(operation, outcome string) {
	googleGroupOperations.WithLabelValues(operation, outcome).Inc()
}
