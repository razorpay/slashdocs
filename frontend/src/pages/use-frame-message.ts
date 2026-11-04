import { useEffect, useRef, type RefObject } from "react";

// useFrameMessage gives receive each message from the render frame while it
// is ready. The frame also runs the document's own scripts, so receive checks
// what it reads.
export function useFrameMessage(
  frame: RefObject<HTMLIFrameElement | null>,
  origin: string | null,
  ready: boolean,
  receive: (data: Record<string, unknown>) => void,
) {
  const latest = useRef(receive);
  latest.current = receive;
  useEffect(() => {
    if (!ready || !origin) return;
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== origin || e.source !== frame.current?.contentWindow) return;
      if (e.data && typeof e.data === "object") latest.current(e.data);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [frame, origin, ready]);
}
