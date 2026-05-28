"use client";

import React, { useMemo, useState } from "react";
import Link from "next/link";
import { motion, AnimatePresence } from "framer-motion";
import { GAMES, CATEGORY_ORDER, type GameCategory, type GameMeta } from "@/lib/games";
import { useWallet, STARTING_BALANCE } from "@/lib/wallet";
import { formatChips } from "@/lib/format";
import { Button } from "@/components/ui/Button";
import { sfx } from "@/lib/sound";

const CATEGORY_LABEL: Record<GameCategory, string> = {
  Cards: "Card Games",
  Table: "Table Games",
  Slots: "Slots",
  Wheel: "Wheels",
  Dice: "Dice",
  Modern: "Modern",
  Lottery: "Lottery",
};

function GameCard({ game, index }: { game: GameMeta; index: number }) {
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 18 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.95 }}
      transition={{ duration: 0.35, delay: Math.min(index * 0.015, 0.3) }}
    >
      <Link
        href={`/games/${game.slug}`}
        onClick={() => sfx.chip()}
        className="group relative block h-full overflow-hidden rounded-2xl border border-white/10 bg-ink-panel/80 p-5 transition-all duration-300 hover:-translate-y-1 hover:border-white/25"
        style={{ boxShadow: "0 12px 30px rgba(0,0,0,0.4)" }}
      >
        {/* accent glow */}
        <span
          className="pointer-events-none absolute -right-8 -top-8 h-28 w-28 rounded-full opacity-30 blur-2xl transition-opacity duration-300 group-hover:opacity-70"
          style={{ background: game.accent }}
        />
        <span
          className="pointer-events-none absolute inset-x-0 bottom-0 h-[2px] origin-left scale-x-0 transition-transform duration-300 group-hover:scale-x-100"
          style={{ background: `linear-gradient(90deg, transparent, ${game.accent}, transparent)` }}
        />

        <div className="relative flex items-start justify-between">
          <span
            className="grid h-12 w-12 place-items-center rounded-xl text-2xl transition-transform duration-300 group-hover:scale-110 group-hover:rotate-6"
            style={{ background: `${game.accent}22`, border: `1px solid ${game.accent}55` }}
          >
            {game.emoji}
          </span>
          {game.players === "multi" && (
            <span className="rounded-full border border-white/15 bg-white/5 px-2 py-0.5 text-[10px] uppercase tracking-wider text-white/60">
              vs bots
            </span>
          )}
        </div>

        <h3
          className="mt-4 font-display text-lg font-bold text-white transition-colors"
          style={{ textShadow: "0 1px 8px rgba(0,0,0,0.5)" }}
        >
          {game.name}
        </h3>
        <p className="mt-1 text-sm leading-snug text-white/55">{game.blurb}</p>

        <div className="mt-4 flex items-center gap-2">
          <span
            className="rounded-md px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider"
            style={{ color: game.accent, background: `${game.accent}1a` }}
          >
            {game.category}
          </span>
          <span className="ml-auto text-sm font-semibold text-gold opacity-0 transition-opacity duration-300 group-hover:opacity-100">
            Play →
          </span>
        </div>
      </Link>
    </motion.div>
  );
}

export function Dashboard() {
  const wallet = useWallet();
  const [filter, setFilter] = useState<GameCategory | "All">("All");
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return GAMES.filter((g) => {
      const matchCat = filter === "All" || g.category === filter;
      const matchQ =
        !q ||
        g.name.toLowerCase().includes(q) ||
        g.blurb.toLowerCase().includes(q) ||
        g.tags?.some((t) => t.includes(q));
      return matchCat && matchQ;
    });
  }, [filter, query]);

  const categories: (GameCategory | "All")[] = ["All", ...CATEGORY_ORDER];

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
      {/* Hero */}
      <section className="relative mb-10 overflow-hidden rounded-3xl border border-gold/20 bg-gradient-to-b from-ink-panel/90 to-ink/90 px-6 py-10 text-center sm:py-14">
        <div className="bg-grid pointer-events-none absolute inset-0 opacity-40" />
        <span className="pointer-events-none absolute left-1/2 top-0 h-40 w-[60%] -translate-x-1/2 rounded-full bg-gold/10 blur-3xl" />
        <motion.p
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          className="relative text-xs uppercase tracking-[0.5em] text-gold/70"
        >
          Welcome to
        </motion.p>
        <motion.h1
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.5 }}
          className="gold-text relative mt-2 font-display text-5xl font-black tracking-tight sm:text-7xl"
        >
          NEON ROYALE
        </motion.h1>
        <p className="relative mx-auto mt-3 max-w-xl text-sm text-white/55 sm:text-base">
          {GAMES.length} legendary casino games. One neon floor. Play money only —
          chase the jackpot risk-free.
        </p>

        {/* Balance + reset */}
        <div className="relative mt-6 flex flex-wrap items-center justify-center gap-3">
          <div className="rounded-2xl border border-gold/30 bg-black/50 px-6 py-3">
            <div className="text-[10px] uppercase tracking-widest text-white/40">
              Your Balance
            </div>
            <div className="gold-text text-2xl font-black tabular-nums sm:text-3xl">
              {wallet.ready ? formatChips(wallet.balance) : "—"}
            </div>
          </div>
          {wallet.ready && wallet.balance < STARTING_BALANCE / 2 && (
            <Button
              variant="gold"
              onClick={() => {
                wallet.topUp(STARTING_BALANCE);
                sfx.jackpot();
              }}
            >
              Claim {formatChips(STARTING_BALANCE)} chips
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={() => wallet.reset()}>
            Reset
          </Button>
        </div>
      </section>

      {/* Controls */}
      <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="no-scrollbar flex gap-2 overflow-x-auto pb-1">
          {categories.map((c) => {
            const active = filter === c;
            return (
              <button
                key={c}
                onClick={() => {
                  setFilter(c);
                  sfx.click();
                }}
                className={`whitespace-nowrap rounded-full px-4 py-2 text-sm font-semibold transition ${
                  active
                    ? "bg-gradient-to-b from-gold-light to-gold-dark text-ink shadow-gold"
                    : "border border-white/10 bg-white/5 text-white/60 hover:text-white"
                }`}
              >
                {c === "All" ? "All Games" : CATEGORY_LABEL[c]}
              </button>
            );
          })}
        </div>
        <div className="relative sm:w-64">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search games…"
            className="w-full rounded-full border border-white/10 bg-black/40 px-4 py-2 pl-9 text-sm text-white placeholder:text-white/30 focus:border-gold/50 focus:outline-none"
          />
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-white/40">🔍</span>
        </div>
      </div>

      {/* Grid */}
      <motion.div
        layout
        className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
      >
        <AnimatePresence mode="popLayout">
          {filtered.map((game, i) => (
            <GameCard key={game.slug} game={game} index={i} />
          ))}
        </AnimatePresence>
      </motion.div>

      {filtered.length === 0 && (
        <p className="py-16 text-center text-white/40">No games match “{query}”.</p>
      )}

      <footer className="mt-16 border-t border-white/10 pt-6 text-center text-xs text-white/30">
        Neon Royale · For entertainment only · No real-money wagering · Play
        responsibly
      </footer>
    </div>
  );
}
