"use client";

import React, { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";

interface CollapsiblePanelProps {
  /** Header label, e.g. "Paytable" or "Odds & Rules". */
  title: string;
  /** Optional short summary shown in the header while collapsed (e.g. "best 1.06%"). */
  summary?: React.ReactNode;
  /** Accent color for the chevron/title glow. */
  accent?: string;
  /**
   * Force the initial open state. When omitted, the panel opens itself on roomy
   * viewports (wide AND tall enough) and stays collapsed on phones / landscape —
   * the single biggest lever for fitting a game on one screen.
   */
  defaultOpen?: boolean;
  className?: string;
  children: React.ReactNode;
}

/**
 * A compact, tap-to-expand panel for secondary content (paytables, odds, rules,
 * history). Collapsed by default on small / short viewports so the play surface
 * and controls fit on one screen; auto-expands on desktop. Always reachable via
 * the header toggle on every viewport.
 */
export function CollapsiblePanel({
  title,
  summary,
  accent = "#d4af37",
  defaultOpen,
  className = "",
  children,
}: CollapsiblePanelProps) {
  // Start collapsed for SSR + small screens; expand after mount on roomy
  // viewports. Avoids hydration mismatch and keeps phones/landscape compact.
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (defaultOpen !== undefined) {
      setOpen(defaultOpen);
      return;
    }
    if (typeof window !== "undefined") {
      // Only auto-open where there's genuinely room to spare: a wide AND tall
      // desktop. Laptops (~900px tall) and every phone/landscape start collapsed
      // so the play surface + controls fit on one screen; the header toggles it.
      const roomy = window.matchMedia("(min-width: 1024px) and (min-height: 950px)");
      setOpen(roomy.matches);
    }
  }, [defaultOpen]);

  return (
    <div className={`glass overflow-hidden rounded-2xl ${className}`}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 px-4 py-2 text-left transition-colors hover:bg-white/5"
      >
        <span className="flex items-center gap-2">
          <span
            className="text-[11px] font-bold uppercase tracking-[0.2em]"
            style={{ color: accent }}
          >
            {title}
          </span>
          {summary && !open && (
            <span className="text-[11px] text-white/45">{summary}</span>
          )}
        </span>
        <motion.span
          animate={{ rotate: open ? 180 : 0 }}
          transition={{ duration: 0.2 }}
          className="text-xs text-white/50"
          aria-hidden
        >
          ▾
        </motion.span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key="body"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: "easeInOut" }}
            className="overflow-hidden"
          >
            <div className="px-4 pb-3 pt-0">{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
