# slashdocs CLI

`slashdocs` is the scriptable CLI for the slashdocs HTML review service.

## Install from source

```bash
go build -o bin/slashdocs ./cli
```

## Auth

```bash
slashdocs auth login slashdocs.example.com       # log in to your slashdocs server
slashdocs auth login                          # reuses the active context's server
slashdocs auth whoami
slashdocs auth logout                         # revokes server credential by default
SLASHDOCS_NO_KEYCHAIN=1 slashdocs auth login ... # force file-only token storage
```

There is no built-in default server. Installing via `curl https://<your-server>/install.sh | sh` preconfigures the CLI to use that server; otherwise pass the server URL to `slashdocs auth login`, use `--server`, or set `SLASHDOCS_SERVER`.

Self-hosted login only needs the server URL. The server owns the OIDC configuration (generic `SLASHDOCS_OIDC_*` variables or the Google aliases); the CLI uses server-mediated loopback PKCE.

By default, login stores the secret token in the OS keychain when available and keeps only metadata plus a `token_ref` in `~/.config/slashdocs/config.json`. If the keychain is unavailable, it falls back to storing the token in the config file with `0600` permissions. Set `SLASHDOCS_NO_KEYCHAIN=1` to force file-only storage.

For CI/bots:

```bash
export SLASHDOCS_SERVER=https://slashdocs.example.com
export SLASHDOCS_TOKEN=slashdocs_sa_...
```

## Core agent loop

```bash
slashdocs docs list
slashdocs docs list 'incident author:alice@example.com labels:api,review in:"Product Specs"'
slashdocs docs list 'author:/@example\.com$/ labels:/^api-/'
slashdocs docs labels set doc_123 api review-ready
slashdocs docs labels list doc_123
slashdocs docs pull doc_123 --out report.html
slashdocs docs comments list doc_123 --json > review.json
# edit report.html
slashdocs docs push doc_123 report.html --summary "Address review comments"
slashdocs docs comments resolve doc_123 cmt_1 cmt_2
```

## Local documents

`slashdocs local` lets you try slashdocs on one computer, without a server, account, or login. It serves a folder of HTML documents with the slashdocs viewer and comments. To share documents with your team, and to get version history, full-text search, labels, and notifications, use a slashdocs server.

```bash
slashdocs local start                 # serves ~/slashdocs at http://slashdocs.localhost
slashdocs local start --dir ./reports # serves another folder
slashdocs local status
slashdocs local stop                  # stops it, and it does not start again
slashdocs local serve                 # runs in the foreground
```

Put `.html` files, and folders of them, in the documents folder. The listing shows each document's `<title>`. `*.localhost` names go to this machine without DNS setup.

`start` installs a service, so the server starts by itself and again after a crash:

- On macOS, it is a launchd agent of your user. It starts when you log in. The log is in `~/.config/slashdocs/local.log`.
- On Linux, only root can use port 80, so `start` and `stop` ask for your password with sudo. They install systemd system units: a socket unit opens port 80 and gives it to the server, which runs as your user. It starts when the computer starts. The log is in `journalctl -u slashdocs-local`.

If the system has no service manager, such as a container without systemd, `start` runs the server in the background until you stop it or the computer stops.

The server uses port 80, so the URL has no port. If port 80 is in use, it uses port 7070, at `http://slashdocs.localhost:7070`. Use `--port` to choose a port. On macOS, a normal user can use port 80 only on all network addresses, so the server closes each connection that does not come from this machine.

Documents open in a sandboxed frame on `http://127.0.0.1`, a different origin from the app. A self-update restarts the server, so it runs the new version.

Select text in a document to comment on it. All state is in the documents folder, so you can use git or other tools on it. Each document keeps its state in a hidden file next to it: the state of `specs/api.html` is in `specs/.api.html.slashdocs.json`. The state is the comments, and a title that replaces the `<title>` of the HTML. Move or rename the two files together. The file uses the fields of the slashdocs API.

### Use the local documents from the CLI

Add `--local` to a command to use slashdocs local. If it is not running, `--local` starts it first, as `slashdocs local start` does, with the default folder and port. `--local` does not change your saved server or its login.

```bash
slashdocs --local docs create report.html   # writes report.html in the documents folder
slashdocs --local docs push report.html report.html
slashdocs --local docs comments list report.html
```

On Linux, the first start asks for your password with sudo. If there is no terminal, as when an agent runs the command, run `slashdocs local start` yourself first.

The ID of a local document is its path in the documents folder, such as `specs/api.html`, and a folder ID is the path of the folder. These commands work:

- `docs list`, `show`, `create`, `push`, `pull`, `delete`, `headings`, `link`, and `comments`.
- `docs create --title` and `docs update --title`: they keep the title in the state file. Without a title, or with a title that is the file name, the listing shows the `<title>` of the HTML.
- `docs move`: it moves the document and its comments, so the ID changes.

A document is one HTML file, as the authoring guidelines tell. Images and other files with a relative path in a document do not load in the viewer. A document has only one version, its current content. Use git for older versions. `docs list` finds each word of the query in the title or the path. Commands that need a slashdocs server, such as `grants`, `labels`, `versions`, and `folders`, are not available with `--local`.

## Service accounts

```bash
slashdocs sa create report-bot
slashdocs sa key create sa_123 --name prod-ci
slashdocs sa key revoke sa_123 sak_123
```

Disable all `sa` commands in a packaged environment:

```bash
SLASHDOCS_DISABLE_SA_COMMANDS=1 slashdocs sa list
```

## MCP server

The slashdocs application server exposes a remote Streamable HTTP MCP endpoint at:

```bash
https://<your-slashdocs-host>/mcp
```

Connect that URL directly from an MCP client—there is no local MCP process or
CLI installation to manage. Interactive clients use the server's browser OAuth
flow. Headless clients can send a service-account key as an `Authorization:
Bearer …` header; create one in the slashdocs web application's service-account
settings.

The remote server exposes document, version, comment, sharing, and folder
operations, plus management of existing service accounts. It intentionally
does not expose service-account or bearer-key creation; use the web application
or CLI to mint credentials.

## Skills

Reinstall the agent skill that is bundled with the CLI:

```bash
slashdocs skills update
```

The command installs the `slashdocs` skill into `~/.agents/skills/slashdocs/SKILL.md` and `~/.claude/skills/slashdocs/SKILL.md`. The skill comes from the CLI binary, not from the server. Each CLI update also installs the skill of the new version.

## Updates

The CLI updates itself from the server it uses. It installs only a newer release that the slashdocs signing private key signs, so a server cannot make the CLI run code that the maintainers did not release. Builds get the matching public key at build time. See [docs/releasing.md](../docs/releasing.md#cli-signing-keys).

## Output

Use `--json` for machine-readable output. Without `--json`, commands print concise human-readable summaries.

## Exit codes

- `0`: success
- `1`: generic error
- `2`: usage error
- `3`: auth/permission error
- `4`: not found
- `5`: version conflict
- `6`: network error
