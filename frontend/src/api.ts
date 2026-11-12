import type { Replacement } from "@/lib/source-edits";

export type Principal = {
  type: "user" | "service_account" | "google_group" | "anyone";
  id: string;
  email?: string;
  name?: string;
  picture_url?: string;
};
export type CommentMentionPrincipal = Omit<Principal, "type"> & {
  type: "user" | "service_account";
};
export type CommentMentionPrincipalRef = Pick<CommentMentionPrincipal, "type" | "id">;
export type UserPrincipal = Omit<Principal, "type"> & { type: "user" };
export type CommentMention = {
  principal: CommentMentionPrincipal;
  offset: number;
  length: number;
};
export type Document = {
  id: string;
  title: string;
  owner?: Principal;
  current_version_id?: string;
  // The sequence number of the live document: each operation on it gets the
  // next one.
  seq?: number;
  parent_folder_id?: string;
  parent_folder?: { id: string; title: string };
  // Set on a single document: the reader may move it.
  can_move?: boolean;
  approval_status?: ApprovalStatus;
  approval_summary?: ApprovalSummary;
  updated_at?: string;
  labels?: string[];
  // Search results only: the matching text. U+0002 and U+0003 surround each match.
  snippet?: string;
};
export type ServerConfig = {
  deployment: "public" | "org";
  org_name: string;
  everyone_label: string;
  provider_name: string;
  google_groups_enabled: boolean;
  labels_enabled: boolean;
};
export type GoogleGroup = { id: string; email: string; name: string };
export type Version = {
  id: string;
  number: number;
  document_id?: string;
  created_by?: Principal;
  change_summary?: string;
  sha256?: string;
  created_at?: string;
  // The time of the last operation of the version.
  edited_at?: string;
  // The people whose operations the version holds.
  authors?: Principal[];
};
// The answer to a change of the content of a document: the version that
// the change made. unchanged says that the content was the same already:
// the answer is then the current version, and no version was made. seq is
// the seq of the document with the change.
export type SavedVersion = Version & { seq: number; unchanged?: boolean };
// The changes of a document after a seq, up to seq, which version_id holds.
// ops are the operations between the two, in order: the replacements of
// each one are at UTF-8 byte offsets of the source before it. typed says
// that the browser editor made every one, and authors are the people who
// made them, the newest first. sum is the CRC-32 of the source at seq.
export type DocumentChanges = {
  seq: number;
  version_id: string;
  ops: Replacement[][];
  typed: boolean;
  authors: Principal[];
  sum: number;
};
// An operation on the live document: replacements of the source at
// base_seq, by position. The server tells a repeat of an operation by its
// client_op_id.
export type Operation = {
  base_seq: number;
  client_op_id: string;
  replacements: Replacement[];
  summary?: string;
};
// What a document event tells of the document: its newest seq and the
// version that holds it. The event of an operation names its author, and
// whether they typed it. A small operation comes with the event: changes
// then turn the source at prev_seq into the source at seq.
export type DocumentEvent = {
  seq: number;
  version_id: string;
  typed?: boolean;
  authors?: Principal[];
  prev_seq?: number;
  changes?: DocumentChanges;
  // The people are done: the version is now a part of the history.
  sealed?: boolean;
  // A restore of an earlier state made the change, and updated_by is the
  // person who restored.
  restored?: boolean;
  updated_by?: Principal;
};
export type GitHubStatus = {
  connected: boolean;
  configured: boolean;
  login?: string;
  avatar_url?: string;
};
export type GitHubRawRequest = {
  owner: string;
  repo: string;
  path: string;
  ref: string;
};
export type GitHubRawResponse = GitHubRawRequest & { content: string };
export type Anchor = {
  quote: string;
  prefix?: string;
  suffix?: string;
  dom_path?: string;
  start_offset?: number;
  end_offset?: number;
  // Pins the comment to a spot in an element instead of to the quote, which
  // then holds the start of the element's text.
  point?: AnchorPoint;
};
// A spot in a rendered document: the element by its data-slashdocs-target
// value or id, and by its child-index path (neither for the body), a label
// for lists, and x and y as fractions of its box, outside 0 to 1 beside it.
// page_x and page_y are the spot in the page, in a viewport viewport_w wide,
// where the pin shows when its element is gone.
export type AnchorPoint = {
  target?: string;
  path?: string;
  label?: string;
  x: number;
  y: number;
  page_x?: number;
  page_y?: number;
  viewport_w?: number;
};
// REACTION_EMOJI is the closed set the server accepts. Values are stable ASCII
// slugs rather than literal emoji, so each client picks its own glyph.
export const REACTION_EMOJI = [
  "+1",
  "-1",
  "laugh",
  "hooray",
  "confused",
  "heart",
  "rocket",
  "eyes",
  "plus",
] as const;
export type ReactionEmoji = (typeof REACTION_EMOJI)[number];
export type CommentReaction = {
  emoji: string;
  count: number;
  reacted: boolean;
  // Optional when reading from a server that predates reactor identities.
  reactors?: Principal[];
};
export type Comment = {
  id: string;
  body: string;
  selected_text?: string;
  status: string;
  author: Principal;
  created_on_version_id: string;
  parent_comment_id?: string;
  root_comment_id?: string;
  // Optional only for rolling-upgrade reads from an older server. New servers
  // always return an array, including when it is empty.
  mentions?: CommentMention[];
  // Optional for the same reason as mentions.
  reactions?: CommentReaction[];
  anchor?: Anchor;
  replies?: Comment[];
  current_placement?: {
    status: "attached" | "orphaned" | "moved";
    confidence: number;
    matched_text: string;
  };
  created_at?: string;
  resolved_at?: string;
  edited?: boolean;
  // A thread with a message by someone else that the signed-in reader did
  // not read.
  unread?: boolean;
};
export type CommentPatch = {
  body?: string;
  status?: string;
  mentions?: CommentMention[];
  // Moves a point comment to a new spot, or gives a text comment the anchor
  // of its text after the reader typed in it.
  anchor?: Anchor;
  // The body that an edit started from. The server refuses the edit with 409
  // when the body is no longer this.
  base_body?: string;
};

