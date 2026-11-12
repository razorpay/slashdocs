#!/usr/bin/env bash
# End-to-end smoke test for the docker-compose stack.
#
#   scripts/e2e.sh        reset and boot an isolated slashdocs-e2e compose stack;
#                         exercise login, documents, comments, sharing,
#                         folders, rendering, and SSE; exits non-zero on the
#                         first failure. The stack is left running.
#   scripts/e2e.sh down   tear the isolated stack down, including volumes.
#
# Requirements: docker (with compose), go, curl, python3.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-slashdocs-e2e}"
APP="http://localhost:8080"          # SLASHDOCS_APP_ORIGIN in docker-compose.yml
RENDER="http://127.0.0.1:8080"       # SLASHDOCS_RENDER_ORIGIN (same listener, distinct origin)
DEX="http://localhost:5556"
DEV_USER="admin@example.com"         # static Dex user from dev/dex-config.yaml
DEV_PASSWORD="password"

cd "$ROOT"

if [[ "${1:-}" == "down" ]]; then
  exec docker compose down -v --remove-orphans
fi

TMP="$(mktemp -d)"
JAR="$TMP/cookies.txt"
SSE_PID=""
cleanup() {
  [[ -n "$SSE_PID" ]] && kill "$SSE_PID" 2>/dev/null || true
  rm -rf "$TMP"
}
trap cleanup EXIT

pass() { printf 'PASS  %s\n' "$1"; }
fail() {
  printf 'FAIL  %s\n' "$1" >&2
  exit 1
}

# jsonget <key>... : read JSON on stdin and print the value at the key path.
jsonget() {
  python3 -c '
import json, sys
d = json.load(sys.stdin)
for k in sys.argv[1:]:
    d = d[int(k)] if isinstance(d, list) else d[k]
print(d)
' "$@"
}

# api <curl args>... : curl against the stack, failing loudly on HTTP errors.
api() { curl -sS --fail-with-body "$@"; }

# --- Boot ------------------------------------------------------------------

# Authentication and migration checks require a deterministic database. Only
# the dedicated E2E project is reset; normal developer compose state is left
# untouched.
docker compose down -v --remove-orphans >/dev/null 2>&1 || true
if [[ -n "${SLASHDOCS_IMAGE:-}" ]]; then
  # CI already built and tagged the image, so never rebuild it. --pull missing
  # pulls only the images that are absent (Postgres, versitygw, Dex), and keeps
  # the pull_policy of slashdocs from pulling this local-only tag.
  docker compose up -d --no-build --pull missing
else
  # Test this checkout, tagged locally so it never replaces the published
  # razorpay/slashdocs:latest that a plain `docker compose up` runs.
  SLASHDOCS_IMAGE=slashdocs-e2e:local docker compose up -d --build
fi

for i in $(seq 1 120); do
  curl -sf "$APP/readyz" >/dev/null && break
  [[ "$i" == 120 ]] && fail "server ready ($APP/readyz did not come up)"
  sleep 2
done
pass "server ready ($APP/readyz)"

# --- Login: drive the OIDC code flow through Dex non-interactively ----------

LOGIN_URL="$(curl -sS -L -c "$JAR" -b "$JAR" -o "$TMP/login.html" -w '%{url_effective}' \
  "$APP/v1/auth/oidc/start?mode=web")"
