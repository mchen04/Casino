"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useWallet } from "@/lib/wallet";
import { usePlayStateless } from "@/lib/playStateless";
import { sfx } from "@/lib/sound";
import { sleep } from "@/lib/async";
import { formatChips, formatDelta, formatMultiplier } from "@/lib/format";
import { Button } from "@/components/ui/Button";
import { BetControls } from "@/components/BetControls";
import { CountingNumber } from "@/components/CountingNumber";
import { Celebration } from "@/components/Celebration";

// ===========================================================================
// TIANNA'S TREASURY — flagship neon Megaways. Server owns every outcome; the
// client just animates the spin sequence the server returns: the grid, every
// cascading tumble, the rising multiplier meter, and Tianna's Vault free spins.
// Hyper-neon, cycling gradients, coin storms, a roaring multiplier — built to
// be the most dopamine-loaded, visually unhinged game in the casino. 💎👑
// ===========================================================================

const MIN_BET = 5;
const CHIPS = [5, 25, 100, 500, 2000];
const REELS = 6;

type Sym = "T" | "CROWN" | "GEM" | "RING" | "STAR" | "HEART" | "A" | "K" | "Q" | "VAULT";

const SYMS: Record<Sym, { glyph: string; color: string; text?: boolean }> = {
  T: { glyph: "T", color: "#ff2bd1", text: true },
  CROWN: { glyph: "👑", color: "#ffd24a" },
  GEM: { glyph: "💎", color: "#22e1ff" },
  RING: { glyph: "💍", color: "#f5d060" },
  STAR: { glyph: "⭐", color: "#ffe14d" },
  HEART: { glyph: "💗", color: "#ff5e9c" },
  A: { glyph: "A", color: "#8aff80", text: true },
  K: { glyph: "K", color: "#a855f7", text: true },
  Q: { glyph: "Q", color: "#22e1ff", text: true },
  VAULT: { glyph: "🏆", color: "#ffd24a" },
};

// ---- Server outcome shapes (mirror tiannas-treasury.ts) -------------------
interface WayWin {
  symbol: Sym;
  length: number;
  ways: number;
  cells: [number, number][];
  base: number;
}
interface TumbleStep {
  grid: Sym[][];
  wins: WayWin[];
  multiplier: number;
  win: number;
}
interface SpinResult {
  steps: TumbleStep[];
  win: number;
  endMultiplier: number;
}
interface TTOutcome {
  base: SpinResult;
  scatters: number;
  scatterPay: number;
  freeSpinCount: number;
  freeSpins: SpinResult[];
  totalWin: number;
  bigWin: boolean;
}

const cellKey = (r: number, row: number) => `${r}:${row}`;

// ---- A single symbol tile -------------------------------------------------
function Tile({ sym, winning, dropDelay }: { sym: Sym; winning: boolean; dropDelay: number }) {
  const def = SYMS[sym];
  const isWild = sym === "T";
  const isScatter = sym === "VAULT";
  return (
    <motion.div
      initial={{ y: -28, opacity: 0, scale: 0.6 }}
      animate={{
        y: 0,
        opacity: 1,
        scale: winning ? [1, 1.16, 1] : 1,
      }}
      transition={{
        y: { type: "spring", stiffness: 420, damping: 22, delay: dropDelay },
        opacity: { duration: 0.18, delay: dropDelay },
        scale: winning ? { duration: 0.6, repeat: Infinity } : { duration: 0.2 },
      }}
      className="relative grid place-items-center rounded-lg"
      style={{
        height: "var(--tt-cell)",
        background: winning
          ? `radial-gradient(circle at 50% 40%, ${def.color}66, ${def.color}18)`
          : isWild
            ? "linear-gradient(135deg, #ff2bd133, #22e1ff22)"
            : "rgba(10,4,20,0.72)",
        boxShadow: winning
          ? `0 0 0 2px ${def.color}, 0 0 22px ${def.color}cc`
          : isWild
            ? "0 0 0 1.5px #ff2bd1aa, 0 0 16px #ff2bd155"
            : isScatter
              ? "0 0 0 1.5px #ffd24a99, 0 0 16px #ffd24a55"
              : "inset 0 0 0 1px rgba(255,255,255,0.06)",
      }}
    >
      {def.text ? (
        <span
          className="font-display font-black"
          style={{
            fontSize: "calc(var(--tt-cell) * 0.5)",
            color: def.color,
            textShadow: `0 0 10px ${def.color}, 0 0 3px #fff`,
          }}
        >
          {def.glyph}
        </span>
      ) : (
        <span style={{ fontSize: "calc(var(--tt-cell) * 0.56)", filter: `drop-shadow(0 0 7px ${def.color})` }}>
          {def.glyph}
        </span>
      )}
      {isWild && (
        <span className="pointer-events-none absolute -bottom-1 text-[8px] font-black uppercase tracking-widest" style={{ color: "#ff2bd1" }}>
          wild
        </span>
      )}
    </motion.div>
  );
}

