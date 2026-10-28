local grafana = import 'github.com/grafana/grafonnet/gen/grafonnet-latest/main.libsonnet';

local datasource = '${DS_PROMETHEUS}';

local prom(expr, legend='') = {
  datasource: { type: 'prometheus', uid: datasource },
  editorMode: 'code',
  expr: expr,
  legendFormat: legend,
  range: true,
  refId: 'A',
};

local panel(title, kind, x, y, w, h, targets, extra={}) = {
  title: title,
  type: kind,
  datasource: { type: 'prometheus', uid: datasource },
  gridPos: { x: x, y: y, w: w, h: h },
  targets: targets,
} + extra;

local stat(title, x, y, w, h, expr, unit='', decimals=0) =
  panel(title, 'stat', x, y, w, h, [prom(expr)], {
    fieldConfig: {
      defaults: {
        unit: unit,
        decimals: decimals,
        color: { mode: 'palette-classic' },
      },
      overrides: [],
    },
    options: {
      colorMode: 'value',
      graphMode: 'area',
      justifyMode: 'auto',
      orientation: 'auto',
      reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false },
      textMode: 'auto',
    },
  });

local timeseries(title, x, y, w, h, targets, unit='', decimals=2) =
  panel(title, 'timeseries', x, y, w, h, targets, {
    fieldConfig: {
      defaults: {
        unit: unit,
        decimals: decimals,
        custom: {
          drawStyle: 'line',
          lineInterpolation: 'linear',
          lineWidth: 2,
          fillOpacity: 10,
          showPoints: 'never',
          spanNulls: false,
        },
      },
      overrides: [],
    },
    options: {
      legend: { displayMode: 'table', placement: 'bottom', showLegend: true },
      tooltip: { mode: 'multi', sort: 'none' },
    },
  });

local bar(title, x, y, w, h, targets, unit='', decimals=2) =
  timeseries(title, x, y, w, h, targets, unit, decimals) + { type: 'barchart' };

local table(title, x, y, w, h, targets) =
  panel(title, 'table', x, y, w, h, targets, {
    options: { showHeader: true, cellHeight: 'sm' },
    fieldConfig: { defaults: {}, overrides: [] },
  });

