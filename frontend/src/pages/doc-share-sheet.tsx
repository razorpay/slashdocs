import { useEffect, useMemo, useState, type ComponentPropsWithoutRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { errorMessage } from "@/lib/errors";
import { Copy, LockKeyhole, UsersRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/misc";
import {
  SheetBody,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  api,
  APIError,
  type AccessSource,
  type EffectiveAccessItem,
  type GoogleGroup,
} from "@/api";
import { publicURL } from "@/lib/config";
import { queryKeys } from "@/lib/queryKeys";
import {
  ROLES,
  DEFAULT_ROLE,
  GENERAL_ACCESS_NONE,
  ROLE_RANK,
  BOT_DOMAIN_SUFFIX,
  BOT_ADDRESS_EXAMPLE,
} from "@/lib/constants";

type PendingChange = {
  label: string;
  source: AccessSource;
  action: "update" | "revoke";
  newRole?: string;
};

export function ShareSheet({
  docId,
  resourceType = "document",
  resourceId,
  canManageAccess = true,
  onOpenAutoFocus,
  onInteractOutside,
}: {
  docId?: string;
  resourceType?: "document" | "folder";
  resourceId?: string;
  canManageAccess?: boolean;
  onOpenAutoFocus?: ComponentPropsWithoutRef<typeof SheetContent>["onOpenAutoFocus"];
  onInteractOutside?: ComponentPropsWithoutRef<
    typeof SheetContent
  >["onInteractOutside"];
}) {
  const id = resourceId || docId || "";
  const isFolder = resourceType === "folder";
  const q = useQueryClient();
  const accessKey = isFolder
    ? queryKeys.folderAccess(id)
    : queryKeys.documentAccess(id);
  const access = useQuery({
    queryKey: accessKey,
    queryFn: () => (isFolder ? api.folderAccess(id) : api.documentAccess(id)),
  });
  const config = useQuery({
    queryKey: queryKeys.config(),
    queryFn: () => api.getConfig(),
    staleTime: Infinity,
  });
  const [address, setAddress] = useState("");
  const [debouncedAddress, setDebouncedAddress] = useState("");
  const [shareMode, setShareMode] = useState<"people" | "groups">("people");
  const [selectedGroup, setSelectedGroup] = useState<GoogleGroup | null>(null);
  const [role, setRole] = useState(DEFAULT_ROLE);
  const [pendingChange, setPendingChange] = useState<PendingChange | null>(null);
  const shareURL = `${publicURL()}/app/${isFolder ? "folders" : "d"}/${id}`;
  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedAddress(address.trim()), 250);
    return () => window.clearTimeout(t);
  }, [address]);
  const userSearch = useQuery({
    queryKey: queryKeys.userSearch(debouncedAddress),
    queryFn: () => api.searchUsers(debouncedAddress),
    enabled:
      canManageAccess &&
      shareMode === "people" &&
      debouncedAddress.length >= 2 &&
      !debouncedAddress.includes(BOT_DOMAIN_SUFFIX),
    staleTime: 30_000,
  });
  const userSuggestions = userSearch.data?.items || [];
  const groupSearch = useQuery({
    queryKey: ["google-groups", "search", debouncedAddress],
    queryFn: () => api.searchGoogleGroups(debouncedAddress),
    enabled:
      canManageAccess &&
      shareMode === "groups" &&
      !!config.data?.google_groups_enabled &&
      debouncedAddress.length >= 2,
    staleTime: 30_000,
    retry: false,
  });
  const groupSuggestions = groupSearch.data?.items || [];

  const items = access.data?.items || [];
  const anyoneItem = items.find((i) => i.principal?.type === "anyone");
  const namedItems = items.filter(
    (i) => i.principal?.type !== "anyone" && i.principal?.id,
  );

  const anyoneDirectSource = useMemo(() => {
    if (!anyoneItem) return undefined;
    return anyoneItem.sources?.find((s) => s.resource_id === id);
  }, [anyoneItem, id]);

  const anyoneInheritedSource = useMemo(() => {
    if (!anyoneItem) return undefined;
    return anyoneItem.sources?.find((s) => s.resource_id !== id);
  }, [anyoneItem, id]);

  const anyoneEffectiveRole = anyoneItem?.effective_role || GENERAL_ACCESS_NONE;

  const directGrantId = (item: EffectiveAccessItem) =>
    item.sources?.find((s) => s.resource_id === id)?.grant_id;

  const inheritedSource = (item: EffectiveAccessItem) =>
    item.sources?.find((s) => s.resource_id !== id && s.grant_id);

  const invalidateAccess = () => {
    q.invalidateQueries({ queryKey: accessKey });
    q.invalidateQueries({ queryKey: queryKeys.folderAccessAll() });
    q.invalidateQueries({ queryKey: queryKeys.userSearchAll() });
  };

  const m = useMutation({
    mutationFn: () => {
      if (shareMode === "groups") {
        if (!selectedGroup) throw new Error("Select a verified Google Group.");
        return isFolder
          ? api.createFolderGoogleGroupGrant(id, selectedGroup.email, role)
          : api.createGoogleGroupGrant(id, selectedGroup.email, role);
      }
      return isFolder
        ? api.createFolderGrant(id, address.trim(), role)
        : api.createGrant(id, address.trim(), role);
    },
    onSuccess: () => {
      setAddress("");
      setSelectedGroup(null);
      toast.success("Access granted.");
      invalidateAccess();
    },
    onError: (e) => toast.error(errorMessage(e, "Couldn't share.")),
  });
  const updateGrant = useMutation({
    mutationFn: ({
      resourceId: rid,
      grantId,
      nextRole,
      sourceType,
    }: {
      resourceId: string;
      grantId: string;
      nextRole: string;
      sourceType: string;
    }) =>
      sourceType === "document"
        ? api.updateGrant(rid, grantId, nextRole)
        : api.updateFolderGrant(rid, grantId, nextRole),
    onSuccess: () => {
      toast.success("Access updated.");
      invalidateAccess();
      setPendingChange(null);
    },
    onError: (e) => toast.error(errorMessage(e, "Couldn't update access.")),
  });
  const revokeGrant = useMutation({
    mutationFn: ({
      resourceId: rid,
      grantId,
      sourceType,
    }: {
      resourceId: string;
      grantId: string;
      sourceType: string;
    }) =>
      sourceType === "document"
        ? api.deleteGrant(rid, grantId)
        : api.deleteFolderGrant(rid, grantId),
    onSuccess: () => {
      toast.success("Access revoked.");
      invalidateAccess();
      setPendingChange(null);
    },
    onError: (e) => toast.error(errorMessage(e, "Couldn't revoke access.")),
  });
  const updateDirectGrant = useMutation({
    mutationFn: ({ grantId, nextRole }: { grantId: string; nextRole: string }) =>
      isFolder
        ? api.updateFolderGrant(id, grantId, nextRole)
        : api.updateGrant(id, grantId, nextRole),
    onSuccess: () => {
      toast.success("Access updated.");
      invalidateAccess();
    },
    onError: (e) => toast.error(errorMessage(e, "Couldn't update access.")),
  });
  const revokeDirectGrant = useMutation({
    mutationFn: (grantId: string) =>
      isFolder ? api.deleteFolderGrant(id, grantId) : api.deleteGrant(id, grantId),
    onSuccess: () => {
      toast.success("Access revoked.");
      invalidateAccess();
    },
    onError: (e) => toast.error(errorMessage(e, "Couldn't revoke access.")),
  });
  const general = useMutation({
    mutationFn: async (next: string) => {
      if (next === GENERAL_ACCESS_NONE) {
        if (anyoneDirectSource?.grant_id) {
          if (isFolder) await api.deleteFolderGrant(id, anyoneDirectSource.grant_id);
          else await api.deleteGrant(id, anyoneDirectSource.grant_id);
        }
        return;
      }
      if (isFolder) await api.setFolderGeneralAccess(id, next);
      else await api.setGeneralAccess(id, next);
    },
    onSuccess: () => {
      toast.success("General access updated.");
      invalidateAccess();
      setPendingChange(null);
    },
    onError: (e) => toast.error(errorMessage(e, "Couldn't update general access.")),
  });

  const confirmPending = () => {
    if (!canManageAccess || !pendingChange) return;
    const { source, action, newRole } = pendingChange;
    if (action === "revoke") {
      revokeGrant.mutate({
        resourceId: source.resource_id,
        grantId: source.grant_id!,
        sourceType: source.resource_type,
      });
    } else if (newRole) {
      updateGrant.mutate({
        resourceId: source.resource_id,
        grantId: source.grant_id!,
        nextRole: newRole,
        sourceType: source.resource_type,
      });
    }
  };

  const handleInheritedChange = (item: EffectiveAccessItem, nextValue: string) => {
    if (!canManageAccess) return;
    const src = inheritedSource(item);
    if (!src?.grant_id) return;
    const label =
      item.principal?.name ||
      item.principal?.email ||
      item.principal?.id ||
      "this principal";
    if (nextValue === "revoke") {
      setPendingChange({ label, source: src, action: "revoke" });
    } else {
      setPendingChange({
        label,
        source: src,
        action: "update",
        newRole: nextValue,
      });
    }
  };

  const handleGeneralInheritedChange = (nextValue: string) => {
    if (!canManageAccess) return;
    if (!anyoneInheritedSource?.grant_id) return;
    const label = config.data?.everyone_label || "Everyone on this server";
    if (nextValue === GENERAL_ACCESS_NONE) {
      setPendingChange({
        label,
        source: anyoneInheritedSource,
        action: "revoke",
      });
    } else {
      setPendingChange({
        label,
        source: anyoneInheritedSource,
        action: "update",
        newRole: nextValue,
      });
    }
  };

  const everyoneLabel = config.data?.everyone_label || "Everyone on this server";
  const isPublic = config.data?.deployment === "public";
  const userPlaceholder = isPublic ? "user@gmail.com" : "user@org.example";
  const resourceLabel = isFolder ? "folder" : "document";

  return (
    <SheetContent
      aria-describedby={undefined}
      onOpenAutoFocus={onOpenAutoFocus}
      onInteractOutside={onInteractOutside}
    >
      <SheetHeader>
        <SheetTitle>Share {resourceLabel}</SheetTitle>
      </SheetHeader>
      <SheetBody>
        {pendingChange ? (
          <div className="space-y-3 rounded-lg border border-[var(--color-warning-border)] bg-[var(--color-warning-bg,var(--color-surface-muted))] p-4">
            <p className="text-sm font-medium">
              {pendingChange.action === "revoke" ? "Remove" : "Change"} access for{" "}
              {pendingChange.label}?
            </p>
            <p className="text-xs text-[var(--color-fg-muted)]">
              This access is inherited from{" "}
              <span className="font-medium">{pendingChange.source.resource_title}</span>
              .
              {pendingChange.action === "revoke"
                ? " Removing it will affect everyone who accesses items through that folder."
                : " Changing it will affect everyone who accesses items through that folder."}
            </p>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => setPendingChange(null)}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                disabled={updateGrant.isPending || revokeGrant.isPending}
                onClick={confirmPending}
              >
                {pendingChange.action === "revoke"
                  ? "Remove from folder"
                  : "Change on folder"}
              </Button>
            </div>
          </div>
        ) : (
          <>
            {!canManageAccess ? (
              <div
                id="share-read-only-note"
                className="mb-4 flex gap-3 rounded-lg border border-[var(--color-danger)]/25 bg-[var(--color-danger)]/5 px-3 py-2.5 text-sm"
              >
                <LockKeyhole className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-danger)]" />
                <div>
                  <p className="font-medium">
                    Sharing is read-only for your access level.
                  </p>
                  <p className="mt-1 text-xs leading-5 text-[var(--color-fg-muted)]">
                    You can see who has access and copy the link, but you need at least
                    editor access to change sharing.
                  </p>
                </div>
              </div>
            ) : null}
            <form
              className={`space-y-3 ${canManageAccess ? "" : "opacity-55"}`}
              aria-describedby={!canManageAccess ? "share-read-only-note" : undefined}
              onSubmit={(e) => {
                e.preventDefault();
                if (!canManageAccess) return;
                m.mutate();
              }}
            >
              <fieldset
                disabled={!canManageAccess || m.isPending}
                className="space-y-3"
              >
                {config.data?.google_groups_enabled ? (
                  <div
                    className="grid grid-cols-2 gap-1 rounded-lg bg-[var(--color-surface-muted)] p-1"
                    role="tablist"
                    aria-label="Share target type"
                  >
                    <button
                      type="button"
                      role="tab"
                      aria-selected={shareMode === "people"}
                      className={`rounded-md px-2 py-1.5 text-xs font-medium ${shareMode === "people" ? "bg-[var(--color-surface)] shadow-sm" : "text-[var(--color-fg-muted)]"}`}
                      onClick={() => {
                        setShareMode("people");
                        setAddress("");
                        setSelectedGroup(null);
                      }}
                    >
                      People and bots
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={shareMode === "groups"}
                      className={`rounded-md px-2 py-1.5 text-xs font-medium ${shareMode === "groups" ? "bg-[var(--color-surface)] shadow-sm" : "text-[var(--color-fg-muted)]"}`}
                      onClick={() => {
                        setShareMode("groups");
                        setAddress("");
                        setSelectedGroup(null);
                      }}
                    >
                      Google Groups
                    </button>
                  </div>
                ) : null}
                <div>
                  <Input
                    placeholder={
                      shareMode === "groups"
                        ? "Search group name or email"
                        : `${userPlaceholder}  or  ${BOT_ADDRESS_EXAMPLE}`
                    }
                    value={address}
                    onChange={(e) => {
                      setAddress(e.target.value);
                      if (shareMode === "groups") setSelectedGroup(null);
                    }}
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                  />
                  <p className="mt-1.5 text-[11px] text-[var(--color-fg-muted)]">
                    {shareMode === "groups"
                      ? "Select a server-verified organization group before sharing."
                      : isPublic
                        ? "Enter a full email, or add a bot by its address. People you share with appear as you type."
                        : "Search existing slashdocs users by email, or add a bot by its address."}
                  </p>
                  {shareMode === "groups" && selectedGroup ? (
                    <div className="mt-2 flex items-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2">
                      <UsersRound className="h-4 w-4 shrink-0" />
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium">
                          {selectedGroup.name || selectedGroup.email}
                        </div>
                        <div className="truncate text-xs text-[var(--color-fg-muted)]">
                          {selectedGroup.email}
                        </div>
                      </div>
                    </div>
                  ) : shareMode === "groups" && groupSuggestions.length > 0 ? (
                    <div className="mt-2 overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]">
                      {groupSuggestions.map((group) => (
                        <button
                          key={group.id}
                          type="button"
                          className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-[var(--color-surface-muted)]"
                          onClick={() => {
                            setSelectedGroup(group);
                            setAddress(group.email);
                          }}
                        >
                          <UsersRound className="h-4 w-4 shrink-0" />
                          <span className="min-w-0">
                            <span className="block truncate font-medium">
                              {group.name || group.email}
                            </span>
                            <span className="block truncate text-xs text-[var(--color-fg-muted)]">
                              {group.email}
                            </span>
                          </span>
                        </button>
                      ))}
                    </div>
                  ) : shareMode === "groups" && groupSearch.isFetching ? (
                    <div className="mt-2 text-xs text-[var(--color-fg-muted)]">
                      Searching Google Groups…
                    </div>
                  ) : shareMode === "groups" && groupSearch.error ? (
                    <div className="mt-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-[var(--color-danger)] dark:border-red-900/60 dark:bg-red-950/30">
                      Google Group search is temporarily unavailable. Try again shortly.
                    </div>
                  ) : shareMode === "groups" && debouncedAddress.length >= 2 ? (
                    <div className="mt-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-3 py-2 text-xs text-[var(--color-fg-muted)]">
                      No verified organization groups matched that search.
                    </div>
                  ) : userSuggestions.length > 0 ? (
                    <div className="mt-2 overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]">
                      {userSuggestions.map((u) => (
                        <button
                          key={u.id || u.email}
                          type="button"
                          className="block w-full px-3 py-2 text-left text-sm hover:bg-[var(--color-surface-muted)]"
                          onClick={() => setAddress(u.email || "")}
                        >
                          <div className="font-medium">{u.name || u.email}</div>
                          {u.name && u.email ? (
                            <div className="text-xs text-[var(--color-fg-muted)]">
                              {u.email}
                            </div>
                          ) : null}
                        </button>
                      ))}
                    </div>
                  ) : debouncedAddress.length >= 2 &&
                    !debouncedAddress.includes(BOT_DOMAIN_SUFFIX) &&
                    !userSearch.isFetching ? (
                    <div className="mt-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-3 py-2 text-xs text-[var(--color-fg-muted)]">
                      {isPublic
                        ? "None of your contacts match. Enter a full email to share with someone else. They need to sign in once first."
                        : "No matching slashdocs users. They need to sign in once before you can share with them."}
                    </div>
                  ) : null}
                </div>
                <select
                  value={role}
                  onChange={(e) => setRole(e.target.value)}
                  aria-label="Access role"
                  className="h-9 w-full rounded-sm border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm disabled:cursor-not-allowed"
                >
                  {ROLES.map((r) => (
                    <option key={r.value} value={r.value}>
                      {r.label}
                    </option>
                  ))}
                </select>
                <Button
                  className="w-full"
                  type="submit"
                  disabled={
                    !canManageAccess ||
                    !address.trim() ||
                    (shareMode === "groups" && !selectedGroup) ||
                    m.isPending
                  }
                >
                  Share
                </Button>
              </fieldset>
            </form>
            <div className="mt-6">
              <h4 className="mb-2 text-xs font-medium uppercase tracking-wider text-[var(--color-fg-muted)]">
                People and groups with access
              </h4>
              <div className="space-y-1">
                {access.isLoading ? (
                  <>
                    <Skeleton className="h-9 w-full" />
                    <Skeleton className="h-9 w-full" />
                  </>
                ) : access.error ? (
                  <div className="text-xs text-[var(--color-danger)]">
                    {access.error instanceof APIError &&
                    access.error.code === "group_membership_unavailable"
                      ? "Google Group membership is temporarily unavailable. Access was not evaluated from stale data."
                      : "Could not load access list."}
                  </div>
                ) : namedItems.length === 0 ? (
                  <div className="text-xs text-[var(--color-fg-muted)]">
                    No people or bots added yet.
                  </div>
                ) : (
                  namedItems.map((item) => {
                    const grantId = directGrantId(item);
                    const src = inheritedSource(item);
                    const inherited = !!src;
                    const isGroup = item.principal.type === "google_group";
                    const isOwner = item.effective_role === "owner";
                    const principalLabel =
                      item.principal.name ||
                      item.principal.email ||
                      (isOwner ? "Owner" : item.principal.id);
                    return (
                      <div
                        key={item.principal.type + ":" + item.principal.id}
                        className="flex items-center justify-between gap-3 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm"
                      >
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5 truncate font-medium">
                            {isGroup ? (
                              <UsersRound className="h-3.5 w-3.5 shrink-0" />
                            ) : null}
                            {principalLabel}
                            {item.principal?.type === "service_account" ? " (bot)" : ""}
                          </div>
                          {item.principal?.name && item.principal?.email ? (
                            <div className="truncate text-xs text-[var(--color-fg-muted)]">
                              {item.principal.email}
                            </div>
                          ) : null}
                          <div className="truncate text-[11px] text-[var(--color-fg-muted)]">
                            {isOwner
                              ? "Owner"
                              : inherited && src
                                ? `Inherited from ${src.resource_title}`
                                : isGroup
                                  ? "Google Group · direct access"
                                  : "Direct access"}
                          </div>
                        </div>
                        {isOwner ? (
                          <span className="text-xs font-medium text-[var(--color-fg-muted)]">
                            Owner
                          </span>
                        ) : (
                          <select
                            value={item.effective_role}
                            disabled={
                              !canManageAccess ||
                              updateGrant.isPending ||
                              revokeGrant.isPending ||
                              updateDirectGrant.isPending ||
                              revokeDirectGrant.isPending
                            }
                            onChange={(e) => {
                              const next = e.target.value;
                              const inheritedRole = src?.role;
                              const reducingBelowInherited =
                                inheritedRole &&
                                (ROLE_RANK[next] || 0) <
                                  (ROLE_RANK[inheritedRole] || 0);
                              if (reducingBelowInherited) {
                                handleInheritedChange(item, next);
                              } else if (next === "revoke" && grantId) {
                                revokeDirectGrant.mutate(grantId);
                              } else if (grantId) {
                                updateDirectGrant.mutate({ grantId, nextRole: next });
                              } else {
                                handleInheritedChange(item, next);
                              }
                            }}
                            aria-label="Access role"
                            className="h-8 shrink-0 rounded-sm border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-sm disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            {ROLES.map((r) => (
                              <option key={r.value} value={r.value}>
                                {r.label}
                              </option>
                            ))}
                            <option value="revoke">Remove access</option>
                          </select>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
            </div>
            <div className="mt-6">
              <h4 className="mb-2 text-xs font-medium uppercase tracking-wider text-[var(--color-fg-muted)]">
                General access
              </h4>
              <div className="flex items-center justify-between gap-3 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm">
                <span className="truncate">{everyoneLabel}</span>
                <select
                  value={anyoneEffectiveRole}
                  disabled={!canManageAccess || general.isPending}
                  onChange={(e) => {
                    const next = e.target.value;
                    const inheritedRole = anyoneInheritedSource?.role;
                    if (
                      inheritedRole &&
                      (ROLE_RANK[next] || 0) < (ROLE_RANK[inheritedRole] || 0)
                    ) {
                      handleGeneralInheritedChange(next);
                    } else {
                      general.mutate(next);
                    }
                  }}
                  aria-label="General access role"
                  className="h-8 rounded-sm border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-sm disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <option value={GENERAL_ACCESS_NONE}>No access</option>
                  {ROLES.map((r) => (
                    <option key={r.value} value={r.value}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="mt-6 rounded-lg border border-dashed border-[var(--color-border)] bg-[var(--color-surface-muted)]/45 p-3">
              <div className="flex items-center justify-between gap-3">
                <div className="text-sm font-medium">
                  {isFolder ? "Folder" : "Document"} link
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="shrink-0"
                  onClick={async () => {
                    await navigator.clipboard.writeText(shareURL);
                    toast.success("Share link copied.");
                  }}
                >
                  <Copy className="h-4 w-4" /> Copy link
                </Button>
              </div>
            </div>
          </>
        )}
      </SheetBody>
    </SheetContent>
  );
}
