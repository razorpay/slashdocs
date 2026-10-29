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
  parent_folder_id?: string;
  parent_folder?: { id: string; title: string };
  updated_at?: string;
  labels?: string[];
  // Search results only: the matching text. U+0002 and U+0003 surround each match.
  snippet?: string;
  // Folder listings only: the caller's effective role on this document.
  // Empty string means the caller owns the containing folder but has no direct
  // document role — they can eject the document via DELETE /v1/folders/{id}/documents/{doc_id}.
  caller_role?: string;
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
    status: string;
    confidence: number;
    matched_text: string;
  };
  created_at?: string;
  resolved_at?: string;
  edited?: boolean;
};
export type CommentPatch = {
  body?: string;
  status?: string;
  mentions?: CommentMention[];
};

const COMMENT_MENTIONS_MEDIA_TYPE = "application/vnd.slashdocs.comment-mentions+json";
export type Grant = {
  id: string;
  principal?: Principal;
  role: string;
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
  // Stream events other than KV changes set kind; presence and cursor events
  // carry data.
  kind?: "kv" | "document" | "comments" | "presence" | "cursor";
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
// under the body, and fractions of the width and height of that element.
export type CursorSpot = { path: string; x: number; y: number };
// A pointer position at time t, in milliseconds on the sender's clock. A
// hidden point means that the pointer left the document.
export type CursorPoint = CursorSpot & { t: number; hidden?: boolean };
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

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
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
  if (res.status === 204) return undefined as T;
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) {
    return (await res.json()) as T;
  }
  return (await res.text()) as T;
}

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
  listDocuments: (q?: string) => {
    const params = new URLSearchParams();
    if (q) {
      params.set("q", q);
      // Date modifiers such as on:today use the searcher's days.
      params.set("tz", Intl.DateTimeFormat().resolvedOptions().timeZone);
    }
    const qs = params.toString();
    return request<{ items: Document[] }>(`/v1/documents${qs ? `?${qs}` : ""}`);
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
  createVersion: (doc: string, base: string, summary: string, file: File) => {
    const fd = new FormData();
    fd.set("base_version_id", base);
    fd.set("change_summary", summary);
    fd.set("file", file);
    return request<Version>(`/v1/documents/${doc}/versions`, {
      method: "POST",
      body: fd,
    });
  },
  renderToken: (doc: string, version: string) =>
    request<{ token: string; url: string }>(
      `/v1/documents/${doc}/versions/${version}/render-token`,
      { method: "POST" },
    ),
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
  ) =>
    request<Comment>(`/v1/documents/${doc}/comments`, {
      method: "POST",
      ...(mentions.length > 0
        ? { headers: { "Content-Type": COMMENT_MENTIONS_MEDIA_TYPE } }
        : {}),
      body: JSON.stringify({
        version_id: version,
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
  patchComment: (doc: string, id: string, patch: CommentPatch) =>
    request<Comment>(`/v1/documents/${doc}/comments/${id}`, {
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
  listFolders: (folderId?: string, path?: string, q?: string) => {
    const params = new URLSearchParams();
    if (folderId) params.set("folder_id", folderId);
    if (path) params.set("path", path);
    if (q) params.set("q", q);
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
