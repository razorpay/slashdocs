import type {
  MoveDestinationBootstrap,
  MoveDestinationChildren,
  MoveDestinationLevel,
  MoveDestinationNode,
} from "@/api";

export const MOVE_TREE_ROOT = "__move_tree_root__";
export const MOVE_TREE_DOCUMENTS = "__move_tree_documents__";
const MOVE_TREE_CONTROL = "__move_tree_control__";

export type MoveTreeControlType = "before" | "after" | "retry";

export const moveTreeControlId = (
  parent: string | null,
  control: MoveTreeControlType,
) => `${MOVE_TREE_CONTROL}:${parent ?? MOVE_TREE_ROOT}:${control}`;

export type MoveTreeBranch = {
  ids: string[];
  before?: string;
  after?: string;
  loading?: boolean;
  error?: boolean;
  retry?: {
    cursor?: string;
    position: "replace" | "before" | "after";
  };
};

export type MoveTreeState = {
  bootstrap?: MoveDestinationBootstrap;
  nodes: Record<string, MoveDestinationNode>;
  branches: Record<string, MoveTreeBranch>;
  expanded: Record<string, boolean>;
  focused: string;
  selected?: string;
  announcement: string;
};

export type MoveTreeAction =
  | { type: "reset" }
  | { type: "bootstrap"; data: MoveDestinationBootstrap; reveal?: boolean }
  | {
      type: "branch-loading";
      parent: string | null;
      cursor?: string;
      position: "replace" | "before" | "after";
    }
  | {
      type: "branch-loaded";
      parent: string | null;
      data: MoveDestinationChildren;
      position?: "replace" | "before" | "after";
    }
  | { type: "branch-error"; parent: string | null; clearCursor?: boolean }
  | { type: "expand"; id: string; expanded: boolean }
  | { type: "focus"; id: string }
  | { type: "select"; id: string; announcement?: string }
  | { type: "announce"; message: string };

const branchKey = (parent: string | null) => parent ?? MOVE_TREE_ROOT;

const mergeNodes = (
  current: Record<string, MoveDestinationNode>,
  items: MoveDestinationNode[],
) => {
  const nodes = { ...current };
  for (const item of items) nodes[item.id] = item;
  return nodes;
};

const levelBranch = (level: MoveDestinationLevel): MoveTreeBranch => ({
  ids: level.items.map((item) => item.id),
  before: level.before,
  after: level.after,
});

export const initialMoveTreeState: MoveTreeState = {
  nodes: {},
  branches: {},
  expanded: {},
  focused: MOVE_TREE_DOCUMENTS,
  announcement: "",
};

