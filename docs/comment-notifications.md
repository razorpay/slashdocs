# Comment notifications and links

Comments stay beside their highlighted text. The sidebar shows the total thread
count, including threads whose text is currently hidden or missing, with All,
Open, and Resolved filters. Opening a comment link selects its thread even if it
is resolved. Each comment and reply has a **Copy comment link** action.

## Personal notification controls

Use the bell beside the comment count to mute or enable notifications from that
document. In **Profile → Chat notifications**, switch notifications off globally.
The global switch overrides document settings. Muting affects only your account;
it does not change document access or anyone else's preferences. Re-enabling
starts with future activity, without replaying the muted backlog.

With Slack or Google Chat configured, each new comment or reply notifies the document's human
owner and explicitly mentioned human users. The author is excluded and recipients
are deduplicated; an owner who is also mentioned receives one mention notification.
Edits, reactions, resolving, and reopening do not notify. Service accounts can
write comments and receive structured mentions, but have no chat inbox.

Choose a person from the `@` suggestions to create a mention. The composer shows
accepted mentions below the text field. Pasting or typing around a tag preserves
it; editing the tag itself removes its association. Plain `@text` is not a tag.

## CLI workflows

Every command uses the current authenticated user or service account. Preferences
cannot be changed on someone else's behalf. Add `--json` for structured output.

```bash
# Global preference and effective per-document preference.
slashdocs notifications status --json
slashdocs notifications disable
slashdocs notifications enable
slashdocs docs notifications disable doc_123
slashdocs docs notifications status doc_123 --json
slashdocs docs notifications enable doc_123

# Repeated --mention flags create real tags, appending @email if absent.
slashdocs docs comments create doc_123 --version ver_123 \
  --quote 'Launch checklist' --body 'Please review' \
  --mention reviewer@example.com --mention owner@example.com

# File and stdin input avoid shell escaping for longer comments.
slashdocs docs comments reply doc_123 cmt_123 --body-file - \
  --mention reviewer@example.com < review.txt

# Stable principal IDs also work, including agents.
slashdocs docs comments reply doc_123 cmt_123 --body 'Follow up' \
  --mention sa:sa_123

# Mention changes require the updated body; editing does not send notifications.
slashdocs docs comments update doc_123 cmt_123 --body 'Updated request' \
  --mention user:usr_123
slashdocs docs comments update doc_123 cmt_123 --clear-mentions

# Discover headings; get a URL without launching a browser.
slashdocs docs headings doc_123 --json
slashdocs docs link doc_123 --heading launch-checklist
slashdocs docs link doc_123 --heading launch-checklist --version ver_123
slashdocs docs link doc_123 --comment cmt_123

# Resolved threads remain available to agents.
slashdocs docs comments list doc_123 --status resolved --json
```

The CLI resolves an email to an exact platform user and calculates structured
mention offsets, including Unicode. For `user:<id>` and `sa:<id>`, it uses `@<id>`
as the label. A matching standalone label already in the body is reused; otherwise
it is appended. Without `--mention`, the CLI never guesses recipients from prose.

## Heading links

Hover or focus a heading to reveal its **#** copy-link button (always visible on
touch devices). Existing HTML IDs are preserved. Headings without an ID receive
one derived from their text, with numeric suffixes to avoid collisions. For links
that should survive title edits or reordered headings, authors should supply
explicit stable IDs such as `<h2 id="launch-checklist">Launch checklist</h2>`.

Links follow the latest version unless `--version` is supplied. The headings API
lists stored HTML headings; headings generated only by JavaScript become available
in the viewer when created. Agents can link to a known runtime ID with
`docs link --heading`. Following a link opens enclosing `<details>` elements;
other custom interactions remain controlled by the document. Source HTML is not
rewritten by these viewer conveniences.

## Google Chat setup

Configure at most one provider: `SLASHDOCS_SLACK_BOT_TOKEN` or
`SLASHDOCS_GOOGLE_CHAT_WEBHOOK_URL`. The server refuses to start with both.
Recipients, mutes, retries, and content redaction are the same for every
provider.

Google Chat notifications go to one space through an incoming webhook, as a
card that names its recipient ("For: alice@example.com"). The space sees all
notifications, and a comment with several recipients posts once per recipient.

1. In Google Chat, open the space, then **Apps & integrations → Webhooks →
   Add webhook**, and copy the URL.
2. Set it as a secret; the URL itself grants posting rights:

   ```bash
   SLASHDOCS_GOOGLE_CHAT_WEBHOOK_URL='https://chat.googleapis.com/v1/spaces/…/messages?key=…&token=…'
   ```

Only `https://chat.googleapis.com/v1/spaces/…/messages` URLs are accepted.

### Content

