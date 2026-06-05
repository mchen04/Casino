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
  /** Stable design height used so later game states do not resize the surface. */
  designHeight?: number;
  /** Time allowed for lazy-loaded game content to settle before fitting locks. */
  lockAfterMs?: number;
  className?: string;
}

/**
 * Auto-scales its content down so the whole play surface fits the visible
 * viewport height — the single lever that makes every game "fit on one screen,
 * just play" on desktop, laptop, phone portrait AND landscape, with no scroll.
 *
 * It measures the game once while the lazy-loaded component settles, then locks
 * that height basis before user interaction. Gameplay can reveal cards, banners
 * or bet controls without zooming the whole UI in and out; only viewport changes
 * refit the surface.
 */
export function FitToViewport({
  children,
  maxScale = 1,
  minScale = 0.3,
  bottomGap = 14,
  designHeight = 760,
  lockAfterMs = 1500,
  className = "",
}: FitToViewportProps) {
  const outerRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [boxH, setBoxH] = useState<number | undefined>(undefined);
  const rafRef = useRef<number | null>(null);
  const basisHRef = useRef(0);
  const lockedRef = useRef(false);

  const measure = useCallback((force = false) => {
    const outer = outerRef.current;
    const inner = innerRef.current;
    if (!outer || !inner) return;
    if (lockedRef.current && !force && basisHRef.current > 0) return;

    // Natural content height — unaffected by the visual transform.
    const contentH = inner.offsetHeight;
    if (contentH <= 0) return;
    if (!lockedRef.current || basisHRef.current === 0) {
      basisHRef.current = Math.max(basisHRef.current, designHeight, contentH);
    }

    const top = outer.getBoundingClientRect().top;
    const availH = window.innerHeight - top - bottomGap;
    const basisH = Math.max(basisHRef.current, designHeight, contentH);

    let next = Math.min(maxScale, availH / basisH);
    next = Math.max(minScale, Math.min(maxScale, next));
    if (!Number.isFinite(next) || next <= 0) next = maxScale;

    const nextBoxH = basisH * next;

    setScale((prev) => (Math.abs(prev - next) > 0.004 ? next : prev));
    setBoxH((prev) =>
      prev === undefined || Math.abs(prev - nextBoxH) > 0.5 ? nextBoxH : prev,
    );
  }, [bottomGap, designHeight, maxScale, minScale]);

  const schedule = useCallback((force = false) => {
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => measure(force));
  }, [measure]);

  useLayoutEffect(() => {
    schedule();
    const inner = innerRef.current;
    const outer = outerRef.current;
    const ro = new ResizeObserver(() => schedule(false));
    if (inner) ro.observe(inner);
    const onResize = () => schedule(true);
    const lock = () => {
      lockedRef.current = true;
    };
    const lockTimer = window.setTimeout(lock, lockAfterMs);

    outer?.addEventListener("pointerdown", lock, { capture: true });
    outer?.addEventListener("keydown", lock, { capture: true });
    window.addEventListener("resize", onResize);
    window.addEventListener("orientationchange", onResize);
    return () => {
      ro.disconnect();
      window.clearTimeout(lockTimer);
      outer?.removeEventListener("pointerdown", lock, { capture: true });
      outer?.removeEventListener("keydown", lock, { capture: true });
      window.removeEventListener("resize", onResize);
      window.removeEventListener("orientationchange", onResize);
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, [lockAfterMs, schedule]);

  return (
    <div
      ref={outerRef}
      data-testid="viewport-fitter"
      className={className}
      style={{ height: boxH, overflow: "visible", position: "relative" }}
    >
      <div
        ref={innerRef}
        data-testid="viewport-fitter-content"
        style={{
          transform: scale === 1 ? undefined : `scale(${scale})`,
          transformOrigin: "top center",
          transition: "none",
          width: "100%",
        }}
      >
        {children}
      </div>
    </div>
  );
}