export function moveTreeReducer(
  state: MoveTreeState,
  action: MoveTreeAction,
): MoveTreeState {
  if (action.type === "reset") return { ...initialMoveTreeState };
  if (action.type === "bootstrap") {
    let nodes = action.reveal ? state.nodes : {};
    const branches = action.reveal ? { ...state.branches } : {};
    const expanded = action.reveal ? { ...state.expanded } : {};
    for (const level of action.data.levels) {
      nodes = mergeNodes(nodes, level.items);
      branches[branchKey(level.parent)] = levelBranch(level);
      if (level.parent) expanded[level.parent] = true;
    }
    const focus = action.data.focus ?? MOVE_TREE_DOCUMENTS;
    return {
      ...state,
      bootstrap: action.data,
      nodes,
      branches,
      expanded,
      focused: focus,
      selected: action.reveal && nodes[focus]?.selectable ? focus : undefined,
      announcement: action.reveal
        ? `Showing ${nodes[focus]?.title || "folder"} in the folder tree.`
        : "",
    };
  }
  if (action.type === "branch-loading") {
    const key = branchKey(action.parent);
    return {
      ...state,
      branches: {
        ...state.branches,
        [key]: {
          ...(state.branches[key] || { ids: [] }),
          loading: true,
          retry: { cursor: action.cursor, position: action.position },
        },
      },
    };
  }
  if (action.type === "branch-loaded") {
    const key = branchKey(action.parent);
    const previous = state.branches[key];
    const nextIds = action.data.items.map((item) => item.id);
    const position = action.position || "replace";
    const ids =
      position === "after"
        ? [...(previous?.ids || []), ...nextIds].filter(
            (id, index, all) => all.indexOf(id) === index,
          )
        : position === "before"
          ? [...nextIds, ...(previous?.ids || [])].filter(
              (id, index, all) => all.indexOf(id) === index,
            )
          : nextIds;
    return {
      ...state,
      focused: (["before", "after", "retry"] as const).some(
        (control) => state.focused === moveTreeControlId(action.parent, control),
      )
        ? (nextIds[0] ?? action.parent ?? MOVE_TREE_DOCUMENTS)
        : state.focused,
      nodes: mergeNodes(state.nodes, action.data.items),
      branches: {
        ...state.branches,
        [key]: {
          ids,
          before:
            position === "before"
              ? action.data.before
              : position === "replace"
                ? action.data.before
                : previous?.before,
          after:
            position === "before"
              ? previous?.after
              : (action.data.after ?? action.data.next),
          loading: false,
          error: false,
          retry: undefined,
        },
      },
    };
  }
  if (action.type === "branch-error") {
    const key = branchKey(action.parent);
    return {
      ...state,
      focused:
        state.focused === moveTreeControlId(action.parent, "before") ||
        state.focused === moveTreeControlId(action.parent, "after")
          ? moveTreeControlId(action.parent, "retry")
          : state.focused,
      branches: {
        ...state.branches,
        [key]: {
          ...(state.branches[key] || { ids: [] }),
          loading: false,
          error: true,
          retry: action.clearCursor
            ? { position: "replace" }
            : state.branches[key]?.retry,
        },
      },
    };
  }
  if (action.type === "expand") {
    return {
      ...state,
      expanded: { ...state.expanded, [action.id]: action.expanded },
    };
  }
  if (action.type === "focus") return { ...state, focused: action.id };
  if (action.type === "select") {
    return {
      ...state,
      focused: action.id,
      selected: action.id,
      announcement: action.announcement || "Destination selected.",
    };
  }
  return { ...state, announcement: action.message };
}

export type VisibleMoveTreeRow = {
  id: string;
  level: number;
  node?: MoveDestinationNode;
  control?: {
    type: MoveTreeControlType;
    parent: string | null;
    cursor?: string;
    position: "replace" | "before" | "after";
    label: string;
    busy: boolean;
  };
};

export function visibleMoveTreeRows(state: MoveTreeState): VisibleMoveTreeRow[] {
  const rows: VisibleMoveTreeRow[] = [{ id: MOVE_TREE_DOCUMENTS, level: 1 }];
  const branchLocation = (parent: string | null) => {
    if (!parent) return "Documents";
    const titles: string[] = [];
    const seen = new Set<string>();
    let id: string | null | undefined = parent;
    while (id && !seen.has(id)) {
      seen.add(id);
      const node: MoveDestinationNode | undefined = state.nodes[id];
      if (!node) break;
      titles.unshift(node.title);
      id = node.parent_id;
    }
    return ["Documents", ...titles].join(" / ");
  };
  const visit = (parent: string | null, level: number) => {
    const branch = state.branches[branchKey(parent)];
    const location = branchLocation(parent);
    if (branch?.before && !branch.error) {
      rows.push({
        id: moveTreeControlId(parent, "before"),
        level,
        control: {
          type: "before",
          parent,
          cursor: branch.before,
          position: "before",
          label: `Show earlier folders in ${location}`,
          busy: !!branch.loading,
        },
      });
    }
    for (const id of branch?.ids || []) {
      const node = state.nodes[id];
      if (!node) continue;
      rows.push({ id, level, node });
      if (state.expanded[id]) visit(id, level + 1);
    }
    if (branch?.error) {
      rows.push({
        id: moveTreeControlId(parent, "retry"),
        level,
        control: {
          type: "retry",
          parent,
          cursor: branch.retry?.cursor,
          position: branch.retry?.position || "replace",
          label: `Retry loading folders in ${location}`,
          busy: !!branch.loading,
        },
      });
    } else if (branch?.after) {
      rows.push({
        id: moveTreeControlId(parent, "after"),
        level,
        control: {
          type: "after",
          parent,
          cursor: branch.after,
          position: "after",
          label: `Show more folders in ${location}`,
          busy: !!branch.loading,
        },
      });
    }
  };
  visit(null, 2);
  return rows;
}

export function destinationForSelection(id?: string) {
  if (!id) return undefined;
  return id === MOVE_TREE_DOCUMENTS
    ? ({ kind: "root" } as const)
    : ({ kind: "folder", folder_id: id } as const);
}
