"use client";

import React, { useEffect, useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { randFloat, randInt, pick } from "@/lib/rng";

type Tier = "win" | "big" | "jackpot";

interface CelebrationProps {
  /** When true, fire a burst. Re-fires whenever `seed` changes. */
  show: boolean;
  /** Bumps to re-trigger the burst for repeat wins (e.g. payout value). */
  seed?: number | string;
  /** Intensity. jackpot > big > win. */
  tier?: Tier;
  /** Confetti/coin colors; defaults to a gold/neon mix. */
  colors?: string[];
}

const DEFAULT_COLORS = ["#f5d060", "#ffd24a", "#22e1ff", "#ff2bd1", "#8aff80", "#ffffff"];

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    const on = () => setReduced(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return reduced;
}

/**
 * A full-surface win celebration: confetti ribbons fluttering down plus a coin
 * fountain bursting up from the base. Drop it as an absolutely-positioned
 * overlay inside a `relative` felt/cabinet container:
 *
 *   <Celebration show={won} seed={payout} tier="jackpot" />
 *
 * Self-clearing, pointer-events:none, and silent under reduced-motion.
 */
export function Celebration({
  show,
  seed = 0,
  tier = "win",
  colors = DEFAULT_COLORS,
}: CelebrationProps) {
  const reduced = usePrefersReducedMotion();
  const [burstKey, setBurstKey] = useState(0);

  useEffect(() => {
    if (show) setBurstKey((k) => k + 1);
  }, [show, seed]);

  const counts = {
    win: { confetti: 26, coins: 10 },
    big: { confetti: 48, coins: 18 },
    jackpot: { confetti: 80, coins: 30 },
  }[tier];

  const confetti = useMemo(
    () =>
      Array.from({ length: counts.confetti }, (_, i) => ({
        id: i,
        x: randFloat(0, 100),
        delay: randFloat(0, tier === "jackpot" ? 0.5 : 0.3),
        dur: randFloat(1.1, 2.1),
        rot: randInt(180, 720),
        drift: randFloat(-60, 60),
        w: randInt(5, 9),
        h: randInt(9, 16),
        color: pick(colors),
        round: Math.random() > 0.6,
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [burstKey],
  );

  const coins = useMemo(
    () =>
      Array.from({ length: counts.coins }, (_, i) => ({
        id: i,
        x: randFloat(15, 85),
        dx: randFloat(-90, 90),
        rise: randFloat(120, 320),
        delay: randFloat(0, 0.25),
        dur: randFloat(0.9, 1.5),
        rot: randInt(-360, 360),
        size: randInt(16, 26),
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [burstKey],
  );

  if (reduced) return null;

  return (
    <div className="pointer-events-none absolute inset-0 z-30 overflow-hidden" aria-hidden>
      <AnimatePresence>
        {show && (
          <motion.div
            key={burstKey}
            className="absolute inset-0"
            initial={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.4 }}
          >
            {/* Confetti ribbons fluttering down from the top. */}
            {confetti.map((c) => (
              <motion.span
                key={`c${c.id}`}
                className="absolute top-0"
                style={{
                  left: `${c.x}%`,
                  width: c.w,
                  height: c.h,
                  background: c.color,
                  borderRadius: c.round ? "50%" : 2,
                  boxShadow: `0 0 6px ${c.color}aa`,
                }}
                initial={{ y: "-12%", x: 0, rotate: 0, opacity: 0 }}
                animate={{
                  y: "112%",
                  x: c.drift,
                  rotate: c.rot,
                  opacity: [0, 1, 1, 0.9, 0],
                }}
                transition={{ duration: c.dur, delay: c.delay, ease: "easeIn" }}
              />
            ))}

            {/* Coin fountain bursting up from the base. */}
            {coins.map((c) => (
              <motion.span
                key={`coin${c.id}`}
                className="absolute"
                style={{ left: `${c.x}%`, bottom: "6%", fontSize: c.size }}
                initial={{ y: 0, x: 0, opacity: 0, scale: 0.4, rotate: 0 }}
                animate={{
                  y: [-c.rise, -c.rise * 0.6, 40],
                  x: c.dx,
                  opacity: [0, 1, 1, 0],
                  scale: [0.4, 1, 1, 0.7],
                  rotate: c.rot,
                }}
                transition={{ duration: c.dur, delay: c.delay, ease: "easeOut" }}
              >
                {"\u{1FA99}"}
              </motion.span>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
