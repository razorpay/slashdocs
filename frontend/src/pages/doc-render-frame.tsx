import { useCallback, useEffect, useMemo, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type Anchor } from "@/api";
import { queryKeys } from "@/lib/queryKeys";
import { COMMENT_STATUS } from "@/lib/constants";
import { Center } from "@/components/ui/misc";
import { useResolvedTheme } from "@/lib/theme";
import { useDoc } from "./doc-context";

// Renders the sandboxed document iframe and exchanges selection and paint
// messages with the in-iframe bridge. Message origins are validated on both
// ends, and painting is driven by the bridge's ready signal.
export function RenderFrame() {
  const {
    docId,
    version,
    comments,
    activeComment,
    commentNavigation,
    setSelection,
    handleDocCommentClick,
  } = useDoc();
  const ref = useRef<HTMLIFrameElement>(null);
  const readyRef = useRef(false);
  const theme = useResolvedTheme();

  const token = useQuery({
    queryKey: queryKeys.render(version),
    queryFn: () => api.renderToken(docId, version),
    staleTime: 4 * 60_000,
    enabled: !!version,
  });

  const paintPayload = useMemo(
    () =>
      comments
        // Resolved comments keep their anchor server-side (in case a resolve
        // is reversed) but should not be highlighted in the rendered doc.
        .filter((c) => c.status !== COMMENT_STATUS.resolved)
        .map((c) => ({
          id: c.id,
          quote: c.selected_text || c.anchor?.quote,
          anchor: c.anchor,
        })),
    [comments],
  );

  const frameOrigin = useMemo(() => {
    if (!token.data?.url) return null;
    try {
      return new URL(token.data.url, window.location.href).origin;
    } catch {
      return null;
    }
  }, [token.data]);

  // Reset readiness whenever we load a different frame.
  useEffect(() => {
    readyRef.current = false;
  }, [frameOrigin, token.data?.url]);

  // The resolved theme is baked into the iframe URL so the bridge can apply
  // it before the document's first paint (no flash); live toggles are pushed
  // over postMessage below.
  const frameSrc = useMemo(() => {
    const url = token.data?.url;
    if (!url) return undefined;
    const sep = url.includes("?") ? "&" : "?";
    return `${url}${sep}aidocs_theme=${theme}`;
    // theme is intentionally excluded: changing it must not reload the frame.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token.data?.url]);

  const paint = useCallback(() => {
    if (!readyRef.current || !frameOrigin) return;
    ref.current?.contentWindow?.postMessage(
      { type: "aidocs:paint", comments: paintPayload, active: activeComment },
      frameOrigin,
    );
  }, [paintPayload, activeComment, frameOrigin]);

  // Push live theme changes to the bridge once the frame is ready.
  useEffect(() => {
    if (!readyRef.current || !frameOrigin) return;
    ref.current?.contentWindow?.postMessage(
      { type: "aidocs:theme", theme },
      frameOrigin,
    );
  }, [theme, frameOrigin]);

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (!frameOrigin || e.origin !== frameOrigin) return;
      if (e.data?.type === "aidocs:selection") {
        const anchor = e.data.anchor as Partial<Anchor> | undefined;
        const quote = anchor?.quote ?? e.data.quote;
        if (quote) setSelection({ quote, anchor });
      }
      if (e.data?.type === "aidocs:activate" && typeof e.data.id === "string") {
        handleDocCommentClick(e.data.id);
      }
      if (e.data?.type === "aidocs:ready") {
        readyRef.current = true;
        paint();
        ref.current?.contentWindow?.postMessage(
          { type: "aidocs:theme", theme },
          frameOrigin,
        );
      }
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [frameOrigin, paint, setSelection, handleDocCommentClick, theme]);

  // Push fresh paint data once the frame is ready and whenever it changes.
  useEffect(() => {
    paint();
  }, [paint]);

  useEffect(() => {
    if (commentNavigation?.source !== "panel") return;
    paint();
  }, [commentNavigation, paint]);

  // The parent (DocPage) only mounts RenderFrame when a current version
  // exists, so version is always set here.
  if (token.isLoading) return <Center>Preparing secure render…</Center>;
  if (token.error) return <Center>Could not create render token.</Center>;
  return (
    <iframe
      ref={ref}
      title="Rendered document"
      // Match the frame to the resolved theme so dark readers don't see a
      // white flash before the document paints.
      className="h-full w-full"
      style={{ background: theme === "dark" ? "#0b0d12" : "#fff" }}
      src={frameSrc}
      sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"
    />
  );
}
