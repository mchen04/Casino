"use client";

import React from "react";
import { MotionConfig } from "framer-motion";

/**
 * App-wide framer-motion config. `reducedMotion="user"` makes every animated
 * component in every game automatically respect the OS "reduce motion" setting
 * (transform/layout animations are skipped, opacity kept) — accessibility for
 * the whole casino floor from one place, no per-game wiring needed.
 */
export function MotionProvider({ children }: { children: React.ReactNode }) {
  return <MotionConfig reducedMotion="user">{children}</MotionConfig>;
}
