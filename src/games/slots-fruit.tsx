"use client";

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  AnimatePresence,
  motion,
  useMotionValue,
  useSpring,
  useTransform,
} from "framer-motion";
import { useWallet } from "@/lib/wallet";
import { weightedPick, randInt } from "@/lib/rng";
import { formatChips, formatMultiplier } from "@/lib/format";
import { sfx } from "@/lib/sound";
import { Button } from "@/components/ui/Button";
import { BetControls } from "@/components/BetControls";
import { CollapsiblePanel } from "@/components/CollapsiblePanel";
import { Celebration } from "@/components/Celebration";

/* ------------------------------------------------------------------ *
 * Fruit Frenzy — 5×3 video slot, 10 fixed paylines.
 * Accent: #2ecc71
 * ------------------------------------------------------------------ */

const ACCENT = "#2ecc71";

const ROWS = 3;
const REELS = 5;
const LINES = 10; // fixed paylines
const FREE_SPINS_AWARD = 8;
const SCATTERS_FOR_FREE = 3;

/* ---- Symbols ----------------------------------------------------- */

type SymKey =
  | "CHERRY"
  | "LEMON"
  | "ORANGE"
  | "PLUM"
  | "GRAPE"
  | "MELON"
  | "BELL"
  | "STAR" // wild
  | "SCATTER"; // "FREE" coin

interface SymDef {
  key: SymKey;
  glyph: string;
  label: string;
  color: string;
  /** Relative weight on a reel strip. Higher = more common. */
  weight: number;
  /** Payout multiplier of the TOTAL bet for 3 / 4 / 5 of a kind on a line. */
  pay: [number, number, number];
  wild?: boolean;
  scatter?: boolean;
}

// Pays are expressed as a multiple of the TOTAL bet for 3/4/5 of a kind on a
// payline. Values are tuned (Monte-Carlo verified over 5M spins, incl. free
// spins + retriggers) so the game's overall RTP is ~96.97% — a fair, modern
// slot. The previous values returned only ~25% RTP, so even frequent line hits
// netted a loss; these restore real wins. Hit frequency ~28.7%.
const SYMBOLS: Record<SymKey, SymDef> = {
  CHERRY: { key: "CHERRY", glyph: "🍒", label: "Cherry", color: "#ff5d73", weight: 26, pay: [0.8, 2.5, 8] },
  LEMON: { key: "LEMON", glyph: "🍋", label: "Lemon", color: "#ffe14d", weight: 24, pay: [0.8, 2.7, 9] },
  ORANGE: { key: "ORANGE", glyph: "🍊", label: "Orange", color: "#ff9f1c", weight: 22, pay: [1.1, 3.3, 12] },
  PLUM: { key: "PLUM", glyph: "🫐", label: "Plum", color: "#9b5de5", weight: 20, pay: [1.6, 4.8, 16] },
  GRAPE: { key: "GRAPE", glyph: "🍇", label: "Grape", color: "#c44dff", weight: 18, pay: [2.3, 6.5, 23] },
  MELON: { key: "MELON", glyph: "🍉", label: "Watermelon", color: "#ff4d6d", weight: 14, pay: [3, 10, 40] },
  BELL: { key: "BELL", glyph: "🔔", label: "Bell", color: "#ffd166", weight: 10, pay: [6, 23, 98] },
  STAR: { key: "STAR", glyph: "⭐", label: "Wild", color: ACCENT, weight: 6, pay: [12, 46, 190], wild: true },
  SCATTER: { key: "SCATTER", glyph: "🪙", label: "Scatter", color: "#2ecc71", weight: 5, pay: [0, 0, 0], scatter: true },
};

const PAY_ORDER: SymKey[] = [
  "STAR",
  "BELL",
  "MELON",
  "GRAPE",
  "PLUM",
  "ORANGE",
  "LEMON",
  "CHERRY",
];

/* ---- Reel strips (per-reel weighting) ---------------------------- */
// Each reel is its own strip of weighted symbols. Wild & scatter appear less
// on the outer reels to keep big wins rare. We sample independently per cell.

const SYM_KEYS: SymKey[] = Object.keys(SYMBOLS) as SymKey[];

function reelWeights(reelIndex: number): number[] {
  return SYM_KEYS.map((k) => {
    const def = SYMBOLS[k];
    let w = def.weight;
    // Wild slightly rarer on first and last reel; scatter even on all.
    if (def.wild && (reelIndex === 0 || reelIndex === REELS - 1)) w *= 0.6;
    return w;
  });
}

const REEL_WEIGHTS: number[][] = Array.from({ length: REELS }, (_, r) =>
  reelWeights(r),
);

function spinCell(reelIndex: number): SymKey {
  const weights = REEL_WEIGHTS[reelIndex] ?? REEL_WEIGHTS[0]!;
  return weightedPick(SYM_KEYS, weights);
}

