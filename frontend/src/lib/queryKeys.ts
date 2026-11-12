// React Query key factory. Keys share prefixes so related queries invalidate
// together.
export const queryKeys = {
  me: () => ["me"] as const,
  config: () => ["config"] as const,
  documents: () => ["documents"] as const,
  document: (id: string) => ["document", id] as const,
  versions: (doc: string) => ["versions", doc] as const,
  // load is the number of the frame load that the render URL is for, where
  // each load takes its own URL.
  // frame names the frame that asks: each one has its own tokens.
  render: (docId: string, version: string, load: number, frame: string) =>
    ["render", docId, version, load, frame] as const,
  comments: (doc: string) => ["comments", doc] as const,
  serviceAccounts: () => ["service-accounts"] as const,
  serviceAccountKeys: (id: string) => ["service-account-keys", id] as const,
  // Prefix key matching every folder listing (root and nested alike); use it
  // to invalidate after moves and deletes that can touch any folder.
  foldersAll: () => ["folders"] as const,
  folders: (folderId?: string) => ["folders", folderId || "root"] as const,
  folder: (id: string) => ["folder", id] as const,
  moveDestinationsAll: () => ["move-destinations"] as const,
  moveDestinations: (type: "document" | "folder", id: string, reveal?: string) =>
    ["move-destinations", type, id, "bootstrap", reveal || "initial"] as const,
  moveDestinationChildren: (
    type: "document" | "folder",
    id: string,
    parent: string | null,
    cursor?: string,
    anchor?: string,
    direction?: "before" | "after",
  ) =>
    [
      "move-destinations",
      type,
      id,
      "children",
      parent || "root",
      cursor || (anchor && direction ? `${direction}:${anchor}` : "initial"),
    ] as const,
  moveDestinationSearch: (type: "document" | "folder", id: string, query: string) =>
    ["move-destinations", type, id, "search", query] as const,
  // Prefix key matching folder access lists for every folder.
  folderAccessAll: () => ["folder-access"] as const,
  folderAccess: (id: string) => ["folder-access", id] as const,
  documentAccess: (id: string) => ["document-access", id] as const,
  documentAccessRequests: (id: string) => ["document-access-requests", id] as const,
  managedAccessRequests: () => ["access-requests"] as const,
  inbox: () => ["inbox"] as const,
  pins: () => ["pins"] as const,
  featured: () => ["featured"] as const,
  // Prefix key matching every people search. Grants change who is a contact.
  userSearchAll: () => ["users", "search"] as const,
  userSearch: (query: string) => ["users", "search", query] as const,
  approvers: (doc: string) => ["approvers", doc] as const,
  approvals: (doc: string, version?: string) =>
    ["approvals", doc, version || "current"] as const,
  // Prefix key matching approval decisions for every version of a document.
  approvalsAll: (doc: string) => ["approvals", doc] as const,
};