const COMMENT_MENTIONS_MEDIA_TYPE = "application/vnd.slashdocs.comment-mentions+json";
export type Grant = {
  id: string;
  principal?: Principal;
  role: string;
};
export type ApprovalStatus = "approved" | "rejected" | "pending";
export type ApprovalDecision = "approved" | "rejected";
export type ApprovalSummary = {
  total: number;
  approved: number;
  rejected: number;
  pending: number;
};
export type ApprovalRequest = {
  id: string;
  document_id: string;
  approver: Principal;
  requested_by?: { id: string; email?: string };
};
export type Approval = {
  id: string;
  document_id: string;
  version_id: string;
  version_number: number;
  version_sha256: string;
  approver: Principal;
  decision: ApprovalDecision;
  note?: string;
  decided_at?: string;
};
export type ApprovalListItem = {
  id?: string;
  approver: Principal;
  decision: ApprovalDecision | null;
  note?: string;
  decided_at?: string;
  // The version the approver decided on: older than the listed version when
  // both have the same content.
  version_id?: string;
  version_number?: number;
  // Comment threads this approver started on the document.
  comments_open?: number;
  comments_total?: number;
  // A pending approver's most recent decision, made on other content.
  earlier?: { decision: ApprovalDecision; decided_at: string };
};
export type ApprovalsList = {
  version_id: string;
  version_number?: number;
  version_sha256?: string;
  status?: ApprovalStatus;
  summary: ApprovalSummary;
  items: ApprovalListItem[];
};
export type FolderBreadcrumb = {
  id: string;
  title: string;
};

