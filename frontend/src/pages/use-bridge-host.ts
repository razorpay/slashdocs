import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, APIError, type DocumentKVEvent } from "@/api";
import { documentDarkStore, useResolvedTheme } from "@/lib/theme";
import { errorMessage } from "@/lib/errors";

// useBridgeHost is the app side of the render bridge that every embedded
// document needs, wherever it is shown. It passes the theme, answers the
// document's KV and GitHub requests, and forwards KV changes to the frame.
// Message origins are checked on both ends. A signed-out reader who writes
// KV data goes to signIn instead.
export function useBridgeHost(
  docId: string,
  renderURL: string | undefined,
  signIn?: () => void,
) {
  const ref = useRef<HTMLIFrameElement>(null);
  // The frame is ready only for the URL it loaded. A new URL is not ready
  // from the first render that uses it.
  const [readyURL, setReadyURL] = useState<string>();
  const ready = !!renderURL && readyURL === renderURL;
  const renderURLRef = useRef(renderURL);
  renderURLRef.current = renderURL;
  const dark = documentDarkStore.useStore();
  const resolvedTheme = useResolvedTheme();
  // A dark document is sent the dark theme whatever the app theme is.
  const theme = dark ? "dark" : resolvedTheme;
  // Stable handlers read the latest theme and readiness from refs. Handlers
  // that re-register can miss a slashdocs:ready sent during the teardown.
  const themeRef = useRef(theme);
  themeRef.current = theme;
  const darkRef = useRef(dark);
  darkRef.current = dark;
  const readyRef = useRef(ready);
  readyRef.current = ready;
  // The newest KV revision the frame received, so no change goes twice.
  const kvRevision = useRef(0);
  const signInRef = useRef(signIn);
  signInRef.current = signIn;

  const frameOrigin = useMemo(() => {
    if (!renderURL) return null;
    try {
      return new URL(renderURL, window.location.href).origin;
    } catch {
      return null;
    }
  }, [renderURL]);

  // The theme is in the frame URL, so the bridge applies it before the first
  // paint. Later changes go by message, so a theme change never reloads.
  const frameSrc = useMemo(() => {
    if (!renderURL) return undefined;
    const sep = renderURL.includes("?") ? "&" : "?";
    const darkParam = darkRef.current ? "&slashdocs_dark=1" : "";
    return `${renderURL}${sep}slashdocs_theme=${themeRef.current}${darkParam}`;
  }, [renderURL]);

  useEffect(() => {
    kvRevision.current = 0;
  }, [docId]);

  const postToFrame = useCallback(
    (message: unknown) => {
      if (!frameOrigin) return;
      ref.current?.contentWindow?.postMessage(message, frameOrigin);
    },
    [frameOrigin],
  );

  useEffect(() => {
    if (ready) postToFrame({ type: "slashdocs:theme", theme });
  }, [theme, ready, postToFrame]);

  useEffect(() => {
    if (ready) postToFrame({ type: "slashdocs:dark", on: dark });
  }, [dark, ready, postToFrame]);

  // A frame that is not ready yet reads the current KV state when it
  // hydrates, so it misses no change.
  const deliverKV = useCallback(
    (detail: DocumentKVEvent) => {
      if (!readyRef.current || typeof detail?.revision !== "number") return;
      if (detail.revision <= kvRevision.current) return;
      kvRevision.current = detail.revision;
      postToFrame({
        type: "slashdocs:kv-event",
        detail: { ...detail, source: "sync", operation: "sync" },
      });
    },
    [postToFrame],
  );

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (!frameOrigin || e.origin !== frameOrigin) return;
      const requestWindow = e.source;
      if (!requestWindow || requestWindow !== ref.current?.contentWindow) return;
      // Reply only to the frame that asked: the frame can navigate while a
      // request is in flight.
      const reply = (message: unknown) => {
        if (ref.current?.contentWindow !== requestWindow) return;
        requestWindow.postMessage(message, frameOrigin);
      };
      const data = e.data as Record<string, unknown> | null;
      if (data?.type === "slashdocs:ready") {
        setReadyURL(renderURLRef.current);
        reply({ type: "slashdocs:theme", theme: themeRef.current });
        reply({ type: "slashdocs:dark", on: darkRef.current });
      }
      if (data?.type === "slashdocs:kv-request") {
        void answerKV(docId, data, reply, kvRevision, signInRef.current);
      }
      if (data?.type === "slashdocs:github-request") {
        void answerGitHub(docId, data, reply);
      }
      if (data?.type === "slashdocs:github-connect") {
        window.location.assign(
          api.githubConnectURL(
            window.location.pathname + window.location.search + window.location.hash,
          ),
        );
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [docId, frameOrigin]);

  return { ref, frameSrc, frameOrigin, ready, postToFrame, deliverKV };
}

type Reply = (message: unknown) => void;

function failure(err: unknown, fallback: string) {
  return err instanceof APIError
    ? { message: err.message, code: err.code, status: err.status }
    : { message: errorMessage(err, fallback) };
}

async function answerKV(
  docId: string,
  data: Record<string, unknown>,
  reply: Reply,
  kvRevision: { current: number },
  signIn?: () => void,
) {
  const remember = (revision: number) => {
    kvRevision.current = Math.max(kvRevision.current, revision);
  };
  const requestId = String(data.requestId || "");
  const respond = (result: unknown) =>
    reply({ type: "slashdocs:kv-response", requestId, ok: true, result });
  try {
    const operation = String(data.operation || "");
    if (operation === "all" || operation === "hydrate" || operation === "get") {
      const snapshot = await api.listDocumentKV(docId);
      remember(snapshot.revision);
      respond(
        operation === "get"
          ? {
              revision: snapshot.revision,
              value:
                typeof data.key === "string" ? snapshot.items[data.key] : undefined,
            }
          : snapshot,
      );
      return;
    }
    if (operation !== "patch") throw new Error("unknown KV operation");
    if (signIn) {
      signIn();
      throw new Error("Sign in to edit this document.");
    }
    const set =
      data.set && typeof data.set === "object" && !Array.isArray(data.set)
        ? (data.set as Record<string, unknown>)
        : {};
    const deleteKeys = Array.isArray(data.delete)
      ? data.delete.filter((key): key is string => typeof key === "string")
      : [];
    const result = await api.patchDocumentKV(docId, { set, delete: deleteKeys });
    // The stream can deliver this change before the response arrives.
    const delivered = result.revision <= kvRevision.current;
    remember(result.revision);
    respond(result);
    if (!delivered) {
      reply({
        type: "slashdocs:kv-event",
        detail: {
          ...result,
          source: String(data.source || "local"),
          operation: String(data.kvOperation || "patch"),
        },
      });
    }
  } catch (err) {
    reply({
      type: "slashdocs:kv-response",
      requestId,
      ok: false,
      error: failure(err, "KV request failed"),
    });
  }
}

async function answerGitHub(
  docId: string,
  data: Record<string, unknown>,
  reply: Reply,
) {
  const requestId = String(data.requestId || "");
  try {
    if (data.operation !== "raw") throw new Error("unknown GitHub operation");
    const result = await api.githubRawContent(docId, {
      owner: String(data.owner || ""),
      repo: String(data.repo || ""),
      path: String(data.path || ""),
      ref: String(data.ref || ""),
    });
    reply({ type: "slashdocs:github-response", requestId, ok: true, result });
  } catch (err) {
    reply({
      type: "slashdocs:github-response",
      requestId,
      ok: false,
      error: failure(err, "GitHub request failed"),
    });
  }
}
