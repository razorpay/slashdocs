import { useMemo, useState, type ReactNode } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { ArrowDown, ArrowUp, GripVertical, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { APIError } from "@/api";
import { cn } from "@/lib/cn";
import {
  addFromPool,
  addPart,
  addPlanned,
  applyDrop,
  chapterNumbers,
  groupProblems,
  moveChapterBy,
  moveChapterToPart,
  moveMatterBy,
  movePartBy,
  removeChapter,
  removeMatter,
  removePart,
  renamePart,
  renamePlanned,
  sameOutline,
  setTitle,
  type ChapterPos,
  type Draft,
  type Problem,
  type RowKey,
  type Section,
} from "@/lib/book-outline";
import { booksApi, type OutlineResponse } from "@/lib/books";
import { errorMessage } from "@/lib/errors";
import { queryKeys } from "@/lib/queryKeys";
import { useTitle } from "@/lib/use-title";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { Center, Skeleton } from "@/components/ui/misc";
import { Page } from "@/components/layout/page";
import { BookError } from "./book-home";
import { bookRetry, useManifest } from "./book-chapter-state";

const SELECT =
  "h-8 rounded-sm border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-sm text-[var(--color-fg)]";
const CONFLICT_TEXT =
  "Someone changed the outline while you were editing. Reload to see their version.";

type Errors = Map<RowKey, string[]>;

function plural(n: number, one: string, many: string) {
  return `${n} ${n === 1 ? one : many}`;
}

function FieldErrors({ messages }: { messages?: string[] }) {
  if (!messages?.length) return null;
  return (
    <ul className="mt-1 text-xs text-[var(--color-danger)]">
      {messages.map((m) => (
        <li key={m}>{m}</li>
      ))}
    </ul>
  );
}

type DragHandle = Pick<
  ReturnType<typeof useDraggable>,
  "attributes" | "listeners" | "setActivatorNodeRef"
>;

function Handle({ handle, label }: { handle: DragHandle; label: string }) {
  return (
    <button
      type="button"
      ref={handle.setActivatorNodeRef}
      aria-label={label}
      className="flex h-8 w-6 shrink-0 cursor-grab touch-none items-center justify-center rounded-sm text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-muted)]"
      {...handle.attributes}
      {...handle.listeners}
    >
      <GripVertical aria-hidden="true" className="h-4 w-4" />
    </button>
  );
}

function IconButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="h-8 w-8"
      aria-label={label}
      tooltip={label}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

// A row that can be dragged (by its Handle) and dropped on, under one id so a
// drop can tell which row it is over.
function useRow(id: string) {
  const drag = useDraggable({ id });
  const drop = useDroppable({ id });
  const t = drag.transform;
  return {
    ref: (el: HTMLElement | null) => {
      drag.setNodeRef(el);
      drop.setNodeRef(el);
    },
    style: t
      ? {
          transform: `translate3d(${t.x}px, ${t.y}px, 0)`,
          zIndex: 10,
          position: "relative" as const,
        }
      : undefined,
    handle: drag as DragHandle,
    dragging: drag.isDragging,
    over: drop.isOver && !drag.isDragging,
  };
}

type Ops = {
  draft: Draft;
  update: (next: Draft) => void;
  titleOf: (id: string) => string;
  errors: Errors;
};

function ChapterRow({
  ops,
  at,
  number,
  canUp,
  canDown,
}: {
  ops: Ops;
  at: ChapterPos;
  number: number;
  canUp: boolean;
  canDown: boolean;
}) {
  const { draft, update, titleOf, errors } = ops;
  const entry = draft.outline.parts[at.part].chapters[at.index];
  const planned = entry.doc === undefined;
  const title = planned ? entry.planned || "" : titleOf(entry.doc!);
  const row = useRow(`ch:${at.part}:${at.index}`);
  const name = planned ? (title ? `${title} (planned)` : "planned chapter") : title;
  return (
    <li
      ref={row.ref}
      style={row.style}
      aria-label={`Chapter ${number}: ${planned ? (title ? `${title} (planned)` : "(planned)") : title}`}
      className={cn(
        "rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-2",
        row.over && "ring-2 ring-[var(--color-accent)]",
        row.dragging && "opacity-80 shadow-lg",
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Handle handle={row.handle} label={`Drag ${name}`} />
        <span className="w-7 shrink-0 text-right text-sm tabular-nums text-[var(--color-fg-muted)]">
          {number}
        </span>
        {planned ? (
          <Input
            aria-label="Planned chapter title"
            placeholder="Title of the planned chapter"
            className="h-8 min-w-0 flex-1"
            value={title}
            onChange={(e) => update(renamePlanned(draft, at, e.target.value))}
          />
        ) : (
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{title}</span>
        )}
        <select
          aria-label={`Move ${name} to part…`}
          className={SELECT}
          value=""
          onChange={(e) => {
            if (e.target.value !== "")
              update(moveChapterToPart(draft, at, Number(e.target.value)));
          }}
        >
          <option value="">Move to part…</option>
          {draft.outline.parts.map((p, i) =>
            i === at.part ? null : (
              <option key={i} value={i}>
                {p.title || `Part ${i + 1}`}
              </option>
            ),
          )}
        </select>
        <IconButton
          label={`Move ${name} up`}
          disabled={!canUp}
          onClick={() => update(moveChapterBy(draft, at, -1))}
        >
          <ArrowUp className="h-4 w-4" />
        </IconButton>
        <IconButton
          label={`Move ${name} down`}
          disabled={!canDown}
          onClick={() => update(moveChapterBy(draft, at, 1))}
        >
          <ArrowDown className="h-4 w-4" />
        </IconButton>
        <IconButton
          label={`Remove ${name}`}
          onClick={() => update(removeChapter(draft, at, titleOf))}
        >
          <Trash2 className="h-4 w-4" />
        </IconButton>
      </div>
      <FieldErrors messages={errors.get(`chapter:${at.part}:${at.index}`)} />
    </li>
  );
}

function PartSection({
  ops,
  index,
  numbers,
}: {
  ops: Ops;
  index: number;
  numbers: number[][];
}) {
  const { draft, update, errors } = ops;
  const parts = draft.outline.parts;
  const part = parts[index];
  const head = useRow(`part:${index}`);
  const end = useDroppable({ id: `end:${index}` });
  const label = part.title || `Part ${index + 1}`;
  return (
    <section
      role="group"
      aria-label={label}
      className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-muted)]/40 p-3"
    >
      <header
        ref={head.ref}
        style={head.style}
        className={cn(
          "flex flex-wrap items-center gap-2 rounded-md",
          head.over && "ring-2 ring-[var(--color-accent)]",
        )}
      >
        <Handle handle={head.handle} label={`Drag ${label}`} />
        <Input
          aria-label={`Title of part ${index + 1}`}
          className="h-8 min-w-0 flex-1 font-semibold"
          value={part.title}
          onChange={(e) => update(renamePart(draft, index, e.target.value))}
        />
        <IconButton
          label={`Move ${label} up`}
          disabled={index === 0}
          onClick={() => update(movePartBy(draft, index, -1))}
        >
          <ArrowUp className="h-4 w-4" />
        </IconButton>
        <IconButton
          label={`Move ${label} down`}
          disabled={index === parts.length - 1}
          onClick={() => update(movePartBy(draft, index, 1))}
        >
          <ArrowDown className="h-4 w-4" />
        </IconButton>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={`Remove ${label}`}
          onClick={() => update(removePart(draft, index, ops.titleOf))}
        >
          Remove part
        </Button>
      </header>
      <div className="px-1">
        <FieldErrors messages={errors.get(`part:${index}`)} />
      </div>
      <ol className="mt-2 flex flex-col gap-2">
        {part.chapters.map((_, c) => (
          <ChapterRow
            key={c}
            ops={ops}
            at={{ part: index, index: c }}
            number={numbers[index][c]}
            canUp={!(index === 0 && c === 0)}
            canDown={!(index === parts.length - 1 && c === part.chapters.length - 1)}
          />
        ))}
      </ol>
      <footer
        ref={end.setNodeRef}
        className={cn(
          "mt-2 flex items-center gap-2 rounded-md",
          end.isOver && "ring-2 ring-[var(--color-accent)]",
        )}
      >
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => update(addPlanned(draft, index))}
        >
          <Plus aria-hidden="true" className="h-3.5 w-3.5" />
          Add planned chapter
        </Button>
        {part.chapters.length === 0 ? (
          <span className="text-xs text-[var(--color-fg-muted)]">
            Drag chapters here, or add them from Not in outline.
          </span>
        ) : null}
      </footer>
    </section>
  );
}