export type Folder = {
  id: string;
  title: string;
  owner?: Principal;
  parent_folder_id?: string;
  ancestors?: FolderBreadcrumb[];
};
export type FolderEntry = {
  type: "folder" | "document";
  folder?: Folder;
  document?: Document;
  last_active?: string;
};
// FeaturedSection is a titled row of server-configured documents and folders.
// Users cannot hide the items of a permanent section.
export type FeaturedSection = {
  title: string;
  description?: string;
  permanent: boolean;
  items: FolderEntry[];
};
export type Pin = {
  resource_type: "document" | "folder";
  resource_id: string;
};
export type DocumentKVSnapshot = {
  revision: number;
  items: Record<string, unknown>;
};
export type DocumentKVChange = {
  key: string;
  value?: unknown;
  deleted?: boolean;
  revision: number;
  updated_at?: string;
  updated_by?: Principal;
  operation?: string;
};
export type DocumentKVPatch = {
  set?: Record<string, unknown>;
  delete?: string[];
};
export type DocumentKVPatchResult = {
  revision: number;
  changes: DocumentKVChange[];
  updated_by?: Principal;
};
export type DocumentKVEvent = {
  document_id: string;
  revision: number;
  changes: DocumentKVChange[];
  updated_at?: string;
  updated_by?: Principal;
  // Stream events other than KV changes set kind. Presence and cursor events
  // carry data, and a document event carries data: the newest seq and its
  // version, and the operation that made it when that is small.
  kind?: "kv" | "document" | "comments" | "approvals" | "presence" | "cursor";
  data?: unknown;
};
// A viewer's place in a document, published on the document event stream.
export type DocumentPresence = {
  session: string;
  version?: string;
  anchor?: Partial<Anchor>;
  left?: boolean;
  picture_url?: string;
};
// A place in a rendered document: the element at a path of child indexes
// under the body, and fractions of the width and height of that element. z is
// how much larger the element shows than its layout size, in a document that
// zooms itself. It is absent when the element is not zoomed.
export type CursorPlace = { path: string; x: number; y: number; z?: number };
// Where a viewer's pointer is, in v the place at the center of their view,
// which those who follow them show, in m their cursor chat message, in e the
// path of the block that holds their caret while they edit, in c the offset
// of the caret in the text of that block, in UTF-16 code units, and in a the
// offset of the other end of their selection in that block, when they
// selected text. A hidden spot means that the pointer left the document; it
// may still carry the view, the block, the caret and the selection end.
export type CursorSpot = CursorPlace & {
  v?: CursorPlace;
  m?: string;
  e?: string;
  c?: number;
  a?: number;
  hidden?: boolean;
};
// A pointer position at time t, in milliseconds on the sender's clock.
export type CursorPoint = CursorSpot & { t: number };
// A batch of pointer positions from one viewer session.
export type DocumentCursor = {
  session: string;
  version: string;
  points: CursorPoint[];
};
export type AccessSource = {
  resource_type: string;
  resource_id: string;
  resource_title: string;
  role: string;
  grant_id?: string;
};
export type EffectiveAccessItem = {
  principal: Principal;
  effective_role: string;
  sources: AccessSource[];
};
export type AccessRequest = {
  requester: Principal;
  requested_at: string;
};
export type DocumentAccessRequest = AccessRequest & {
  document_id: string;
  document_title: string;
};
// InboxItem is a thing that waits on the reader: a document to approve, or an
// open thread with a message that they did not read.
export type InboxItem = {
  kind: "approval" | "thread";
  document_id: string;
  document_title: string;
  comment_id?: string;
  // Who asked for the approval, or wrote the newest unread message, body.
  from: Principal;
  body?: string;
  at: string;
};
export type ServiceAccount = {
  id: string;
  name: string;
  disabled?: boolean;
  owner?: Principal;
};
export type ServiceAccountKey = { id: string; name: string };

export class APIError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

// send makes a request and throws an APIError for a response that is not ok.
async function send(path: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(path, {
    credentials: "include",
    ...init,
    headers: {
      ...(init.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
      ...(init.headers || {}),
    },
  });
  if (!res.ok) {
    let msg = res.statusText;
    let code = "http_error";
    let details: unknown;
    try {
      const payload = (await res.json()) as {
        error?: { message?: string; code?: string; details?: unknown };
      };
      msg = payload.error?.message || msg;
      code = payload.error?.code || code;
      details = payload.error?.details;
    } catch {}
    throw new APIError(res.status, code, msg, details);
  }
  return res;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await send(path, init);
  if (res.status === 204) return undefined as T;
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) {
    return (await res.json()) as T;
  }
  return (await res.text()) as T;
}

