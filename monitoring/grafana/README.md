# slashdocs Grafana dashboard

This directory contains a portable Prometheus/Grafana dashboard for slashdocs app and business metrics.

- `slashdocs-dashboard.libsonnet` is the Grafonnet source of truth.
- `slashdocs-dashboard.json` is the rendered dashboard for direct Grafana import or provisioning.
- `jsonnetfile.json` and `jsonnetfile.lock.json` pin Grafonnet dependencies.
- `vendor/` is intentionally ignored; regenerate it with `jb install`.

Render locally:

```bash
make dashboards
```

Verify the committed JSON is up to date:

```bash
make check-dashboards
```

CI runs `make check-dashboards` and fails if the rendered JSON differs from the committed JSON.

The dashboard uses a datasource variable named `DS_PROMETHEUS`, so it should work across internal, hosted, and self-hosted deployments after selecting the right Prometheus datasource in Grafana.

For Google Group sharing, alert on sustained request outcomes
`permission_denied` (Google 401/403) or `quota`, refresh failures, and elevated
`slashdocs_google_group_authorization_failures_total`. All group metrics use only
operation/event/outcome labels; never add user emails, group emails, or group
IDs as labels.
