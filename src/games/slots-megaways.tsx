"use client";

import React, { useCallback, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useWallet } from "@/lib/wallet";
import { BetControls } from "@/components/BetControls";
import { formatChips, formatMultiplier } from "@/lib/format";
import { weightedPick, randInt } from "@/lib/rng";
import { sfx } from "@/lib/sound";
import { sleep } from "@/lib/async";

// ---- Symbol definitions -----------------------------------------------------
interface Sym {
  key: string;
  glyph: string;
  color: string;
  weight: number;
  /** Pay in units of the line stake for a 3-of-a-kind across reels (per way). */
  pay: number;
  wild?: boolean;
  scatter?: boolean;
}

const SYMBOLS: Sym[] = [
  { key: "diamond", glyph: "💎", color: "#22e1ff", weight: 5, pay: 0.5 },
  { key: "amethyst", glyph: "🟣", color: "#a855f7", weight: 8, pay: 0.3 },
  { key: "emerald", glyph: "🟢", color: "#2ecc71", weight: 10, pay: 0.2 },
  { key: "topaz", glyph: "🟡", color: "#f5d060", weight: 12, pay: 0.15 },
  { key: "ruby", glyph: "🔴", color: "#e3342f", weight: 14, pay: 0.1 },
  { key: "sapphire", glyph: "🔵", color: "#3b82f6", weight: 14, pay: 0.08 },
  { key: "wild", glyph: "⭐", color: "#ff2bd1", weight: 4, pay: 0, wild: true },
  { key: "scatter", glyph: "💫", color: "#8aff80", weight: 3, pay: 0, scatter: true },
];

const PAY_SYMBOLS = SYMBOLS.filter((s) => !s.scatter);
const REELS = 6;
const MIN_ROWS = 2;
const MAX_ROWS = 6;
// Length multiplier: matching on more consecutive reels pays more.
const LEN_MULT: Record<number, number> = { 3: 1, 4: 2.5, 5: 6, 6: 15 };
const MAX_WIN_UNITS = 600; // safety cap per spin

let CELL_SEQ = 0;
const nextId = () => `c${CELL_SEQ++}`;

interface Cell {
  id: string;
  sym: Sym;
}

function randomSym(): Sym {
  return weightedPick(
    SYMBOLS,
    SYMBOLS.map((s) => s.weight),
  );
}

function makeReel(rows: number): Cell[] {
  return Array.from({ length: rows }, () => ({ id: nextId(), sym: randomSym() }));
}

function makeGrid(): Cell[][] {
  return Array.from({ length: REELS }, () => makeReel(randInt(MIN_ROWS, MAX_ROWS)));
}

interface WinResult {
  winners: Set<string>; // cell ids that are part of a win
  units: number; // total pay units (before cascade multiplier)
  scatters: number;
}

function evaluate(grid: Cell[][]): WinResult {
  const winners = new Set<string>();
  let units = 0;

  // Count scatters anywhere.
  let scatters = 0;
  for (const reel of grid) for (const c of reel) if (c.sym.scatter) scatters++;

  for (const target of PAY_SYMBOLS) {
    if (target.wild) continue; // wilds only substitute, never lead
    // consecutive run of reels (from reel 0) containing target or wild
    let runLen = 0;
    const counts: number[] = [];
    const ids: string[][] = [];
    for (let r = 0; r < REELS; r++) {
      const matches = grid[r].filter((c) => c.sym.key === target.key || c.sym.wild);
      if (matches.length === 0) break;
      runLen++;
      counts.push(matches.length);
      ids.push(matches.map((c) => c.id));
    }
    if (runLen >= 3) {
      const ways = counts.reduce((a, b) => a * b, 1);
      const lm = LEN_MULT[Math.min(runLen, 6)] ?? LEN_MULT[6];
      units += target.pay * lm * ways;
      for (let r = 0; r < runLen; r++) ids[r].forEach((id) => winners.add(id));
    }
  }

  return { winners, units: Math.min(units, MAX_WIN_UNITS), scatters };
}