// A browser refuses a request that outlives its page when the bodies of
// all such requests on their way are larger than this together. keptAlive
// is the size of those bodies.
const KEEPALIVE_MAX = 64 * 1024;
let keptAlive = 0;

// requestKept is a request that outlives a page that goes, unless its body
// is too large for that with the others on their way.
async function requestKept<T>(path: string, init: RequestInit & { body: string }) {
  const size = new TextEncoder().encode(init.body).length;
  const keepalive = keptAlive + size <= KEEPALIVE_MAX;
  if (keepalive) keptAlive += size;
  try {
    return await request<T>(path, { ...init, keepalive });
  } finally {
    if (keepalive) keptAlive -= size;
  }
}
// A request of the live document that has no answer after this long fails,
// as on a network that does not answer. It then goes again.
const LIVE_TIMEOUT_MS = 10_000;

function mentionPayload(mentions: CommentMention[]) {
  return mentions.map((mention) => ({
    principal: {
      type: mention.principal.type,
      id: mention.principal.id,
    } satisfies CommentMentionPrincipalRef,
    offset: mention.offset,
    length: mention.length,
  }));
}

export type NotificationPreferences = { enabled: boolean; effective_enabled: boolean };
const notificationPath = (docId?: string) =>
  docId
    ? `/v1/documents/${encodeURIComponent(docId)}/notifications`
    : "/v1/me/notifications";

