"use client";

import React, { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import {
  GAMES,
  CATEGORY_ORDER,
  houseEdge,
  formatHouseEdge,
  type GameCategory,
  type GameMeta,
} from "@/lib/games";
import { useWallet, STARTING_BALANCE } from "@/lib/wallet";
import { formatChips } from "@/lib/format";
import { Button } from "@/components/ui/Button";
import { ClaimBonus } from "@/components/ClaimBonus";
import { sfx } from "@/lib/sound";
import { apiLeaderboard } from "@/lib/auth-client";
import type { LeaderboardEntry } from "@/lib/kv";

const CATEGORY_LABEL: Record<GameCategory, string> = {
  Cards: "Card Games",
  Table: "Table Games",
  Slots: "Slots",
  Wheel: "Wheels",
  Dice: "Dice",
  Modern: "Modern",
  Lottery: "Lottery",
};

/** Color the house-edge badge: green = player-friendly, amber/red = steep. */
function edgeColor(edge: number): string {
  if (edge <= 1.5) return "#34d399"; // green
  if (edge <= 3.5) return "#f5d060"; // gold
  if (edge <= 6) return "#f59e0b"; // amber
  return "#f87171"; // red
}

function GameCard({ game, index }: { game: GameMeta; index: number }) {
  const edge = houseEdge(game.slug);
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
          {edge !== undefined && (
            <span
              className="rounded-md px-2 py-0.5 text-[10px] font-semibold tabular-nums"
              title={`House edge — the casino's long-run advantage on ${game.name}`}
              style={{ color: edgeColor(edge), background: `${edgeColor(edge)}1a` }}
            >
              {formatHouseEdge(edge)} edge
            </span>
          )}
          <span className="ml-auto text-sm font-semibold text-gold opacity-0 transition-opacity duration-300 group-hover:opacity-100">
            Play →
          </span>
        </div>
      </Link>
    </motion.div>
  );
}

const MEDALS = ["🥇", "🥈", "🥉"];

