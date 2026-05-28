"use client";

import React from "react";
import { motion } from "framer-motion";
import { Chip } from "@/components/ui/Chip";
import { Button } from "@/components/ui/Button";
import { formatChips } from "@/lib/format";
import { sfx } from "@/lib/sound";
import { clamp } from "@/lib/rng";

interface BetControlsProps {
  bet: number;
  setBet: (n: number) => void;
  balance: number;
  min?: number;
  max?: number;
  /** Chip denominations to offer. */
  chips?: number[];
  /** Disable all controls (e.g. mid-round). */
  disabled?: boolean;
  /** Optional primary action button rendered alongside (e.g. "Deal"). */
  primaryLabel?: string;
  onPrimary?: () => void;
  primaryDisabled?: boolean;
  className?: string;
}

const DEFAULT_CHIPS = [5, 25, 100, 500, 1000];

/**
 * A self-contained betting bar: chip selector, quick adjusters (½, 2×, Max,
 * Clear), live bet readout, and an optional primary action button.
 */
export function BetControls({
  bet,
  setBet,
  balance,
  min = 1,
  max,
  chips = DEFAULT_CHIPS,
  disabled = false,
  primaryLabel,
  onPrimary,
  primaryDisabled,
  className = "",
}: BetControlsProps) {
  const ceiling = Math.max(min, Math.min(max ?? balance, balance));
  const set = (n: number) => setBet(clamp(Math.floor(n), 0, ceiling));

  const addChip = (v: number) => {
    if (disabled) return;
    sfx.chip();
    set(bet + v);
  };

  return (
    <div
      className={`glass rounded-2xl p-3 sm:p-4 ${className}`}
      data-testid="bet-controls"
    >
      <div className="flex flex-wrap items-center justify-center gap-2 sm:gap-3">
        {chips.map((v) => (
          <Chip
            key={v}
            value={v}
            size={52}
            selected={false}
            onClick={disabled || v > balance ? undefined : () => addChip(v)}
          />
        ))}
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
        <Button size="sm" variant="ghost" disabled={disabled} onClick={() => set(0)}>
          Clear
        </Button>
        <Button size="sm" variant="ghost" disabled={disabled} onClick={() => set(Math.floor(bet / 2))}>
          ½
        </Button>
        <Button size="sm" variant="ghost" disabled={disabled} onClick={() => set(bet * 2)}>
          2×
        </Button>
        <Button size="sm" variant="ghost" disabled={disabled} onClick={() => set(ceiling)}>
          Max
        </Button>

        <motion.div
          key={bet}
          initial={{ scale: 0.9 }}
          animate={{ scale: 1 }}
          className="ml-1 min-w-[110px] rounded-xl border border-gold/30 bg-black/40 px-4 py-2 text-center"
        >
          <div className="text-[9px] uppercase tracking-widest text-white/40">Bet</div>
          <div className="gold-text text-lg font-bold tabular-nums">{formatChips(bet)}</div>
        </motion.div>

        {primaryLabel && onPrimary && (
          <Button
            size="lg"
            variant="gold"
            data-testid="play-btn"
            disabled={primaryDisabled ?? (disabled || bet < min || bet > balance)}
            onClick={onPrimary}
          >
            {primaryLabel}
          </Button>
        )}
      </div>
    </div>
  );
}
