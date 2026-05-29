"use client";

import React, {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

interface FitToViewportProps {
  children: React.ReactNode;
  /** Never enlarge past this (1 = natural size). */
  maxScale?: number;
  /** Never shrink below this; past it we allow a scroll fallback. The floor is
   *  low enough that even the densest tables (craps/bingo/keno) fit a phone in
   *  landscape (~390px tall) with no scroll. */
  minScale?: number;
  /** Breathing room reserved below the surface (px). */
  bottomGap?: number;
  className?: string;
}

/**
 * Auto-scales its content down so the whole play surface fits the visible
 * viewport height — the single lever that makes every game "fit on one screen,
 * just play" on desktop, laptop, phone portrait AND landscape, with no scroll.
 *
 * It measures the content's natural (un-transformed) height against the space
 * between the sticky header and the bottom of the window, then applies a uniform
 * `scale()` (only ever shrinking). Transforms don't affect layout measurement,
 * so this never fights framer-motion's transform/opacity animations; it only
 * re-fits when real layout height changes (a result banner, an opened paytable).
 */
export function FitToViewport({
  children,
  maxScale = 1,
  minScale = 0.3,
  bottomGap = 14,
  className = "",
}: FitToViewportProps) {
  const outerRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [boxH, setBoxH] = useState<number | undefined>(undefined);
  const rafRef = useRef<number | null>(null);

  const measure = useCallback(() => {
    const outer = outerRef.current;
    const inner = innerRef.current;
    if (!outer || !inner) return;

    // Natural content height — unaffected by the visual transform.
    const contentH = inner.offsetHeight;
    if (contentH <= 0) return;

    const top = outer.getBoundingClientRect().top;
    const availH = window.innerHeight - top - bottomGap;

    let next = Math.min(maxScale, availH / contentH);
    next = Math.max(minScale, Math.min(maxScale, next));
    if (!Number.isFinite(next) || next <= 0) next = maxScale;

    const nextBoxH = contentH * next;

    setScale((prev) => (Math.abs(prev - next) > 0.004 ? next : prev));
    setBoxH((prev) =>
      prev === undefined || Math.abs(prev - nextBoxH) > 0.5 ? nextBoxH : prev,
    );
  }, [bottomGap, maxScale, minScale]);

  const schedule = useCallback(() => {
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(measure);
  }, [measure]);

  useLayoutEffect(() => {
    schedule();
    const inner = innerRef.current;
    const ro = new ResizeObserver(schedule);
    if (inner) ro.observe(inner);
    window.addEventListener("resize", schedule);
    window.addEventListener("orientationchange", schedule);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("orientationchange", schedule);
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, [schedule]);

  return (
    <div
      ref={outerRef}
      className={className}
      style={{ height: boxH, position: "relative" }}
    >
      <div
        ref={innerRef}
        style={{
          transform: scale === 1 ? undefined : `scale(${scale})`,
          transformOrigin: "top center",
          transition: "transform 180ms cubic-bezier(0.2,0.7,0.2,1)",
          width: "100%",
        }}
      >
        {children}
      </div>
    </div>
  );
}