function Matter({
  ops,
  section,
  label,
}: {
  ops: Ops;
  section: Section;
  label: string;
}) {
  const { draft, update, titleOf, errors } = ops;
  const list = draft.outline[section];
  return (
    <section role="group" aria-label={label} className="flex flex-col gap-2">
      <h2 className="text-sm font-semibold">{label}</h2>
      {list.length === 0 ? (
        <p className="text-sm text-[var(--color-fg-muted)]">
          Nothing here. Add a document from Not in outline.
        </p>
      ) : (
        <ol className="flex flex-col gap-2">
          {list.map((e, i) => {
            const title = titleOf(e.doc ?? "");
            return (
              <li
                key={i}
                aria-label={`${label}: ${title}`}
                className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-2"
              >
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-sm">{title}</span>
                  <IconButton
                    label={`Move ${title} up`}
                    disabled={i === 0}
                    onClick={() => update(moveMatterBy(draft, section, i, -1))}
                  >
                    <ArrowUp className="h-4 w-4" />
                  </IconButton>
                  <IconButton
                    label={`Move ${title} down`}
                    disabled={i === list.length - 1}
                    onClick={() => update(moveMatterBy(draft, section, i, 1))}
                  >
                    <ArrowDown className="h-4 w-4" />
                  </IconButton>
                  <IconButton
                    label={`Remove ${title}`}
                    onClick={() => update(removeMatter(draft, section, i, titleOf))}
                  >
                    <Trash2 className="h-4 w-4" />
                  </IconButton>
                </div>
                <FieldErrors messages={errors.get(`${section}:${i}`)} />
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

function PoolList({ ops }: { ops: Ops }) {
  const { draft, update } = ops;
  return (
    <section role="region" aria-label="Not in outline" className="flex flex-col gap-2">
      <h2 className="text-sm font-semibold">Not in outline</h2>
      {draft.pool.length === 0 ? (
        <p className="text-sm text-[var(--color-fg-muted)]">
          Every document in this folder is in the outline.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {draft.pool.map((d) => (
            <li
              key={d.id}
              className="flex flex-wrap items-center gap-2 rounded-md border border-dashed border-[var(--color-border)] p-2"
            >
              <span className="min-w-0 flex-1 truncate text-sm">{d.title}</span>
              <select
                aria-label={`Add ${d.title} to…`}
                className={SELECT}
                value=""
                onChange={(e) => {
                  const v = e.target.value;
                  if (!v) return;
                  update(
                    addFromPool(
                      draft,
                      d.id,
                      v === "front" || v === "back"
                        ? { section: v }
                        : { part: Number(v.slice(5)) },
                    ),
                  );
                }}
              >
                <option value="">Add to part…</option>
                {draft.outline.parts.map((p, i) => (
                  <option key={i} value={`part:${i}`}>
                    {p.title || `Part ${i + 1}`}
                  </option>
                ))}
                <option value="front">Front matter</option>
                <option value="back">Back matter</option>
              </select>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Editor({
  bookId,
  data,
  titles,
  onReload,
  placed,
}: {
  bookId: string;
  data: OutlineResponse;
  titles: Map<string, string>;
  onReload: () => Promise<void>;
  placed?: { placed: number; notInOutline: number };
}) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<Draft>({
    outline: data.outline,
    pool: data.not_in_outline,
  });
  const [note, setNote] = useState("");
  const [problems, setProblems] = useState<Problem[]>([]);
  const [conflict, setConflict] = useState(false);
  const [confirmReload, setConfirmReload] = useState(false);
  const [reloading, setReloading] = useState(false);

  const poolTitles = useMemo(() => {
    const m = new Map(titles);
    for (const d of data.not_in_outline) m.set(d.id, d.title);
    for (const d of draft.pool) m.set(d.id, d.title);
    return m;
  }, [titles, data.not_in_outline, draft.pool]);
  const titleOf = (id: string) => poolTitles.get(id) || "Untitled document";

  const dirty = !sameOutline(draft.outline, data.outline);
  const numbers = chapterNumbers(draft.outline);
  const { byRow, summary } = useMemo(
    () => groupProblems(problems, draft.outline),
    [problems, draft.outline],
  );

  // Edits move rows, so problems from the last save would point at the wrong
  // ones. Clear them on the next edit.
  const update = (next: Draft) => {
    setDraft(next);
    if (problems.length) setProblems([]);
  };

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor),
  );
  const onDragEnd = (e: DragEndEvent) => {
    if (e.over) update(applyDrop(draft, String(e.active.id), String(e.over.id)));
  };

  const save = useMutation({
    mutationFn: () =>
      booksApi.pushOutline(bookId, data.version_id, draft.outline, note.trim()),
    onSuccess: async (r) => {
      toast.success(`Saved the outline as version ${r.number}.`);
      setProblems([]);
      setConflict(false);
      await qc.invalidateQueries({ queryKey: queryKeys.book(bookId) });
    },
    onError: (e) => {
      if (e instanceof APIError && e.status === 409) {
        setConflict(true);
        return;
      }
      if (e instanceof APIError && e.status === 422) {
        const list = (e.details as { problems?: Problem[] } | undefined)?.problems;
        setProblems(
          list?.length
            ? list
            : [{ path: "", message: e.message || "The outline is not valid." }],
        );
        return;
      }
      toast.error(errorMessage(e, "Could not save the outline."));
    },
  });

  const reload = async () => {
    setReloading(true);
    try {
      await onReload();
    } finally {
      setReloading(false);
    }
  };

  const ops: Ops = { draft, update, titleOf, errors: byRow };
  const o = draft.outline;
  return (
    <Page lane="focus" backdrop={false}>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-[-0.01em]">Edit outline</h1>
          <p className="text-sm text-[var(--color-fg-muted)]">
            Version {data.number}. Chapters are numbered in order across parts.
          </p>
        </div>
        <Button asChild variant="ghost" size="sm">
          <Link to={`/app/b/${encodeURIComponent(bookId)}`}>Back to the book</Link>
        </Button>
      </div>

      {placed ? (
        <p
          role="status"
          className="mb-4 rounded-md bg-[var(--color-accent-muted)] px-3 py-2 text-sm"
        >
          {`Placed ${plural(placed.placed, "chapter", "chapters")}; ${plural(
            placed.notInOutline,
            "document is",
            "documents are",
          )} not in the outline yet.`}
        </p>
      ) : null}
      {data.removed.length ? (
        <p className="mb-4 text-sm text-[var(--color-fg-muted)]">
          {`${plural(data.removed.length, "document was", "documents were")} deleted or moved out of this folder. Saving drops them from the outline.`}
        </p>
      ) : null}

      {conflict ? (
        <div
          role="alert"
          className="mb-4 rounded-md border border-[var(--color-danger)] p-3 text-sm"
        >
          <p>{CONFLICT_TEXT}</p>
          {confirmReload ? (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <span>Reloading discards your unsaved changes.</span>
              <Button size="sm" variant="danger" disabled={reloading} onClick={reload}>
                Discard my changes
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmReload(false)}>
                Keep editing
              </Button>
            </div>
          ) : (
            <Button
              size="sm"
              variant="outline"
              className="mt-2"
              disabled={reloading}
              onClick={() => (dirty ? setConfirmReload(true) : reload())}
            >
              Reload
            </Button>
          )}
        </div>
      ) : null}
      {summary.length ? (
        <div
          role="alert"
          className="mb-4 rounded-md border border-[var(--color-danger)] p-3 text-sm"
        >
          <p className="font-medium">The outline has problems.</p>
          <ul className="mt-1 list-disc pl-5">
            {summary.map((p, i) => (
              <li key={i}>{p.path ? `${p.path}: ${p.message}` : p.message}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="mb-6 grid gap-3 sm:grid-cols-2">
        <div>
          <Label htmlFor="book-title">Book title</Label>
          <Input
            id="book-title"
            value={o.title}
            onChange={(e) => update(setTitle(draft, "title", e.target.value))}
          />
          <FieldErrors messages={byRow.get("title")} />
        </div>
        <div>
          <Label htmlFor="book-subtitle">Subtitle</Label>
          <Input
            id="book-subtitle"
            value={o.subtitle ?? ""}
            onChange={(e) => update(setTitle(draft, "subtitle", e.target.value))}
          />
          <FieldErrors messages={byRow.get("subtitle")} />
        </div>
      </div>

      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={onDragEnd}
      >
        <div className="flex flex-col gap-6">
          <Matter ops={ops} section="front" label="Front matter" />
          <div className="flex flex-col gap-3">
            {o.parts.map((_, i) => (
              <PartSection key={i} ops={ops} index={i} numbers={numbers} />
            ))}
            <div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => update(addPart(draft))}
              >
                <Plus aria-hidden="true" className="h-3.5 w-3.5" />
                Add part
              </Button>
            </div>
          </div>
          <Matter ops={ops} section="back" label="Back matter" />
          <PoolList ops={ops} />
        </div>
      </DndContext>

      <div className="mt-8 flex flex-wrap items-end gap-3 border-t border-[var(--color-border)] pt-4">
        <div className="min-w-0 flex-1">
          <Label htmlFor="outline-note">Note (optional)</Label>
          <Input
            id="outline-note"
            value={note}
            placeholder="What changed in this outline?"
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
        <Button disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
          Save outline
        </Button>
      </div>
    </Page>
  );
}

export function BookOutlineEditorPage() {
  const { bookId = "" } = useParams();
  const qc = useQueryClient();
  const loc = useLocation();
  const [epoch, setEpoch] = useState(0);
  useTitle("Edit outline");
  const outline = useQuery({
    queryKey: queryKeys.bookOutline(bookId),
    queryFn: () => booksApi.outline(bookId),
    enabled: !!bookId,
    // The draft is local; refetching behind the editor's back would only
    // risk replacing it.
    refetchOnWindowFocus: false,
    staleTime: Infinity,
    ...bookRetry,
    // The page explains its own errors.
    meta: { suppressGlobalError: true },
  });
  // The outline carries no titles for documents already placed. The manifest
  // has them; if it fails the rows fall back to a generic name.
  const manifest = useManifest(bookId);
  const titles = useMemo(() => {
    const m = new Map<string, string>();
    for (const g of manifest.data?.toc ?? [])
      for (const l of g.children) {
        const id = l.properties?.documentId;
        if (id) m.set(id, l.title);
      }
    return m;
  }, [manifest.data]);

  if (outline.isLoading || (manifest.isLoading && !outline.data)) {
    return (
      <Page lane="focus" backdrop={false}>
        <Skeleton className="mb-3 h-9 w-48" />
        <Skeleton className="h-64 w-full" />
      </Page>
    );
  }
  // Only without an outline: a failed refetch (after a save) keeps the
  // editor and its draft.
  if (!outline.data) {
    const e = outline.error;
    if (e instanceof APIError && e.status === 403)
      return (
        <Center>
          <p className="text-sm">Only editors of this folder can change the outline.</p>
        </Center>
      );
    return <BookError error={e} onRetry={() => void outline.refetch()} />;
  }
  const placed = (loc.state ?? undefined) as
    { placed: number; notInOutline: number } | undefined;
  return (
    <Editor
      // A new version or a reload starts a fresh draft.
      key={`${outline.data.version_id}:${epoch}`}
      bookId={bookId}
      data={outline.data}
      titles={titles}
      placed={placed && typeof placed.placed === "number" ? placed : undefined}
      onReload={async () => {
        await Promise.all([
          qc.invalidateQueries({ queryKey: queryKeys.bookOutline(bookId) }),
          qc.invalidateQueries({ queryKey: queryKeys.book(bookId) }),
        ]);
        setEpoch((n) => n + 1);
      }}
    />
  );
}
