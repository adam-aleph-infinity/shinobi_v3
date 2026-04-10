"use client";
import { useState, useEffect, useCallback, useRef } from "react";

/**
 * direction "right" (default) — drag handle is on the panel's RIGHT edge.
 *   Dragging right grows the panel. Use for left-side panels.
 * direction "left" — drag handle is on the panel's LEFT edge.
 *   Dragging left grows the panel. Use for right-side panels.
 */
export function useResize(
  initial: number,
  min = 120,
  max = 600,
  direction: "right" | "left" = "right",
) {
  const [width, setWidth] = useState(initial);
  const state = useRef({ dragging: false, startX: 0, startW: 0 });

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    state.current = { dragging: true, startX: e.clientX, startW: width };
    e.preventDefault();
  }, [width]);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!state.current.dragging) return;
      const delta = direction === "right"
        ? e.clientX - state.current.startX
        : state.current.startX - e.clientX;
      setWidth(Math.max(min, Math.min(max, state.current.startW + delta)));
    };
    const onUp = () => { state.current.dragging = false; };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    return () => { document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp); };
  }, [min, max, direction]);

  return [width, onMouseDown] as const;
}
