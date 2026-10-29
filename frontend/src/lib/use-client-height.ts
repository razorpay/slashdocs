import { useLayoutEffect, useRef, useState } from "react";

// Tracks an element's clientHeight as it resizes. Attach the returned ref to it.
export function useClientHeight<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [height, setHeight] = useState(0);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () => setHeight(element.clientHeight);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return [ref, height] as const;
}