export const api = {
  notificationPreferences: (docId?: string) =>
    request<NotificationPreferences>(notificationPath(docId)),
  setNotificationPreferences: (enabled: boolean, docId?: string) =>
    request<NotificationPreferences>(notificationPath(docId), {
      method: "PUT",
      body: JSON.stringify({ enabled }),
    }),
  me: () =>
    request<{
      principal: Principal;
      user?: Principal;
      service_account?: unknown;
    }>("/v1/me"),
  loginURL: (redirect: string = location.pathname + location.search) =>
    `/v1/auth/google/start?mode=web&redirect=${encodeURIComponent(redirect)}`,
  logout: () => request<void>("/v1/auth/logout", { method: "POST" }),
  // One page of documents. has_more says that the next offset holds more.
  listDocuments: (q?: string, offset = 0) => {
    const params = new URLSearchParams();
    if (q) {
      params.set("q", q);
      // Date modifiers such as on:today use the searcher's days.
      params.set("tz", Intl.DateTimeFormat().resolvedOptions().timeZone);
    }
    if (offset) params.set("offset", String(offset));
    const qs = params.toString();
    return request<{ items: Document[]; has_more: boolean }>(
      `/v1/documents${qs ? `?${qs}` : ""}`,
    );
  },
  getDocument: (id: string) => request<Document>(`/v1/documents/${id}`),
  requestDocumentAccess: (id: string) =>
    request<{ status: "sent" }>(
      `/v1/documents/${encodeURIComponent(id)}/access-requests`,
      {
        method: "POST",
        body: JSON.stringify({}),
      },
    ),
  getConfig: () => request<ServerConfig>("/v1/config"),
  searchUsers: (q: string) =>
    request<{ items: UserPrincipal[] }>(`/v1/users?q=${encodeURIComponent(q)}`),
  searchGoogleGroups: (q: string) =>
    request<{ items: GoogleGroup[] }>(`/v1/google-groups?q=${encodeURIComponent(q)}`),
  createDocument: (title: string, file: File) => {
    const fd = new FormData();
    fd.set("title", title);
    fd.set("file", file);
    return request<{
      id: string;
      current_version_id: string;
      // Present when the server applied its configured default sharing
      // grant to the new document.
      default_grant?: { grant_id: string; role: string };
    }>("/v1/documents", {
      method: "POST",
      body: fd,
    });
  },
  listVersions: (doc: string) =>
    request<{ items: Version[] }>(`/v1/documents/${doc}/versions`),
  // Replaces the content of the document with a file. base names the state
  // that the person saw: the version, and the seq of the document when
  // people type in that version.
  createVersion: (
    doc: string,
    base: { version: string; seq?: number },
    summary: string,
    file: File,
  ) => {
    const fd = new FormData();
    fd.set("base_version_id", base.version);
    if (base.seq !== undefined) fd.set("base_seq", String(base.seq));
    fd.set("change_summary", summary);
    fd.set("file", file);
    return request<SavedVersion>(`/v1/documents/${doc}/versions`, {
      method: "POST",
      body: fd,
    });
  },
  // The source of a version, exactly as stored, or the source of the
  // document at a seq that the version holds, with the seq that the server
  // names for it. The source of the current version with no seq is the live
  // document. A leading byte order mark stays, because the server counts it
  // in the offsets of replacements.
  versionSource: async (doc: string, version: string, seq?: number) => {
    const res = await send(
      `/v1/documents/${doc}/versions/${version}/html${seq === undefined ? "" : `?seq=${seq}`}`,
    );
    const at = res.headers.get("X-Slashdocs-Seq") ?? "";
    return {
      source: new TextDecoder("utf-8", { ignoreBOM: true }).decode(
        await res.arrayBuffer(),
      ),
      seq: /^\d+$/.test(at) ? Number(at) : undefined,
    };
  },
  // Replaces ranges of the source at base_seq, by position, as one
  // operation. The server merges it into the live document. others are the
  // operations after base_seq, in order, on the source that the caller
  // made: they turn it into the source at seq, whose CRC-32 is sum. A retry
  // with the same client_op_id gives the answer of the first request. The
  // request outlives a page that goes (see requestKept). A request with no
  // answer in time fails, and can go again.
  sendOps: (doc: string, input: Operation) =>
    requestKept<{
      seq: number;
      version_id: string;
      others: Replacement[][];
      sum: number;
    }>(`/v1/documents/${doc}/ops`, {
      method: "POST",
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(LIVE_TIMEOUT_MS),
    }),
  // The changes of the document after the seq. A request with no answer in
  // time fails.
  documentChanges: (doc: string, after: number) =>
    request<DocumentChanges>(`/v1/documents/${doc}/changes?after=${after}`, {
      signal: AbortSignal.timeout(LIVE_TIMEOUT_MS),
    }),
  // Saves the content of an earlier version as the newest one.
  restoreVersion: (doc: string, version: string) =>
    request<SavedVersion>(`/v1/documents/${doc}/versions/${version}/restore`, {
      method: "POST",
    }),
  // The URL that renders a version. For a document with live state, seq is
  // the state of the document that the URL renders.
  renderToken: (doc: string, version: string) =>
    request<{ token: string; url: string; seq?: number }>(
      `/v1/documents/${doc}/versions/${version}/render-token`,
      { method: "POST" },
    ),
  listApprovers: (doc: string) =>
    request<{ items: ApprovalRequest[] }>(`/v1/documents/${doc}/approvers`),
  createApprover: (doc: string, address: string) =>
    request<ApprovalRequest>(`/v1/documents/${doc}/approvers`, {
      method: "POST",
      body: JSON.stringify({ address }),
    }),
  deleteApprover: (doc: string, approverId: string) =>
    request<undefined>(`/v1/documents/${doc}/approvers/${approverId}`, {
      method: "DELETE",
    }),
  listApprovals: (doc: string, version?: string) =>
    request<ApprovalsList>(
      `/v1/documents/${doc}/approvals${version ? `?version=${encodeURIComponent(version)}` : ""}`,
    ),
  // seq is the state of the document that the approver sees. The server
  // refuses a decision on a state that is not the newest one.
  createApproval: (
    doc: string,
    versionId: string,
    decision: ApprovalDecision,
    note?: string,
    seq?: number,
  ) =>
    request<Approval>(`/v1/documents/${doc}/approvals`, {
      method: "POST",
      body: JSON.stringify({ version_id: versionId, decision, note, seq }),
    }),
  deleteApproval: (doc: string, approvalId: string) =>
    request<undefined>(`/v1/documents/${doc}/approvals/${approvalId}`, {
      method: "DELETE",
    }),
  printToken: (doc: string, version: string) =>
    request<{ token: string; url: string }>(
      `/v1/documents/${doc}/versions/${version}/print-token`,
      { method: "POST" },
    ),
  getDocumentLabels: (doc: string) =>
    request<{ items: string[] }>(`/v1/documents/${doc}/labels`),
  replaceDocumentLabels: (doc: string, labels: string[]) =>
    request<{ items: string[] }>(`/v1/documents/${doc}/labels`, {
      method: "PUT",
      body: JSON.stringify({ labels }),
    }),
  githubStatus: () => request<GitHubStatus>("/v1/integrations/github"),
  githubConnectURL: (redirect = location.pathname + location.search) =>
    `/v1/integrations/github/start?redirect=${encodeURIComponent(redirect)}`,
  githubDisconnect: () =>
    request<void>("/v1/integrations/github", { method: "DELETE" }),
  githubRawContent: (doc: string, input: GitHubRawRequest) =>
    request<GitHubRawResponse>(`/v1/documents/${doc}/github/raw`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  listDocumentKV: (doc: string) =>
    request<DocumentKVSnapshot>(`/v1/documents/${doc}/kv`),
  patchDocumentKV: (doc: string, patch: DocumentKVPatch) =>
    request<DocumentKVPatchResult>(`/v1/documents/${doc}/kv`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  postDocumentPresence: (doc: string, presence: DocumentPresence) =>
    request<void>(`/v1/documents/${doc}/presence`, {
      method: "POST",
      body: JSON.stringify(presence),
    }),
  postDocumentCursor: (doc: string, cursor: DocumentCursor) =>
    request<void>(`/v1/documents/${doc}/cursor`, {
      method: "POST",
      body: JSON.stringify(cursor),
    }),
  // emoji stays a string: the only caller forwards a slug the server sent, and
  // narrowing it here would need a cast that asserts what the wire does not
  // guarantee. Values authored in this client come from REACTION_EMOJI, which
  // is already the literal union.
  setCommentReaction: (doc: string, comment: string, emoji: string, reacted: boolean) =>
    request<void>(
      `/v1/documents/${doc}/comments/${comment}/reactions/${encodeURIComponent(emoji)}`,
      { method: reacted ? "PUT" : "DELETE" },
    ),
  markCommentRead: (doc: string, thread: string) =>
    request<void>(`/v1/documents/${doc}/comments/${thread}/read`, { method: "PUT" }),
  listComments: (doc: string, version?: string) =>
    request<{ items: Comment[] }>(
      `/v1/documents/${doc}/comments${version ? `?version_id=${encodeURIComponent(version)}` : ""}`,
    ),
  createComment: (
    doc: string,
    version: string,
    body: string,
    quote: string,
    anchor?: Partial<Anchor>,
    mentions: CommentMention[] = [],
    // The seq of the document that the anchor is on, when the page knows it.
    seq?: number,
  ) =>
    request<Comment>(`/v1/documents/${doc}/comments`, {
      method: "POST",
      ...(mentions.length > 0
        ? { headers: { "Content-Type": COMMENT_MENTIONS_MEDIA_TYPE } }
        : {}),
      body: JSON.stringify({
        version_id: version,
        seq,
        body,
        mentions: mentionPayload(mentions),
        // Use the anchor captured from the render bridge, falling back to a
        // placeholder when the bridge supplied no selection offsets.
        anchor: {
          quote,
          prefix: anchor?.prefix ?? "",
          suffix: anchor?.suffix ?? "",
          dom_path: anchor?.dom_path ?? "body",
          start_offset: anchor?.start_offset ?? 0,
          end_offset: anchor?.end_offset ?? quote.length,
          ...(anchor?.point && { point: anchor.point }),
        },
      }),
    }),
  createCommentReply: (
    doc: string,
    id: string,
    body: string,
    mentions: CommentMention[] = [],
  ) =>
    request<Comment>(`/v1/documents/${doc}/comments/${id}/replies`, {
      method: "POST",
      ...(mentions.length > 0
        ? { headers: { "Content-Type": COMMENT_MENTIONS_MEDIA_TYPE } }
        : {}),
      body: JSON.stringify({ body, mentions: mentionPayload(mentions) }),
    }),
  // The change outlives a page that goes (see requestKept), as the new
  // anchor of a comment that the reader typed in does.
  patchComment: (doc: string, id: string, patch: CommentPatch) =>
    requestKept<Comment>(`/v1/documents/${doc}/comments/${id}`, {
      method: "PATCH",
      ...(patch.mentions !== undefined
        ? { headers: { "Content-Type": COMMENT_MENTIONS_MEDIA_TYPE } }
        : {}),
      body: JSON.stringify({
        ...patch,
        ...(patch.mentions !== undefined
          ? { mentions: mentionPayload(patch.mentions) }
          : {}),
      }),
    }),
  deleteComment: (doc: string, id: string) =>
    request<void>(`/v1/documents/${doc}/comments/${id}`, { method: "DELETE" }),
  createGrant: (doc: string, address: string, role: string) =>
    request<Grant>(`/v1/documents/${doc}/grants`, {
      method: "POST",
      body: JSON.stringify({ address, role }),
    }),
  createGoogleGroupGrant: (doc: string, email: string, role: string) =>
    request<Grant>(`/v1/documents/${doc}/grants`, {
      method: "POST",
      body: JSON.stringify({
        principal: { type: "google_group", email },
        role,
      }),
    }),
  // setGeneralAccess upserts the "anyone" grant (everyone who can reach this
  // server). Pass role "" / null to remove it (no general access).
  setGeneralAccess: (doc: string, role: string) =>
    request<Grant>(`/v1/documents/${doc}/grants`, {
      method: "POST",
      body: JSON.stringify({ principal: { type: "anyone" }, role }),
    }),
  updateGrant: (doc: string, grantId: string, role: string) =>
    request<Grant>(`/v1/documents/${doc}/grants/${grantId}`, {
      method: "PATCH",
      body: JSON.stringify({ role }),
    }),
  deleteGrant: (doc: string, grantId: string) =>
    request<void>(`/v1/documents/${doc}/grants/${grantId}`, {
      method: "DELETE",
    }),
  listServiceAccounts: () =>
    request<{ items: ServiceAccount[] }>("/v1/service-accounts"),
  createServiceAccount: (label: string, domain?: string) =>
    request<{
      id: string;
      label: string;
      name: string;
      key: { id: string; token: string };
    }>("/v1/service-accounts", {
      method: "POST",
      body: JSON.stringify(domain ? { label, domain } : { label }),
    }),
  renameDocument: (id: string, title: string) =>
    request<Document>(`/v1/documents/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ title }),
    }),
  deleteDocument: (id: string) =>
    request<void>(`/v1/documents/${id}`, { method: "DELETE" }),
  updateServiceAccount: (id: string, name: string, disabled: boolean) =>
    request<ServiceAccount>(`/v1/service-accounts/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ name, disabled }),
    }),
  listServiceAccountKeys: (id: string) =>
    request<{ items: ServiceAccountKey[] }>(`/v1/service-accounts/${id}/keys`),
  createServiceAccountKey: (id: string, name: string) =>
    request<{ id: string; token: string }>(`/v1/service-accounts/${id}/keys`, {
      method: "POST",
      body: JSON.stringify({ name }),
    }),
  revokeServiceAccountKey: (id: string, key: string) =>
    request<void>(`/v1/service-accounts/${id}/keys/${key}`, {
      method: "DELETE",
    }),
  // Folders
  // A q or a minRole searches every folder, and minRole keeps only the
  // folders where the reader has at least that role.
  listFolders: (folderId?: string, path?: string, q?: string, minRole?: string) => {
    const params = new URLSearchParams();
    if (folderId) params.set("folder_id", folderId);
    if (path) params.set("path", path);
    if (q) params.set("q", q);
    if (minRole) params.set("min_role", minRole);
    const qs = params.toString();
    return request<{ folder?: Folder; items: FolderEntry[]; has_more: boolean }>(
      `/v1/folders${qs ? `?${qs}` : ""}`,
    );
  },
  getFolder: (id: string) => request<Folder>(`/v1/folders/${id}`),
  createFolder: (title: string, parentFolderId?: string) =>
    request<Folder>("/v1/folders", {
      method: "POST",
      body: JSON.stringify({ title, parent_folder_id: parentFolderId || undefined }),
    }),
  updateFolder: (id: string, title?: string, parentFolderId?: string | null) =>
    request<Folder & { permission_warning?: { kind: string; message: string } }>(
      `/v1/folders/${id}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          ...(title ? { title } : {}),
          ...(parentFolderId !== undefined ? { parent_folder_id: parentFolderId } : {}),
        }),
      },
    ),
  deleteFolder: (id: string) =>
    request<void>(`/v1/folders/${id}`, { method: "DELETE" }),
  createFolderGrant: (id: string, address: string, role: string) =>
    request<Grant>(`/v1/folders/${id}/grants`, {
      method: "POST",
      body: JSON.stringify({ address, role }),
    }),
  createFolderGoogleGroupGrant: (id: string, email: string, role: string) =>
    request<Grant>(`/v1/folders/${id}/grants`, {
      method: "POST",
      body: JSON.stringify({
        principal: { type: "google_group", email },
        role,
      }),
    }),
  setFolderGeneralAccess: (id: string, role: string) =>
    request<Grant>(`/v1/folders/${id}/grants`, {
      method: "POST",
      body: JSON.stringify({ principal: { type: "anyone" }, role }),
    }),
  updateFolderGrant: (folderId: string, grantId: string, role: string) =>
    request<Grant>(`/v1/folders/${folderId}/grants/${grantId}`, {
      method: "PATCH",
      body: JSON.stringify({ role }),
    }),
  deleteFolderGrant: (folderId: string, grantId: string) =>
    request<void>(`/v1/folders/${folderId}/grants/${grantId}`, {
      method: "DELETE",
    }),
  listFolderDocuments: (id: string) =>
    request<{ items: Document[] }>(`/v1/folders/${id}/documents`),
  moveDocumentToFolder: (folderId: string, documentId: string) =>
    request<{
      document_id: string;
      moved: boolean;
      permission_warning?: { message: string };
    }>(`/v1/folders/${folderId}/documents`, {
      method: "POST",
      body: JSON.stringify({ document_id: documentId }),
    }),
  moveDocumentToRoot: (folderId: string, documentId: string) =>
    request<void>(`/v1/folders/${folderId}/documents/${documentId}`, {
      method: "DELETE",
    }),
  folderAccess: (id: string) =>
    request<{
      items: EffectiveAccessItem[];
      current_role: string;
    }>(`/v1/folders/${id}/access`),
  documentAccess: (id: string) =>
    request<{
      items: EffectiveAccessItem[];
      current_role: string;
    }>(`/v1/documents/${id}/access`),
  // An editor gets every request. Anyone else gets only their own.
  documentAccessRequests: (id: string) =>
    request<{ items: AccessRequest[] }>(`/v1/documents/${id}/access-requests`),
  // The requests on every document on which the reader manages access.
  managedAccessRequests: () =>
    request<{ items: DocumentAccessRequest[] }>("/v1/access-requests"),
  inbox: () => request<{ items: InboxItem[] }>("/v1/me/inbox"),
  declineAccessRequest: (doc: string, requester: Principal) =>
    request<void>(
      `/v1/documents/${doc}/access-requests/${requester.type}/${encodeURIComponent(requester.id)}`,
      { method: "DELETE" },
    ),
  // Pins
  listPins: () => request<{ items: Pin[] }>("/v1/pins"),
  putPin: (resourceType: string, resourceId: string) =>
    request<void>(`/v1/pins/${resourceType}/${resourceId}`, { method: "PUT" }),
  deletePin: (resourceType: string, resourceId: string) =>
    request<void>(`/v1/pins/${resourceType}/${resourceId}`, {
      method: "DELETE",
    }),
  // Featured items: documents and folders that the server shows to each user.
  listFeatured: () => request<{ items: FeaturedSection[] }>("/v1/featured"),
  hideFeatured: (resourceId: string) =>
    request<void>(`/v1/featured/${resourceId}`, { method: "DELETE" }),
};

export const docID = (d: Partial<Document>) => d.id || "";
export const docTitle = (d: Partial<Document>) => d.title || "Untitled";
export const currentVersionID = (d: Partial<Document>) => d.current_version_id || "";
export const versionID = (v: Partial<Version>) => v.id || "";