[[ "$LOGIN_URL" == "$DEX"/* ]] || fail "login redirect (landed on $LOGIN_URL, expected Dex)"

# Dex's local connector serves a plain HTML form; POST the static credentials
# to its action URL and follow the redirects back through the slashdocs callback.
# (sed both extracts and HTML-unescapes; bash's ${var//&amp;/&} is unsafe here
# because bash 5.2 expands & in the replacement to the matched text.)
ACTION="$(grep -o 'action="[^"]*"' "$TMP/login.html" | head -1 \
  | sed 's/^action="//; s/"$//; s/\&amp;/\&/g')"
[[ -n "$ACTION" ]] || fail "login form (no form action found on $LOGIN_URL)"
[[ "$ACTION" == http* ]] || ACTION="$DEX$ACTION"

FINAL_URL="$(curl -sS -L -c "$JAR" -b "$JAR" -o /dev/null -w '%{url_effective}' \
  --data-urlencode "login=$DEV_USER" --data-urlencode "password=$DEV_PASSWORD" "$ACTION")"
[[ "$FINAL_URL" == "$APP"/* ]] || fail "login callback (landed on $FINAL_URL, expected $APP)"

ME="$(api -b "$JAR" "$APP/v1/me")"
grep -q "$DEV_USER" <<<"$ME" || fail "login session (/v1/me: $ME)"
pass "login via Dex OIDC as $DEV_USER"

# --- Service account + key via the API (session cookie) ---------------------

SA="$(api -b "$JAR" -H 'Content-Type: application/json' -H "Origin: $APP" \
  -d '{"label":"e2e-bot"}' "$APP/v1/service-accounts")"
SA_ID="$(jsonget id <<<"$SA")"
SA_TOKEN="$(jsonget key token <<<"$SA")"
[[ "$SA_ID" == sa_* && -n "$SA_TOKEN" ]] || fail "service account create ($SA)"
pass "service account created ($SA_ID)"

KEY="$(api -b "$JAR" -H 'Content-Type: application/json' -H "Origin: $APP" \
  -d '{"name":"e2e-key"}' "$APP/v1/service-accounts/$SA_ID/keys")"
SA_TOKEN="$(jsonget token <<<"$KEY")"
[[ "$SA_TOKEN" == slashdocs_sa_* ]] || fail "service account key create ($KEY)"
pass "service account key created"

USERS="$(api -b "$JAR" "$APP/v1/users?q=admin")"
grep -q "$DEV_USER" <<<"$USERS" || fail "users list ($USERS)"
DEV_USER_ID="$(jsonget items 0 id <<<"$USERS")"
DEV_USER_LABEL="$(python3 -c 'import json,sys; p=json.load(sys.stdin)["items"][0]; print(p.get("name") or p.get("email") or p["id"])' <<<"$USERS")"
[[ -n "$DEV_USER_ID" && -n "$DEV_USER_LABEL" ]] || fail "users list missing canonical identity ($USERS)"
pass "users listed"

CONFIG="$(api "$APP/v1/config")"
[[ "$(jsonget provider_name <<<"$CONFIG")" == "Dex" ]] || fail "config ($CONFIG)"
pass "config listed"

# --- CLI: push / pull / version documents as the service account ------------

go build -o "$TMP/slashdocs" ./cli
export XDG_CONFIG_HOME="$TMP/xdg" SLASHDOCS_NO_BROWSER=1
cli() { "$TMP/slashdocs" --server "$APP" --token "$SA_TOKEN" --json "$@"; }
pass "CLI built"

PNG="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
cat >"$TMP/report.html" <<EOF
<!doctype html>
<html>
  <head><meta charset="utf-8"><title>E2E Report</title></head>
  <body>
    <h1>Quarterly revenue report</h1>
    <p>Total revenue grew 42 percent.</p>
    <img alt="chart" src="data:image/png;base64,$PNG">
  </body>
</html>
EOF

DOC="$(cli docs create "$TMP/report.html" --title "E2E Report" | jsonget id)"
[[ "$DOC" == doc_* ]] || fail "document create ($DOC)"
pass "document pushed via CLI ($DOC)"

cli docs pull "$DOC" --out "$TMP/pulled.html" >/dev/null
diff -q "$TMP/report.html" "$TMP/pulled.html" >/dev/null || fail "pulled HTML differs from upload"
pass "document pulled back and diffed clean"

V1="$(cli docs show "$DOC" | jsonget current_version_id)"
sed 's/42 percent/43 percent/' "$TMP/report.html" >"$TMP/report-v2.html"
cli docs push "$DOC" "$TMP/report-v2.html" --summary "e2e: revise growth number" >/dev/null
V2="$(cli docs show "$DOC" | jsonget current_version_id)"
[[ "$V2" == ver_* && "$V2" != "$V1" ]] || fail "new version ($V1 -> $V2)"
VERSIONS="$(cli docs versions list "$DOC")"
grep -q "$V1" <<<"$VERSIONS" && grep -q "$V2" <<<"$VERSIONS" || fail "versions list ($VERSIONS)"
pass "new version created via CLI ($V2)"

cli docs list | grep -q "$DOC" || fail "docs list is missing $DOC"
pass "documents listed via CLI"

# --- Comments: structured mention, reply, resolve ---------------------------

CMT_PAYLOAD="$(python3 -c '
import json, sys
print(json.dumps({
  "version_id": sys.argv[1],
  "body": "🙂 ping @admin@example.com",
  "anchor": {"quote": "Total revenue grew 43 percent."},
  "mentions": [{
    "principal": {"type": "user", "id": sys.argv[2]},
    "offset": 8,
    "length": 18,
  }],
}))
' "$V2" "$DEV_USER_ID")"
CMT_RESPONSE="$(api -H "Authorization: Bearer $SA_TOKEN" \
  -H 'Content-Type: application/vnd.slashdocs.comment-mentions+json' \
  -d "$CMT_PAYLOAD" "$APP/v1/documents/$DOC/comments")"
CMT="$(jsonget id <<<"$CMT_RESPONSE")"
[[ "$CMT" == cmt_* ]] || fail "structured comment create ($CMT_RESPONSE)"
python3 -c '
import json, sys
d = json.load(sys.stdin)
assert d["body"] == "🙂 ping @admin@example.com"
assert "\u2063" not in d["body"]
m = d["mentions"]
assert len(m) == 1
assert m[0]["offset"] == 8
assert m[0]["length"] == 18
assert m[0]["principal"]["id"] == sys.argv[1]
' "$DEV_USER_ID" <<<"$CMT_RESPONSE" || fail "structured comment response ($CMT_RESPONSE)"

CMT_LIST="$(api -H "Authorization: Bearer $SA_TOKEN" "$APP/v1/documents/$DOC/comments")"
python3 -c '
import json, sys
d = json.load(sys.stdin)
c = next(item for item in d["items"] if item["id"] == sys.argv[1])
assert c["body"] == "🙂 ping @admin@example.com"
assert "\u2063" not in c["body"]
assert len(c["mentions"]) == 1
assert c["mentions"][0]["principal"]["id"] == sys.argv[2]
assert c["mentions"][0]["offset"] == 8 and c["mentions"][0]["length"] == 18
' "$CMT" "$DEV_USER_ID" <<<"$CMT_LIST" || fail "structured comment list ($CMT_LIST)"

COMMENTS_HUMAN="$("$TMP/slashdocs" --server "$APP" --token "$SA_TOKEN" docs comments list "$DOC")"
grep -Fq "mentions=@$DEV_USER_LABEL" <<<"$COMMENTS_HUMAN" \
  || fail "CLI mention annotation ($COMMENTS_HUMAN)"
pass "structured comment round-tripped cleanly ($CMT)"

cli docs comments reply "$DOC" "$CMT" --body "Net revenue." | jsonget id >/dev/null \
  || fail "comment reply"
pass "comment replied"

cli docs comments resolve "$DOC" "$CMT" >/dev/null
cli docs comments list "$DOC" --status resolved | grep -q "$CMT" || fail "comment not resolved"
pass "comment resolved"

# --- Share / grants ----------------------------------------------------------

cli docs grants add "$DOC" --to "$DEV_USER" --role commenter >/dev/null
ACCESS="$(cli docs grants list "$DOC")"
grep -q "$DEV_USER" <<<"$ACCESS" && grep -q commenter <<<"$ACCESS" \
  || fail "grant listing ($ACCESS)"
# The granted human session can now read the document too.
api -b "$JAR" "$APP/v1/documents/$DOC" >/dev/null || fail "granted session cannot read doc"
pass "document shared with $DEV_USER as commenter"

# --- Folders ------------------------------------------------------------------

FLD="$(cli folders create --title "E2E Folder" | jsonget id)"
[[ "$FLD" == fld_* ]] || fail "folder create ($FLD)"
cli docs move "$DOC" --folder-id "$FLD" >/dev/null
api -H "Authorization: Bearer $SA_TOKEN" "$APP/v1/folders/$FLD/documents" | grep -q "$DOC" \
  || fail "document not listed in folder"
pass "folder created and document moved in ($FLD)"

cli docs move "$DOC" --root >/dev/null
[[ "$(cli docs show "$DOC" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("parent_folder_id") or "")')" == "" ]] \
  || fail "document did not move back to root"
pass "document moved back to root"

cli docs move "$DOC" --folder-id "$FLD" >/dev/null
api -X DELETE -H "Authorization: Bearer $SA_TOKEN" "$APP/v1/folders/$FLD" >/dev/null
SHOW="$(cli docs show "$DOC")"
[[ "$(python3 -c 'import json,sys; print(json.load(sys.stdin).get("parent_folder_id") or "")' <<<"$SHOW")" == "" ]] \
  || fail "document did not survive folder deletion ($SHOW)"
pass "folder deleted; document survived to root"

# --- Render origin ------------------------------------------------------------

RENDER_URL="$(api -X POST -H "Authorization: Bearer $SA_TOKEN" \
  "$APP/v1/documents/$DOC/versions/$V2/render-token" | jsonget url)"
[[ "$RENDER_URL" == "$RENDER"/v/* ]] || fail "render URL not on render origin ($RENDER_URL)"

curl -sS -D "$TMP/render.headers" -o "$TMP/render.html" "$RENDER_URL"
grep -qi '^content-security-policy:.*frame-ancestors http://localhost:8080' "$TMP/render.headers" \
  || fail "render CSP missing frame-ancestors (headers: $(cat "$TMP/render.headers"))"
grep -qi '^x-content-type-options: nosniff' "$TMP/render.headers" \
  || fail "render missing X-Content-Type-Options"
grep -q 'sandbox="allow-scripts' "$TMP/render.html" || fail "render is not sandboxed in an iframe"
# The document lives inside the wrapper's srcdoc attribute, where +/= get
# HTML-escaped, so match an escape-free prefix of the embedded image.
grep -q "data:image/png;base64,${PNG%%+*}" "$TMP/render.html" \
  || fail "rendered HTML lost the embedded image"
pass "version rendered on render origin with sandbox CSP"

# The same path must 404 on the app origin: untrusted HTML never shares it.
APP_RENDER_STATUS="$(curl -s -o /dev/null -w '%{http_code}' "$APP${RENDER_URL#"$RENDER"}")"
[[ "$APP_RENDER_STATUS" == 404 ]] || fail "render leaked onto app origin (HTTP $APP_RENDER_STATUS)"
pass "render blocked on app origin (404)"

# --- SSE: KV events stream -----------------------------------------------------

curl -sS -N --max-time 20 -H "Authorization: Bearer $SA_TOKEN" \
  "$APP/v1/documents/$DOC/kv/events" >"$TMP/sse.log" &
SSE_PID=$!
sleep 1
api -X PATCH -H "Authorization: Bearer $SA_TOKEN" -H 'Content-Type: application/json' \
  -d '{"set":{"e2e_probe":"42"}}' "$APP/v1/documents/$DOC/kv" >/dev/null
for i in $(seq 1 10); do
  grep -q 'e2e_probe' "$TMP/sse.log" && break
  [[ "$i" == 10 ]] && fail "SSE stream never delivered the KV event ($(cat "$TMP/sse.log"))"
  sleep 1
done
kill "$SSE_PID" 2>/dev/null || true
wait "$SSE_PID" 2>/dev/null || true
SSE_PID=""
pass "SSE delivered KV event after patch"

echo
echo "All e2e checks passed. Stack is still running: open $APP"
echo "Tear it down with: scripts/e2e.sh down"
