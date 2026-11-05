import { Page, PageHeader, SettingsNav } from "@/components/layout/page";
import { useTitle } from "@/lib/use-title";
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { errorMessage } from "@/lib/errors";
import { Bot, KeyRound, Plus, Power, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { CodeBlock, Skeleton } from "@/components/ui/misc";
import { LoadError } from "@/components/error-state";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { api, type ServiceAccount } from "@/api";
import { publicURL } from "@/lib/config";
import { queryKeys } from "@/lib/queryKeys";
import { BOT_DOMAIN_SUFFIX } from "@/lib/constants";
import { useFieldDraft } from "@/lib/field-drafts";
import { headlessCLI, keepOneTimeKey } from "@/lib/one-time-keys";
import { useIsMobile } from "@/lib/use-media-query";

// A bot address or a typed name: the label before the @, and the domain
// after it, if there is one.
function splitAddress(name: string) {
  const at = name.indexOf("@");
  return at < 0
    ? { label: name, domain: undefined }
    : { label: name.slice(0, at), domain: name.slice(at + 1) };
}

export function ServiceAccountsPage() {
  useTitle("Bots");
  const sas = useQuery({
    queryKey: queryKeys.serviceAccounts(),
    queryFn: api.listServiceAccounts,
  });
  const [creating, setCreating] = useState(false);
  const items = sas.data?.items || [];
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = items.find((s) => s.id === selectedId) || items[0] || null;
  // On a narrow screen the detail is under the list, so a bot that the
  // reader picks brings its detail into view.
  const stacked = useIsMobile();
  const [picked, setPicked] = useState(false);

  return (
    <Page lane="focus">
      <SettingsNav />
      <PageHeader
        title="Bots"
        description="Bots (service accounts in the API) are their own identities — share docs with them just like you would with a person. Use them for n8n workflows, scheduled jobs, or anything that runs without you."
        actions={
          <Button onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4" /> New bot
          </Button>
        }
      />
      <NewBotDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={(sa) => setSelectedId(sa.id)}
      />

      {/* minmax(0, 1fr) keeps long IDs and code from widening the columns. */}
      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 md:grid-cols-[220px_minmax(0,1fr)]">
        <div className="min-w-0 space-y-2">
          {sas.isLoading ? (
            <>
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </>
          ) : sas.error ? (
            <LoadError title="Could not load bots" query={sas} />
          ) : items.length === 0 ? (
            <div className="rounded-md border border-dashed border-[var(--color-border)] p-6 text-center text-sm text-[var(--color-fg-muted)]">
              No bots yet. Create one to share docs with it.
            </div>
          ) : (
            <ul className="space-y-1">
              {items.map((sa) => {
                const id = sa.id;
                const active = selected?.id === id;
                // The name before the @ tells bots apart, so it comes first.
                const { label, domain } = splitAddress(sa.name);
                return (
                  <li key={id}>
                    <button
                      onClick={() => {
                        setSelectedId(id);
                        setPicked(true);
                      }}
                      aria-current={active || undefined}
                      title={sa.name}
                      className="wash-link flex w-full items-center gap-3 rounded-sm px-3 py-2.5 text-left text-sm"
                    >
                      <Bot className="h-4 w-4 shrink-0 text-[var(--color-fg-muted)]" />
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-medium">{label}</div>
                        {domain && (
                          <div className="truncate font-mono text-[10px] text-[var(--color-fg-muted)]">
                            @{domain}
                          </div>
                        )}
                      </div>
                      {sa.disabled && <Badge variant="warning">disabled</Badge>}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* The first bot is selected when any loaded, so there is no prompt to pick one. */}
        <div className="min-w-0">
          {selected && (
            <ServiceAccountDetail
              key={selected.id}
              sa={selected}
              reveal={picked && stacked}
            />
          )}
        </div>
      </div>
    </Page>
  );
}

// The detail mounts for one bot, so its field and the callbacks of its
// mutations belong to that bot even when the reader selects another before
// a response comes. Those callbacks run after it unmounts too. reveal brings
// it into view as it mounts, with the focus on its heading.
function ServiceAccountDetail({ sa, reveal }: { sa: ServiceAccount; reveal: boolean }) {
  const { id, name, disabled = false } = sa;
  const q = useQueryClient();
  const url = publicURL();
  const heading = useRef<HTMLDivElement>(null);
  const revealed = useRef(reveal);
  useEffect(() => {
    if (!revealed.current) return;
    heading.current?.focus({ preventScroll: true });
    heading.current?.scrollIntoView({
      block: "start",
      behavior: matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "auto"
        : "smooth",
    });
  }, []);
  const keys = useQuery({
    queryKey: queryKeys.serviceAccountKeys(id),
    queryFn: () => api.listServiceAccountKeys(id),
  });
  // The words of the field belong to this bot, so they never move to another.
  const { text: keyName, setText: setKeyName } = useFieldDraft(`key-name:${id}`);
  const createKey = useMutation({
    // The key reaches the reader on any page, under the bot and the name sent.
    mutationFn: (sent: string) =>
      keepOneTimeKey(api.createServiceAccountKey(id, sent), (r) => ({
        bot: name,
        keyName: sent,
        token: r.token,
      })),
    onSuccess: (_, sent) => {
      // A name typed while the key was made stays for the next key.
      setKeyName((now) => (now.trim() === sent ? "" : now));
      q.invalidateQueries({ queryKey: queryKeys.serviceAccountKeys(id) });
    },
    onError: (e) => toast.error(errorMessage(e, `Could not make a key for ${name}`)),
  });
  const revokeKey = useMutation({
    mutationFn: (key: { id: string; name: string }) =>
      api.revokeServiceAccountKey(id, key.id),
    onSuccess: (_, key) => {
      toast.success(`Revoked key “${key.name}” of ${name}.`);
      q.invalidateQueries({ queryKey: queryKeys.serviceAccountKeys(id) });
    },
    onError: (e) => toast.error(errorMessage(e, "Could not revoke key")),
  });
  const toggle = useMutation({
    mutationFn: (off: boolean) => api.updateServiceAccount(id, name, off),
    onSuccess: (_, off) => {
      toast.success(`${off ? "Disabled" : "Enabled"} ${name}.`);
      q.invalidateQueries({ queryKey: queryKeys.serviceAccounts() });
    },
    onError: (e) => toast.error(errorMessage(e, "Could not update bot")),
  });

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
          {/* The app bar covers the top 3.5rem of a scrolled page. */}
          <div
            ref={heading}
            tabIndex={-1}
            className="min-w-0 scroll-mt-16 rounded-sm outline-none"
          >
            <CardTitle className="flex items-center gap-2 break-all">
              <Bot className="h-4 w-4 shrink-0" /> {name}
            </CardTitle>
            <div className="mt-1 break-all font-mono text-xs text-[var(--color-fg-muted)]">
              {id}
            </div>
          </div>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="outline" size="sm" busy={toggle.isPending}>
                <Power className="h-3.5 w-3.5" />
                {disabled ? "Enable" : "Disable"}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogTitle>
                {disabled ? "Enable" : "Disable"} “{name}”?
              </AlertDialogTitle>
              <AlertDialogDescription>
                {disabled
                  ? "Agents using active keys will be able to authenticate again."
                  : "All agents using this bot will immediately lose access. Keys and grants are retained."}
              </AlertDialogDescription>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={() => toggle.mutate(!disabled)}>
                  {disabled ? "Enable" : "Disable"}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </CardHeader>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            <KeyRound className="h-4 w-4" /> API keys
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <form
            className="flex flex-wrap gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              createKey.mutate(keyName.trim());
            }}
          >
            <Input
              value={keyName}
              onChange={(e) => setKeyName(e.target.value)}
              placeholder="Key name"
              className="min-w-0 flex-1 basis-40"
            />
            <Button type="submit" disabled={!keyName.trim()} busy={createKey.isPending}>
              <Plus className="h-4 w-4" /> New key
            </Button>
          </form>
          <div className="space-y-1">
            {keys.isLoading ? (
              <>
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
              </>
            ) : keys.error ? (
              <LoadError title="Could not load keys" query={keys} />
            ) : keys.data?.items?.length ? (
              keys.data.items.map((k) => (
                <div
                  key={k.id}
                  className="flex items-center gap-3 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm"
                >
                  <KeyRound className="h-3.5 w-3.5 shrink-0 text-[var(--color-fg-muted)]" />
                  <span className="min-w-0 truncate font-medium">{k.name}</span>
                  <span className="min-w-0 flex-1 truncate font-mono text-xs text-[var(--color-fg-muted)]">
                    {k.id}
                  </span>
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Revoke key ${k.name}`}
                        busy={revokeKey.isPending && revokeKey.variables.id === k.id}
                        className="text-[var(--color-fg-muted)] hover:text-[var(--color-danger)]"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogTitle>Revoke key “{k.name}”?</AlertDialogTitle>
                      <AlertDialogDescription>
                        Agents using this key will immediately lose access.
                      </AlertDialogDescription>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                          variant="danger"
                          onClick={() => revokeKey.mutate(k)}
                        >
                          Revoke
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </div>
              ))
            ) : (
              <div className="rounded-md border border-dashed border-[var(--color-border)] p-4 text-center text-xs text-[var(--color-fg-muted)]">
                No keys yet. Mint one to start using the CLI.
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Headless agent quickstart</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="mb-2 text-xs text-[var(--color-fg-muted)]">
            The CLI reads the server and the key from the environment, so it needs no
            login:
          </p>
          <CodeBlock>{headlessCLI(url, "<YOUR_KEY>")}</CodeBlock>
          <p className="mt-3 text-xs text-[var(--color-fg-muted)]">For raw HTTP:</p>
          <CodeBlock>{`curl -H "Authorization: Bearer <YOUR_KEY>" \\
  ${url}/v1/documents`}</CodeBlock>
        </CardContent>
      </Card>
    </div>
  );
}

function NewBotDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onCreated: (sa: CreatedBot) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <NewBotForm onCreated={onCreated} onClose={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

type CreatedBot = Awaited<ReturnType<typeof api.createServiceAccount>>;

// The form mounts each time the dialog opens, however it closed. The name
// that the reader did not send comes back, and a sent one does not. The app
// shows the key of the bot, on any page.
function NewBotForm({
  onCreated,
  onClose,
}: {
  onCreated: (sa: CreatedBot) => void;
  onClose: () => void;
}) {
  const q = useQueryClient();
  const { text: value, setText: setValue } = useFieldDraft("bot-name");
  const trimmed = value.trim();
  const { label, domain } = splitAddress(trimmed);
  const hasDomain = domain !== undefined;
  // Lightweight inline hint mirroring the server's `.bot` address rule; the
  // server remains authoritative.
  const domainLooksValid = !hasDomain || domain.endsWith(BOT_DOMAIN_SUFFIX);
  const create = useMutation({
    mutationFn: (sent: string) => {
      const { label, domain } = splitAddress(sent);
      return keepOneTimeKey(api.createServiceAccount(label, domain), (sa) => ({
        bot: sa.name,
        token: sa.key.token,
      }));
    },
    // It runs after Cancel too.
    onSuccess: (_, sent) => {
      setValue((now) => (now.trim() === sent ? "" : now));
      q.invalidateQueries({ queryKey: queryKeys.serviceAccounts() });
    },
    onError: (e) => toast.error(errorMessage(e, `Could not create ${label}`)),
  });
  return (
    <>
      <DialogHeader>
        <DialogTitle>New bot</DialogTitle>
        <DialogDescription>
          Bots are their own identities — share docs with them just like you would with
          a person.
        </DialogDescription>
      </DialogHeader>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          // The form closes, and the page selects the bot, only while they
          // are open: a later form stays.
          if (label)
            create.mutate(trimmed, {
              onSuccess: (sa) => {
                onCreated(sa);
                onClose();
              },
            });
        }}
        className="space-y-4"
      >
        <Field
          label="Name"
          hint={
            <>
              Letters, numbers, and hyphens. Add{" "}
              <code className="font-mono">@something.bot</code> to pick your bot's
              address, or skip it and we'll pick one for you.
            </>
          }
          error={
            hasDomain &&
            !domainLooksValid &&
            `Addresses must end in ${BOT_DOMAIN_SUFFIX}.`
          }
        >
          <Input
            placeholder="n8n-prod   or   n8n-prod@ops.team.bot"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            autoFocus
          />
        </Field>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={!label || !domainLooksValid}
            busy={create.isPending}
          >
            Create bot
          </Button>
        </DialogFooter>
      </form>
    </>
  );
}
