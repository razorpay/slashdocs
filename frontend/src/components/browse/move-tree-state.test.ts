import { describe, expect, it } from "vitest";
import type { MoveDestinationBootstrap, MoveDestinationNode } from "@/api";
import {
  MOVE_TREE_DOCUMENTS,
  destinationForSelection,
  initialMoveTreeState,
  moveTreeReducer,
  visibleMoveTreeRows,
} from "./move-tree-state";

const node = (
  id: string,
  title: string,
  parent: string | null,
  extra: Partial<MoveDestinationNode> = {},
): MoveDestinationNode => ({
  id,
  title,
  parent_id: parent,
  access: "edit",
  selectable: true,
  ...extra,
});

const bootstrap: MoveDestinationBootstrap = {
  resource: {
    type: "document",
    id: "doc_1",
    title: "Plan",
    can_move: true,
    source: { kind: "folder", folder_id: "c", token: "ms1_source" },
  },
  documents: { selectable: true, current: false, can_create_child: true },
  path: ["a", "b", "c"],
  path_restricted_prefix: false,
  levels: [
    { parent: null, items: [node("a", "A", null, { has_children: true })] },
    { parent: "a", items: [node("b", "B", "a", { has_children: true })] },
    {
      parent: "b",
      items: [node("c", "C", "b", { current: true, selectable: false })],
    },
  ],
  focus: "c",
};

describe("moveTreeReducer", () => {
  it("expands ancestors but keeps the current folder collapsed", () => {
    const state = moveTreeReducer(initialMoveTreeState, {
      type: "bootstrap",
      data: bootstrap,
    });

    expect(state.expanded).toMatchObject({ a: true, b: true });
    expect(state.expanded.c).toBeUndefined();
    expect(visibleMoveTreeRows(state).map((row) => row.id)).toEqual([
      MOVE_TREE_DOCUMENTS,
      "a",
      "b",
      "c",
    ]);
  });

  it("keeps expansion separate from destination selection", () => {
    let state = moveTreeReducer(initialMoveTreeState, {
      type: "bootstrap",
      data: bootstrap,
    });
    state = moveTreeReducer(state, { type: "expand", id: "c", expanded: true });
    expect(state.selected).toBeUndefined();
    state = moveTreeReducer(state, { type: "select", id: "b" });
    expect(state.selected).toBe("b");
    expect(state.expanded.c).toBe(true);
  });

  it("clears every opening-specific value on reset", () => {
    let state = moveTreeReducer(initialMoveTreeState, {
      type: "bootstrap",
      data: bootstrap,
    });
    state = moveTreeReducer(state, { type: "select", id: "b" });
    state = moveTreeReducer(state, {
      type: "announce",
      message: "Old announcement",
    });

    expect(moveTreeReducer(state, { type: "reset" })).toEqual(initialMoveTreeState);
  });

  it("keeps sibling branches when revealing a search result", () => {
    let state = moveTreeReducer(initialMoveTreeState, {
      type: "bootstrap",
      data: bootstrap,
    });
    state = moveTreeReducer(state, {
      type: "branch-loaded",
      parent: "a",
      position: "replace",
      data: {
        parent: "a",
        items: [node("b", "B", "a"), node("sibling", "Sibling", "a")],
      },
    });
    state = moveTreeReducer(state, {
      type: "bootstrap",
      reveal: true,
      data: {
        ...bootstrap,
        path: ["a", "sibling"],
        levels: [
          {
            parent: "a",
            items: [node("b", "B", "a"), node("sibling", "Sibling", "a")],
          },
        ],
        focus: "sibling",
      },
    });
    expect(state.selected).toBe("sibling");
    expect(state.nodes.b).toBeDefined();
    expect(state.announcement).toContain("Sibling");
  });

  it("focuses but does not select an unavailable search result", () => {
    let state = moveTreeReducer(initialMoveTreeState, {
      type: "bootstrap",
      data: bootstrap,
    });
    const result = node("readonly", "Read only", null, {
      access: "view",
      selectable: false,
      reason: "view_only",
    });
    state = moveTreeReducer(state, {
      type: "bootstrap",
      reveal: true,
      data: {
        ...bootstrap,
        path: [result.id],
        levels: [{ parent: null, items: [result] }],
        focus: result.id,
      },
    });

    expect(state.focused).toBe(result.id);
    expect(state.selected).toBeUndefined();
    expect(state.announcement).toContain("Read only");
  });

  it("maps the top level and folders to explicit move destinations", () => {
    expect(destinationForSelection(MOVE_TREE_DOCUMENTS)).toEqual({ kind: "root" });
    expect(destinationForSelection("folder_1")).toEqual({
      kind: "folder",
      folder_id: "folder_1",
    });
  });

  it("does not reuse a forward-only cursor as another backward cursor", () => {
    let state = moveTreeReducer(initialMoveTreeState, {
      type: "bootstrap",
      data: bootstrap,
    });
    state = moveTreeReducer(state, {
      type: "branch-loaded",
      parent: "b",
      position: "before",
      data: {
        parent: "b",
        items: [node("before", "Before", "b")],
        next: "forward-only",
      },
    });

    expect(state.branches.b.before).toBeUndefined();
    expect(state.branches.b.after).toBe(bootstrap.levels[2]?.after);
  });

  it("drops an expired cursor before exposing a manual retry", () => {
    let state = moveTreeReducer(initialMoveTreeState, {
      type: "bootstrap",
      data: bootstrap,
    });
    state = moveTreeReducer(state, {
      type: "branch-loading",
      parent: "b",
      cursor: "expired",
      position: "after",
    });
    state = moveTreeReducer(state, {
      type: "branch-error",
      parent: "b",
      clearCursor: true,
    });

    expect(state.branches.b.retry).toEqual({ position: "replace" });
    expect(
      visibleMoveTreeRows(state).find((row) => row.control?.type === "retry")?.control,
    ).toMatchObject({ cursor: undefined, position: "replace" });
  });
});