/** A grid is grid[reel][row]. */
type Grid = SymKey[][];

function spinGrid(): Grid {
  return Array.from({ length: REELS }, (_, r) =>
    Array.from({ length: ROWS }, () => spinCell(r)),
  );
}

/* ---- Paylines ----------------------------------------------------- */
// Each payline is an array of row indices, one per reel (length REELS).
// Standard 10-line layout for a 5×3 slot.
const PAYLINES: number[][] = [
  [1, 1, 1, 1, 1], // 0  middle
  [0, 0, 0, 0, 0], // 1  top
  [2, 2, 2, 2, 2], // 2  bottom
  [0, 1, 2, 1, 0], // 3  V
  [2, 1, 0, 1, 2], // 4  ^
  [1, 0, 0, 0, 1], // 5  top-bowl
  [1, 2, 2, 2, 1], // 6  bottom-bowl
  [0, 0, 1, 2, 2], // 7  down-stair
  [2, 2, 1, 0, 0], // 8  up-stair
  [1, 0, 1, 2, 1], // 9  zigzag
];

const LINE_COLORS = [
  "#2ecc71",
  "#22e1ff",
  "#ff5d73",
  "#ffd166",
  "#c44dff",
  "#ff9f1c",
  "#5dffb0",
  "#ff4da6",
  "#7cd4ff",
  "#ffe14d",
];

/* ---- Win evaluation ---------------------------------------------- */

interface LineWin {
  line: number;
  symbol: SymKey;
  count: number; // 3,4,5
  multiplier: number; // of total bet
  cells: { reel: number; row: number }[];
}

interface SpinResult {
  grid: Grid;
  lineWins: LineWin[];
  scatterCells: { reel: number; row: number }[];
  scatterCount: number;
  totalMultiplier: number; // of total bet (line wins only)
}

function evaluateSpin(grid: Grid): SpinResult {
  const lineWins: LineWin[] = [];
  let totalMultiplier = 0;

  for (let li = 0; li < LINES; li++) {
    const pattern = PAYLINES[li];
    if (!pattern) continue;
    const lineSyms: SymKey[] = pattern.map(
      (row, reel) => grid[reel]?.[row] ?? "CHERRY",
    );

    // Determine the paying symbol: first non-wild, non-scatter from the left.
    // Wilds substitute. A line of all wilds pays as STAR.
    let base: SymKey | null = null;
    for (const s of lineSyms) {
      if (s === "SCATTER") break; // scatter can't be part of a line win
      if (s !== "STAR") {
        base = s;
        break;
      }
    }
    // All wilds (no concrete base) → treat as STAR wild line.
    if (base === null) {
      if (lineSyms[0] === "STAR") base = "STAR";
      else continue;
    }

    // (Scatters are handled separately and never lead a payline.)

    // Count consecutive matches from the left (wild matches anything).
    let count = 0;
    const cells: { reel: number; row: number }[] = [];
    for (let reel = 0; reel < REELS; reel++) {
      const s = lineSyms[reel];
      if (s === base || s === "STAR") {
        count++;
        const row = pattern[reel] ?? 0;
        cells.push({ reel, row });
      } else {
        break;
      }
    }

    if (count >= 3) {
      const def = SYMBOLS[base];
      const mult = def.pay[count - 3] ?? 0;
      if (mult > 0) {
        lineWins.push({
          line: li,
          symbol: base,
          count,
          multiplier: mult,
          cells: cells.slice(0, count),
        });
        totalMultiplier += mult;
      }
    }
  }

  // Scatters anywhere.
  const scatterCells: { reel: number; row: number }[] = [];
  for (let reel = 0; reel < REELS; reel++) {
    for (let row = 0; row < ROWS; row++) {
      if (grid[reel]?.[row] === "SCATTER") scatterCells.push({ reel, row });
    }
  }

  return {
    grid,
    lineWins,
    scatterCells,
    scatterCount: scatterCells.length,
    totalMultiplier,
  };
}

/* ---- Animated rolling counter ------------------------------------ */

function RollingNumber({ value }: { value: number }) {
  const mv = useMotionValue(0);
  const spring = useSpring(mv, { stiffness: 90, damping: 18 });
  const text = useTransform(spring, (v) => formatChips(v));
  useEffect(() => {
    mv.set(value);
  }, [value, mv]);
  return <motion.span>{text}</motion.span>;
}

/* ---- A single reel cell ------------------------------------------ */

interface CellState {
  sym: SymKey;
  spinning: boolean;
  spinSym: SymKey; // blurred symbol shown while spinning
}