grafana.dashboard.new('slashdocs App Overview')
+ grafana.dashboard.withUid('slashdocs-app-overview')
+ grafana.dashboard.withTags(['slashdocs', 'prometheus', 'app'])
+ grafana.dashboard.withRefresh('30s')
+ grafana.dashboard.time.withFrom('now-6h')
+ grafana.dashboard.time.withTo('now')
+ grafana.dashboard.withVariables([
  grafana.dashboard.variable.datasource.new('DS_PROMETHEUS', 'prometheus')
  + grafana.dashboard.variable.datasource.generalOptions.withLabel('Prometheus'),
])
+ grafana.dashboard.withPanels([
  stat('Request rate', 0, 0, 6, 4, 'sum(rate(slashdocs_http_requests_total[$__rate_interval]))', 'reqps', 2),
  stat('5xx rate', 6, 0, 6, 4, 'sum(rate(slashdocs_http_requests_total{status=~"5.."}[$__rate_interval]))', 'reqps', 3),
  stat('p95 latency', 12, 0, 6, 4, 'histogram_quantile(0.95, sum(rate(slashdocs_http_request_duration_seconds_bucket[$__rate_interval])) by (le))', 's', 3),
  stat('Documents created', 18, 0, 6, 4, 'sum(increase(slashdocs_document_events_total{event="created"}[$__range]))', 'short', 0),

  timeseries('HTTP request rate by route', 0, 4, 12, 8, [
    prom('sum(rate(slashdocs_http_requests_total[$__rate_interval])) by (method, route, status)', '{{method}} {{route}} {{status}}'),
  ], 'reqps', 2),
  timeseries('HTTP latency p50/p95/p99', 12, 4, 12, 8, [
    prom('histogram_quantile(0.50, sum(rate(slashdocs_http_request_duration_seconds_bucket[$__rate_interval])) by (le))', 'p50'),
    prom('histogram_quantile(0.95, sum(rate(slashdocs_http_request_duration_seconds_bucket[$__rate_interval])) by (le))', 'p95'),
    prom('histogram_quantile(0.99, sum(rate(slashdocs_http_request_duration_seconds_bucket[$__rate_interval])) by (le))', 'p99'),
  ], 's', 3),

  timeseries('Auth attempts', 0, 12, 12, 8, [
    prom('sum(rate(slashdocs_auth_attempts_total[$__rate_interval])) by (kind, outcome)', '{{kind}} {{outcome}}'),
  ], 'ops', 2),
  timeseries('Document and version events', 12, 12, 12, 8, [
    prom('sum(rate(slashdocs_document_events_total[$__rate_interval])) by (event, visibility, actor_type)', 'doc {{event}} {{visibility}} {{actor_type}}'),
    prom('sum(rate(slashdocs_version_events_total[$__rate_interval])) by (event, actor_type)', 'version {{event}} {{actor_type}}'),
  ], 'ops', 2),

  timeseries('Comment events', 0, 20, 12, 8, [
    prom('sum(rate(slashdocs_comment_events_total[$__rate_interval])) by (event, status, actor_type)', '{{event}} {{status}} {{actor_type}}'),
  ], 'ops', 2),
  timeseries('Grant events', 12, 20, 12, 8, [
    prom('sum(rate(slashdocs_grant_events_total[$__rate_interval])) by (event, role, principal_type, actor_type)', '{{event}} {{role}} {{principal_type}} {{actor_type}}'),
  ], 'ops', 2),

  timeseries('Service account events', 0, 28, 12, 8, [
    prom('sum(rate(slashdocs_service_account_events_total[$__rate_interval])) by (event, actor_type)', '{{event}} {{actor_type}}'),
  ], 'ops', 2),
  timeseries('Render events', 12, 28, 12, 8, [
    prom('sum(rate(slashdocs_render_events_total[$__rate_interval])) by (event, outcome)', '{{event}} {{outcome}}'),
  ], 'ops', 2),

  timeseries('HTML payload size p50/p95', 0, 36, 12, 8, [
    prom('histogram_quantile(0.50, sum(rate(slashdocs_html_bytes_bucket[$__rate_interval])) by (le, operation))', 'p50 {{operation}}'),
    prom('histogram_quantile(0.95, sum(rate(slashdocs_html_bytes_bucket[$__rate_interval])) by (le, operation))', 'p95 {{operation}}'),
  ], 'bytes', 0),
  table('Top slow routes p95', 12, 36, 12, 8, [
    prom('topk(10, histogram_quantile(0.95, sum(rate(slashdocs_http_request_duration_seconds_bucket[$__rate_interval])) by (le, method, route)))', '{{method}} {{route}}'),
  ]),

  stat('MCP request rate', 0, 44, 6, 4, 'sum(rate(slashdocs_mcp_requests_total[$__rate_interval]))', 'reqps', 2),
  stat('MCP protocol/transport error ratio', 6, 44, 6, 4, 'sum(rate(slashdocs_mcp_requests_total{outcome!="success"}[$__rate_interval])) / clamp_min(sum(rate(slashdocs_mcp_requests_total[$__rate_interval])), 0.000001)', 'percentunit', 3),
  stat('MCP tool error ratio', 12, 44, 6, 4, 'sum(rate(slashdocs_mcp_tool_calls_total{outcome!="success"}[$__rate_interval])) / clamp_min(sum(rate(slashdocs_mcp_tool_calls_total[$__rate_interval])), 0.000001)', 'percentunit', 3),
  stat('MCP tool p95', 18, 44, 6, 4, 'histogram_quantile(0.95, sum(rate(slashdocs_mcp_tool_call_duration_seconds_bucket[$__rate_interval])) by (le))', 's', 3),

  timeseries('MCP protocol requests', 0, 48, 12, 8, [
    prom('sum(rate(slashdocs_mcp_requests_total[$__rate_interval])) by (method, outcome)', '{{method}} {{outcome}}'),
  ], 'reqps', 2),
  timeseries('MCP tool calls', 12, 48, 12, 8, [
    prom('sum(rate(slashdocs_mcp_tool_calls_total[$__rate_interval])) by (tool, outcome)', '{{tool}} {{outcome}}'),
  ], 'ops', 2),

  timeseries('MCP tool latency p50/p95', 0, 56, 12, 8, [
    prom('histogram_quantile(0.50, sum(rate(slashdocs_mcp_tool_call_duration_seconds_bucket[$__rate_interval])) by (le, tool))', 'p50 {{tool}}'),
    prom('histogram_quantile(0.95, sum(rate(slashdocs_mcp_tool_call_duration_seconds_bucket[$__rate_interval])) by (le, tool))', 'p95 {{tool}}'),
  ], 's', 3),
  table('Top MCP tools', 12, 56, 12, 8, [
    prom('topk(10, sum(rate(slashdocs_mcp_tool_calls_total[$__rate_interval])) by (tool, outcome))', '{{tool}} {{outcome}}'),
  ]),

  timeseries('MCP request latency p50/p95', 0, 64, 24, 8, [
    prom('histogram_quantile(0.50, sum(rate(slashdocs_mcp_request_duration_seconds_bucket[$__rate_interval])) by (le, method))', 'p50 {{method}}'),
    prom('histogram_quantile(0.95, sum(rate(slashdocs_mcp_request_duration_seconds_bucket[$__rate_interval])) by (le, method))', 'p95 {{method}}'),
  ], 's', 3),

  timeseries('Approval events', 0, 72, 12, 8, [
    prom('sum(rate(slashdocs_approval_events_total[$__rate_interval])) by (event, decision, actor_type)', '{{event}} {{decision}} {{actor_type}}'),
  ], 'ops', 2),
])