// Remove winners, drop survivors down, refill from the top to original rows.
function cascade(grid: Cell[][], winners: Set<string>): Cell[][] {
  return grid.map((reel) => {
    const survivors = reel.filter((c) => !winners.has(c.id));
    const need = reel.length - survivors.length;
    const fresh = Array.from({ length: need }, () => ({
      id: nextId(),
      sym: randomSym(),
    }));
    return [...fresh, ...survivors];
  });
}

const MULT_LADDER = [1, 2, 3, 5, 8, 12, 20];

export default function NeonMegaways() {
  const wallet = useWallet();
  const [bet, setBet] = useState(20);
  const [grid, setGrid] = useState<Cell[][]>(() => makeGrid());
  const [winners, setWinners] = useState<Set<string>>(new Set());
  const [multIndex, setMultIndex] = useState(0);
  const [spinning, setSpinning] = useState(false);
  const [spinWin, setSpinWin] = useState<number | null>(null);
  const [message, setMessage] = useState("Cascading reels · up to 46,656 ways");
  const busy = useRef(false);

  const ways = useMemo(() => grid.reduce((a, reel) => a * reel.length, 1), [grid]);

  const spin = useCallback(async () => {
    if (busy.current || spinning) return;
    if (bet < 1 || bet > wallet.balance) return;
    if (!wallet.bet(bet)) return;

    busy.current = true;
    setSpinning(true);
    setSpinWin(null);
    setWinners(new Set());
    setMultIndex(0);
    setMessage("Spinning…");
    sfx.tick();

    // initial random grid + a brief "spin" feel
    let current = makeGrid();
    setGrid(current);
    await sleep(420);
    sfx.thud();

    let total = 0;
    let cascadeNum = 0;

    // cascade loop
    for (;;) {
      const res = evaluate(current);
      if (res.scatters >= 4 && cascadeNum === 0) {
        const bonus = bet * (res.scatters - 2);
        total += bonus;
        setMessage(`💫 ${res.scatters} scatters · +${formatChips(bonus)} bonus`);
        await sleep(500);
      }
      if (res.units <= 0 || res.winners.size === 0) break;

      const mult = MULT_LADDER[Math.min(cascadeNum, MULT_LADDER.length - 1)];
      const winChips = Math.round(bet * res.units * mult * 0.25);
      total += winChips;
      setMultIndex(Math.min(cascadeNum, MULT_LADDER.length - 1));
      setWinners(new Set(res.winners));
      setMessage(
        `Cascade ${cascadeNum + 1} · ${formatMultiplier(mult)} · +${formatChips(winChips)}`,
      );
      sfx.win();
      await sleep(720);

      // explode + drop
      current = cascade(current, res.winners);
      setGrid(current);
      setWinners(new Set());
      cascadeNum++;
      await sleep(520);
    }

    if (total > 0) {
      wallet.win(total);
      setSpinWin(total);
      if (total >= bet * 20) sfx.jackpot();
      else sfx.win();
      setMessage(`WIN ${formatChips(total)} chips!`);
    } else {
      setSpinWin(0);
      sfx.lose();
      setMessage("No win — spin again");
    }

    setSpinning(false);
    busy.current = false;
  }, [bet, spinning, wallet]);

  return (
    <div className="mx-auto max-w-5xl">
      <div className="glass relative overflow-hidden rounded-3xl border border-neon-violet/30 p-4 sm:p-6">
        {/* ambient neon glow */}
        <span className="pointer-events-none absolute -left-10 top-0 h-40 w-40 rounded-full bg-neon-violet/20 blur-3xl" />
        <span className="pointer-events-none absolute -right-10 bottom-0 h-40 w-40 rounded-full bg-neon-cyan/20 blur-3xl" />

        {/* header */}
        <div className="relative mb-4 flex items-center justify-between">
          <div>
            <h2 className="font-display text-xl font-black text-neon-violet neon-magenta">
              NEON MEGAWAYS
            </h2>
            <p className="text-xs text-white/50">
              {ways.toLocaleString()} ways · cascading wins
            </p>
          </div>
          <div className="text-right">
            <div className="text-[10px] uppercase tracking-widest text-white/40">
              Multiplier
            </div>
            <motion.div
              key={multIndex}
              initial={{ scale: 0.7, opacity: 0.4 }}
              animate={{ scale: 1, opacity: 1 }}
              className="font-display text-2xl font-black text-neon-cyan neon-cyan"
            >
              {formatMultiplier(MULT_LADDER[multIndex])}
            </motion.div>
          </div>
        </div>

        {/* reels */}
        <div className="relative grid grid-cols-6 gap-1.5 rounded-2xl bg-black/40 p-2 sm:gap-2 sm:p-3">
          {grid.map((reel, ri) => (
            <div key={ri} className="flex flex-col justify-center gap-1.5 sm:gap-2">
              <AnimatePresence mode="popLayout">
                {reel.map((cell) => {
                  const isWin = winners.has(cell.id);
                  return (
                    <motion.div
                      key={cell.id}
                      layout
                      initial={{ y: -40, opacity: 0, scale: 0.6 }}
                      animate={{
                        y: 0,
                        opacity: 1,
                        scale: isWin ? [1, 1.18, 1] : 1,
                      }}
                      exit={{ scale: 0, opacity: 0, rotate: 90 }}
                      transition={{ duration: 0.32, ease: [0.2, 0.7, 0.2, 1] }}
                      className="grid aspect-square place-items-center rounded-lg text-xl sm:text-2xl"
                      style={{
                        background: isWin
                          ? `${cell.sym.color}33`
                          : "rgba(255,255,255,0.04)",
                        boxShadow: isWin
                          ? `0 0 0 2px ${cell.sym.color}, 0 0 16px ${cell.sym.color}`
                          : "inset 0 0 0 1px rgba(255,255,255,0.06)",
                      }}
                    >
                      <span
                        style={{
                          filter: isWin
                            ? `drop-shadow(0 0 6px ${cell.sym.color})`
                            : undefined,
                        }}
                      >
                        {cell.sym.glyph}
                      </span>
                    </motion.div>
                  );
                })}
              </AnimatePresence>
            </div>
          ))}
        </div>

        {/* result */}
        <div className="relative mt-4 text-center" data-testid="round-result">
          <AnimatePresence mode="wait">
            <motion.p
              key={message}
              initial={{ y: 8, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: -8, opacity: 0 }}
              className={`text-sm font-semibold ${
                spinWin && spinWin > 0
                  ? "text-neon-lime"
                  : spinWin === 0
                    ? "text-white/50"
                    : "text-neon-cyan"
              }`}
            >
              {message}
            </motion.p>
          </AnimatePresence>
        </div>
      </div>

      {/* paytable */}
      <div className="glass mt-4 rounded-2xl p-3 text-xs text-white/60">
        <div className="mb-2 font-semibold text-white/80">
          Paytable (per way, ×3+ reels)
        </div>
        <div className="flex flex-wrap gap-3">
          {PAY_SYMBOLS.filter((s) => !s.wild).map((s) => (
            <span key={s.key} className="inline-flex items-center gap-1">
              <span style={{ filter: `drop-shadow(0 0 4px ${s.color})` }}>
                {s.glyph}
              </span>
              <span className="tabular-nums">{s.pay.toFixed(2)}×</span>
            </span>
          ))}
          <span className="inline-flex items-center gap-1">
            ⭐ <span className="text-neon-magenta">Wild</span>
          </span>
          <span className="inline-flex items-center gap-1">
            💫 <span className="text-neon-lime">4+ Scatter bonus</span>
          </span>
        </div>
      </div>

      <BetControls
        className="mt-4"
        bet={bet}
        setBet={setBet}
        balance={wallet.balance}
        min={1}
        chips={[5, 20, 50, 100, 500]}
        disabled={spinning}
        primaryLabel={spinning ? "Spinning…" : "SPIN"}
        onPrimary={spin}
        primaryDisabled={spinning || bet < 1 || bet > wallet.balance}
      />
    </div>
  );
}
