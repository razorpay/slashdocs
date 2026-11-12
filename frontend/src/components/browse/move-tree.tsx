import {
  useEffect,
  useId,
  useMemo,
  useRef,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import {
  ChevronDown,
  ChevronRight,
  Folder as FolderIcon,
  Home,
  LockKeyhole,
} from "lucide-react";
import { cn } from "@/lib/cn";
import type { MoveDestinationNode } from "@/api";
import {
  MOVE_TREE_DOCUMENTS,
  MOVE_TREE_ROOT,
  type MoveTreeAction,
  type MoveTreeState,
  visibleMoveTreeRows,
} from "./move-tree-state";

const unavailableMessage = (node?: MoveDestinationNode, documentsCurrent?: boolean) => {
  if (documentsCurrent || node?.current || node?.reason === "current")
    return "This is the current location.";
  if (node?.reason === "too_deep") return "This folder is too deep to use.";
  return "View only. You cannot move items here.";
};

const visualIndent = (level: number) => {
  const depth = Math.max(0, level - 1);
  return {
    "--move-tree-indent-mobile": `${Math.min(depth, 4) * 12}px`,
    "--move-tree-indent-desktop": `${Math.min(depth, 10) * 18}px`,
  } as CSSProperties;
};

export function MoveTree({
  state,
  dispatch,
  setExpanded,
  loadChildren,
  pending,
}: {
  state: MoveTreeState;
  dispatch: (action: MoveTreeAction) => void;
  setExpanded: (id: string, expanded: boolean) => Promise<void>;
  loadChildren: (
    parent: string | null,
    cursor?: string,
    position?: "replace" | "before" | "after",
  ) => Promise<boolean>;
  pending: boolean;
}) {
  const rows = useMemo(() => visibleMoveTreeRows(state), [state]);
  const refs = useRef(new Map<string, HTMLElement>());
  const instructionsId = useId();
  const typeahead = useRef("");
  const typeaheadTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    const item = refs.current.get(state.focused);
    if (!item) return;
    const timer = window.setTimeout(() => {
      const active = document.activeElement;
      const focusIsInTree = [...refs.current.values()].some((row) => row === active);
      const dialogOwnsInitialFocus = active?.getAttribute("role") === "dialog";
      if (
        active &&
        active !== document.body &&
        !focusIsInTree &&
        !dialogOwnsInitialFocus
      )
        return;
      item.focus({ preventScroll: true });
      item.scrollIntoView?.({ block: "nearest" });
    });
    return () => window.clearTimeout(timer);
  }, [state.focused, rows.length]);

  const focusAt = (index: number) => {
    const row = rows[Math.max(0, Math.min(index, rows.length - 1))];
    if (row) dispatch({ type: "focus", id: row.id });
  };

  const select = (id: string, node?: MoveDestinationNode) => {
    const documentsCurrent =
      id === MOVE_TREE_DOCUMENTS && state.bootstrap?.documents.current;
    const selectable =
      id === MOVE_TREE_DOCUMENTS
        ? !!state.bootstrap?.documents.selectable
        : !!node?.selectable;
    if (selectable) {
      dispatch({
        type: "select",
        id,
        announcement: `${id === MOVE_TREE_DOCUMENTS ? "Documents" : node?.title} selected as the destination.`,
      });
      return;
    }
    dispatch({
      type: "announce",
      message: unavailableMessage(node, documentsCurrent),
    });
  };

  const activateControl = (row: (typeof rows)[number]) => {
    if (!row.control || row.control.busy) return;
    void loadChildren(row.control.parent, row.control.cursor, row.control.position);
  };

  const onKeyDown = (
    event: KeyboardEvent<HTMLElement>,
    index: number,
    node?: MoveDestinationNode,
  ) => {
    const row = rows[index];
    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusAt(index + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      focusAt(index - 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      focusAt(0);
    } else if (event.key === "End") {
      event.preventDefault();
      focusAt(rows.length - 1);
    } else if (event.key === "ArrowRight" && node?.has_children) {
      event.preventDefault();
      if (!state.expanded[node.id]) void setExpanded(node.id, true);
      else if (rows[index + 1]?.level > row.level) focusAt(index + 1);
    } else if (event.key === "ArrowLeft" && row.control) {
      event.preventDefault();
      dispatch({
        type: "focus",
        id: row.control.parent || MOVE_TREE_DOCUMENTS,
      });
    } else if (event.key === "ArrowLeft" && node) {
      event.preventDefault();
      if (state.expanded[node.id]) void setExpanded(node.id, false);
      else dispatch({ type: "focus", id: node.parent_id || MOVE_TREE_DOCUMENTS });
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (row.control) activateControl(row);
      else if (node && !node.selectable && node.has_children)
        void setExpanded(node.id, !state.expanded[node.id]);
      else select(row.id, node);
    } else if (
      event.key.length === 1 &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey
    ) {
      window.clearTimeout(typeaheadTimer.current);
      typeahead.current += event.key.toLocaleLowerCase();
      typeaheadTimer.current = window.setTimeout(() => (typeahead.current = ""), 500);
      const ordered = [...rows.slice(index + 1), ...rows.slice(0, index + 1)];
      const match = ordered.find((item) => {
        const title =
          item.id === MOVE_TREE_DOCUMENTS
            ? "documents"
            : item.control?.label || item.node?.title || "";
        return title.toLocaleLowerCase().startsWith(typeahead.current);
      });
      if (match) dispatch({ type: "focus", id: match.id });
    }
  };

  return (
    <>
      <p id={instructionsId} className="sr-only">
        Use arrow keys to move through folders and loading controls. Press Enter or
        Space to choose a destination, expand a view-only folder, or load folders.
      </p>
      <div
        role="tree"
        aria-label="Move destination folders"
        aria-describedby={instructionsId}
        aria-busy={pending || undefined}
        className="min-h-0 overscroll-contain py-1 outline-none"
      >
        {rows.map((row, index) => {
          if (row.control) {
            return (
              <button
                key={row.id}
                ref={(element) => {
                  if (element) refs.current.set(row.id, element);
                  else refs.current.delete(row.id);
                }}
                type="button"
                role="treeitem"
                aria-level={row.level}
                aria-label={row.control.label}
                aria-busy={row.control.busy || undefined}
                tabIndex={state.focused === row.id ? 0 : -1}
                onFocus={() => dispatch({ type: "focus", id: row.id })}
                onClick={() => activateControl(row)}
                onKeyDown={(event) => onKeyDown(event, index)}
                className="flex min-h-11 w-full touch-manipulation items-center rounded-md pe-3 ps-[calc(1rem+var(--move-tree-indent-mobile))] text-start text-sm font-medium text-[var(--color-accent)] outline-none hover:bg-[var(--color-surface-muted)] focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:ring-offset-1 focus-visible:ring-offset-[var(--color-surface)] md:ps-[calc(1rem+var(--move-tree-indent-desktop))]"
                style={visualIndent(row.level)}
              >
                {row.control.busy
                  ? "Loading folders…"
                  : row.control.type === "before"
                    ? "Show earlier"
                    : row.control.type === "after"
                      ? "Show more"
                      : "Could not load folders. Retry"}
              </button>
            );
          }
          const documents = row.id === MOVE_TREE_DOCUMENTS;
          const node = row.node;
          const expanded = documents ? true : !!state.expanded[row.id];
          const hasChildren = documents || !!node?.has_children;
          const current = documents
            ? state.bootstrap?.documents.current
            : node?.current || node?.reason === "current";
          const viewOnly = node?.access === "view" || node?.reason === "view_only";
          const tooDeep = node?.reason === "too_deep";
          const branch = state.branches[node?.id || MOVE_TREE_ROOT];
          const selected = state.selected === row.id;
          const title = documents ? "Documents" : node?.title || "Folder";
          const Icon = documents ? Home : FolderIcon;
          return (
            <div key={row.id} role="none" style={visualIndent(row.level)}>
              <div
                ref={(element) => {
                  if (element) refs.current.set(row.id, element);
                  else refs.current.delete(row.id);
                }}
                role="treeitem"
                aria-level={row.level}
                aria-expanded={hasChildren ? expanded : undefined}
                aria-selected={selected}
                aria-current={current ? "location" : undefined}
                tabIndex={state.focused === row.id ? 0 : -1}
                onFocus={() => dispatch({ type: "focus", id: row.id })}
                onClick={() => {
                  dispatch({ type: "focus", id: row.id });
                  if (node && !node.selectable && node.has_children)
                    void setExpanded(node.id, !expanded);
                  else select(row.id, node);
                }}
                onKeyDown={(event) => onKeyDown(event, index, node)}
                className={cn(
                  "group flex min-h-11 w-full touch-manipulation select-none items-center gap-2 rounded-md py-1.5 pe-3 ps-[calc(0.5rem+var(--move-tree-indent-mobile))] text-start text-sm outline-none transition-colors duration-100 md:ps-[calc(0.5rem+var(--move-tree-indent-desktop))]",
                  "focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:ring-offset-1 focus-visible:ring-offset-[var(--color-surface)]",
                  selected
                    ? "bg-[var(--color-accent-muted)] text-[var(--color-fg)]"
                    : "hover:bg-[var(--color-surface-muted)]",
                )}
              >
                {node?.has_children ? (
                  <button
                    type="button"
                    tabIndex={-1}
                    aria-label={expanded ? `Collapse ${title}` : `Expand ${title}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      dispatch({ type: "focus", id: node.id });
                      event.currentTarget.parentElement?.focus({ preventScroll: true });
                      void setExpanded(node.id, !expanded);
                    }}
                    className="-ms-2 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-[var(--color-fg-muted)] active:scale-[0.96]"
                  >
                    {expanded ? (
                      <ChevronDown className="h-4 w-4" />
                    ) : (
                      <ChevronRight className="h-4 w-4" />
                    )}
                  </button>
                ) : (
                  <span className="w-5 shrink-0" aria-hidden="true" />
                )}
                <Icon
                  aria-hidden="true"
                  className="h-4 w-4 shrink-0 text-[var(--color-accent)]"
                />
                <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                  <span className="block min-w-0 break-words font-medium">{title}</span>
                  {node?.restricted_parent ? (
                    <span className="block text-xs text-[var(--color-fg-muted)]">
                      In a restricted folder
                    </span>
                  ) : null}
                </span>
                {viewOnly ? (
                  <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-xs text-[var(--color-fg-muted)]">
                    <LockKeyhole aria-hidden="true" className="h-3.5 w-3.5" /> View only
                  </span>
                ) : current ? (
                  <span className="shrink-0 whitespace-nowrap text-xs text-[var(--color-fg-muted)]">
                    Current
                  </span>
                ) : tooDeep ? (
                  <span className="shrink-0 whitespace-nowrap text-xs text-[var(--color-fg-muted)]">
                    Too deep
                  </span>
                ) : null}
              </div>
              {expanded && branch?.loading ? (
                <div
                  role="treeitem"
                  aria-level={row.level + 1}
                  aria-disabled="true"
                  aria-busy="true"
                  tabIndex={-1}
                  className="py-2 pe-3 ps-[calc(2rem+var(--move-tree-indent-mobile))] text-sm text-[var(--color-fg-muted)] md:ps-[calc(2rem+var(--move-tree-indent-desktop))]"
                >
                  Loading folders…
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </>
  );
}