export default function TiannasTreasury() {
  const { balance, ready } = useWallet();
  const playRound = usePlayStateless();

  const [bet, setBet] = useState(50);
  const [grid, setGrid] = useState<Sym[][]>(() => idleGrid());
  const [winCells, setWinCells] = useState<Set<string>>(new Set());
  const [multiplier, setMultiplier] = useState(1);
  const [runningWin, setRunningWin] = useState(0);
  const [spinning, setSpinning] = useState(false);
  const [vault, setVault] = useState<{ active: boolean; spin: number; total: number } | null>(null);
  const [banner, setBanner] = useState<string>("");
  const [lastTotal, setLastTotal] = useState<number | null>(null);
  const [celebrate, setCelebrate] = useState<{ key: number; tier: "win" | "big" | "jackpot" } | null>(null);

  const spinGuard = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const canAfford = ready && bet >= MIN_BET && bet <= balance;

  const animateSpin = useCallback(async (sr: SpinResult, isFree: boolean) => {
    for (let i = 0; i < sr.steps.length; i++) {
      if (!mounted.current) return;
      const step = sr.steps[i];
      setGrid(step.grid);
      setMultiplier(step.multiplier);
      if (step.wins.length > 0) {
        const cells = new Set<string>();
        for (const w of step.wins) for (const [r, row] of w.cells) cells.add(cellKey(r, row));
        setWinCells(cells);
        setRunningWin((w) => Math.round((w + step.win) * 100) / 100);
        if (step.win >= bet * 8) sfx.jackpot();
        else sfx.win();
        await sleep(720);
        if (!mounted.current) return;
        setWinCells(new Set());
        // brief tumble gap before the next (already-tumbled) grid renders
        await sleep(150);
      } else {
        setWinCells(new Set());
        sfx.tick();
        await sleep(260);
      }
    }
  }, [bet]);

  const spin = useCallback(async () => {
    if (spinGuard.current || !canAfford) return;
    spinGuard.current = true;
    setSpinning(true);
    setBanner("");
    setLastTotal(null);
    setCelebrate(null);
    setRunningWin(0);
    setMultiplier(1);
    setVault(null);
    setWinCells(new Set());
    sfx.thud();

    let round;
    try {
      round = await playRound("tiannas-treasury", bet, {}, { defer: true });
    } catch {
      spinGuard.current = false;
      setSpinning(false);
      return;
    }
    const o = round.outcome as unknown as TTOutcome;

    // Base spin (+ cascades).
    await animateSpin(o.base, false);
    if (!mounted.current) return;

    if (o.scatterPay > 0 && o.freeSpinCount === 0) {
      setBanner(`🏆 ${o.scatters} VAULTS — +${formatChips(o.scatterPay)}`);
      setRunningWin((w) => Math.round((w + o.scatterPay) * 100) / 100);
      sfx.jackpot();
      await sleep(700);
    }

    // Tianna's Vault free spins — the multiplier meter never resets here.
    if (o.freeSpinCount > 0) {
      setBanner(`🏆 TIANNA'S VAULT — ${o.freeSpinCount} FREE SPINS!`);
      if (o.scatterPay > 0) setRunningWin((w) => Math.round((w + o.scatterPay) * 100) / 100);
      sfx.jackpot();
      await sleep(1100);
      for (let i = 0; i < o.freeSpins.length; i++) {
        if (!mounted.current) return;
        setVault({ active: true, spin: i + 1, total: o.freeSpins.length });
        await animateSpin(o.freeSpins[i], true);
        await sleep(180);
      }
      setVault(null);
      setBanner("");
    }

    if (!mounted.current) return;
    // Spin fully resolved — NOW credit the winnings into the header balance, so
    // the money never appears before the cascades + vault finish animating.
    round.settle();
    setLastTotal(o.totalWin);
    setRunningWin(o.totalWin);
    if (o.totalWin > 0) {
      const tier = o.totalWin >= bet * 50 ? "jackpot" : o.totalWin >= bet * 12 ? "big" : "win";
      setCelebrate({ key: Date.now(), tier });
      if (tier === "jackpot") sfx.jackpot();
    } else {
      sfx.lose();
    }
    setSpinning(false);
    spinGuard.current = false;
  }, [canAfford, bet, playRound, animateSpin]);

  // Max reel height for laying out the grid frame.
  const maxH = useMemo(() => Math.max(2, ...grid.map((r) => r.length)), [grid]);

  return (
    <div className="mx-auto w-full max-w-4xl px-2 py-2 sm:py-4">
      <div
        className="relative overflow-hidden rounded-3xl border p-3 sm:p-5"
        style={{
          borderColor: "#ff2bd155",
          background:
            "radial-gradient(120% 90% at 50% -10%, #2a0936 0%, #160322 55%, #0a0113 100%)",
          boxShadow: "0 0 0 1px #22e1ff22, 0 0 60px #ff2bd133, inset 0 0 80px rgba(0,0,0,0.6)",
        }}
      >
        {/* cycling neon aurora backdrop */}
        <motion.div
          className="pointer-events-none absolute inset-0 opacity-40"
          animate={{
            background: [
              "radial-gradient(60% 40% at 20% 0%, #ff2bd144, transparent 70%)",
              "radial-gradient(60% 40% at 80% 0%, #22e1ff44, transparent 70%)",
              "radial-gradient(60% 40% at 50% 10%, #ffd24a44, transparent 70%)",
              "radial-gradient(60% 40% at 20% 0%, #ff2bd144, transparent 70%)",
            ],
          }}
          transition={{ duration: 6, repeat: Infinity, ease: "linear" }}
        />

        <Celebration
          show={celebrate !== null}
          seed={celebrate?.key ?? 0}
          tier={celebrate?.tier ?? "win"}
          colors={["#ff2bd1", "#22e1ff", "#ffd24a", "#8aff80", "#ffffff"]}
        />

        {/* ===== Header: Tianna's name in neon ===== */}
        <div className="relative mb-3 flex items-end justify-between gap-3">
          <div>
            <motion.h2
              className="font-display text-3xl font-black tracking-wider sm:text-4xl"
              style={{ color: "#fff" }}
              animate={{
                textShadow: [
                  "0 0 14px #ff2bd1, 0 0 30px #ff2bd1aa",
                  "0 0 14px #22e1ff, 0 0 30px #22e1ffaa",
                  "0 0 14px #ffd24a, 0 0 30px #ffd24aaa",
                  "0 0 14px #ff2bd1, 0 0 30px #ff2bd1aa",
                ],
              }}
              transition={{ duration: 4.5, repeat: Infinity, ease: "linear" }}
            >
              TIANNA&rsquo;S TREASURY
            </motion.h2>
            <div className="text-[11px] uppercase tracking-[0.3em] text-fuchsia-200/70">
              👑 Megaways · Cascading Vault · up to 117,649 ways
            </div>
          </div>

          {/* The roaring multiplier meter */}
          <motion.div
            className="grid shrink-0 place-items-center rounded-2xl px-4 py-2 text-center"
            animate={{
              boxShadow:
                multiplier > 1
                  ? ["0 0 18px #ff2bd1aa", "0 0 34px #ffd24a", "0 0 18px #22e1ffaa"]
                  : "0 0 10px #ffffff22",
              scale: multiplier > 1 ? [1, 1.06, 1] : 1,
            }}
            transition={{ duration: 0.9, repeat: Infinity }}
            style={{ background: "rgba(0,0,0,0.4)", border: "1px solid #ffffff22" }}
          >
            <div className="text-[9px] uppercase tracking-[0.25em] text-white/50">Multiplier</div>
            <div
              className="font-display text-2xl font-black tabular-nums sm:text-3xl"
              style={{ color: "#ffd24a", textShadow: "0 0 16px #ffd24a" }}
            >
              {multiplier}×
            </div>
          </motion.div>
        </div>

        {/* ===== Vault / banner ===== */}
        <div className="relative mb-2 min-h-[26px] text-center">
          <AnimatePresence mode="wait">
            {banner && (
              <motion.div
                key={banner}
                initial={{ opacity: 0, scale: 0.8, y: 6 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                data-testid="tt-banner"
                className="inline-block rounded-full px-4 py-1 font-display text-sm font-black uppercase tracking-wider"
                style={{
                  background: "linear-gradient(90deg,#ff2bd1,#ffd24a,#22e1ff)",
                  color: "#1a0322",
                  boxShadow: "0 0 24px #ff2bd1aa",
                }}
              >
                {banner}
                {vault ? ` · ${vault.spin}/${vault.total}` : ""}
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* ===== The Megaways grid ===== */}
        <div
          className="relative mx-auto grid gap-1.5 rounded-2xl p-2 sm:gap-2 sm:p-3"
          style={
            {
              gridTemplateColumns: `repeat(${REELS}, minmax(0, 1fr))`,
              "--tt-cell": "clamp(34px, 12vw, 62px)",
              background: "linear-gradient(180deg, rgba(255,43,209,0.06), rgba(34,225,255,0.05))",
              border: "1px solid rgba(255,255,255,0.08)",
            } as React.CSSProperties
          }
        >
          {grid.map((reel, r) => (
            <div
              key={r}
              className="flex flex-col justify-center gap-1.5 sm:gap-2"
              style={{ minHeight: `calc(var(--tt-cell) * ${maxH} + ${(maxH - 1) * 8}px)` }}
            >
              <AnimatePresence initial={false}>
                {reel.map((sym, row) => (
                  <Tile
                    key={`${r}-${row}-${sym}`}
                    sym={sym}
                    winning={winCells.has(cellKey(r, row))}
                    dropDelay={row * 0.03 + r * 0.02}
                  />
                ))}
              </AnimatePresence>
            </div>
          ))}
        </div>

        {/* ===== Win tally ===== */}
        <div className="relative mt-3 grid grid-cols-3 gap-2 text-center">
          <Stat label="Balance" value={ready ? formatChips(balance) : "—"} color="#22e1ff" />
          <div
            className="grid place-items-center rounded-2xl border bg-black/30 px-2 py-2"
            style={{ borderColor: runningWin > 0 ? "#ffd24a66" : "rgba(255,255,255,0.08)" }}
          >
            <div className="text-[9px] uppercase tracking-[0.2em] text-white/40">
              {spinning ? "Winning…" : "Last Win"}
            </div>
            <div
              className="font-display text-xl font-black tabular-nums sm:text-2xl"
              style={{ color: "#ffd24a", textShadow: runningWin > 0 ? "0 0 14px #ffd24a" : "none" }}
            >
              <CountingNumber value={runningWin} />
            </div>
          </div>
          <Stat
            label="Net"
            value={lastTotal !== null ? formatDelta(lastTotal - bet) : "—"}
            color={lastTotal !== null && lastTotal - bet >= 0 ? "#8aff80" : "#ff5e9c"}
          />
        </div>

        {/* ===== Spin button ===== */}
        <div className="relative mt-3 flex justify-center">
          <Button
            data-testid="play-btn"
            variant="neon"
            size="lg"
            block
            disabled={spinning || !canAfford}
            onClick={() => void spin()}
            className="max-w-md"
          >
            {spinning ? "SPINNING…" : `SPIN · ${formatChips(bet)} 💎`}
          </Button>
        </div>

        {/* ===== Bet controls ===== */}
        <div className="relative mt-3">
          <BetControls
            bet={bet}
            setBet={setBet}
            balance={balance}
            min={MIN_BET}
            chips={CHIPS}
            disabled={spinning}
          />
        </div>

        <div className="relative mt-3 text-center text-[10px] leading-relaxed text-white/40">
          Tianna&rsquo;s &ldquo;T&rdquo; is wild on the middle reels · 4+ 🏆 trigger the Vault free
          spins (the multiplier never resets) · ~95% RTP, server-fair. Built for Tianna. 💗
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div className="grid place-items-center rounded-2xl border border-white/8 bg-black/30 px-2 py-2">
      <div className="text-[9px] uppercase tracking-[0.2em] text-white/40">{label}</div>
      <div className="font-display text-lg font-bold tabular-nums sm:text-xl" style={{ color }}>
        {value}
      </div>
    </div>
  );
}

// A pretty idle grid so the board isn't empty before the first spin.
function idleGrid(): Sym[][] {
  const pool: Sym[] = ["CROWN", "GEM", "RING", "STAR", "HEART", "A", "K", "Q", "T", "VAULT"];
  const heights = [4, 5, 4, 5, 4, 5];
  return heights.map((h, r) =>
    Array.from({ length: h }, (_, i) => pool[(r * 3 + i * 2) % pool.length]),
  );
}
