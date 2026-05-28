"use client";

import React, { useState } from "react";
import Link from "next/link";
import { motion, AnimatePresence } from "framer-motion";
import { useWallet } from "@/lib/wallet";
import { formatChips } from "@/lib/format";
import { isMuted, toggleMuted, sfx } from "@/lib/sound";

interface GameShellProps {
  title: string;
  subtitle?: string;
  accent?: string;
  children: React.ReactNode;
}

/**
 * Standard chrome for every game: lobby link, title, live balance, mute,
 * top-up rescue, and a felt play surface. Game components render as children.
 */
export function GameShell({ title, subtitle, accent = "#d4af37", children }: GameShellProps) {
  const wallet = useWallet();
  const [muted, setMuted] = useState(false);

  // sync mute state on mount (client only)
  React.useEffect(() => setMuted(isMuted()), []);

  return (
    <div className="min-h-screen w-full">
      {/* Top bar */}
      <header className="sticky top-0 z-30 border-b border-white/10 bg-ink/70 backdrop-blur-xl">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-3 px-4 py-3">
          <Link
            href="/"
            className="group inline-flex items-center gap-2 rounded-lg px-2 py-1 text-sm text-white/70 transition hover:text-gold"
          >
            <span className="text-lg transition group-hover:-translate-x-0.5">←</span>
            <span className="hidden sm:inline">Lobby</span>
          </Link>

          <div className="min-w-0 text-center">
            <h1
              className="truncate font-display text-lg font-bold sm:text-xl"
              style={{ color: accent, textShadow: `0 0 18px ${accent}55` }}
            >
              {title}
            </h1>
            {subtitle && (
              <p className="truncate text-[11px] text-white/45">{subtitle}</p>
            )}
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                setMuted(toggleMuted());
                sfx.click();
              }}
              className="grid h-9 w-9 place-items-center rounded-lg border border-white/10 bg-white/5 text-base transition hover:bg-white/10"
              aria-label={muted ? "Unmute" : "Mute"}
              title={muted ? "Unmute" : "Mute"}
            >
              {muted ? "🔇" : "🔊"}
            </button>

            <div className="rounded-xl border border-gold/30 bg-black/40 px-3 py-1.5 text-right">
              <div className="text-[9px] uppercase tracking-widest text-white/40">
                Balance
              </div>
              <AnimatePresence mode="popLayout">
                <motion.div
                  key={wallet.balance}
                  initial={{ y: -8, opacity: 0 }}
                  animate={{ y: 0, opacity: 1 }}
                  exit={{ y: 8, opacity: 0 }}
                  transition={{ duration: 0.2 }}
                  className="gold-text text-sm font-bold tabular-nums"
                >
                  {formatChips(wallet.balance)}
                </motion.div>
              </AnimatePresence>
            </div>

            {wallet.ready && wallet.balance < 100 && (
              <button
                onClick={() => {
                  wallet.topUp(5000);
                  sfx.chip();
                }}
                className="rounded-lg bg-gradient-to-b from-gold-light to-gold-dark px-3 py-1.5 text-xs font-bold text-ink shadow-gold"
              >
                +5,000
              </button>
            )}
          </div>
        </div>
      </header>

      {/* Play surface */}
      <main className="mx-auto max-w-7xl px-3 py-5 sm:px-5 sm:py-8">{children}</main>
    </div>
  );
}
