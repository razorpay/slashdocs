import { Page, PageHeader } from "@/components/layout/page";
import { useTitle } from "@/lib/use-title";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { errorMessage } from "@/lib/errors";
import { Bot, KeyRound, Plus, Power, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { CodeBlock, EmptyState, Skeleton } from "@/components/ui/misc";
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

export function ServiceAccountsPage() {
  useTitle("Service accounts");
  const q = useQueryClient();
  const sas = useQuery({
    queryKey: queryKeys.serviceAccounts(),
    queryFn: api.listServiceAccounts,
  });
  const [creating, setCreating] = useState(false);
  const items = sas.data?.items || [];
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = items.find((s) => s.id === selectedId) || items[0] || null;

  return (
    <Page>
      <PageHeader
        title="Bots"
        description="Bots are their own identities — share docs with them just like you would with a person. Use them for n8n workflows, scheduled jobs, or anything that runs without you."
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
        }}
      />

      <div className="grid gap-6 md:grid-cols-[280px_1fr]">
        <div className="space-y-2">
          {sas.isLoading ? (
            <>
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </>
          ) : sas.error ? (
            <div className="rounded-md border border-dashed border-[var(--color-border)] p-6 text-center text-sm text-[var(--color-danger)]">
              Could not load bots.
            </div>
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

        <div>
          {selected ? (
            <ServiceAccountDetail sa={selected} />
          ) : (
            <EmptyState
              icon={<Bot className="h-5 w-5" />}
              title="No bot selected"
              description="Pick one on the left to manage its keys."
            />
          )}
        </div>
      </div>
    </Page>
  );
}

function ServiceAccountDetail({ sa }: { sa: ServiceAccount }) {
  const { id, name, disabled = false } = sa;
  const q = useQueryClient();
  const url = publicURL();
  const keys = useQuery({
    queryKey: queryKeys.serviceAccountKeys(id),
    queryFn: () => api.listServiceAccountKeys(id),
  });
  const [revealToken, setRevealToken] = useState<{
    token: string;
    keyName: string;
  } | null>(null);
  const [keyName, setKeyName] = useState("default");
  const createKey = useMutation({
    mutationFn: () => api.createServiceAccountKey(id, keyName),
    onSuccess: (r) => {
      setRevealToken({ token: r.token, keyName });
      setKeyName("default");
      q.invalidateQueries({ queryKey: queryKeys.serviceAccountKeys(id) });
    },
    onError: (e) => toast.error(errorMessage(e, "Failed")),
  });
  const revokeKey = useMutation({
    mutationFn: (keyID: string) => api.revokeServiceAccountKey(id, keyID),
    onSuccess: () => {
      toast.success("Key revoked.");
      q.invalidateQueries({ queryKey: queryKeys.serviceAccountKeys(id) });
    },
    onError: (e) => toast.error(errorMessage(e, "Could not revoke key")),
  });
  const toggle = useMutation({
    mutationFn: () => api.updateServiceAccount(id, name, !disabled),
    onSuccess: () => {
      toast.success(disabled ? "Enabled." : "Disabled.");
      q.invalidateQueries({ queryKey: queryKeys.serviceAccounts() });
    },
    onError: (e) => toast.error(errorMessage(e, "Could not update bot")),
  });

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row items-start justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Bot className="h-4 w-4" /> {name}
            </CardTitle>
            <div className="mt-1 font-mono text-xs text-[var(--color-fg-muted)]">
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
                  : "All agents using this service account will immediately lose access. Keys and grants are retained."}
              </AlertDialogDescription>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={() => toggle.mutate()}>
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
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              createKey.mutate();
            }}
          >
            <Input
              value={keyName}
              onChange={(e) => setKeyName(e.target.value)}
              placeholder="Key name"
            />
            <Button type="submit" disabled={!keyName || createKey.isPending}>
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
              <div className="rounded-md border border-dashed border-[var(--color-border)] p-4 text-center text-xs text-[var(--color-danger)]">
                Could not load keys.
              </div>
            ) : keys.data?.items?.length ? (
              keys.data.items.map((k) => (
                <div
                  key={k.id}
                  className="flex items-center gap-3 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm"
                >
                  <KeyRound className="h-3.5 w-3.5 text-[var(--color-fg-muted)]" />
                  <span className="font-medium">{k.name}</span>
                  <span className="flex-1 truncate font-mono text-xs text-[var(--color-fg-muted)]">
                    {k.id}
                  </span>
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button variant="ghost" size="icon" aria-label="Revoke">
                        <Trash2 className="h-3.5 w-3.5 text-[var(--color-danger)]" />
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
                          onClick={() => revokeKey.mutate(k.id)}
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
            Use the minted key as a bearer token from any HTTP client, or with the CLI
            in non-interactive mode:
          </p>
          <CodeBlock>{`slashdocs auth login --token <YOUR_KEY>
slashdocs docs create report.html`}</CodeBlock>
          <p className="mt-3 text-xs text-[var(--color-fg-muted)]">For raw HTTP:</p>
          <CodeBlock>{`curl -H "Authorization: Bearer <YOUR_KEY>" \\
  ${url}/v1/documents`}</CodeBlock>
        </CardContent>
      </Card>

      <Dialog open={!!revealToken} onOpenChange={(o) => !o && setRevealToken(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Copy this key now</DialogTitle>
            <DialogDescription>
              This is the only time the secret token will be shown. Store it somewhere
              safe.
            </DialogDescription>
          </DialogHeader>
          {revealToken && (
            <>
              <div className="mb-1 text-xs font-medium text-[var(--color-fg-muted)]">
                {revealToken.keyName}
              </div>
              <CodeBlock>{revealToken.token}</CodeBlock>
              <div className="mt-4 text-xs text-[var(--color-fg-muted)]">
                Use it as a bearer token from your headless agent, or:
              </div>
              <CodeBlock>{`slashdocs auth login ${url} --token ${revealToken.token}`}</CodeBlock>
            </>
          )}
          <DialogFooter>
            <Button onClick={() => setRevealToken(null)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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
  onCreated: (sa: { id: string; name: string }) => void;
}) {
  const [value, setValue] = useState("");
  const [result, setResult] = useState<{ name: string; token: string } | null>(null);
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
    onSuccess: (r) => {
      setResult({ name: r.name, token: r.key.token });
      onCreated({ id: r.id, name: r.name });
    },
    onError: (e) => toast.error(errorMessage(e, "Failed")),
  });
  function reset() {
    setValue("");
    setResult(null);
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (!o) reset();
      }}
    >
      <DialogContent>
        {!result ? (
          <>
            <DialogHeader>
              <DialogTitle>New bot</DialogTitle>
              <DialogDescription>
                Bots are their own identities — share docs with them just like you would
                with a person.
              </DialogDescription>
            </DialogHeader>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (label) create.mutate();
              }}
              className="space-y-4"
            >
              <div>
                <label className="mb-1 block text-xs font-medium text-[var(--color-fg-muted)]">
                  Name
                </label>
                <Input
                  placeholder="n8n-prod   or   n8n-prod@ops.team.bot"
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  autoFocus
                />
                <p className="mt-1 text-[11px] text-[var(--color-fg-muted)]">
                  Letters, numbers, and hyphens. Add{" "}
                  <code className="font-mono">@something.bot</code> to pick your bot's
                  address, or skip it and we'll pick one for you.
                </p>
                {hasDomain && !domainLooksValid && (
                  <p className="mt-1 text-[11px] text-[var(--color-danger)]">
                    Addresses must end in {BOT_DOMAIN_SUFFIX}.
                  </p>
                )}
              </div>

              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => onOpenChange(false)}
                >
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
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Meet {result.name}</DialogTitle>
              <DialogDescription>
                Share docs with this address to let your bot read or edit them.
              </DialogDescription>
            </DialogHeader>
            <CodeBlock>{result.name}</CodeBlock>
            <div className="mt-5 rounded-sm border border-[var(--color-warning)]/40 bg-[var(--color-warning)]/10 p-3">
              <div className="mb-1 text-xs font-medium uppercase tracking-wide text-[var(--color-fg-muted)]">
                Bot key
              </div>
              <div className="mb-2 text-sm font-semibold text-[var(--color-warning)]">
                Copy this key now — you won't see it again.
              </div>
              <CodeBlock>{result.token}</CodeBlock>
            </div>
            <DialogFooter>
              <Button onClick={() => onOpenChange(false)}>Done</Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
