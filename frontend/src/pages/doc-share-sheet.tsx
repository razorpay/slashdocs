import { useEffect, useMemo, useState, type ComponentPropsWithoutRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { errorMessage } from "@/lib/errors";
import { Check, ChevronDown, Copy, LockKeyhole, UsersRound, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Combobox } from "@/components/ui/combobox";
import { Skeleton, useCopy } from "@/components/ui/misc";
import { RelativeTime } from "@/components/ui/relative-time";
import {
  Dropdown,
  DropdownContent,
  DropdownItem,
  DropdownSeparator,
  DropdownTrigger,
} from "@/components/ui/dropdown";
import {
  SheetBody,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  api,
  APIError,
  type AccessRequest,
  type AccessSource,
  type EffectiveAccessItem,
  type GoogleGroup,
  type Principal,
} from "@/api";
import { cn } from "@/lib/cn";
import { publicURL } from "@/lib/config";
import { queryKeys } from "@/lib/queryKeys";
import {
  ROLES,
  DEFAULT_ROLE,
  GENERAL_ACCESS_NONE,
  ROLE_RANK,
  BOT_DOMAIN_SUFFIX,
  ADDRESS_PATTERN,
} from "@/lib/constants";
import { PersonAvatar } from "./doc-comment-parts";

const GENERAL_ACCESS_OPTIONS = [
  { value: GENERAL_ACCESS_NONE, label: "No access" },
  ...ROLES,
];

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
  const accessRequests = useQuery({
    queryKey: queryKeys.documentAccessRequests(id),
    queryFn: () => api.documentAccessRequests(id),
    enabled: !isFolder && canManageAccess,
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
  const link = useCopy<HTMLParagraphElement>();
  const invite = useCopy();
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

  // The owner of a folder above gets editor without a grant.
  const ownedFolder = (item: EffectiveAccessItem) =>
    item.sources?.find((s) => s.resource_id !== id && !s.grant_id);

  const invalidateAccess = () => {
    q.invalidateQueries({ queryKey: accessKey });
    q.invalidateQueries({ queryKey: queryKeys.documentAccessRequests(id) });
    q.invalidateQueries({ queryKey: queryKeys.managedAccessRequests() });
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
      invalidateAccess();
    },
    // The error shows under the field, not as a toast.
    onError: () => {},
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
      invalidateAccess();
    },
    onError: (e) => toast.error(errorMessage(e, "Couldn't update access.")),
  });
  const revokeDirectGrant = useMutation({
    mutationFn: (grantId: string) =>
      isFolder ? api.deleteFolderGrant(id, grantId) : api.deleteGrant(id, grantId),
    onSuccess: () => {
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

  // changeRole sets a role, or "revoke". A change below a role that a folder
  // gives asks first, because it changes the folder.
  const changeRole = (item: EffectiveAccessItem, next: string) => {
    const grantId = directGrantId(item);
    const inheritedRole = inheritedSource(item)?.role;
    const reducingBelowInherited =
      inheritedRole && (ROLE_RANK[next] || 0) < (ROLE_RANK[inheritedRole] || 0);
    if (reducingBelowInherited) {
      handleInheritedChange(item, next);
    } else if (next === "revoke" && grantId) {
      revokeDirectGrant.mutate(grantId);
    } else if (grantId) {
      updateDirectGrant.mutate({ grantId, nextRole: next });
    } else {
      handleInheritedChange(item, next);
    }
  };

  // The people or groups that match the field. A user whose email is
  // already in the field was picked, so it shows no more. One who already
  // has access shows, but cannot be picked.
  const grantees = new Set(namedItems.map((i) => i.principal.email));
  const suggestions = (
    shareMode === "groups"
      ? selectedGroup
        ? []
        : groupSuggestions.map((g) => ({
            key: g.id,
            name: g.name || g.email,
            detail: g.email,
            address: g.email,
            group: g,
            icon: <GrantAvatar principal={{ type: "google_group", id: g.id }} />,
          }))
      : userSuggestions
          .filter((u) => u.email !== address.trim())
          .map((u) => ({
            key: u.id,
            name: u.name || u.email || u.id,
            detail: u.name ? u.email : undefined,
            address: u.email || "",
            group: null,
            icon: <GrantAvatar principal={u} />,
          }))
  ).map((s) => ({
    ...s,
    disabledNote: grantees.has(s.address) ? "Has access" : undefined,
  }));

  const everyoneLabel = config.data?.everyone_label || "Everyone on this server";
  const isPublic = config.data?.deployment === "public";
  const resourceLabel = isFolder ? "folder" : "document";
  // No user matches the field. On a public server the search finds only
  // contacts, so a share can still work. On an org server it finds every user,
  // so the share would fail.
  const noUserMatch =
    shareMode === "people" &&
    debouncedAddress.length >= 2 &&
    !debouncedAddress.includes(BOT_DOMAIN_SUFFIX) &&
    userSearch.isSuccess &&
    !userSearch.isFetching &&
    userSuggestions.length === 0;
  const noAccount = noUserMatch && !isPublic;
  const hint =
    shareMode === "groups"
      ? "Select a server-verified organization group before sharing."
      : noUserMatch
        ? isPublic
          ? "None of your contacts match. You can share with anyone who signed in once."
          : "No slashdocs user matches. They need to sign in once before you can share with them."
        : isPublic
          ? "Enter a full email, or add a bot by its address. People you share with appear as you type."
          : "Search existing slashdocs users by email, or add a bot by its address.";
  const changeMode = (mode: typeof shareMode) => {
    setShareMode(mode);
    setAddress("");
    setSelectedGroup(null);
    m.reset();
  };

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
                      onClick={() => changeMode("people")}
                    >
                      People and bots
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={shareMode === "groups"}
                      className={`rounded-md px-2 py-1.5 text-xs font-medium ${shareMode === "groups" ? "bg-[var(--color-surface)] shadow-sm" : "text-[var(--color-fg-muted)]"}`}
                      onClick={() => changeMode("groups")}
                    >
                      Google Groups
                    </button>
                  </div>
                ) : null}
                <div>
                  <Combobox
                    aria-label={
                      shareMode === "groups" ? "Google Group" : "Person or bot"
                    }
                    aria-invalid={!!m.error || undefined}
                    placeholder={
                      shareMode === "groups"
                        ? "Search group name or email"
                        : "Email or bot address"
                    }
                    value={address}
                    onValueChange={(next) => {
                      setAddress(next);
                      m.reset();
                      if (shareMode === "groups") setSelectedGroup(null);
                    }}
                    options={suggestions}
                    onPick={(s) => {
                      setSelectedGroup(s.group);
                      setAddress(s.address);
                    }}
                  />
                  {m.error ? (
                    <div className="mt-1.5 flex items-start gap-2">
                      <p role="alert" className="text-xs text-[var(--color-danger)]">
                        {errorMessage(m.error, "Couldn't share.")}
                      </p>
                      {/* With no account to share with, the link is the next step. */}
                      {noUserMatch ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="shrink-0"
                          onClick={() => invite.copy(shareURL)}
                        >
                          <CopyLabel copied={invite.copied} idle="Copy invite link" />
                        </Button>
                      ) : null}
                    </div>
                  ) : (
                    <p className="mt-1.5 text-xs text-[var(--color-fg-muted)]">
                      {hint}
                    </p>
                  )}
                  {shareMode === "people" ? null : selectedGroup ? (
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
                  ) : groupSuggestions.length > 0 ? null : groupSearch.isFetching ? (
                    <div className="mt-2 text-xs text-[var(--color-fg-muted)]">
                      Searching Google Groups…
                    </div>
                  ) : groupSearch.error ? (
                    <div className="mt-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-[var(--color-danger)] dark:border-red-900/60 dark:bg-red-950/30">
                      Google Group search is temporarily unavailable. Try again shortly.
                    </div>
                  ) : debouncedAddress.length >= 2 ? (
                    <div className="mt-2 text-xs text-[var(--color-fg-muted)]">
                      No verified organization groups matched that search.
                    </div>
                  ) : null}
                </div>
                <RoleMenu
                  label="Access role"
                  value={role}
                  options={ROLES}
                  onChange={setRole}
                  className="h-9 w-full"
                />
                <Button
                  className="w-full"
                  type="submit"
                  disabled={
                    !canManageAccess ||
                    (shareMode === "groups"
                      ? !selectedGroup
                      : !ADDRESS_PATTERN.test(address.trim()) || noAccount) ||
                    m.isPending
                  }
                >
                  Share
                </Button>
              </fieldset>
            </form>
            {accessRequests.data?.items.length ? (
              <div className="mt-6">
                <h4 className="mb-2 text-xs font-medium uppercase tracking-wider text-[var(--color-fg-muted)]">
                  Requests for access
                </h4>
                <div className="space-y-1">
                  {accessRequests.data.items.map((request) => (
                    <AccessRequestRow
                      key={request.requester.type + ":" + request.requester.id}
                      docId={id}
                      request={request}
                      onDone={invalidateAccess}
                    />
                  ))}
                </div>
              </div>
            ) : null}
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
                    const folder = ownedFolder(item);
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
                        <GrantAvatar principal={item.principal} />
                        <div className="min-w-0 flex-1">
                          <div className="truncate font-medium">
                            {principalLabel}
                            {item.principal?.type === "service_account" ? " (bot)" : ""}
                          </div>
                          {item.principal?.name && item.principal?.email ? (
                            <div className="truncate text-xs text-[var(--color-fg-muted)]">
                              {item.principal.email}
                            </div>
                          ) : null}
                          {isOwner ? null : (
                            <div className="truncate text-[11px] text-[var(--color-fg-muted)]">
                              {inherited && src
                                ? `Inherited from ${src.resource_title}`
                                : folder
                                  ? `Owner of ${folder.resource_title}`
                                  : isGroup
                                    ? "Google Group · direct access"
                                    : "Direct access"}
                            </div>
                          )}
                        </div>
                        {isOwner ? (
                          <span className="text-xs font-medium text-[var(--color-fg-muted)]">
                            Owner
                          </span>
                        ) : (
                          <RoleMenu
                            label="Access role"
                            value={item.effective_role}
                            options={ROLES}
                            disabled={
                              !canManageAccess ||
                              !(grantId || src) ||
                              updateGrant.isPending ||
                              revokeGrant.isPending ||
                              updateDirectGrant.isPending ||
                              revokeDirectGrant.isPending
                            }
                            onChange={(next) => changeRole(item, next)}
                            onRemove={() => changeRole(item, "revoke")}
                          />
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
                <RoleMenu
                  label="General access role"
                  value={anyoneEffectiveRole}
                  options={GENERAL_ACCESS_OPTIONS}
                  disabled={!canManageAccess || general.isPending}
                  onChange={(next) => {
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
                />
              </div>
            </div>
            <div className="mt-6 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-muted)]/45 p-3">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-medium">
                    {isFolder ? "Folder" : "Document"} link
                  </div>
                  <p
                    ref={link.ref}
                    className="select-all truncate text-xs text-[var(--color-fg-muted)]"
                  >
                    {shareURL}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="shrink-0"
                  onClick={() => link.copy(shareURL)}
                >
                  <CopyLabel copied={link.copied} idle="Copy link" />
                </Button>
              </div>
            </div>
          </>
        )}
      </SheetBody>
    </SheetContent>
  );
}

