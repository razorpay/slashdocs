# Contributing to slashdocs

Thank you for your interest in contributing to slashdocs! This document outlines the process for contributing to this project.

## Code of Conduct

This project follows our [Code of Conduct](CODE_OF_CONDUCT.md). By participating, you are expected to uphold it.

## TLDR;

```bash
make build
make test
make format
```

## Development Process

We use a fork-based workflow for all contributions:

1. **Fork the repository**: Start by forking the [slashdocs repository](https://github.com/razorpay/slashdocs) to your GitHub account.

2. **Clone your fork**: Clone your fork to your local machine:

   ```bash
   git clone https://github.com/YOUR-USERNAME/slashdocs.git
   cd slashdocs
   ```

3. **Add upstream remote**: Add the original repository as an "upstream" remote:

   ```bash
   git remote add upstream https://github.com/razorpay/slashdocs.git
   ```

4. **Create a branch**: Create a new branch for your changes:

   ```bash
   git checkout -b username/feature
   ```

   Use a descriptive branch name that includes your username followed by a brief feature description.

5. **Make your changes**: Implement your changes, following the existing code style.

6. **Write tests**: Add tests for your changes when applicable.

7. **Run tests and formatting**: Make sure `make test` passes and run `make format` before committing.

8. **Commit your changes**: Make commits with clear messages following this format:

   ```bash
   git commit -m "type: description of the change"
   ```

   Where `type` is one of:
   - `feat`: for adding new features
   - `fix`: for bug fixes
   - `ref`: for code refactoring
   - `test`: for adding tests
   - `chore`: for tooling, CI, and other maintenance work

   Example: `git commit -m "feat: add comment threads to the review panel"`

9. **Keep your branch updated**: Regularly sync your branch with the upstream repository:

   ```bash
   git fetch upstream
   git rebase upstream/master
   ```

10. **Push to your fork** and open a pull request against `razorpay/slashdocs`.

## Pull Request Process

1. Fill out the pull request template with all relevant information.
2. Link any related issues in the pull request description.
3. Ensure all status checks pass.
4. Wait for review from maintainers and address any feedback.
5. Once approved, a maintainer will merge your changes.

## Local Development Setup

### Prerequisites

- Go 1.27 or later
- Node.js 22.18 or later (the React frontend is built with Vite and embedded into the Go binary)
- Postgres 14+
- S3-compatible object storage (the compose stack uses versitygw)
- For the compose stack and image builds: Docker with Compose v2 and the Buildx plugin (`docker buildx version` should work; on Ubuntu or Debian, `sudo apt install docker-buildx`)

### Setting up the Development Environment

1. Clone your fork of the repository (see above).

2. Install Go dependencies:

   ```bash
   go mod download
   ```

3. Configure the server. Copy [`.env.example`](.env.example) to `.env` and fill it in — it documents every variable (Postgres DSN, blob storage, OIDC credentials, session secret, app/render origins).

### Building

```bash
make build           # server (with embedded frontend + CLI assets) and CLI
make build-backend   # API server only (also rebuilds frontend and CLI assets)
make build-cli       # CLI only
make build-frontend  # embedded frontend assets
make swagger         # regenerate OpenAPI docs
```

Binaries are written to `bin/slashdocs-server` and `bin/slashdocs`.

### Running the Server Locally

```bash
set -a && source .env && set +a
./bin/slashdocs-server
```

### Running Tests

```bash
make test
```

This regenerates the Swagger docs, rebuilds and type-checks the frontend, runs the Go API and CLI tests, and runs the frontend unit tests with `npm test`. The frontend tests use the type stripping built into Node.js 22.18 and later. Handler and repository tests run against a real PostgreSQL database: with Docker available they start a disposable `postgres:17-alpine` container automatically (via testcontainers); otherwise set `SLASHDOCS_TEST_DATABASE_URL` to a PostgreSQL server whose role may `CREATE DATABASE`. Without either, the database-backed tests are skipped.

On macOS with [colima](https://github.com/abiosoft/colima), point testcontainers at the colima socket first:

```bash
export DOCKER_HOST="unix://$HOME/.colima/default/docker.sock"
export TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=/var/run/docker.sock
```

The optional browser suite exercises the real UI and Dex login flow in
headless Chromium:

```bash
make e2e-browser
```

The target reuses a healthy slashdocs + Dex stack already listening on ports 8080
and 5556; otherwise it boots the isolated `slashdocs-e2e` project, installs the
matching Chromium build, and leaves the stack up for debugging. For a manual
frontend-only run, use `npm ci`, `npm run e2e:install`, and `npm run e2e` from
`frontend/`. On Linux, if Playwright reports missing browser libraries, run
`npx playwright install --with-deps chromium` once. Remove an isolated E2E
project and its volumes with `scripts/e2e.sh down`; use `docker compose down -v`
for the normal quickstart project. Browser E2E is advisory and is not part of
`make ci`.

### Formatting

```bash
make format
```

Runs `gofmt` over the Go packages and Prettier over the frontend, charts, and docs.

## Documentation

When adding new features or modifying existing ones, please update the documentation accordingly. This includes:

- Code comments
- README updates
- [docs/self-hosting.md](docs/self-hosting.md) for anything operators need to know

## Getting Help

## Releases

Maintainers cut releases by pushing a `v*` tag; CI builds and publishes the
Docker image, CLI archives, and Helm chart from that tag. Contributors do not
need to touch versions or tags; see [docs/releasing.md](docs/releasing.md).

If you have questions or need help with the contribution process, please open a [GitHub issue](https://github.com/razorpay/slashdocs/issues).

Thank you for contributing to slashdocs!