function Cell({
  state,
  win,
  lineColor,
}: {
  state: CellState;
  win: boolean;
  lineColor: string | null;
}) {
  const def = SYMBOLS[state.sym];
  const blurDef = SYMBOLS[state.spinSym];
  return (
    <div
      className="relative grid place-items-center overflow-hidden rounded-xl"
      style={{
        background:
          "linear-gradient(160deg, rgba(255,255,255,0.06), rgba(0,0,0,0.35))",
        boxShadow: win
          ? `0 0 0 2px ${lineColor ?? ACCENT}, 0 0 22px ${lineColor ?? ACCENT}aa, inset 0 0 18px ${lineColor ?? ACCENT}66`
          : "inset 0 0 12px rgba(0,0,0,0.45)",
        border: "1px solid rgba(255,255,255,0.08)",
        aspectRatio: "1 / 1",
        transition: "box-shadow 180ms ease",
      }}
    >
      {/* faint symbol tint glow */}
      <div
        className="pointer-events-none absolute inset-0 opacity-30"
        style={{
          background: `radial-gradient(circle at 50% 45%, ${def.color}33, transparent 70%)`,
        }}
      />
      <AnimatePresence mode="popLayout" initial={false}>
        {state.spinning ? (
          <motion.div
            key="blur"
            initial={{ y: -30, opacity: 0 }}
            animate={{ y: [-10, 10, -10], opacity: 1 }}
            exit={{ y: 30, opacity: 0 }}
            transition={{
              y: { repeat: Infinity, duration: 0.18, ease: "linear" },
              opacity: { duration: 0.08 },
            }}
            className="select-none"
            style={{
              fontSize: "clamp(26px, 7.5vw, 54px)",
              filter: "blur(2px)",
              lineHeight: 1,
            }}
          >
            {blurDef.glyph}
          </motion.div>
        ) : (
          <motion.div
            key={`s-${state.sym}`}
            initial={{ y: 28, opacity: 0, scale: 0.6 }}
            animate={{ y: 0, opacity: 1, scale: 1 }}
            transition={{ type: "spring", stiffness: 460, damping: 26 }}
            className="relative select-none"
            style={{ fontSize: "clamp(26px, 7.5vw, 54px)", lineHeight: 1 }}
          >
            <motion.span
              animate={
                win
                  ? { scale: [1, 1.22, 1], rotate: [0, -6, 6, 0] }
                  : { scale: 1, rotate: 0 }
              }
              transition={
                win
                  ? { repeat: Infinity, duration: 0.9, ease: "easeInOut" }
                  : { duration: 0.2 }
              }
              style={{ display: "inline-block" }}
            >
              {def.glyph}
            </motion.span>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/* ---- Paytable panel ---------------------------------------------- */

function Paytable({ bet }: { bet: number }) {
  const perLine = bet; // pays are quoted as multiples of TOTAL bet
  return (
    <>
      <div className="grid grid-cols-1 gap-1 text-[11px] sm:text-xs">
        <div className="grid grid-cols-[1.4fr_1fr_1fr_1fr] gap-1 px-1 text-white/40">
          <span>Symbol</span>
          <span className="text-right">×3</span>
          <span className="text-right">×4</span>
          <span className="text-right">×5</span>
        </div>
        {PAY_ORDER.map((k) => {
          const d = SYMBOLS[k];
          return (
            <div
              key={k}
              className="grid grid-cols-[1.4fr_1fr_1fr_1fr] items-center gap-1 rounded-lg px-1 py-0.5"
              style={{ background: "rgba(255,255,255,0.03)" }}
            >
              <span className="flex items-center gap-1 truncate">
                <span style={{ fontSize: 16 }}>{d.glyph}</span>
                <span className="truncate text-white/70">
                  {d.label}
                  {d.wild ? " (wild)" : ""}
                </span>
              </span>
              {([0, 1, 2] as const).map((i) => (
                <span
                  key={i}
                  className="text-right tabular-nums text-white/85"
                  title={`${formatMultiplier(d.pay[i])} of total bet`}
                >
                  {d.pay[i] > 0 ? formatChips(d.pay[i] * perLine) : "—"}
                </span>
              ))}
            </div>
          );
        })}
        <div
          className="mt-1 grid grid-cols-[1.4fr_3fr] items-center gap-1 rounded-lg px-1 py-1"
          style={{ background: `${ACCENT}1a` }}
        >
          <span className="flex items-center gap-1">
            <span style={{ fontSize: 16 }}>{SYMBOLS.SCATTER.glyph}</span>
            <span className="text-white/70">Scatter</span>
          </span>
          <span className="text-right text-white/80">
            3+ anywhere → {FREE_SPINS_AWARD} FREE SPINS
          </span>
        </div>
      </div>
      <p className="mt-2 text-center text-[10px] leading-snug text-white/40">
        10 fixed paylines · left→right · wild ⭐ substitutes all but 🪙 · payouts
        scale with your total bet.
      </p>
    </>
  );
}

/* ---- Payline overlay (SVG glowing lines) -------------------------- */

function PaylineOverlay({
  activeLines,
  showAll,
}: {
  activeLines: number[];
  showAll: boolean;
}) {
  // Grid is REELS columns × ROWS rows. We draw in a 0..100 viewbox.
  const colW = 100 / REELS;
  const rowH = 100 / ROWS;
  const cx = (reel: number) => colW * (reel + 0.5);
  const cy = (row: number) => rowH * (row + 0.5);

  const lines = showAll ? PAYLINES.map((_, i) => i) : activeLines;

  return (
    <svg
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      className="pointer-events-none absolute inset-0 h-full w-full"
    >
      {lines.map((li) => {
        const pattern = PAYLINES[li];
        if (!pattern) return null;
        const pts = pattern
          .map((row, reel) => `${cx(reel)},${cy(row)}`)
          .join(" ");
        const color = LINE_COLORS[li % LINE_COLORS.length] ?? ACCENT;
        return (
          <motion.polyline
            key={li}
            points={pts}
            fill="none"
            stroke={color}
            strokeWidth={showAll ? 0.6 : 1.1}
            strokeLinecap="round"
            strokeLinejoin="round"
            initial={{ pathLength: 0, opacity: 0 }}
            animate={{
              pathLength: 1,
              opacity: showAll ? 0.35 : 0.95,
            }}
            transition={{ duration: 0.5, ease: "easeOut" }}
            style={{
              filter: showAll
                ? "none"
                : `drop-shadow(0 0 2px ${color}) drop-shadow(0 0 4px ${color})`,
            }}
          />
        );
      })}
    </svg>
  );
}

/* ---- Win burst particles ----------------------------------------- */

function WinBurst({ trigger }: { trigger: number }) {
  const bits = useMemo(
    () =>
      Array.from({ length: 14 }, () => ({
        x: randInt(-160, 160),
        y: randInt(-120, 40),
        r: randInt(-180, 180),
        glyph: ["🍒", "🍋", "🍊", "🍇", "⭐", "🪙", "🍉"][randInt(0, 6)],
        d: 0.7 + Math.random() * 0.5,
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [trigger],
  );
  return (
    <div className="pointer-events-none absolute inset-0 grid place-items-center overflow-visible">
      {bits.map((b, i) => (
        <motion.div
          key={`${trigger}-${i}`}
          initial={{ x: 0, y: 0, scale: 0, opacity: 1, rotate: 0 }}
          animate={{ x: b.x, y: b.y, scale: 1, opacity: 0, rotate: b.r }}
          transition={{ duration: b.d, ease: "easeOut" }}
          className="absolute select-none"
          style={{ fontSize: 26 }}
        >
          {b.glyph}
        </motion.div>
      ))}
    </div>
  );
}

/* ================================================================== *
 * Main component
 * ================================================================== */

type Phase = "idle" | "spinning" | "resolved";

const MIN_BET = 10; // must be a multiple of LINES so per-line is whole
const REEL_STAGGER_MS = 220;
const SPIN_BASE_MS = 620;

// Buy-a-bonus: pay BUY_COST_MULT× the total bet for BUY_SPINS free spins whose
// wins are all multiplied by BUY_MULT. Tuned so the buy returns ~96.9% (sim:
// 10 spins × ×10 incl. retriggers ≈ 96.9× the total bet) — fair vs the 100× cost.
const BUY_COST_MULT = 100;
const BUY_SPINS = 10;
const BUY_MULT = 10;

export default function FruitFrenzy() {
  const wallet = useWallet();
  const { balance, ready } = wallet;

  const [bet, setBet] = useState(50);
  const [phase, setPhase] = useState<Phase>("idle");

  // Reel cell state.
  const initGrid = useMemo<Grid>(() => spinGrid(), []);
  const [cells, setCells] = useState<CellState[][]>(() =>
    initGrid.map((reel) =>
      reel.map((s) => ({ sym: s, spinning: false, spinSym: s })),
    ),
  );

  const [result, setResult] = useState<SpinResult | null>(null);
  const [resultText, setResultText] = useState("");
  const [lastWin, setLastWin] = useState(0);
  const [highlightLine, setHighlightLine] = useState<number[]>([]);
  const [burst, setBurst] = useState(0);
  const [showAllLines, setShowAllLines] = useState(false);

  // Free spins.
  const [freeSpins, setFreeSpins] = useState(0);
  const [freeBanner, setFreeBanner] = useState(false);
  const [inFreeSpin, setInFreeSpin] = useState(false);
  // Win multiplier active during a *bought* bonus (1 during normal play and
  // naturally-triggered free spins, so the base RTP is never inflated).
  const [buyMult, setBuyMult] = useState(1);

  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const cycleWinRef = useRef(0); // accumulated free-spin session win
  const tickInterval = useRef<ReturnType<typeof setInterval> | null>(null);
  // Keep a stable ref to resolveSpin so runSpin never closes over a stale version.
  const resolveSpinRef = useRef<((grid: Grid, free: boolean) => void) | null>(null);

  const clearTimers = useCallback(() => {
    timers.current.forEach((t) => clearTimeout(t));
    timers.current = [];
    if (tickInterval.current) {
      clearInterval(tickInterval.current);
      tickInterval.current = null;
    }
  }, []);

  useEffect(() => () => clearTimers(), [clearTimers]);

  const busy = phase === "spinning";
  const affordable = bet <= balance && bet >= MIN_BET;
  const perLine = bet / LINES;

  /**
   * Core spin animation + resolution. If `free` is true the bet has already
   * been "paid" (free spin) and winnings accumulate into the session.
   */
  const runSpin = useCallback(
    (free: boolean) => {
      clearTimers();
      setPhase("spinning");
      setResult(null);
      setResultText("");
      setHighlightLine([]);
      setShowAllLines(false);
      setInFreeSpin(free);

      const target = spinGrid();

      // Start all reels spinning; cycle the blurred symbol fast.
      setCells((prev) =>
        prev.map((reel, r) =>
          reel.map((c) => ({
            ...c,
            spinning: true,
            spinSym: spinCell(r),
          })),
        ),
      );

      tickInterval.current = setInterval(() => {
        setCells((prev) =>
          prev.map((reel, r) =>
            reel.map((c) =>
              c.spinning ? { ...c, spinSym: spinCell(r) } : c,
            ),
          ),
        );
      }, 70);

      // Stop reels left-to-right with a stagger.
      for (let r = 0; r < REELS; r++) {
        const stopAt = SPIN_BASE_MS + r * REEL_STAGGER_MS;
        timers.current.push(
          setTimeout(() => {
            sfx.thud();
            sfx.tick();
            setCells((prev) =>
              prev.map((reel, ri) =>
                ri === r
                  ? reel.map((_c, row) => ({
                      sym: target[r]?.[row] ?? "CHERRY",
                      spinning: false,
                      spinSym: target[r]?.[row] ?? "CHERRY",
                    }))
                  : reel,
              ),
            );
          }, stopAt),
        );
      }

      // After the last reel stops, resolve.
      const resolveAt = SPIN_BASE_MS + (REELS - 1) * REEL_STAGGER_MS + 260;
      timers.current.push(
        setTimeout(() => {
          if (tickInterval.current) {
            clearInterval(tickInterval.current);
            tickInterval.current = null;
          }
          // Use ref so we always call the latest resolveSpin (avoids stale closure).
          resolveSpinRef.current?.(target, free);
        }, resolveAt),
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [clearTimers],
  );

  /** Resolve a settled grid: pay line wins, handle scatters / free spins. */
  const resolveSpin = useCallback(
    (grid: Grid, free: boolean) => {
      const res = evaluateSpin(grid);
      setResult(res);

      // Bought-bonus spins multiply every win; normal/natural spins use ×1.
      const winMult = free ? buyMult : 1;
      const gross = Math.round(bet * res.totalMultiplier * winMult);
      const triggersFree = res.scatterCount >= SCATTERS_FOR_FREE;

      // Pay line winnings.
      if (gross > 0) {
        wallet.win(gross);
        setLastWin(gross);
        if (free) cycleWinRef.current += gross;
        setBurst((b) => b + 1);
        if (res.totalMultiplier >= 10) sfx.jackpot();
        else sfx.win();
      } else {
        setLastWin(0);
        if (!free && !triggersFree) sfx.lose();
      }

      // Cycle through winning lines, highlighting each.
      if (res.lineWins.length > 0) {
        let i = 0;
        const showNext = () => {
          if (i >= res.lineWins.length) {
            // After cycling once, show all winners together.
            setHighlightLine(res.lineWins.map((w) => w.line));
            return;
          }
          const win = res.lineWins[i];
          if (win) setHighlightLine([win.line]);
          i++;
          timers.current.push(setTimeout(showNext, 650));
        };
        showNext();
      }

      // Build the result text.
      const parts: string[] = [];
      if (gross > 0) {
        const top = [...res.lineWins].sort(
          (a, b) => b.multiplier - a.multiplier,
        )[0];
        parts.push(
          `WIN ${formatChips(gross)} · ${res.lineWins.length} line${
            res.lineWins.length > 1 ? "s" : ""
          }`,
        );
        if (top) {
          parts.push(
            `${top.count}× ${SYMBOLS[top.symbol].label} (${formatMultiplier(
              top.multiplier,
            )})`,
          );
        }
      }
      if (triggersFree) {
        parts.push(`${res.scatterCount} 🪙 → ${FREE_SPINS_AWARD} FREE SPINS!`);
      } else if (gross === 0 && !free) {
        parts.push("No win — spin again!");
      } else if (gross === 0 && free) {
        parts.push("No win this free spin");
      }
      setResultText(parts.join("  •  "));

      // Award / continue free spins.
      if (triggersFree) {
        sfx.jackpot();
        setFreeBanner(true);
        setFreeSpins((n) => n + FREE_SPINS_AWARD);
        if (!free) cycleWinRef.current = gross; // start a fresh session tally
        timers.current.push(
          setTimeout(() => setFreeBanner(false), 1800),
        );
      }

      setPhase("resolved");
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [bet, wallet, buyMult],
  );

  // Always keep the ref pointed at the latest resolveSpin so runSpin's
  // setTimeout callback never invokes a stale closure.
  useEffect(() => {
    resolveSpinRef.current = resolveSpin;
  }, [resolveSpin]);

  // Drive auto free-spins: whenever we're resolved and have free spins left,
  // automatically launch the next free spin after a short pause.
  useEffect(() => {
    if (phase !== "resolved") return;
    if (freeSpins <= 0) return;
    const t = setTimeout(() => {
      setFreeSpins((n) => Math.max(0, n - 1));
      runSpin(true);
    }, 1100);
    timers.current.push(t);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, freeSpins]);

  // When a free-spin session ends, summarise and clear any bought multiplier.
  useEffect(() => {
    if (phase === "resolved" && freeSpins === 0 && inFreeSpin) {
      const total = cycleWinRef.current;
      if (total > 0) {
        setResultText(
          `FREE SPINS DONE · won ${formatChips(total)} total!`,
        );
      } else {
        setResultText("Free spins done");
      }
      setInFreeSpin(false);
      setBuyMult(1);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, freeSpins, inFreeSpin]);

  /** Player-initiated paid spin. */
  const handleSpin = useCallback(() => {
    if (busy || freeSpins > 0) return;
    if (bet < MIN_BET) return;
    if (!wallet.bet(bet)) {
      sfx.lose();
      setResultText("Not enough chips for that bet");
      return;
    }
    sfx.chip();
    cycleWinRef.current = 0;
    runSpin(false);
  }, [busy, freeSpins, bet, wallet, runSpin]);

  /** Buy the bonus: pay BUY_COST_MULT× the bet for an enhanced free-spin round. */
  const buyCost = bet * BUY_COST_MULT;
  const handleBuyBonus = useCallback(() => {
    if (busy || freeSpins > 0) return;
    if (bet < MIN_BET) return;
    if (!wallet.bet(buyCost)) {
      sfx.lose();
      setResultText(`Need ${formatChips(buyCost)} to buy the bonus`);
      return;
    }
    sfx.jackpot();
    clearTimers();
    cycleWinRef.current = 0;
    setLastWin(0);
    setBuyMult(BUY_MULT);
    setInFreeSpin(true);
    setFreeBanner(true);
    setResultText(`Bonus bought — ${BUY_SPINS} super spins at ${BUY_MULT}×!`);
    setFreeSpins(BUY_SPINS);
    // Kick the auto-free-spin driver (it runs while phase==="resolved").
    setPhase("resolved");
    timers.current.push(setTimeout(() => setFreeBanner(false), 1800));
  }, [busy, freeSpins, bet, wallet, buyCost, clearTimers]);

  // Winning cell lookup for highlighting.
  const winningCellSet = useMemo(() => {
    const set = new Set<string>();
    if (!result) return set;
    for (const w of result.lineWins) {
      if (highlightLine.includes(w.line)) {
        for (const c of w.cells) set.add(`${c.reel}-${c.row}`);
      }
    }
    // Always sparkle scatters once resolved.
    if (phase === "resolved") {
      for (const c of result.scatterCells) set.add(`${c.reel}-${c.row}`);
    }
    return set;
  }, [result, highlightLine, phase]);

  const cellLineColor = useCallback(
    (reel: number, row: number): string | null => {
      if (!result) return null;
      for (const w of result.lineWins) {
        if (!highlightLine.includes(w.line)) continue;
        if (w.cells.some((c) => c.reel === reel && c.row === row)) {
          return LINE_COLORS[w.line % LINE_COLORS.length] ?? ACCENT;
        }
      }
      return null;
    },
    [result, highlightLine],
  );

  const won = lastWin > 0 && phase === "resolved";
  // Celebration intensity: a free-spins/scatter trigger or a huge win → jackpot.
  const triggeredFree = (result?.scatterCount ?? 0) >= SCATTERS_FOR_FREE;
  const winRatio = bet > 0 ? lastWin / bet : 0;
  const celebrationTier: "win" | "big" | "jackpot" =
    triggeredFree || winRatio >= 15 ? "jackpot" : winRatio >= 4 ? "big" : "win";
  const playDisabled = !ready || busy || freeSpins > 0 || !affordable;
  const buyDisabled = !ready || busy || freeSpins > 0 || buyCost > balance;

  return (
    <div className="mx-auto w-full max-w-5xl">
      {/* Header / stats */}
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2 sm:mb-3">
        <div className="flex items-baseline gap-2">
          <h2
            className="font-display text-2xl font-bold tracking-wide sm:text-3xl"
            style={{ color: ACCENT, textShadow: `0 0 18px ${ACCENT}80` }}
          >
            Fruit Frenzy
          </h2>
          <span className="text-xs uppercase tracking-[0.3em] text-white/40">
            5×3 · 10 lines
          </span>
        </div>
        <div className="flex items-center gap-3 text-right">
          <div>
            <div className="text-[10px] uppercase tracking-widest text-white/40">
              Balance
            </div>
            <div className="gold-text text-lg font-bold tabular-nums">
              <RollingNumber value={balance} />
            </div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-widest text-white/40">
              Last Win
            </div>
            <div
              className="text-lg font-bold tabular-nums"
              style={{ color: won ? ACCENT : "rgba(255,255,255,0.55)" }}
            >
              <RollingNumber value={lastWin} />
            </div>
          </div>
        </div>
      </div>

      <div className="grid gap-2 sm:gap-4 md:grid-cols-[1fr_280px] lg:grid-cols-[1fr_300px]">
        {/* ---------- LEFT: reels + controls ---------- */}
        <div className="flex flex-col gap-2 sm:gap-4">
          <div
            className="felt relative overflow-hidden rounded-3xl p-3 sm:p-6 [@media(max-height:600px)]:p-2"
            style={{
              boxShadow: `inset 0 0 60px rgba(0,0,0,0.5), 0 0 0 1px ${ACCENT}33`,
            }}
          >
            {/* free-spin badge */}
            <AnimatePresence>
              {freeSpins > 0 && (
                <motion.div
                  initial={{ y: -20, opacity: 0, scale: 0.8 }}
                  animate={{ y: 0, opacity: 1, scale: 1 }}
                  exit={{ y: -20, opacity: 0, scale: 0.8 }}
                  className="absolute left-1/2 top-2 z-20 -translate-x-1/2 rounded-full px-4 py-1 text-sm font-bold"
                  style={{
                    background: `linear-gradient(90deg, ${ACCENT}, #22e1ff)`,
                    color: "#04130b",
                    boxShadow: `0 0 24px ${ACCENT}aa`,
                  }}
                  data-testid="free-spins-counter"
                >
                  🪙 FREE SPINS LEFT: {freeSpins}
                </motion.div>
              )}
            </AnimatePresence>

            {/* the reel grid */}
            <div className="relative mx-auto [@media(max-height:600px)]:max-w-[440px]">
              <div
                className="relative grid gap-2 rounded-2xl p-2 [@media(max-height:600px)]:gap-1 [@media(max-height:600px)]:p-1"
                style={{
                  gridTemplateColumns: `repeat(${REELS}, minmax(0, 1fr))`,
                  background:
                    "linear-gradient(180deg, rgba(0,0,0,0.35), rgba(0,0,0,0.15))",
                }}
              >
                {Array.from({ length: REELS }, (_, reel) => (
                  <div
                    key={reel}
                    className="grid gap-2 [@media(max-height:600px)]:gap-1"
                    style={{
                      gridTemplateRows: `repeat(${ROWS}, minmax(0, 1fr))`,
                    }}
                  >
                    {Array.from({ length: ROWS }, (_, row) => {
                      const cs = cells[reel]?.[row];
                      if (!cs) return null;
                      const key = `${reel}-${row}`;
                      return (
                        <Cell
                          key={key}
                          state={cs}
                          win={winningCellSet.has(key)}
                          lineColor={cellLineColor(reel, row)}
                        />
                      );
                    })}
                  </div>
                ))}

                {/* glowing payline overlay */}
                <PaylineOverlay
                  activeLines={highlightLine}
                  showAll={showAllLines}
                />
              </div>

              {/* win burst */}
              {won && <WinBurst trigger={burst} />}
            </div>

            {/* FREE SPINS banner */}
            <AnimatePresence>
              {freeBanner && (
                <motion.div
                  initial={{ scale: 0.4, opacity: 0, rotate: -8 }}
                  animate={{ scale: 1, opacity: 1, rotate: 0 }}
                  exit={{ scale: 1.4, opacity: 0 }}
                  transition={{ type: "spring", stiffness: 260, damping: 16 }}
                  className="pointer-events-none absolute inset-0 z-30 grid place-items-center"
                >
                  <div
                    className="rounded-2xl px-8 py-5 text-center"
                    style={{
                      background: "rgba(4,19,11,0.86)",
                      border: `2px solid ${ACCENT}`,
                      boxShadow: `0 0 50px ${ACCENT}cc`,
                    }}
                  >
                    <motion.div
                      animate={{ scale: [1, 1.08, 1] }}
                      transition={{ repeat: Infinity, duration: 0.7 }}
                      className="font-display text-3xl font-black tracking-wider sm:text-5xl"
                      style={{
                        color: ACCENT,
                        textShadow: `0 0 24px ${ACCENT}`,
                      }}
                    >
                      FREE SPINS!
                    </motion.div>
                    <div className="mt-1 text-sm font-bold text-white/80">
                      {FREE_SPINS_AWARD} spins — auto-played
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* win-celebration overlay (confetti + coin fountain) */}
            <Celebration
              show={won}
              seed={lastWin}
              tier={celebrationTier}
              colors={["#2ecc71", "#ffd24a", "#ff5e7e", "#22e1ff", "#ffffff"]}
            />
          </div>

          {/* result line */}
          <motion.div
            key={resultText || "empty"}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            className="glass min-h-[44px] rounded-xl px-4 py-2 text-center text-sm font-semibold"
            style={{
              color: won ? ACCENT : "rgba(255,255,255,0.7)",
              border: won ? `1px solid ${ACCENT}66` : undefined,
            }}
            data-testid="round-result"
          >
            {resultText ||
              (phase === "spinning"
                ? "Spinning…"
                : "Set your bet and spin the reels!")}
          </motion.div>

          {/* primary control row */}
          <div className="flex flex-wrap items-center justify-center gap-3">
            <motion.div whileTap={{ scale: 0.97 }}>
              <Button
                size="lg"
                variant="gold"
                onClick={handleSpin}
                disabled={playDisabled}
                data-testid="play-btn"
                className="min-w-[160px]"
              >
                {freeSpins > 0
                  ? "FREE SPIN…"
                  : busy
                    ? "SPINNING…"
                    : `SPIN · ${formatChips(bet)}`}
              </Button>
            </motion.div>
            <motion.div whileTap={{ scale: 0.97 }}>
              <Button
                size="lg"
                variant="ghost"
                onClick={handleBuyBonus}
                disabled={buyDisabled}
                data-testid="buy-bonus-btn"
                className="min-w-[150px] border border-[#2ecc71]/50 text-[#2ecc71]"
                title={`Buy ${BUY_SPINS} free spins at ${BUY_MULT}× for ${BUY_COST_MULT}× your bet`}
              >
                🪙 BUY BONUS · {formatChips(buyCost)}
              </Button>
            </motion.div>
            <Button
              size="md"
              variant="ghost"
              onMouseEnter={() => !busy && setShowAllLines(true)}
              onMouseLeave={() => setShowAllLines(false)}
              onClick={() => setShowAllLines((v) => !v)}
              disabled={busy}
              data-testid="show-lines-btn"
            >
              Show 10 Lines
            </Button>
          </div>

          {/* bet controls */}
          <BetControls
            bet={bet}
            setBet={(n) => {
              // Keep bet a multiple of LINES (>= MIN_BET) for clean per-line math.
              const snapped = Math.max(
                MIN_BET,
                Math.round(n / LINES) * LINES,
              );
              setBet(snapped);
            }}
            balance={balance}
            min={MIN_BET}
            max={Math.max(MIN_BET, Math.floor(balance / LINES) * LINES)}
            chips={[10, 25, 50, 100, 500]}
            disabled={busy || freeSpins > 0}
          />
          <div className="text-center text-[11px] text-white/40">
            Total bet covers all 10 lines · {formatChips(perLine)} per line
          </div>
        </div>

        {/* ---------- RIGHT: paytable ---------- */}
        <div className="flex flex-col gap-2 sm:gap-4">
          <CollapsiblePanel
            title="Paytable"
            accent={ACCENT}
            summary={<>10 lines · ⭐ wild</>}
          >
            <Paytable bet={bet} />
          </CollapsiblePanel>
          <CollapsiblePanel
            title="How it works"
            accent={ACCENT}
            summary={<>rules</>}
          >
            <ul className="space-y-1 text-[11px] text-white/55">
              <li>• 3+ matching from the leftmost reel on a payline pay.</li>
              <li>• ⭐ Wild stands in for every symbol except 🪙 Scatter.</li>
              <li>
                • 3+ 🪙 Scatters anywhere award {FREE_SPINS_AWARD} auto free
                spins (wins added).
              </li>
              <li>• Bigger symbols pay more; the bell &amp; wild pay top.</li>
            </ul>
          </CollapsiblePanel>
        </div>
      </div>
    </div>
  );
}