// CopyLabel says what the last copy did. After a failed copy, the reader can
// select the link under "Document link".
function CopyLabel({
  copied,
  idle,
}: {
  copied: ReturnType<typeof useCopy>["copied"];
  idle: string;
}) {
  if (copied === "done")
    return (
      <>
        <Check className="h-4 w-4" /> Copied
      </>
    );
  if (copied === "failed")
    return (
      <span
        role="status"
        className="flex items-center gap-1.5 text-[var(--color-danger)]"
      >
        <X className="h-4 w-4" /> Could not copy
      </span>
    );
  return (
    <>
      <Copy className="h-4 w-4" /> {idle}
    </>
  );
}

// GrantAvatar is the face of whoever has access. A group has none, so its
// icon takes the place.
function GrantAvatar({ principal }: { principal: Principal }) {
  if (principal.type !== "google_group")
    return <PersonAvatar who={principal} size={24} />;
  return (
    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--color-surface-muted)] text-[var(--color-fg-muted)]">
      <UsersRound className="h-3.5 w-3.5" />
    </span>
  );
}

// AccessRequestRow is a request for access: share with the requester in a
// role, or decline.
function AccessRequestRow({
  docId,
  request: { requester, requested_at },
  onDone,
}: {
  docId: string;
  request: AccessRequest;
  onDone: () => void;
}) {
  const [role, setRole] = useState<string>(DEFAULT_ROLE);
  // A bot has no email. Its name is its address.
  const address = requester.email || requester.name || "";
  const share = useMutation({
    mutationFn: () => api.createGrant(docId, address, role),
    onSuccess: onDone,
    onError: (e) => toast.error(errorMessage(e, "Couldn't share.")),
  });
  const decline = useMutation({
    mutationFn: () => api.declineAccessRequest(docId, requester),
    onSuccess: onDone,
    onError: (e) => toast.error(errorMessage(e, "Couldn't decline the request.")),
  });
  const busy = share.isPending || decline.isPending;
  return (
    // On a narrow screen, the actions go under the name.
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm">
      <PersonAvatar who={requester} size={24} />
      <div className="min-w-0 flex-1 basis-28">
        <div className="truncate font-medium">
          {requester.name || requester.email || requester.id}
          {requester.type === "service_account" ? " (bot)" : ""}
        </div>
        <div className="truncate text-xs text-[var(--color-fg-muted)]">
          {requester.name && requester.email ? `${requester.email} · ` : null}
          <RelativeTime iso={requested_at} prefix="Asked" />
        </div>
      </div>
      <div className="ml-auto flex items-center gap-2">
        <RoleMenu
          label={`Role for ${address}`}
          value={role}
          options={ROLES}
          onChange={setRole}
          disabled={busy}
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="shrink-0"
          disabled={!address || busy}
          aria-label={`Share with ${address}`}
          onClick={() => share.mutate()}
        >
          Share
        </Button>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="h-8 w-8 shrink-0"
          tooltip="Decline"
          disabled={busy}
          aria-label={`Decline ${address}`}
          onClick={() => decline.mutate()}
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

// RoleMenu picks a role. Its trigger looks like a field and shows the role,
// and a check marks the role in the menu. Remove access, when given, sits
// apart as a danger item.
function RoleMenu({
  label,
  value,
  options,
  onChange,
  onRemove,
  disabled,
  className,
}: {
  label: string;
  value: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  onChange: (value: string) => void;
  onRemove?: () => void;
  disabled?: boolean;
  className?: string;
}) {
  const current = options.find((o) => o.value === value)?.label ?? value;
  return (
    <Dropdown>
      <DropdownTrigger asChild disabled={disabled}>
        <button
          type="button"
          aria-label={`${label}: ${current}`}
          className={cn(
            "flex h-8 shrink-0 items-center justify-between gap-2 rounded-sm border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 text-sm transition-colors hover:bg-[var(--color-surface-muted)] disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-[var(--color-surface)]",
            className,
          )}
        >
          {current}
          <ChevronDown className="h-4 w-4 text-[var(--color-fg-muted)]" />
        </button>
      </DropdownTrigger>
      <DropdownContent className="min-w-40">
        {options.map((o) => (
          <DropdownItem
            key={o.value}
            onSelect={() => o.value !== value && onChange(o.value)}
          >
            <Check className={cn("h-4 w-4", o.value !== value && "invisible")} />
            {o.label}
          </DropdownItem>
        ))}
        {onRemove ? (
          <>
            <DropdownSeparator />
            <DropdownItem
              onSelect={onRemove}
              className="pl-8 text-[var(--color-danger)] data-[highlighted]:bg-red-50 dark:data-[highlighted]:bg-red-950/40"
            >
              Remove access
            </DropdownItem>
          </>
        ) : null}
      </DropdownContent>
    </Dropdown>
  );
}
