// Shared domain constants for comment statuses and roles.
export const COMMENT_STATUS = {
  open: "open",
  resolved: "resolved",
} as const;
export type CommentStatus = (typeof COMMENT_STATUS)[keyof typeof COMMENT_STATUS];

export const COMMENT_FILTERS = ["all", "open", "resolved"] as const;
export type CommentFilter = (typeof COMMENT_FILTERS)[number];
export const COMMENT_FILTER_ALL: CommentFilter = "all";
export const DEFAULT_COMMENT_FILTER: CommentFilter = "open";

export function matchesCommentFilter(status: string, filter: CommentFilter): boolean {
  if (filter === COMMENT_FILTER_ALL) return true;
  return filter === COMMENT_STATUS.resolved
    ? status === COMMENT_STATUS.resolved
    : status !== COMMENT_STATUS.resolved;
}

export const ROLES = [
  { value: "viewer", label: "Viewer" },
  { value: "commenter", label: "Commenter" },
  { value: "editor", label: "Editor" },
] as const;
export const DEFAULT_ROLE = "commenter";
export const ROLE_RANK: Record<string, number> = {
  viewer: 1,
  commenter: 2,
  editor: 3,
  owner: 4,
};

export function canManageSharing(role?: string) {
  return (ROLE_RANK[role || ""] || 0) >= ROLE_RANK.editor;
}

// GENERAL_ACCESS_NONE is the sentinel role for "no general access" (the
// "anyone" grant is absent). The visible label comes from the server's
// everyone_label.
export const GENERAL_ACCESS_NONE = "none";

// Bot addresses end in `.bot`. The server enforces this; the client uses it
// only for inline hints.
export const BOT_DOMAIN_SUFFIX = ".bot";

// Example bot address shown in sharing placeholders and hints.
export const BOT_ADDRESS_EXAMPLE = "report-creator@brave.otter.bot";
