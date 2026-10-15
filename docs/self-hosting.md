# Self-hosting slashdocs

`slashdocs` ships as a single Go binary that embeds the web UI. You provide
Postgres, S3-compatible blob storage, and an OpenID Connect identity
provider (Google, Okta, Entra ID, Keycloak, Dex, ...).

This guide covers three deployment paths:

- [Docker](#docker)
- [Kubernetes with Helm](#kubernetes-with-helm)
- [Bare metal / systemd](#bare-metal--systemd)

It also documents [every environment variable](#environment-variables)
the binary understands.

## Requirements

- Postgres 14+
- S3-compatible object storage (AWS S3, MinIO, Cloudflare R2, etc.)
- An OIDC identity provider (a Google OAuth web client, or any OpenID
  Connect provider such as Okta, Entra ID, Keycloak, or Dex)
- A public HTTPS origin for production

Use **separate app and render origins**:

```text
SLASHDOCS_APP_ORIGIN=https://slashdocs.example.com
SLASHDOCS_RENDER_ORIGIN=https://render.slashdocs.example.com
```

The render origin serves uploaded HTML inside a sandboxed iframe. Putting
it on a different hostname isolates untrusted user-supplied HTML from your
authenticated application origin. A scheme or port difference is insufficient
because cookies are host-scoped. The server refuses to start when the two
hostnames match; local or throwaway setups can override this with
`SLASHDOCS_ALLOW_UNSAFE_RENDER_ORIGIN=true`, accepting that uploaded documents
can then script against the app origin.

## Configure sign-in

slashdocs authenticates humans through OpenID Connect. Pick one provider:

- **Google** — set the classic `GOOGLE_OAUTH_CLIENT_ID` /
  `GOOGLE_OAUTH_CLIENT_SECRET` pair (walkthrough below).
- **Any other OIDC provider** — set `SLASHDOCS_OIDC_ISSUER_URL`,
  `SLASHDOCS_OIDC_CLIENT_ID`, and `SLASHDOCS_OIDC_CLIENT_SECRET`
  (see [Generic OIDC providers](#generic-oidc-providers)).

Set exactly one of the two; the server refuses to start with both.

### Google, step by step (Google Cloud Console)

1. **Pick or create a project.** Go to
   [console.cloud.google.com](https://console.cloud.google.com/), open the
   project picker (top bar), and create a project (e.g. `slashdocs`) or select an
   existing one. Everything below lives inside this project.
2. **Configure the OAuth consent screen** (APIs & Services → OAuth consent
   screen). Choose the user type:
   - **Internal** — only accounts in your Google Workspace organization can
     sign in. This is the right choice for an `org` deployment (see below) and
     skips Google's app-verification review.
   - **External** — any Google account can sign in. Use this for a `public`
     deployment. While the app is in "Testing" only listed test users can log
     in; click **Publish app** to open it to everyone.

   Fill in the app name, support email, and developer contact. You do **not**
   need any sensitive/restricted scopes — slashdocs only reads basic profile and
   email, which are covered by the default non-sensitive scopes.

3. **Create the OAuth client** (APIs & Services → Credentials → Create
   credentials → OAuth client ID). Application type: **Web application**. Give
   it a name (e.g. `slashdocs web`).
4. **Add the authorized redirect URI** — this must exactly match your
   deployment's origin plus `/v1/auth/google/callback`:

   ```text
   https://slashdocs.example.com/v1/auth/google/callback
   ```

   For local testing also add:

   ```text
   http://localhost:8080/v1/auth/google/callback
   ```

   You can list multiple redirect URIs on one client (e.g. prod + local). The
   host must match `SLASHDOCS_APP_ORIGIN` exactly — scheme, host, and no trailing
   slash. (No "Authorized JavaScript origins" are required; slashdocs uses the
   server-side redirect flow.)

5. **Copy the credentials.** After creating the client, copy the **Client ID**
   and **Client secret** into `GOOGLE_OAUTH_CLIENT_ID` and
   `GOOGLE_OAUTH_CLIENT_SECRET` (or your secret store / Helm secret ref).

Optionally restrict logins to specific email domains with
`ALLOWED_OAUTH_DOMAINS=example.com,company.com` (public deployments only).

> On an `org` deployment with a single org domain, slashdocs automatically adds
> Google's `hd=<domain>` parameter to the sign-in URL so the account picker is
> pre-filtered to your Workspace domain. The email-domain check after login
> remains the actual gate.

### Generic OIDC providers

Any OpenID Connect provider that supports the authorization-code flow and
discovery (`/.well-known/openid-configuration`) works — Okta, Entra ID,
Keycloak, and Dex are all known-good. Create a confidential **web**
application at your IdP with the redirect URI:

```text
https://slashdocs.example.com/v1/auth/oidc/callback
```

then configure:

```text
SLASHDOCS_OIDC_ISSUER_URL=https://sso.example.com
SLASHDOCS_OIDC_CLIENT_ID=slashdocs
SLASHDOCS_OIDC_CLIENT_SECRET=...
# Optional label for the login button ("Continue with <name>"; default "SSO").
SLASHDOCS_OIDC_PROVIDER_NAME=Okta
```

The server discovers the provider's endpoints from the issuer at startup,
requests the `openid email profile` scopes, and verifies ID tokens against the
issuer's JWKS. The ID token must include non-empty `sub` and `email` claims;
`name` and `picture` fill in the optional profile fields. The ID token must
also prove the email is verified: `email_verified` must be true. Entra ID never
sends `email_verified`. In the Entra app registration, open **Token
configuration**, add the optional ID-token claims `email` and `xms_edov`, and
save. If the portal does not list `xms_edov`, add
`{"name": "xms_edov", "essential": false}` under `optionalClaims.idToken` in
the **Manifest**.

If the server reaches the IdP at a different URL than browsers do (common with
docker-compose, where the browser sees `http://localhost:5556` but containers
must dial `http://dex:5556`), set `SLASHDOCS_OIDC_INTERNAL_ISSUER_URL` to the
server-side URL. Discovery, token exchange, and JWKS fetches then use the
internal URL while ID tokens are still validated against the public
`SLASHDOCS_OIDC_ISSUER_URL`.

Example: a minimal [Dex](https://dexidp.io/) setup for local testing —

```yaml
# dex-config.yaml
issuer: http://localhost:5556
storage: { type: memory }
web: { http: 0.0.0.0:5556 }
staticClients:
  - id: slashdocs
    secret: dex-client-secret
    name: slashdocs
    redirectURIs:
      - http://localhost:8080/v1/auth/oidc/callback
enablePasswordDB: true
staticPasswords:
  - email: admin@example.com
    # bcrypt of "password"
    hash: "$2a$10$2b2cU8CPhOTaGrs1HRQuAueS7JTT5ZHsHSzYiFPm1leZck7Mc8T4W"
    username: admin
    userID: 08a8684b-db88-4b73-90a9-3cd1661f5466
```

with the matching slashdocs settings:

```text
SLASHDOCS_OIDC_ISSUER_URL=http://localhost:5556
SLASHDOCS_OIDC_INTERNAL_ISSUER_URL=http://dex:5556   # only when slashdocs runs in the same compose network
SLASHDOCS_OIDC_CLIENT_ID=slashdocs
SLASHDOCS_OIDC_CLIENT_SECRET=dex-client-secret
SLASHDOCS_OIDC_PROVIDER_NAME=Dex
```

### Deployment type: public vs org

slashdocs runs in one of two modes, set by `SLASHDOCS_DEPLOYMENT`:

- **`public`** (default) — anyone who can authenticate with the identity
  provider can sign in. Sharing a document with "everyone" means _anyone with
  the link_. People search finds only your contacts: the people you share
  with and the people who share with you. Other users appear only when you
  type their full email address.
- **`org`** — login is gated to your organization's domains
  (`SLASHDOCS_ORG_DOMAINS`, a comma-separated list that supports multiple domains
  for acquisitions). Sharing with "everyone" then means _anyone in the org_,
  because only org members can authenticate. Set `SLASHDOCS_ORG_NAME` to label the
  org in the UI (e.g. "Anyone in Razorpay"). People search finds every user
  who has signed in.

On an org deployment the org domains are the login gate, so you do not also
need `ALLOWED_OAUTH_DOMAINS`. The document permission model is identical in both
modes; only the login gate, people search, and the wording differ.

> For an `org` deployment, set the OAuth consent screen to **Internal** so
> Google itself restricts sign-in to your Workspace organization, and set
> `SLASHDOCS_ORG_DOMAINS` to the same email domain(s). The two together ensure
> only org members can authenticate.

```text
SLASHDOCS_DEPLOYMENT=org
SLASHDOCS_ORG_DOMAINS=acme.com,acme-labs.io
SLASHDOCS_ORG_NAME=Acme
```

Org deployments can also set a server-wide sharing default applied to every
created document (`SLASHDOCS_DEFAULT_DOC_PERMISSION`: `viewer`, `commenter`,
`editor`, or `private`, the default). Users can set a different preference on the CLI by
setting the same env variable on their system while using the CLI.

### Featured sections

The Documents page can show sections of documents and folders above each
user's own items, for example team tutorials on an org deployment or examples
on a public one. Set `SLASHDOCS_FEATURED` to a JSON object. Each key is a section
title, and the key order is the page order:

```json
{
  "Dev tutorials": {
    "description": "Guides for every engineer.",
    "permanent": true,
    "items": ["fld_abc", "doc_def"]
  },
  "Examples": { "items": ["doc_ghi"] }
}
```

- `items` holds document (`doc_`) and folder (`fld_`) IDs. Users only see
  the items that they can open, so share each item with everyone.
- Users can hide each item, unless `permanent` is `true`.
- `description` is optional.

The server does not start if the JSON is not valid.

### MCP Server

Although the preferred usage method is via the CLI, every deployment serves
a remote Streamable HTTP MCP endpoint at `$SLASHDOCS_APP_ORIGIN/mcp`.
The idea is to allow agents that might not have access to a shell environment
to still use Slashdocs. It can also be used for operating systems with weird installation processes like windows.
The server publishes OAuth protected-resource and authorization-server
metadata under `/.well-known/`, so compatible clients can register, open the
normal slashdocs OIDC sign-in, show an explicit consent page, and complete an
authorization-code flow with S256 PKCE.

For unattended automation, a slashdocs service-account key can be supplied as the
Bearer token instead of using browser OAuth.

## Local dev stack (docker compose)

The repository ships a ready-made compose stack —
[`docker-compose.yml`](../docker-compose.yml) — that runs the server together
with Postgres, versitygw (S3), and a Dex identity provider configured exactly
like the split-horizon example above ([`dev/dex-config.yaml`](../dev/dex-config.yaml)):

```bash
docker compose up
```

This pulls the latest published image. To run your local changes instead, use
`docker compose up --build`. Building needs Docker with Compose v2 and the
[Buildx](https://docs.docker.com/build/concepts/overview/#buildx) plugin, because
the Dockerfile uses BuildKit features. Docker Desktop and Docker's official
Engine packages include both. Distro packages may not: on Ubuntu or Debian, run
`sudo apt install docker-buildx`. Check with `docker buildx version`.

Open <http://localhost:8080> and sign in as `admin@example.com` / `password`.
The stack serves the app on `http://localhost:8080` and renders documents on
`http://127.0.0.1:8080` — the same listener, but a distinct browser origin, so
the sandboxing model matches production.

This stack is for development and evaluation only: Dex uses a static dev user
and fixed secrets. Production deployments configure a real identity provider
(above) and bring their own Postgres and S3.

`make e2e` (a wrapper around [`scripts/e2e.sh`](../scripts/e2e.sh)) boots the
stack and runs a non-interactive end-to-end test: OIDC login, service
accounts, CLI push/pull, comments, sharing, folders, sandboxed rendering, and
the KV events stream. `scripts/e2e.sh down` removes the stack and its volumes.

## Docker

Build the image from source, or pull the prebuilt image from Docker Hub.
Building needs the Buildx plugin (see [Local dev stack](#local-dev-stack-docker-compose));
pulling does not.

```bash
# Build locally
docker build -t slashdocs:local .

# Docker Hub (published for every tagged release, linux/amd64 and linux/arm64)
docker pull razorpay/slashdocs:latest
```

Pin an exact version (`razorpay/slashdocs:0.1.0`) or digest in production
rather than `:latest`. Available versions are listed on the
[releases page](https://github.com/razorpay/slashdocs/releases).

Run it, pointing at your Postgres and S3-compatible storage. Copy
[`.env.example`](../.env.example) to `.env`, fill it in, and pass it through:

```bash
docker run --rm -p 8080:8080 --env-file .env \
  razorpay/slashdocs:latest
```

Open <http://localhost:8080>. See `.env.example` for every variable; the
reference tables below document them too.

For production, sit slashdocs behind a TLS-terminating reverse proxy (nginx,
Caddy, Cloudflare, ALB, etc.) and set `SLASHDOCS_APP_ORIGIN` / `SLASHDOCS_RENDER_ORIGIN` to
the public HTTPS URLs.

## Kubernetes with Helm

A Helm chart lives at [`charts/slashdocs/`](../charts/slashdocs/). It deploys
one Deployment, a Service, optional Ingress, and a PodDisruptionBudget.
You bring your own Postgres and S3.

### Quick start

```bash
helm upgrade --install slashdocs ./charts/slashdocs \
  --namespace slashdocs \
  --create-namespace \
  -f my-values.yaml
```

Start by copying the bundled values file:

```bash
cp charts/slashdocs/values.yaml my-values.yaml
```

### Minimal `my-values.yaml`

```yaml
image:
  repository: razorpay/slashdocs
  tag: "0.1.0"

# `public` (the chart default, stated here explicitly) accepts any account
# your OIDC provider allows. To gate login to a company domain instead:
#
#   deployment:
#     mode: org
#     orgDomains: "acme.com"   # comma-separated; required when mode=org
#     orgName: "Acme"          # share UI copy, e.g. "Anyone in Acme"
#     defaultDocPermission: "commenter"  # optional org-wide sharing default
deployment:
  mode: public

origins:
  app: https://slashdocs.example.com
  render: https://render.slashdocs.example.com

googleOAuth:
  clientID: "your-google-client-id"
  clientSecret: "your-google-client-secret"

# Or any other OIDC provider instead of googleOAuth (setting oidc.issuerURL
# switches the chart over):
# oidc:
#   issuerURL: https://sso.example.com
#   providerName: Okta
#   clientID: slashdocs
#   clientSecret: "..."

session:
  # At least 32 random bytes. Generate with: openssl rand -hex 32
  secret: "replace-with-at-least-32-random-bytes"

database:
  host: postgres.slashdocs.svc
  user: slashdocs
  password: replace-me
  name: slashdocs
  sslMode: require

blob:
  bucket: "slashdocs-prod"
  region: "us-east-1"
  accessKeyID: "AKIA..."
  secretAccessKey: "..."

ingress:
  enabled: true
  className: "nginx"
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

### Using existing Secrets

To avoid putting credentials in `values.yaml`, reference pre-created
Kubernetes Secrets via the `existingSecret` fields:

```yaml
googleOAuth:
  existingSecret: slashdocs-google-oauth
  clientIDKey: client-id
  clientSecretKey: client-secret

session:
  existingSecret: slashdocs-session
  secretKey: secret

database:
  existingSecret: slashdocs-db
  hostKey: DATABASE_HOST
  userKey: DATABASE_USER
  passwordKey: DATABASE_PASSWORD
  nameKey: DATABASE_NAME

blob:
  bucket: slashdocs-prod
  region: us-east-1
  existingSecret: slashdocs-blob
  accessKeyIDKey: access-key-id
  secretAccessKeyKey: secret-access-key
```

Then create those Secrets in your cluster with `kubectl create secret`
or your preferred secrets manager (External Secrets Operator, SOPS,
Sealed Secrets, etc.).

### Useful chart values

| Path                                                                       | Purpose                                                                                                                         |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `replicaCount`                                                             | Number of pod replicas.                                                                                                         |
| `image.{repository,tag,pullPolicy}`                                        | Container image.                                                                                                                |
| `origins.{app,render}`                                                     | Public URLs. `app` is injected into the served frontend.                                                                        |
| `database.{host,user,password,name,port,sslMode,migrate}`                  | Postgres connection pieces (composed into a DSN at runtime); `migrate: false` skips startup migrations.                         |
| `blob.{bucket,region,endpoint,forcePathStyle,accessKeyID,secretAccessKey}` | S3 settings.                                                                                                                    |
| `googleOAuth.{clientID,clientSecret}`                                      | Google OAuth credentials.                                                                                                       |
| `oidc.{issuerURL,providerName,internalIssuerURL,clientID,clientSecret}`    | Generic OIDC provider; used instead of `googleOAuth` when `issuerURL` is set.                                                   |
| `session.secret`                                                           | At least 32 random bytes.                                                                                                       |
| `deployment.{mode,orgDomains,orgName,defaultDocPermission}`                | `public` (default) or `org`; org mode gates login to `orgDomains` and may set a sharing default for new documents.              |
| `allowedOAuthDomains`                                                      | Comma-separated email domain allowlist (public mode); empty = no gate.                                                          |
| `kvEvents.{mode,listenerDatabaseURL,existingSecret}`                       | Realtime KV events: `SLASHDOCS_KV_EVENTS_MODE` and the dedicated LISTEN connection URL (secret-backed). Rendered only when set. |
| `commitSha`                                                                | Optional revision surfaced at `/commit.txt`.                                                                                    |
| `ingress`                                                                  | Standard ingress block; supports multiple hosts.                                                                                |
| `googleChat.{webhookSecret,webhookKey}`                                    | Google Chat webhook notifications: Secret holding the webhook URL.                                                              |
| `extraEnv` / `extraEnvFrom`                                                | Append arbitrary env vars / envFrom sources.                                                                                    |
| `resources`                                                                | CPU/memory requests and limits.                                                                                                 |
| `livenessProbe` / `readinessProbe`                                         | HTTP probes against `/livez` and `/readyz`.                                                                                     |
| `podDisruptionBudget`                                                      | Optional PDB for safer upgrades.                                                                                                |

See [`charts/slashdocs/values.yaml`](../charts/slashdocs/values.yaml) for the
full schema with defaults.

## Bare metal / systemd

```bash
git clone https://github.com/razorpay/slashdocs.git
cd slashdocs
make build              # produces bin/slashdocs-server and bin/slashdocs

# Place the binary and create an env file
sudo install -m 0755 bin/slashdocs-server /usr/local/bin/slashdocs-server
sudo install -m 0640 -o root -g root /dev/stdin /etc/slashdocs/env <<'EOF'
# nosemgrep: generic_postgres_string
DATABASE_URL=postgres://slashdocs:pass@localhost:5432/slashdocs?sslmode=disable
BLOB_BUCKET=slashdocs-prod
BLOB_REGION=us-east-1
BLOB_ACCESS_KEY_ID=AKIA...
BLOB_SECRET_ACCESS_KEY=...
SLASHDOCS_APP_ORIGIN=https://slashdocs.example.com
SLASHDOCS_RENDER_ORIGIN=https://render.slashdocs.example.com
GOOGLE_OAUTH_CLIENT_ID=...
GOOGLE_OAUTH_CLIENT_SECRET=...
SESSION_SECRET=...
EOF

sudo tee /etc/systemd/system/slashdocs.service > /dev/null <<'EOF'
[Unit]
Description=slashdocs
After=network.target

[Service]
EnvironmentFile=/etc/slashdocs/env
ExecStart=/usr/local/bin/slashdocs-server
Restart=on-failure
DynamicUser=true

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now slashdocs
```

Terminate TLS at nginx, Caddy, or any reverse proxy of your choice.

## Environment variables

### Required

| Variable                  | Purpose                                                                                                                                                              |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`            | Postgres connection string. Auto-runs migrations at startup unless disabled.                                                                                         |
| `BLOB_BUCKET`             | S3-compatible bucket name for stored HTML versions.                                                                                                                  |
| `SLASHDOCS_APP_ORIGIN`    | Public URL where the web UI is served. Also injected into the served `index.html` so the frontend can render correct copy-paste commands (CLI, curl, agent prompts). |
| `SLASHDOCS_RENDER_ORIGIN` | Public URL where uploaded HTML is sandbox-rendered. Must use a different hostname from `SLASHDOCS_APP_ORIGIN` (see `SLASHDOCS_ALLOW_UNSAFE_RENDER_ORIGIN`).          |
| `SESSION_SECRET`          | Session signing key. At least 32 random bytes.                                                                                                                       |

### Sign-in (exactly one provider)

| Variable                             | Purpose                                                                                                                                        |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `GOOGLE_OAUTH_CLIENT_ID`             | Google OAuth web client ID.                                                                                                                    |
| `GOOGLE_OAUTH_CLIENT_SECRET`         | Google OAuth web client secret.                                                                                                                |
| `SLASHDOCS_OIDC_ISSUER_URL`          | Issuer URL of a generic OIDC provider (Okta, Entra ID, Keycloak, Dex, ...). Endpoints are discovered from `/.well-known/openid-configuration`. |
| `SLASHDOCS_OIDC_CLIENT_ID`           | OIDC client ID.                                                                                                                                |
| `SLASHDOCS_OIDC_CLIENT_SECRET`       | OIDC client secret.                                                                                                                            |
| `SLASHDOCS_OIDC_PROVIDER_NAME`       | Optional display label for the login button. Defaults to `SSO` (`Google` when the Google pair is used).                                        |
| `SLASHDOCS_OIDC_INTERNAL_ISSUER_URL` | Optional server-side base URL for the IdP when it differs from the browser-facing issuer (split horizon, e.g. docker-compose).                 |

Set either the `GOOGLE_OAUTH_*` pair or the `SLASHDOCS_OIDC_*` variables, never
both. The redirect URI to register is
`<SLASHDOCS_APP_ORIGIN>/v1/auth/google/callback` for Google and
`<SLASHDOCS_APP_ORIGIN>/v1/auth/oidc/callback` for everything else.

### Notifications (at most one provider)

Comment and access notifications are off unless one of these is set; the server
refuses to start with both. See
[Comment notifications](comment-notifications.md) for provider setup.

| Variable                            | Purpose                                                                                                                     |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `SLASHDOCS_SLACK_BOT_TOKEN`         | Slack bot token; DMs each recipient.                                                                                        |
| `SLASHDOCS_GOOGLE_CHAT_WEBHOOK_URL` | Google Chat incoming webhook (`https://chat.googleapis.com/v1/spaces/…/messages?…`); posts every notification to one space. |

The webhook URL and the Slack token both grant posting rights, so keep them in
a secret store. The server needs outbound HTTPS to `chat.googleapis.com` or
`slack.com`.

### Optional

| Variable                                    | Default     | Purpose                                                                                                                                                                                                                                                                                             |
| ------------------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SLASHDOCS_PORT`                            | `8080`      | Public app/API listen port.                                                                                                                                                                                                                                                                         |
| `SLASHDOCS_METRICS_PORT`                    | `9090`      | Port for the separate listener that serves `/metrics`. Keep private (scrape over internal networking); never give it a public domain.                                                                                                                                                               |
| `SLASHDOCS_MIGRATE`                         | `true`      | Run database migrations on boot. Set `false` to skip.                                                                                                                                                                                                                                               |
| `SLASHDOCS_DEFAULT_DOC_PERMISSION`          | `private`   | Server-wide default sharing applied when a document is created: `viewer`, `commenter`, `editor`, or `private` (no grant). Non-private values require `SLASHDOCS_DEPLOYMENT=org`; requests may override per document via the `default_permission` form field.                                        |
| `SLASHDOCS_FEATURED`                        | unset       | JSON object of sections that the Documents page shows above each user's own items. See [Featured sections](#featured-sections).                                                                                                                                                                     |
| `SLASHDOCS_KV_EVENTS_MODE`                  | `auto`      | `auto`, `notify`, or `poll`; controls how document KV streams discover persisted events.                                                                                                                                                                                                            |
| `SLASHDOCS_KV_EVENTS_LISTENER_DATABASE_URL` | unset       | Direct or session-pooled URL to the same database for the dedicated LISTEN connection. Never use a transaction-pooling endpoint.                                                                                                                                                                    |
| `SLASHDOCS_PREVIOUS_ORIGINS`                | unset       | Comma-separated app origins that this deployment used before. Requests to them get a permanent redirect to the same path on `SLASHDOCS_APP_ORIGIN`, and the CLI saves the new URL. MCP clients on an old origin get one tool that tells the agent the new MCP URL. Route these hosts to the server. |
| `SLASHDOCS_ALLOW_UNSAFE_RENDER_ORIGIN`      | `false`     | Set `true` to allow app and render origins on the same hostname. Unsafe: documents can script against the app. Never in prod.                                                                                                                                                                       |
| `SLASHDOCS_COMMIT_SHA` / `COMMIT_SHA`       | unset       | Build revision exposed at `/commit.txt`.                                                                                                                                                                                                                                                            |
| `ALLOWED_OAUTH_DOMAINS`                     | unset       | Comma-separated email-domain allowlist for OAuth logins (public deployments).                                                                                                                                                                                                                       |
| `SLASHDOCS_DEPLOYMENT`                      | `public`    | `public` or `org`. An org deployment gates login to `SLASHDOCS_ORG_DOMAINS`.                                                                                                                                                                                                                        |
| `SLASHDOCS_ORG_DOMAINS`                     | unset       | Comma-separated org domains. Required when `SLASHDOCS_DEPLOYMENT=org`; also the login gate.                                                                                                                                                                                                         |
| `SLASHDOCS_ORG_NAME`                        | unset       | Org display name used in share UI copy (e.g. "Anyone in Razorpay").                                                                                                                                                                                                                                     |
| `BLOB_REGION`                               | `us-east-1` | AWS region for the S3 client.                                                                                                                                                                                                                                                                       |
| `BLOB_ENDPOINT`                             | unset       | Custom S3 endpoint (MinIO, R2, etc.).                                                                                                                                                                                                                                                               |
| `BLOB_ACCESS_KEY_ID`                        | unset       | Override AWS-SDK default credential chain.                                                                                                                                                                                                                                                          |
| `BLOB_SECRET_ACCESS_KEY`                    | unset       | Override AWS-SDK default credential chain.                                                                                                                                                                                                                                                          |
| `BLOB_FORCE_PATH_STYLE`                     | `false`     | Set to `true` for MinIO and most non-AWS S3 implementations.                                                                                                                                                                                                                                        |

`SLASHDOCS_KV_EVENTS_MODE=auto` attempts `LISTEN/NOTIFY` only when
`SLASHDOCS_KV_EVENTS_LISTENER_DATABASE_URL` is explicitly set. Without that URL it
uses coalesced polling. The listener URL must reach the same database directly
or through session pooling; the normal `DATABASE_URL` may still use a separate
route for queries and notification sends.

The same per-document stream also carries document, comment, and presence
events. Open viewers refresh comments, hear about new versions, and see who
else is viewing, whichever replica served each request. Presence rows expire
after ten minutes, so the event table does not grow with viewing time.

Live cursors use the same stream but are never stored. In `notify` mode, each
batch of pointer positions goes to every replica as a notification. In `poll`
mode, a viewer sees only the cursors of viewers that the same replica serves.
Thus, use `notify` when you run more than one replica.

`notify` fails startup if LISTEN cannot be verified. It prefers the listener URL
and otherwise uses `DATABASE_URL`, which is an explicit assertion by the
operator that the connection preserves session state. `poll` never opens a
listener. If PgBouncer transaction pooling is the only available database
route, use `poll`.

On Kubernetes, set these through the chart's `kvEvents` block
(`kvEvents.mode` and `kvEvents.listenerDatabaseURL`, or
`kvEvents.existingSecret` + `kvEvents.listenerDatabaseURLKey` to keep the
URL in a pre-created Secret) instead of `extraEnv`.

If `BLOB_ACCESS_KEY_ID` and `BLOB_SECRET_ACCESS_KEY` are omitted, the
AWS SDK default credential chain is used (IRSA, instance profile,
shared config, etc.).

## Health and metadata endpoints

```text
GET /openapi.json              OpenAPI 2.0 (Swagger 2.0) spec
GET /api-docs                  Swagger UI
GET /commit.txt                Build revision (controlled by SLASHDOCS_COMMIT_SHA) (Can be used for canary deployments)
GET /livez                     Liveness JSON: {"status":"ok"}
GET /readyz                    Readiness JSON with dependency checks
GET /.well-known/slashdocs.json   Deployment discovery
```

## How the frontend gets its public URL

When the server returns `index.html`, it substitutes the `SLASHDOCS_APP_ORIGIN`
value into a placeholder so the React app can read it synchronously at
boot. This drives copy-paste-correct commands in the UI:

- The `curl` in the **Try it end-to-end** step of the setup guide.
- The `curl` examples on the **Developers** page.
- The bearer-token CLI snippet in the **Service accounts** detail
  panel.

No extra API call is made; the value comes from the same env you already
configured for the server.

## Storage notes

`slashdocs` stores uploaded HTML versions in blob storage and metadata,
comments, grants, sessions, and OAuth state in Postgres. Documents are
versioned immutably; each push creates a new version.

For search, Postgres also keeps the visible text of each new version. After an
upgrade from a release without content search, every server reads the older
current versions from blob storage in the background and indexes them. Until a
document is indexed, search matches its title only.

For v1, each document should be one self-contained HTML file. If a
document needs images, embed them as data URLs:

```html
<img src="data:image/png;base64,..." alt="diagram" />
```

## Upgrading

Postgres migrations are applied automatically at startup unless
`SLASHDOCS_MIGRATE=false`. The chart and Docker image both honor this. To
roll back, deploy the previous image tag and pre-apply any matching
down-migration manually if needed; the binary does not auto-rollback.

## Production checklist

- [ ] `SLASHDOCS_APP_ORIGIN` and `SLASHDOCS_RENDER_ORIGIN` on different hostnames
      (enforced at startup), and `SLASHDOCS_ALLOW_UNSAFE_RENDER_ORIGIN` unset.
- [ ] HTTPS everywhere (TLS at the proxy/ingress).
- [ ] `SESSION_SECRET` rotated to a fresh 32+ byte value, stored in a
      secret manager.
- [ ] OAuth/OIDC redirect URIs registered at the IdP match `SLASHDOCS_APP_ORIGIN`.
- [ ] `ALLOWED_OAUTH_DOMAINS` set if you don't want public sign-ups.
- [ ] Postgres backups configured.
- [ ] If notifications are on: exactly one provider configured, its secret in a
      secret manager, and outbound HTTPS to the provider allowed.
- [ ] Blob storage versioning / lifecycle rules configured.
- [ ] `SLASHDOCS_COMMIT_SHA` baked into your image so `/commit.txt`
      reports the running build.
- [ ] Monitoring scraping `/metrics` on the metrics port (`SLASHDOCS_METRICS_PORT`,
      default `9090`). Keep this port private — do not expose it publicly.
- [ ] PodDisruptionBudget enabled (`podDisruptionBudget.enabled: true`)
      for at least 1 minAvailable.

## CLI installation for users

Once you've shipped a release, users (and their agents) install the CLI
with:

```bash
curl -fsSL https://slashdocs.example.com/install.sh | sh
slashdocs auth login https://slashdocs.example.com
```

The installer replaces an existing install in place. Otherwise it uses the
first writable directory that is already on `PATH` from `~/.local/bin`,
`~/bin`, and `/usr/local/bin`, so `slashdocs` works in the same terminal. If
none of them is on `PATH`, it installs to `~/.local/bin` and adds that
directory to the shell profile for new terminals. For a system install, run
`curl -fsSL https://slashdocs.example.com/install.sh | sh -s -- --system`.
Set `SLASHDOCS_INSTALL_DIR` to choose the directory.

For self-hosted instances, pass the URL to `slashdocs auth login` so the
CLI knows which server to authenticate against.