Messages are cards: the activity (naming the comment's author, as in Slack) as
the header, the document title as the
subtitle, the highlighted text and comment as HTML-escaped paragraphs, and a
button to the comment. User content never appears in the message's top-level
text, where Google Chat would turn `<users/all>` into a real mention.

## Slack setup

Each deployment uses one Slack app. Platform and Slack email addresses must
match. Install the app with bot scopes
[`users:read`](https://docs.slack.dev/reference/scopes/users.read/) (required by Slack alongside email lookup),
[`users:read.email`](https://docs.slack.dev/reference/methods/users.lookupByEmail/),
[`im:write`](https://docs.slack.dev/reference/methods/conversations.open/), and
[`chat:write`](https://docs.slack.dev/reference/methods/chat.postMessage/).
No event subscriptions or inbound Slack webhook are required.
Enable **App Home → Messages Tab** so the bot can send DMs. It can be read-only;
this integration does not handle messages sent back to the bot. In an app
manifest, set `features.app_home.messages_tab_enabled` and
`features.app_home.messages_tab_read_only_enabled` to `true`.

The server reads the bot token from `SLASHDOCS_SLACK_BOT_TOKEN` at startup.
Keep the token in your secret store and inject it as an environment variable;
the application never reads secret-manager APIs itself. An unset or empty token
disables delivery and enqueueing.

On Kubernetes, put the token in a Secret and reference it through the chart's
`extraEnv` setting:

```yaml
extraEnv:
  - name: SLASHDOCS_SLACK_BOT_TOKEN
    valueFrom:
      secretKeyRef:
        name: slashdocs-secrets
        key: SLASHDOCS_SLACK_BOT_TOKEN
```

With a required `secretKeyRef`, Kubernetes prevents a pod from starting if the
Secret or key is missing. Keep `SLASHDOCS_APP_ORIGIN` set to the public
application origin so notification buttons point to the right deployment.
Rotate by updating the Secret and restarting the workload, then revoke the old
token after rollout. To offboard, remove the environment injection, revoke the
Slack token, and delete the Secret key.

## Delivery behavior

The comment and outbox recipients are saved in one database transaction. A worker
rechecks the recipient's current document access and notification settings before
sending a DM. Slack receives the document title, highlighted text, comment or
reply content, and a button linking to that exact comment. Replies include the
root thread's highlight. The activity leads the message and names the comment's
author by name (or email when no name is known), followed by
`Document: <title>` as a link, an italic Slack
blockquote, the comment, and a prominent **View comment** button. Regular Block
Kit blocks avoid the extra attribution footer Slack adds to attachments.
Text is rendered literally, without Slack mention
parsing or link unfurling. Titles are limited to 150 characters, highlights to
600, and comments to 2,200, with an ellipsis for longer content; the button opens
the full thread. Recognizable labeled passwords, API keys, access tokens, OTPs,
and card numbers are masked before sending, including in push-notification
fallback text. This masking is not a general-purpose sensitive-data classifier.

Successful delivery deletes the outbox row immediately. Missing or ineligible
Slack users are discarded. Temporary failures retry with backoff and Slack's
`Retry-After`; pending entries expire after 24 hours. A lease recovers jobs after
process crashes, and acknowledgements cannot delete a newer worker's claim.
Delivery is at least once: a crash after Slack accepts a message but before the
row is deleted can produce a duplicate. The first version processes one item per
second per worker and limits each recipient to one delivery per six seconds
across replicas. Preference/link APIs have a bounded per-principal request budget.

Tests exercise the queue against PostgreSQL and the Slack HTTP contract against
a local TLS mock. Enabling a real deployment requires its Slack app and bot token.
Local Compose accepts `SLASHDOCS_SLACK_BOT_TOKEN` from the launching process's
environment; when absent, it does not send Slack messages. The RAW workspace
integration check uses this same environment-variable contract and real Slack
delivery.


### Links to selected text

Selecting text shows two compact actions: comment and copy link. Copying a text
link preserves the viewed version. Opening it scrolls to the exact passage and
briefly highlights it, without creating a comment. Enclosing `<details>` sections
open automatically; content behind a custom tab is highlighted when that tab is
opened. If the passage is unavailable, the viewer shows a notice.

Agents can create the same links:

```sh
slashdocs docs link doc_123 --text "The selected passage" --version ver_123
slashdocs docs link doc_123 --text "Approved" --prefix "Launch: " --suffix " by the team"
```

`--prefix` and `--suffix` disambiguate repeated text. `--version` is optional in the
CLI; omitting it follows the latest version. Text is limited to 4,096 characters
and each context string to 64. The quote and context stay in the URL fragment,
not in requests to the server, and document access rules still apply. These are
Slashdocs links (`#text=...`); native Chromium text fragments do not target iframes.
