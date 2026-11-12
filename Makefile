SWAG := go run github.com/swaggo/swag/cmd/swag@v1.16.6
GOLANGCI_LINT_VERSION := v2.14.0
GOLANGCI_LINT_CACHE := $(CURDIR)/bin/.cache/golangci-lint
GOLANGCI_LINT_GOCACHE := $(CURDIR)/bin/.cache/go-build
JSONNET ?= jsonnet
JB ?= jb
SLASHDOCS_VERSION ?= dev-local-$(shell date +%Y%m%d%H%M%S)
SLASHDOCS_COMMIT ?= $(shell git rev-parse --short HEAD 2>/dev/null || true)
SLASHDOCS_CLI_SIGNING_PUBLIC_KEY ?=
E2E_COMPOSE_PROJECT ?= slashdocs-e2e
CLI_LDFLAGS := -X github.com/razorpay/slashdocs/cli/internal/cli.Version=$(SLASHDOCS_VERSION) -X github.com/razorpay/slashdocs/cli/internal/cli.Commit=$(SLASHDOCS_COMMIT) -X github.com/razorpay/slashdocs/cli/internal/cli.SigningPublicKey=$(SLASHDOCS_CLI_SIGNING_PUBLIC_KEY)
SERVER_LDFLAGS := -X github.com/razorpay/slashdocs/api/internal/server.BuildVersion=$(SLASHDOCS_VERSION) -X github.com/razorpay/slashdocs/api/internal/server.BuildCommit=$(SLASHDOCS_COMMIT)

.PHONY: swagger frontend backend cli cli-assets build build-frontend build-backend build-cli dashboards check-dashboards format lint bin/golangci-lint test ci e2e e2e-browser clean

swagger:
	$(SWAG) init \
		-g main.go \
		-d api/cmd/slashdocs-server,api/internal/server,api/internal/repo \
		-o api/internal/server/docs \
		--parseDependency \
		--parseInternal

frontend:
	cd frontend && npm ci && npm run build

backend: swagger frontend cli-assets
	@bridge_source_hash="$$(node frontend/scripts/bridge-source-hash.mjs)" && \
		if [ "$${#bridge_source_hash}" -ne 64 ]; then echo "invalid bridge source hash" >&2; exit 1; fi && \
		go build -ldflags "$(SERVER_LDFLAGS) -X github.com/razorpay/slashdocs/api/internal/server.BuildBridgeSourceHash=$$bridge_source_hash" -o bin/slashdocs-server ./api/cmd/slashdocs-server

# The CLI embeds the `slashdocs local` app, which the frontend build makes.
cli: frontend
	go build -ldflags "$(CLI_LDFLAGS)" -o bin/slashdocs ./cli

cli-assets: frontend
	mkdir -p api/internal/server/download_dist
	GOOS=darwin GOARCH=arm64 CGO_ENABLED=0 go build -ldflags "$(CLI_LDFLAGS)" -o api/internal/server/download_dist/slashdocs-darwin-arm64 ./cli
	GOOS=darwin GOARCH=amd64 CGO_ENABLED=0 go build -ldflags "$(CLI_LDFLAGS)" -o api/internal/server/download_dist/slashdocs-darwin-amd64 ./cli
	GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build -ldflags "$(CLI_LDFLAGS)" -o api/internal/server/download_dist/slashdocs-linux-arm64 ./cli
	GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -ldflags "$(CLI_LDFLAGS)" -o api/internal/server/download_dist/slashdocs-linux-amd64 ./cli

build: backend cli

build-frontend: frontend

build-backend: backend

build-cli: cli

dashboards:
	cd monitoring/grafana && $(JB) install && $(JSONNET) -J vendor slashdocs-dashboard.libsonnet | python3 -m json.tool > slashdocs-dashboard.json

check-dashboards: dashboards
	git diff --exit-code -- monitoring/grafana/slashdocs-dashboard.json

format:
	gofmt -w $$(find api cli -name '*.go' -not -path 'api/internal/server/docs/*')
	cd frontend && npm exec prettier -- --write --ignore-unknown --no-error-on-unmatched-pattern \
		../.github/**/*.{yml,yaml} \
		../charts/**/*.{yaml,yml} \
		../docs/**/*.md \
		../frontend/bridge/**/*.ts \
		../frontend/public/**/*.{html,css,js,json,svg} \
		../frontend/scripts/**/*.{js,ts,json} \
		../frontend/src/**/*.{ts,tsx,css,json} \
		../frontend/e2e/**/*.ts \
		../frontend/playwright.config.ts \
		../frontend/tests/**/*.ts \
		../skills/**/*.md \
		../*.{md,json,yaml,yml}

# Install the pinned linter locally when it is missing or has the wrong version.
bin/golangci-lint:
	@mkdir -p bin
	@if [ "$$(./bin/golangci-lint version 2>/dev/null | awk '{print $$4}')" != "$(patsubst v%,%,$(GOLANGCI_LINT_VERSION))" ]; then \
		curl -sSfL https://raw.githubusercontent.com/golangci/golangci-lint/$(GOLANGCI_LINT_VERSION)/install.sh | \
			sh -s -- -b ./bin $(GOLANGCI_LINT_VERSION); \
	fi

lint: bin/golangci-lint
	./bin/golangci-lint config verify
	cd api && ../bin/golangci-lint fmt --diff --config ../.golangci.yaml
	cd cli && ../bin/golangci-lint fmt --diff --config ../.golangci.yaml
	GOLANGCI_LINT_CACHE=$(GOLANGCI_LINT_CACHE) GOCACHE=$(GOLANGCI_LINT_GOCACHE) \
		./bin/golangci-lint run ./api/... ./cli/... ./internal/... ./skills/...
	cd frontend && npm run lint && npm run format:check

# Handler and repository tests run against a real PostgreSQL database: a
# disposable container via testcontainers, or the server named by
# SLASHDOCS_TEST_DATABASE_URL (see api/internal/testdb).
test: swagger frontend
	go test ./api/... ./cli/... ./internal/...
	cd frontend && npm test

ci: build test lint

# Boots the docker-compose dev stack (Postgres, versitygw, Dex, slashdocs) and runs
# the non-interactive end-to-end smoke test in scripts/e2e.sh. The stack is
# left running; tear it down with `scripts/e2e.sh down`.
e2e:
	scripts/e2e.sh

# Browser E2E is advisory and intentionally separate from `make ci`. Reuse a
# healthy local app + Dex stack when present; otherwise boot the isolated
# project and leave it running for inspection.
e2e-browser:
	@if curl -fsS http://localhost:8080/readyz >/dev/null 2>&1; then \
		if curl -fsS http://localhost:5556/dex/healthz >/dev/null 2>&1; then \
			echo "Using the running slashdocs + Dex stack."; \
		else \
			echo "slashdocs is already running on :8080, but the browser suite requires the local Dex provider on :5556." >&2; \
			exit 1; \
		fi; \
	else \
		COMPOSE_PROJECT_NAME=$(E2E_COMPOSE_PROJECT) SLASHDOCS_IMAGE=$${SLASHDOCS_IMAGE:-slashdocs-e2e:local} docker compose up -d --build --wait; \
	fi
	cd frontend && npm ci
	cd frontend && npm run e2e:install
	cd frontend && npm run e2e

clean:
	rm -rf bin
