import { useCallback, useEffect, useLayoutEffect, useReducer, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  APIError,
  api,
  type MoveDestinationChildren,
  type MoveResourceType,
} from "@/api";
import { queryKeys } from "@/lib/queryKeys";
import {
  initialMoveTreeState,
  MOVE_TREE_ROOT,
  moveTreeReducer,
  type MoveTreeAction,
} from "./move-tree-state";

export function useMoveTree({
  open,
  type,
  id,
}: {
  open: boolean;
  type: MoveResourceType;
  id: string;
}) {
  const client = useQueryClient();
  const [state, dispatch] = useReducer(moveTreeReducer, initialMoveTreeState);
  const identity = `${open ? "open" : "closed"}\u0000${type}\u0000${id}`;
  const identityRef = useRef(identity);
  const epochRef = useRef(1);
  const bootstrapFetchedEpochRef = useRef(-1);
  const bootstrapAppliedEpochRef = useRef(-1);
  const bootstrapRetryEpochRef = useRef(-1);
  const stateRef = useRef(state);
  if (identityRef.current !== identity) {
    identityRef.current = identity;
    epochRef.current += 1;
    bootstrapFetchedEpochRef.current = -1;
    bootstrapAppliedEpochRef.current = -1;
    bootstrapRetryEpochRef.current = -1;
  }
  const bootstrap = useQuery({
    queryKey: queryKeys.moveDestinations(type, id),
    queryFn: async () => {
      const epoch = epochRef.current;
      const data = await api.getMoveDestinations(type, id);
      if (epochRef.current === epoch) bootstrapFetchedEpochRef.current = epoch;
      return data;
    },
    enabled: open,
    meta: { suppressGlobalError: true },
  });
  const bootstrapData = bootstrap.data;
  const bootstrapIsFetching = bootstrap.isFetching;
  const refetchBootstrap = bootstrap.refetch;

  useLayoutEffect(() => {
    stateRef.current = state;
  }, [state]);

  // The dialog can reopen against cached query data while this hook remains
  // mounted. Reset before paint so a destination from the previous opening
  // can never flash as confirmable.
  useLayoutEffect(() => {
    dispatch({ type: "reset" });
  }, [open, type, id]);

  useEffect(() => {
    if (!open || !bootstrapData) return;
    const epoch = epochRef.current;
    if (bootstrapFetchedEpochRef.current !== epoch) {
      if (!bootstrapIsFetching && bootstrapRetryEpochRef.current !== epoch) {
        bootstrapRetryEpochRef.current = epoch;
        void refetchBootstrap();
      }
      return;
    }
    if (bootstrapAppliedEpochRef.current === epoch) return;
    bootstrapAppliedEpochRef.current = epoch;
    dispatch({ type: "bootstrap", data: bootstrapData, reveal: false });
  }, [bootstrapData, bootstrapIsFetching, open, refetchBootstrap]);

  const dispatchForEpoch = useCallback((epoch: number, action: MoveTreeAction) => {
    if (epochRef.current === epoch) dispatch(action);
  }, []);

  const loadChildren = useCallback(
    async (
      parent: string | null,
      cursor?: string,
      position: "replace" | "before" | "after" = cursor ? "after" : "replace",
    ) => {
      const epoch = epochRef.current;
      let usedAnchorRecovery = false;
      dispatchForEpoch(epoch, { type: "branch-loading", parent, cursor, position });
      const fetchPage = (anchor?: string, direction?: "before" | "after") =>
        client.fetchQuery({
          queryKey: queryKeys.moveDestinationChildren(
            type,
            id,
            parent,
            anchor ? undefined : cursor,
            anchor,
            direction,
          ),
          queryFn: () =>
            anchor && direction
              ? api.listMoveDestinationChildren(
                  type,
                  id,
                  parent,
                  undefined,
                  anchor,
                  direction,
                )
              : api.listMoveDestinationChildren(type, id, parent, cursor),
          staleTime: 30_000,
        });
      try {
        let data: MoveDestinationChildren;
        try {
          data = await fetchPage();
        } catch (error) {
          if (
            !(error instanceof APIError) ||
            error.code !== "invalid_cursor" ||
            !cursor ||
            (position !== "before" && position !== "after")
          )
            throw error;
          const branch = stateRef.current.branches[parent ?? MOVE_TREE_ROOT];
          const anchor = position === "before" ? branch?.ids[0] : branch?.ids.at(-1);
          if (!anchor) throw error;
          usedAnchorRecovery = true;
          data = await fetchPage(anchor, position);
        }
        dispatchForEpoch(epoch, { type: "branch-loaded", parent, data, position });
        dispatchForEpoch(epoch, {
          type: "announce",
          message: data.items.length
            ? `${data.items.length} more folder${data.items.length === 1 ? "" : "s"} loaded.`
            : "No more folders to load.",
        });
        return epochRef.current === epoch;
      } catch (error) {
        dispatchForEpoch(epoch, {
          type: "branch-error",
          parent,
          clearCursor:
            usedAnchorRecovery ||
            (error instanceof APIError && error.code === "invalid_cursor"),
        });
        return false;
      }
    },
    [client, dispatchForEpoch, id, type],
  );

  const setExpanded = useCallback(
    async (folderId: string, expanded: boolean) => {
      dispatch({ type: "expand", id: folderId, expanded });
      if (!expanded || state.branches[folderId]) return;
      await loadChildren(folderId);
    },
    [loadChildren, state.branches],
  );

  const reveal = useCallback(
    async (folderId: string) => {
      const epoch = epochRef.current;
      try {
        const data = await client.fetchQuery({
          queryKey: queryKeys.moveDestinations(type, id, folderId),
          queryFn: () => api.getMoveDestinations(type, id, folderId),
        });
        if (epochRef.current !== epoch) return false;
        dispatch({ type: "bootstrap", data, reveal: true });
        return true;
      } catch (error) {
        // A request owned by a closed dialog or another resource is neither a
        // success nor an error for the current opening. Keep both reducer and
        // dialog-local error state untouched.
        if (epochRef.current !== epoch) return false;
        throw error;
      }
    },
    [client, id, type],
  );

  const refresh = useCallback(async () => {
    epochRef.current += 1;
    bootstrapFetchedEpochRef.current = -1;
    bootstrapAppliedEpochRef.current = -1;
    bootstrapRetryEpochRef.current = -1;
    dispatch({ type: "reset" });
    await refetchBootstrap();
  }, [refetchBootstrap]);

  return {
    state,
    dispatch,
    bootstrap,
    loadChildren,
    setExpanded,
    reveal,
    refresh,
  };
}
