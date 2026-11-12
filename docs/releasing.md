# Releasing slashdocs

A release is a git tag. Pushing a tag that matches `v<major>.<minor>.<patch>`
(optionally with a pre-release suffix such as `v1.2.0-rc.1`) runs
[`.github/workflows/release.yml`](../.github/workflows/release.yml), which:

1. Builds the server image for `linux/amd64` and `linux/arm64` and pushes it to
   Docker Hub as `razorpay/slashdocs:<version>` and `razorpay/slashdocs:<major>.<minor>`.
   Stable releases also move `razorpay/slashdocs:latest`; pre-releases do not.
   The image contains the CLI binaries that the server serves, each signed
   with the [CLI signing private key](#cli-signing-keys).
2. Packages the Helm chart with `version` and `appVersion` set to the tag, so the
   chart defaults to the image that was just pushed.
3. Builds standalone CLI archives for Linux and macOS (amd64 and arm64) with
   GoReleaser, and publishes a GitHub Release containing the archives, a
   `checksums.txt`, the chart `.tgz`, and a changelog grouped from the commit
   messages since the previous tag.

The GitHub Release is created only after the image push succeeds, so release
notes never point at an image that does not exist.

## Who can release

Tag creation, update, and deletion on `v*` are restricted by a repository
ruleset to repository administrators. Everyone else contributes through pull
requests; merging to `master` requires a passing CI run and a review from a
code owner ([`.github/CODEOWNERS`](../.github/CODEOWNERS)).

## Cutting a release

```bash
git checkout master
git pull --ff-only
git tag -a v0.1.0 -m "slashdocs v0.1.0"
git push origin v0.1.0
```

Then watch the **Release** workflow under Actions. When it finishes:

- `docker pull razorpay/slashdocs:0.1.0` works on both architectures.
- The GitHub Release lists the CLI archives, `checksums.txt`, and `slashdocs-0.1.0.tgz`.

Edit the generated release notes afterwards if a highlight deserves a sentence
the commit messages do not give it.

## Versioning

- Tags are [semver](https://semver.org) with a `v` prefix. The version string
  baked into the server (`/commit.txt`, `slashdocs-server --version`) and the
  CLI (`slashdocs --version`) is the tag itself, for example `v0.1.0`.
- The image tag and chart version drop the `v`: `razorpay/slashdocs:0.1.0`,
  `slashdocs-0.1.0.tgz`.
- `charts/slashdocs/Chart.yaml` keeps a placeholder `version`/`appVersion` in
  git; the release workflow overrides both from the tag at package time.
- Breaking changes to the API, CLI flags, environment variables, or chart
  values bump the minor version while we are pre-1.0, and the major version
  after that. Call them out under **Breaking changes** in the release notes.

## Docker Hub credentials

`release.yml` logs in to Docker Hub with the organization-level Actions secrets
`PUBLIC_DOCKER_USERNAME` and `PUBLIC_DOCKER_PASSWORD`, the same pair the other
public Razorpay repositories use to publish under the `razorpay` Docker Hub
organization. They are already visible to this repository; nothing needs to be
added per repo. If they are ever rotated or renamed at the organization level,
update the two `secrets.*` references in `release.yml`.

`GITHUB_TOKEN` is provided automatically and is used to create the GitHub Release.

## Master images

Each commit that lands on `master` and passes the tests is published as
`razorpay/slashdocs:master` and `razorpay/slashdocs:sha-<commit>`, by the
**Docker image** job in [`ci.yml`](../.github/workflows/ci.yml). Use them to try
unreleased changes. Pull requests build the image but do not push it.

- `:master` moves with every commit. `:latest` moves only with a stable release
  tag.
- Master images sign their CLI binaries with the
  [CLI signing key](#cli-signing-keys), as releases do. Pull request builds get
  only the public key, so they serve unsigned binaries.
- A master build's version is the next patch after the latest stable tag, as a
  pre-release that counts the commits since that tag, for example
  `v0.2.1-master.12`. It ranks above the release before it and
  below the next release. Thus a CLI that talks to a master server updates to
  each new master build, and then to the next release.

## CLI signing keys

The CLI updates itself from the server it talks to, and that server can be
any URL that a user, a script, or an agent passes with `--server`. So the CLI
does not trust the server. It installs a binary only when:

- the binary has an ed25519 signature from the signing private key, over
  `slashdocs <version> <os>/<arch> <sha256 of the binary>`, and
- the version is newer than the version of the CLI.

The CLI also installs its agent skill from its own binary, not from the server.

The key pair lives in two repository Actions settings:

| Setting | Content | Use |
|---|---|---|
| Variable `SLASHDOCS_CLI_SIGNING_PUBLIC_KEY` | Base64 ed25519 public key | Build input `SLASHDOCS_CLI_SIGNING_PUBLIC_KEY`, set into the CLI with `-ldflags` |
| Secret `SLASHDOCS_CLI_SIGNING_PRIVATE_KEY` | ed25519 private key, PEM | BuildKit secret; the Docker build writes a `.sig` file next to each CLI binary |

The Dockerfile, GoReleaser, and the Makefile all read
`SLASHDOCS_CLI_SIGNING_PUBLIC_KEY`. A CLI built without it installs no updates.
`release.yml` stops if either setting is missing, and the Docker build stops
if the two keys do not match.

To create a key pair, for a new key or for a fork that publishes its own
releases:

```bash
openssl genpkey -algorithm ed25519 -out cli-signing-key.pem
openssl pkey -in cli-signing-key.pem -pubout -outform DER | tail -c 32 | base64
```

Store the second command's output as the `SLASHDOCS_CLI_SIGNING_PUBLIC_KEY`
variable, and the PEM file as the `SLASHDOCS_CLI_SIGNING_PRIVATE_KEY` secret.
Then delete the local PEM file, or keep it offline.
CLIs that have the old key cannot auto-update to a release signed with a new
key; their users reinstall once with `curl -fsSL https://<host>/install.sh | sh`.
If the private key leaks, change the key the same way.

Images built without the keys, for example from source, serve unsigned CLI
binaries. CLIs installed from such a server work, but they do not auto-update.

## Re-running a release

Workflows are idempotent per tag: re-running the **Release** workflow re-pushes
the same image tags and replaces the GitHub Release contents (`mode: replace`).
If a tag was cut by mistake, delete the GitHub Release first, then the tag;
Docker Hub tags must be removed by hand in the Hub UI.