function HeroLeaderboard() {
  const wallet = useWallet();
  const [entries, setEntries] = useState<LeaderboardEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiLeaderboard(10).then((data) => {
      setEntries(data);
      setLoading(false);
    });
  }, []);

  return (
    <div className="relative w-full lg:w-72 xl:w-80 shrink-0">
      <div className="flex items-center justify-between mb-3">
        <span className="text-[10px] font-semibold uppercase tracking-widest text-white/40">
          🏆 Top Players
        </span>
        <Link
          href="/leaderboard"
          className="text-[10px] uppercase tracking-widest text-white/30 transition hover:text-gold"
        >
          View all →
        </Link>
      </div>

      {loading ? (
        <div className="space-y-1.5">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="h-9 animate-pulse rounded-xl bg-white/5" />
          ))}
        </div>
      ) : entries.length === 0 ? (
        <p className="py-6 text-center text-xs text-white/30">No players yet.</p>
      ) : (
        <ul className="space-y-1">
          {entries.map((entry) => {
            const isMe = wallet.username?.toLowerCase() === entry.username.toLowerCase();
            return (
              <li
                key={entry.username}
                className={`flex items-center gap-3 rounded-xl px-3 py-2 ${
                  isMe ? "border border-gold/25 bg-gold/10" : "border border-white/5 bg-white/5"
                }`}
              >
                <span className="w-5 shrink-0 text-center text-sm leading-none">
                  {entry.rank <= 3
                    ? MEDALS[entry.rank - 1]
                    : <span className="text-xs text-white/30">#{entry.rank}</span>}
                </span>
                <span className={`flex-1 truncate text-sm font-semibold ${isMe ? "gold-text" : "text-white/80"}`}>
                  {entry.username}
                  {isMe && <span className="ml-1.5 text-[9px] uppercase tracking-widest text-gold/50">you</span>}
                </span>
                <span className="shrink-0 text-xs tabular-nums text-white/40">
                  {formatChips(entry.balance)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

type ConfirmAction = "reset" | "delete" | null;

function ProfileModal({ onClose }: { onClose: () => void }) {
  const wallet = useWallet();
  const router = useRouter();
  const [confirm, setConfirm] = useState<ConfirmAction>(null);
  const [loading, setLoading] = useState(false);

  async function handleReset() {
    wallet.reset();
    sfx.jackpot();
    setConfirm(null);
    onClose();
  }

  async function handleDelete() {
    setLoading(true);
    await wallet.deleteAccount();
    sfx.click();
    setLoading(false);
    onClose();
    router.push("/login");
  }

  const rtp =
    wallet.totalWagered > 0
      ? ((wallet.totalReturned / wallet.totalWagered) * 100).toFixed(1)
      : "—";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 10 }}
        transition={{ duration: 0.2 }}
        className="relative z-10 w-full max-w-sm overflow-hidden rounded-2xl border border-white/10 bg-ink-panel shadow-2xl"
      >
        {/* Header */}
        <div className="border-b border-white/10 px-6 py-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-[10px] uppercase tracking-widest text-white/40">Logged in as</p>
              <p className="font-display text-lg font-bold text-white">{wallet.username}</p>
            </div>
            <button
              onClick={onClose}
              className="grid h-8 w-8 place-items-center rounded-full text-white/40 transition hover:bg-white/10 hover:text-white"
            >
              ✕
            </button>
          </div>
        </div>

        {/* Stats */}
        <div className="px-6 py-4">
          <p className="mb-3 text-[10px] uppercase tracking-widest text-white/40">Your Stats</p>
          <div className="grid grid-cols-2 gap-2">
            {[
              { label: "Balance", value: formatChips(wallet.balance) + " chips" },
              { label: "Rounds Played", value: wallet.rounds.toLocaleString() },
              { label: "Total Wagered", value: formatChips(wallet.totalWagered) },
              { label: "Biggest Win", value: formatChips(wallet.biggestWin) },
              { label: "Total Returned", value: formatChips(wallet.totalReturned) },
              { label: "RTP", value: rtp === "—" ? "—" : rtp + "%" },
              { label: "Balance Resets", value: wallet.resets.toLocaleString() },
            ].map(({ label, value }) => (
              <div key={label} className="rounded-xl border border-white/5 bg-black/30 px-3 py-2">
                <p className="text-[10px] text-white/40">{label}</p>
                <p className="mt-0.5 text-sm font-semibold text-white">{value}</p>
              </div>
            ))}
          </div>
        </div>

        {/* Divider */}
        <div className="mx-6 border-t border-white/10" />

        {/* Settings */}
        <div className="px-6 py-4">
          <p className="mb-3 text-[10px] uppercase tracking-widest text-white/40">Settings</p>

          <AnimatePresence mode="wait">
            {confirm === "reset" ? (
              <motion.div
                key="confirm-reset"
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                className="rounded-xl border border-yellow-500/30 bg-yellow-500/10 p-4"
              >
                <p className="text-sm font-semibold text-yellow-300">Reset your balance?</p>
                <p className="mt-1 text-xs text-white/50">
                  Your balance will be set back to {formatChips(STARTING_BALANCE)} chips. Your stats will be kept. This cannot be undone.
                </p>
                <div className="mt-3 flex gap-2">
                  <Button variant="ghost" size="sm" onClick={() => setConfirm(null)}>
                    Cancel
                  </Button>
                  <Button variant="gold" size="sm" onClick={handleReset}>
                    Yes, reset
                  </Button>
                </div>
              </motion.div>
            ) : confirm === "delete" ? (
              <motion.div
                key="confirm-delete"
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                className="rounded-xl border border-red-500/30 bg-red-500/10 p-4"
              >
                <p className="text-sm font-semibold text-red-400">Delete your account?</p>
                <p className="mt-1 text-xs text-white/50">
                  Your account, balance, and all stats will be permanently deleted. This cannot be undone.
                </p>
                <div className="mt-3 flex gap-2">
                  <Button variant="ghost" size="sm" onClick={() => setConfirm(null)}>
                    Cancel
                  </Button>
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={handleDelete}
                    disabled={loading}
                  >
                    {loading ? "Deleting…" : "Yes, delete"}
                  </Button>
                </div>
              </motion.div>
            ) : (
              <motion.div
                key="settings-buttons"
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                className="flex flex-col gap-2"
              >
                <button
                  onClick={() => setConfirm("reset")}
                  className="flex w-full items-center justify-between rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-left text-sm text-white/80 transition hover:bg-white/10 hover:text-white"
                >
                  <span>Reset balance to {formatChips(STARTING_BALANCE)} chips</span>
                  <span className="text-white/30">→</span>
                </button>
                <button
                  onClick={() => setConfirm("delete")}
                  className="flex w-full items-center justify-between rounded-xl border border-red-500/20 bg-red-500/5 px-4 py-3 text-left text-sm text-red-400/80 transition hover:bg-red-500/10 hover:text-red-400"
                >
                  <span>Delete account</span>
                  <span className="text-red-500/30">→</span>
                </button>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Footer: Sign out */}
        <div className="border-t border-white/10 px-6 py-4">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              wallet.logout();
              sfx.click();
              onClose();
            }}
          >
            Sign out
          </Button>
        </div>
      </motion.div>
    </div>
  );
}

export function Dashboard() {
  const wallet = useWallet();
  const router = useRouter();
  const [filter, setFilter] = useState<GameCategory | "All">("All");
  const [query, setQuery] = useState("");
  const [profileOpen, setProfileOpen] = useState(false);

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

  // Count games per category so the filter chips can show "Slots (4)" etc. —
  // makes every category (slots especially) easy to find at a glance.
  const categoryCounts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const g of GAMES) m[g.category] = (m[g.category] ?? 0) + 1;
    return m;
  }, []);

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
      {/* Top nav */}
      <div className="mb-4 flex items-center justify-end gap-2">
        {wallet.username ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              sfx.click();
              setProfileOpen(true);
            }}
          >
            👤 {wallet.username}
          </Button>
        ) : (
          <Button variant="gold" size="sm" onClick={() => router.push("/login")}>
            Sign in
          </Button>
        )}
      </div>

      {/* Hero */}
      <section className="relative mb-6 overflow-hidden rounded-3xl border border-gold/20 bg-gradient-to-b from-ink-panel/90 to-ink/90 px-6 py-8 sm:px-10 sm:py-10 [@media(max-height:760px)]:py-5">
        <div className="bg-grid pointer-events-none absolute inset-0 opacity-40" />
        <span className="pointer-events-none absolute left-1/4 top-0 h-40 w-[50%] -translate-x-1/2 rounded-full bg-gold/10 blur-3xl" />
        {/* drifting ambient motes */}
        <span className="animate-floatSlow pointer-events-none absolute left-[10%] top-[28%] h-1.5 w-1.5 rounded-full bg-neon-cyan/60 blur-[1px]" />
        <span className="animate-floatSlow pointer-events-none absolute left-[34%] top-[60%] h-1.5 w-1.5 rounded-full bg-neon-magenta/60 blur-[1px]" style={{ animationDelay: "2.5s" }} />
        <span className="animate-floatSlow pointer-events-none absolute left-[24%] top-[18%] h-1 w-1 rounded-full bg-gold/70 blur-[1px]" style={{ animationDelay: "5s" }} />

        <div className="relative flex flex-col gap-8 lg:flex-row lg:items-center">
          {/* Left: title + balance */}
          <div className="flex-1 text-center lg:text-left">
            <motion.p
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              className="text-xs uppercase tracking-[0.5em] text-gold/70 [@media(max-height:760px)]:hidden"
            >
              Welcome to
            </motion.p>
            <motion.h1
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.5 }}
              className="gold-text-anim mt-2 font-display text-5xl font-black tracking-tight sm:text-7xl"
            >
              NEON ROYALE
            </motion.h1>
            <p className="mx-auto mt-3 max-w-sm text-sm text-white/55 sm:text-base lg:mx-0 [@media(max-height:760px)]:hidden">
              {GAMES.length} legendary casino games. One neon floor. Play money only —
              chase the jackpot risk-free.
            </p>

            {/* Balance + actions */}
            <div className="mt-6 flex flex-wrap items-center justify-center gap-3 lg:justify-start">
              <div className="relative overflow-hidden rounded-2xl border border-gold/30 bg-black/50 px-6 py-3">
                <span className="sheen-layer" aria-hidden />
                <div className="text-[10px] uppercase tracking-widest text-white/40">
                  Your Balance
                </div>
                <div className="gold-text text-2xl font-black tabular-nums sm:text-3xl">
                  {wallet.ready ? formatChips(wallet.balance) : "—"}
                </div>
              </div>
              <ClaimBonus />
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
            </div>
          </div>

          {/* Divider */}
          <div className="hidden lg:block w-px self-stretch bg-white/10" />

          {/* Right: leaderboard */}
          <HeroLeaderboard />
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
                {c === "All"
                  ? `All Games (${GAMES.length})`
                  : `${CATEGORY_LABEL[c]} (${categoryCounts[c] ?? 0})`}
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
        <p className="py-16 text-center text-white/40">No games match "{query}".</p>
      )}

      <footer className="mt-16 border-t border-white/10 pt-6 text-center text-xs text-white/30">
        Neon Royale · For entertainment only · No real-money wagering · Play
        responsibly
      </footer>

      {/* Profile modal */}
      <AnimatePresence>
        {profileOpen && <ProfileModal onClose={() => setProfileOpen(false)} />}
      </AnimatePresence>
    </div>
  );
}
