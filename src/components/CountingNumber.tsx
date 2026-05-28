"use client";

import React, { useEffect, useRef, useState } from "react";
import { formatChips } from "@/lib/format";

interface CountingNumberProps {
  /** Target value to animate to. */
  value: number;
  /** Animation duration in ms. */
  duration?: number;
  /** Custom formatter. Defaults to comma-grouped integers (formatChips). */
  format?: (n: number) => string;
  /** Fixed decimal places (ignored when `format` is provided). */
  decimals?: number;
  prefix?: string;
  suffix?: string;
  className?: string;
}

/**
 * Canonical RAF count-up readout shared by every game. Animates from the
 * previously-displayed value to `value` with a cubic ease-out, and cancels the
 * frame loop on unmount (no setState-after-unmount).
 */
export function CountingNumber({
  value,
  duration = 540,
  format,
  decimals,
  prefix = "",
  suffix = "",
  className = "",
}: CountingNumberProps) {
  const [display, setDisplay] = useState(value);
  const raf = useRef<number | null>(null);
  const fromRef = useRef(value);

  useEffect(() => {
    fromRef.current = display;
    const from = fromRef.current;
    const delta = value - from;
    if (delta === 0) return;
    const start = performance.now();

    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      setDisplay(from + delta * eased);
      if (t < 1) raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);

    return () => {
      if (raf.current) cancelAnimationFrame(raf.current);
    };
    // Only re-run when the target value changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, duration]);

  const text =
    format != null
      ? format(display)
      : decimals != null
        ? display.toFixed(decimals)
        : formatChips(display);

  return (
    <span className={`tabular-nums ${className}`}>
      {prefix}
      {text}
      {suffix}
    </span>
  );
}
