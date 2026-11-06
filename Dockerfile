# No `# syntax=` directive: nothing here needs more than the built-in BuildKit
# syntax, and skipping it avoids an extra registry pull at build time.

# Optional registry prefix for the base images, for builds that must go through
# a private pull-through cache (for example "registry.example.com/dockerhub/").
# Empty means Docker Hub.
ARG BASE_IMAGE_PREFIX=""

# Build on the native runner arch and cross-compile to the target arch, so the
# heavy npm/vite/Go work never runs under QEMU emulation.
FROM --platform=$BUILDPLATFORM ${BASE_IMAGE_PREFIX}node:22-alpine AS frontend
WORKDIR /src/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend ./
# Build the static app and iframe bridge bundles for the Go server, and the
# `slashdocs local` app for the CLI.
RUN npm run build
# Export the canonical bridge source fingerprint (all bridge sources plus
# resolved production deps) for the Go stage, which has no Node runtime. This
# is the same helper `make backend` uses, so the logic lives in one place.
RUN node scripts/bridge-source-hash.mjs > /src/bridge.source.hash

FROM --platform=$BUILDPLATFORM ${BASE_IMAGE_PREFIX}golang:1.27-alpine AS builder
ARG TARGETOS
ARG TARGETARCH
ARG SLASHDOCS_VERSION="dev"
ARG SLASHDOCS_COMMIT_SHA=""
# Base64 ed25519 public key of CLI releases. Without it, the CLIs that this
# image builds install no updates. See docs/releasing.md.
ARG SLASHDOCS_CLI_SIGNING_PUBLIC_KEY=""
WORKDIR /src
RUN apk add --no-cache git ca-certificates openssl
COPY go.mod go.sum ./
RUN go mod download
COPY . ./
COPY --from=frontend /src/api/internal/server/frontend_dist ./api/internal/server/frontend_dist
COPY --from=frontend /src/internal/render/bridge_dist ./internal/render/bridge_dist
COPY --from=frontend /src/cli/internal/cli/local_dist ./cli/internal/cli/local_dist
COPY --from=frontend /src/bridge.source.hash ./bridge.source.hash
# Release builds get the CLI signing private key as a BuildKit secret and sign
# each CLI binary. The CLI auto-updates only to binaries with a valid
# signature; the message must match signedMessage in cli/internal/cli/update.go.
# Builds without the key (CI checks, local builds) serve unsigned binaries. The
# build stops if the two signing keys do not match.
RUN --mount=type=secret,id=SLASHDOCS_CLI_SIGNING_PRIVATE_KEY \
    set -e; \
    key=/run/secrets/SLASHDOCS_CLI_SIGNING_PRIVATE_KEY; \
    if [ -s "$key" ] && [ "$(openssl pkey -in "$key" -pubout -outform DER | tail -c 32 | base64)" != "$SLASHDOCS_CLI_SIGNING_PUBLIC_KEY" ]; then \
      echo "SLASHDOCS_CLI_SIGNING_PRIVATE_KEY does not match SLASHDOCS_CLI_SIGNING_PUBLIC_KEY" >&2; exit 1; \
    fi; \
    mkdir -p api/internal/server/download_dist; \
    for target in darwin/arm64 darwin/amd64 linux/arm64 linux/amd64; do \
      os="${target%/*}"; arch="${target#*/}"; bin="api/internal/server/download_dist/slashdocs-$os-$arch"; \
      CGO_ENABLED=0 GOOS=$os GOARCH=$arch go build -trimpath -ldflags="-s -w -X github.com/razorpay/slashdocs/cli/internal/cli.Version=$SLASHDOCS_VERSION -X github.com/razorpay/slashdocs/cli/internal/cli.Commit=$SLASHDOCS_COMMIT_SHA -X github.com/razorpay/slashdocs/cli/internal/cli.SigningPublicKey=$SLASHDOCS_CLI_SIGNING_PUBLIC_KEY" -o "$bin" ./cli; \
      if [ -s "$key" ]; then \
        printf 'slashdocs %s %s/%s %s' "$SLASHDOCS_VERSION" "$os" "$arch" "$(sha256sum "$bin" | cut -d' ' -f1)" > /tmp/release-message; \
        openssl pkeyutl -sign -rawin -inkey "$key" -in /tmp/release-message -out "$bin.sig"; \
      fi; \
    done
RUN BRIDGE_SOURCE_HASH="$(cat bridge.source.hash)" && test "${#BRIDGE_SOURCE_HASH}" -eq 64 && CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -ldflags="-s -w -X github.com/razorpay/slashdocs/api/internal/server.BuildVersion=$SLASHDOCS_VERSION -X github.com/razorpay/slashdocs/api/internal/server.BuildCommit=$SLASHDOCS_COMMIT_SHA -X github.com/razorpay/slashdocs/api/internal/server.BuildBridgeSourceHash=$BRIDGE_SOURCE_HASH" -o /out/slashdocs-server ./api/cmd/slashdocs-server
RUN env CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -ldflags="-s -w -X github.com/razorpay/slashdocs/cli/internal/cli.Version=$SLASHDOCS_VERSION -X github.com/razorpay/slashdocs/cli/internal/cli.Commit=$SLASHDOCS_COMMIT_SHA -X github.com/razorpay/slashdocs/cli/internal/cli.SigningPublicKey=$SLASHDOCS_CLI_SIGNING_PUBLIC_KEY" -o /out/slashdocs ./cli

FROM ${BASE_IMAGE_PREFIX}alpine:3.23
ARG SLASHDOCS_COMMIT_SHA=""
# CA certs are arch-independent data files; copy them from the builder rather
# than running apk under emulation in the target-arch final stage.
COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
WORKDIR /app
COPY --from=builder /out/slashdocs-server /usr/local/bin/slashdocs-server
COPY --from=builder /out/slashdocs /usr/local/bin/slashdocs
EXPOSE 8080
ENV SLASHDOCS_PORT=8080
ENV SLASHDOCS_COMMIT_SHA=$SLASHDOCS_COMMIT_SHA
CMD ["slashdocs-server"]
