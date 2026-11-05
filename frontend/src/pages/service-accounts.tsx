import { Page, PageHeader, SettingsNav } from "@/components/layout/page";
import { useTitle } from "@/lib/use-title";
import { useState } from "react";
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
import { useLastDefined } from "@/lib/hooks";

// A key that shows once: the default key of a new bot, or a named key.
type NewKey = { bot: string; keyName?: string; token: string };

export function ServiceAccountsPage() {
  useTitle("Bots");
  const q = useQueryClient();
  const sas = useQuery({
    queryKey: queryKeys.serviceAccounts(),
    queryFn: api.listServiceAccounts,
  });
  const [creating, setCreating] = useState(false);
  // The page, not the form that asked, keeps each new key until the reader
  // closes it, so that a key that comes after Cancel or after another bot
  // was selected still shows, and for the bot it belongs to.
  const [newKeys, setNewKeys] = useState<NewKey[]>([]);
  const reveal = (k: NewKey) => setNewKeys((ks) => [...ks, k]);
  const items = sas.data?.items || [];
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = items.find((s) => s.id === selectedId) || items[0] || null;

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
        onCreated={(sa) => {
          q.invalidateQueries({ queryKey: queryKeys.serviceAccounts() });
          setSelectedId(sa.id);
          reveal({ bot: sa.name, token: sa.key.token });
        }}
      />
      <NewKeyDialog
        newKey={newKeys[0]}
        onDone={() => setNewKeys((ks) => ks.slice(1))}
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
                return (
                  <li key={id}>
                    <button
                      onClick={() => setSelectedId(id)}
                      aria-current={active || undefined}
                      className="wash-link flex w-full items-center gap-3 rounded-sm px-3 py-2.5 text-left text-sm"
                    >
                      <Bot className="h-4 w-4 shrink-0 text-[var(--color-fg-muted)]" />
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-medium">{sa.name}</div>
                        <div className="truncate font-mono text-[10px] text-[var(--color-fg-muted)]">
                          {id}
                        </div>
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
            <ServiceAccountDetail key={selected.id} sa={selected} onKey={reveal} />
          )}
        </div>
      </div>
    </Page>
  );
}

// The detail mounts for one bot, so its field and the callbacks of its
// mutations belong to that bot even when the reader selects another before
// a response comes. Those callbacks run after it unmounts too.
function ServiceAccountDetail({
  sa,
  onKey,
}: {
  sa: ServiceAccount;
  onKey: (k: NewKey) => void;
}) {
  const { id, name, disabled = false } = sa;
  const q = useQueryClient();
  const url = publicURL();
  const keys = useQuery({
    queryKey: queryKeys.serviceAccountKeys(id),
    queryFn: () => api.listServiceAccountKeys(id),
  });
  const [keyName, setKeyName] = useState("");
  const createKey = useMutation({
    mutationFn: (sent: string) => api.createServiceAccountKey(id, sent),
    onSuccess: (r, sent) => {
      onKey({ bot: name, keyName: sent, token: r.token });
      // A name typed while the key was made stays for the next key.
      setKeyName((now) => (now.trim() === sent ? "" : now));
      q.invalidateQueries({ queryKey: queryKeys.serviceAccountKeys(id) });
    },
    onError: (e) => toast.error(errorMessage(e, "Failed")),
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
          <div className="min-w-0">
            <CardTitle className="flex items-center gap-2 break-all">
              <Bot className="h-4 w-4 shrink-0" /> {name}
            </CardTitle>
            <div className="mt-1 break-all font-mono text-xs text-[var(--color-fg-muted)]">
              {id}
            </div>
          </div>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="outline" size="sm">
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
            <Button type="submit" disabled={!keyName.trim() || createKey.isPending}>
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

// The CLI takes its server and token from SLASHDOCS_SERVER and SLASHDOCS_TOKEN,
// so a headless agent needs no browser login.
function headlessCLI(url: string, token: string) {
  return `export SLASHDOCS_SERVER=${url}
export SLASHDOCS_TOKEN=${token}
slashdocs docs create report.html`;
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

// The form mounts each time the dialog opens, however it closed, so a new bot
// starts from an empty name. The page shows the key of the bot.
function NewBotForm({
  onCreated,
  onClose,
}: {
  onCreated: (sa: CreatedBot) => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState("");
  const trimmed = value.trim();
  const at = trimmed.indexOf("@");
  const label = at >= 0 ? trimmed.slice(0, at) : trimmed;
  const domain = at >= 0 ? trimmed.slice(at + 1) : "";
  const hasDomain = at >= 0;
  // Lightweight inline hint mirroring the server's `.bot` address rule; the
  // server remains authoritative.
  const domainLooksValid = !hasDomain || domain.endsWith(BOT_DOMAIN_SUFFIX);
  const create = useMutation({
    mutationFn: () => api.createServiceAccount(label, hasDomain ? domain : undefined),
    // It runs after Cancel too, so the key reaches the page.
    onSuccess: onCreated,
    onError: (e) => toast.error(errorMessage(e, "Failed")),
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
          // The form closes only if it is still open: a later form stays.
          if (label) create.mutate(undefined, { onSuccess: onClose });
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
            disabled={!label || !domainLooksValid || create.isPending}
          >
            Create bot
          </Button>
        </DialogFooter>
      </form>
    </>
  );
}

// The dialog keeps the key that it shows through its exit.
function NewKeyDialog({ newKey, onDone }: { newKey?: NewKey; onDone: () => void }) {
  const shown = useLastDefined(newKey);
  return (
    <Dialog open={!!newKey} onOpenChange={(o) => !o && onDone()}>
      <DialogContent>
        {shown && (
          <>
            <DialogHeader>
              <DialogTitle className="break-all">
                {shown.keyName ? `New key for ${shown.bot}` : `Meet ${shown.bot}`}
              </DialogTitle>
              <DialogDescription>
                {shown.keyName
                  ? "Agents that use this key act as this bot."
                  : "Share docs with this address to let your bot read or edit them."}
              </DialogDescription>
            </DialogHeader>
            <CodeBlock>{shown.bot}</CodeBlock>
            <div className="mt-5 rounded-sm border border-[var(--color-warning)]/40 bg-[var(--color-warning)]/10 p-3">
              <div className="mb-1 break-all text-xs font-medium uppercase tracking-wide text-[var(--color-fg-muted)]">
                {shown.keyName || "Bot key"}
              </div>
              <div className="mb-2 text-sm font-semibold text-[var(--color-warning)]">
                Copy this key now — you won't see it again.
              </div>
              <CodeBlock>{shown.token}</CodeBlock>
            </div>
            <div className="mb-1 mt-4 text-xs text-[var(--color-fg-muted)]">
              Use it with the CLI:
            </div>
            <CodeBlock>{headlessCLI(publicURL(), shown.token)}</CodeBlock>
            <DialogFooter>
              <Button onClick={onDone}>Done</Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
