# slashdocs Helm chart

Deploy `slashdocs` to Kubernetes as one application Deployment and Service. You bring Postgres, S3-compatible blob storage, and an OIDC identity provider (Google, Okta, Entra ID, Keycloak, Dex, ...).

## Two origins, on purpose

slashdocs serves uploaded document HTML — untrusted content — in a sandboxed frame on a dedicated render origin (`origins.render`). Keep it on a **different host** from the app origin (`origins.app`): if documents rendered on the app origin, an uploaded script could run same-origin with the authenticated application and its session cookies. The chart defaults reflect this (`slashdocs.example.com` vs `render.slashdocs.example.com`), and when the Traefik `ingressRoute` is enabled, template rendering fails unless `ingressRoute.renderHost` is set and differs from `ingressRoute.host`. Route both hosts to the same Service.

## Install

```bash
helm upgrade --install slashdocs ./charts/slashdocs \
  --namespace slashdocs \
  --create-namespace \
  -f values.yaml
```

## Minimal values

```yaml
image:
  repository: razorpay/slashdocs
  tag: "0.1.0"

# `public` (the chart default) accepts any account your OIDC provider allows.
deployment:
  mode: public

origins:
  app: https://slashdocs.example.com
  render: https://render.slashdocs.example.com

googleOAuth:
  clientID: "..."
  clientSecret: "..."

# Or any other OIDC provider instead of googleOAuth (setting oidc.issuerURL
# switches the chart over):
# oidc:
#   issuerURL: https://sso.example.com
#   providerName: Okta
#   clientID: slashdocs
#   clientSecret: "..."

session:
  secret: "replace-with-at-least-32-random-bytes"

database:
  host: postgres
  user: slashdocs
  password: replace-me
  name: slashdocs
  sslMode: require

blob:
  bucket: slashdocs
  region: us-east-1
  accessKeyID: "..."
  secretAccessKey: "..."

autoscaling:
  enabled: true
  minReplicas: 2
  maxReplicas: 5
  targetCPUUtilizationPercentage: 70
  targetMemoryUtilizationPercentage: 70

ingress:
  enabled: true
  className: nginx
  hosts:
    - host: slashdocs.example.com
      paths:
        - path: /
          pathType: Prefix
    - host: render.slashdocs.example.com
      paths:
        - path: /
          pathType: Prefix
  tls:
    - secretName: slashdocs-tls
      hosts:
        - slashdocs.example.com
        - render.slashdocs.example.com
```

## Restricting sign-in to your organization

The chart defaults to `deployment.mode: public`, which accepts any account
the configured OIDC provider allows. To gate login to a company domain,
switch to org mode and set the domains explicitly:

```yaml
deployment:
  mode: org
  orgDomains: "acme.com" # comma-separated; required when mode=org
  orgName: "Acme" # share UI copy, e.g. "Anyone in Acme"
```

In public mode you can still apply a lighter email-domain allowlist with
`allowedOAuthDomains: "acme.com"` (empty by default, meaning no gate).

Org installs can also pick the sharing default the server applies to every
created document (`viewer`, `commenter`, `editor`, or `private`, the
default):

```yaml
deployment:
  mode: org
  orgDomains: "acme.com"
  defaultDocPermission: "commenter" # new documents are org-commentable
```

Creators can override per document with the `default_permission` field on
create, and every applied default is reported back with its grant id so it
can be revoked. Non-private defaults require org mode: a public server
would share every new document with anyone holding the link, so the server
refuses to start rather than apply that silently.

## One-time structured-mentions upgrade

When upgrading an installation from an image that stored comment mentions as
U+2063 markers, do not use the normal rolling strategy. Pause comment writes
and perform this release with no old/new pod overlap:

```bash
helm upgrade slashdocs ./charts/slashdocs \
  --namespace slashdocs \
  -f values.yaml \
  --set updateStrategy.type=Recreate
```

After every pod runs the new image and browser caches/tabs have been refreshed,
restore normal rolling updates (this changes only the Deployment strategy):

```bash
helm upgrade slashdocs ./charts/slashdocs \
  --namespace slashdocs \
  --reuse-values \
  --set updateStrategy.type=RollingUpdate
```

See the coordinated cutover and irreversible rollback details in
[`docs/self-hosting.md`](../../docs/self-hosting.md#upgrading).

## Realtime KV events

Document KV streams default to `SLASHDOCS_KV_EVENTS_MODE=auto`, which uses
coalesced polling unless a dedicated LISTEN connection URL is provided.
The `kvEvents` block wires the two server env vars; both are rendered only
when set:

```yaml
kvEvents:
  mode: notify # auto | notify | poll (empty = server default, auto)
  # Direct or session-pooled URL to the same database for the dedicated
  # LISTEN connection. Never a transaction-pooling endpoint. Stored in the
  # chart-managed Secret.
  listenerDatabaseURL: "postgres://slashdocs:pass@postgres:5432/slashdocs?sslmode=require"
```

Or keep the URL out of Helm values with a pre-created Secret:

```yaml
kvEvents:
  mode: notify
  existingSecret: slashdocs-kv-events
  listenerDatabaseURLKey: SLASHDOCS_KV_EVENTS_LISTENER_DATABASE_URL
```

If your only database route is PgBouncer in transaction-pooling mode, set
`kvEvents.mode: poll` and leave the listener URL unset.

## Existing secrets

You can keep secrets outside Helm values:

```yaml
googleOAuth:
  existingSecret: slashdocs-google-oauth
  clientIDKey: GOOGLE_OAUTH_CLIENT_ID
  clientSecretKey: GOOGLE_OAUTH_CLIENT_SECRET

session:
  existingSecret: slashdocs-session
  secretKey: SESSION_SECRET

database:
  existingSecret: slashdocs-database
  hostKey: DATABASE_HOST
  userKey: DATABASE_USER
  passwordKey: DATABASE_PASSWORD
  nameKey: DATABASE_NAME

blob:
  existingSecret: slashdocs-blob
  accessKeyIDKey: access-key-id
  secretAccessKeyKey: secret-access-key

googleGroups:
  enabled: true
  customerID: C01234567
  adminEmail: groups-reader-admin@example.com
  existingSecret: slashdocs-google-groups
  credentialsKey: credentials.json

# Google Chat notifications (incoming webhook URL under key webhook-url).
googleChat:
  webhookSecret: slashdocs-chat-webhook
```

Create the Secret before installing, for example:

```bash
kubectl create secret generic slashdocs-chat-webhook --from-literal=webhook-url='https://chat.googleapis.com/v1/spaces/…'
```

## Redirect URIs

Configure this redirect URI in Google Cloud:

```text
https://slashdocs.example.com/v1/auth/google/callback
```

or, for a generic OIDC provider:

```text
https://slashdocs.example.com/v1/auth/oidc/callback
```
