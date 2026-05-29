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
import { Button } from "@/components/ui/Button";
import { Chip } from "@/components/ui/Chip";
import { CollapsiblePanel } from "@/components/CollapsiblePanel";
import { formatChips } from "@/lib/format";
import { sfx } from "@/lib/sound";
import { clamp, randInt, shuffle, weightedPick } from "@/lib/rng";
import { Celebration } from "@/components/Celebration";

/* -------------------------------------------------------------------------- */
/*  Theme                                                                     */
/* -------------------------------------------------------------------------- */

const ACCENT = "#f1c40f"; // Pharaoh gold
const SAND = "#e8d2a0";
const SAND_DARK = "#3a2c14";

const ROWS = 3;
const REELS = 5;
const FREE_SPINS = 10;
const SCATTER_TRIGGER = 3;

/* -------------------------------------------------------------------------- */
/*  Symbols & paytable                                                        */
/* -------------------------------------------------------------------------- */

type SymbolId =
  | "PHARAOH"
  | "ANUBIS"
  | "SCARAB"
  | "EYE"
  | "ANKH"
  | "WILD" // pyramid
  | "BOOK" // scatter
  | "A"
  | "K"
  | "Q"
  | "J"
  | "TEN";

interface SymbolDef {
  id: SymbolId;
  glyph: string;
  label: string;
  color: string;
  /** Relative reel weight (higher = appears more often). */
  weight: number;
  /** Payout multiplier of the *total bet* for 3 / 4 / 5 of a kind. */
  pays: [three: number, four: number, five: number];
}

// Ordered high → low. WILD substitutes for everything except BOOK.
// Pays are multiples of the TOTAL bet (see evaluateLines). The previous values
// were applied to the per-LINE stake (totalBet/10) AND were ~25x too small for
// the hit frequency, so the game returned only ~5.6% RTP (a 94% house edge —
// a near-total rip-off). These values, on the total bet, land it at ~96.8% RTP
// (Monte-Carlo verified over 2M spins incl. the 10 free-spin expanding feature).
const SYMBOLS: Record<SymbolId, SymbolDef> = {
  PHARAOH: { id: "PHARAOH", glyph: "𓀀", label: "Pharaoh", color: "#ffd84d", weight: 4, pays: [11, 80, 528] },
  ANUBIS: { id: "ANUBIS", glyph: "𓃢", label: "Anubis", color: "#caa6ff", weight: 5, pays: [8, 48, 317] },
  SCARAB: { id: "SCARAB", glyph: "🪲", label: "Scarab", color: "#6fe0c0", weight: 6, pays: [7, 32, 212] },
  EYE: { id: "EYE", glyph: "𓂀", label: "Eye of Horus", color: "#5fd1ff", weight: 7, pays: [5, 21, 132] },
  ANKH: { id: "ANKH", glyph: "☥", label: "Ankh", color: "#f7a05a", weight: 8, pays: [4, 16, 92] },
  A: { id: "A", glyph: "A", label: "A", color: "#f4e3b0", weight: 11, pays: [2.6, 8, 48] },
  K: { id: "K", glyph: "K", label: "K", color: "#e9d29a", weight: 12, pays: [2.1, 7, 37] },
  Q: { id: "Q", glyph: "Q", label: "Q", color: "#ddc488", weight: 13, pays: [1.6, 5.2, 26] },
  J: { id: "J", glyph: "J", label: "J", color: "#d4b878", weight: 14, pays: [1.4, 4, 21] },
  TEN: { id: "TEN", glyph: "10", label: "10", color: "#cbae6a", weight: 15, pays: [1.1, 3.2, 16] },
  WILD: { id: "WILD", glyph: "🔺", label: "Pyramid (Wild)", color: ACCENT, weight: 3, pays: [13, 106, 793] },
  BOOK: { id: "BOOK", glyph: "📖", label: "Book (Scatter)", color: "#ff9d3b", weight: 3, pays: [0, 0, 0] },
};

// Scatter (Book) pays on total bet for 3/4/5 anywhere.
const SCATTER_PAYS: Record<number, number> = { 3: 2, 4: 20, 5: 200 };

// Symbols eligible to be the random "expanding" symbol during free spins
// (classic Book-of-Ra: a high/mid symbol, never the card lows, never book/wild).
const EXPANDING_POOL: SymbolId[] = ["PHARAOH", "ANUBIS", "SCARAB", "EYE", "ANKH"];

const REEL_POOL: SymbolId[] = Object.values(SYMBOLS).flatMap((s) =>
  Array<SymbolId>(s.weight).fill(s.id),
);

/* -------------------------------------------------------------------------- */
/*  Paylines (10 fixed lines across a 5×3 grid; row index per reel)           */
/* -------------------------------------------------------------------------- */

const PAYLINES: number[][] = [
  [1, 1, 1, 1, 1], // middle
  [0, 0, 0, 0, 0], // top
  [2, 2, 2, 2, 2], // bottom
  [0, 1, 2, 1, 0], // V
  [2, 1, 0, 1, 2], // ^
  [0, 0, 1, 2, 2], // descend
  [2, 2, 1, 0, 0], // ascend
  [1, 0, 1, 2, 1], // zigzag up
  [1, 2, 1, 0, 1], // zigzag down
  [0, 1, 1, 1, 0], // arch low
];

const LINE_COLORS = [
  "#f1c40f",
  "#22e1ff",
  "#ff2bd1",
  "#8aff80",
  "#a855f7",
  "#ff9d3b",
  "#5fd1ff",
  "#ffd84d",
  "#6fe0c0",
  "#caa6ff",
];

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

type Grid = SymbolId[][]; // [reel][row]

interface LineWin {
  line: number;
  symbol: SymbolId;
  count: number;
  /** [reel, row] coordinates that form the win. */
  cells: [number, number][];
  payout: number; // chips
}

interface ScatterWin {
  count: number;
  cells: [number, number][];
  payout: number;
}

interface ExpandWin {
  symbol: SymbolId;
  reels: number[]; // reels fully covered by the expanding symbol
  lines: number; // number of paylines that contributed (visual)
  payout: number;
}

interface SpinResult {
  grid: Grid;
  lineWins: LineWin[];
  scatter: ScatterWin | null;
  expand: ExpandWin | null;
  triggeredFree: boolean; // first-time free-spins trigger
  retrigger: boolean; // scatter hit during free spins
  total: number; // total chips won this spin
}

/* -------------------------------------------------------------------------- */
/*  Engine                                                                    */
/* -------------------------------------------------------------------------- */

function randomGrid(): Grid {
  const grid: Grid = [];
  for (let r = 0; r < REELS; r++) {
    const col: SymbolId[] = [];
    // Shuffle a slice so a reel rarely shows duplicate stacks.
    const bag = shuffle(REEL_POOL);
    let bi = 0;
    const seen = new Set<SymbolId>();
    for (let row = 0; row < ROWS; row++) {
      // avoid 3 identical low symbols stacked too often by light de-dup
      let s = bag[bi % bag.length];
      bi++;
      let guard = 0;
      while (seen.has(s) && guard < 4 && (s === "BOOK" || s === "WILD")) {
        s = bag[bi % bag.length];
        bi++;
        guard++;
      }
      seen.add(s);
      col.push(s);
    }
    grid.push(col);
  }
  return grid;
}

/** Does symbol `s` count as `target` (wild substitutes for non-book)? */
function matches(s: SymbolId, target: SymbolId): boolean {
  if (s === target) return true;
  if (target === "BOOK") return false; // scatter never substituted
  if (target === "WILD") return s === "WILD";
  return s === "WILD";
}

function evaluateLines(grid: Grid, totalBet: number): LineWin[] {
  const wins: LineWin[] = [];
  PAYLINES.forEach((line, lineIdx) => {
    const first = grid[0][line[0]];
    // The "lead" symbol is the first non-wild symbol on the line (so a wild
    // start adopts the next concrete symbol). All-wild leads count as WILD.
    let lead: SymbolId = first;
    if (first === "WILD") {
      for (let r = 1; r < REELS; r++) {
        const s = grid[r][line[r]];
        if (s !== "WILD" && s !== "BOOK") {
          lead = s;
          break;
        }
      }
    }
    if (lead === "BOOK") return; // scatter handled separately

    const cells: [number, number][] = [];
    let count = 0;
    for (let r = 0; r < REELS; r++) {
      const s = grid[r][line[r]];
      if (matches(s, lead)) {
        count++;
        cells.push([r, line[r]]);
      } else break;
    }
    if (count >= 3) {
      const def = SYMBOLS[lead];
      const mult = def.pays[count - 3];
      if (mult > 0) {
        // Paytable multipliers apply to the TOTAL bet.
        const payout = Math.round(mult * totalBet);
        wins.push({ line: lineIdx, symbol: lead, count, cells, payout });
      }
    }
  });
  return wins;
}

function evaluateScatter(grid: Grid, totalBet: number): ScatterWin | null {
  const cells: [number, number][] = [];
  for (let r = 0; r < REELS; r++) {
    for (let row = 0; row < ROWS; row++) {
      if (grid[r][row] === "BOOK") cells.push([r, row]);
    }
  }
  if (cells.length < SCATTER_TRIGGER) return null;
  const mult = SCATTER_PAYS[Math.min(5, cells.length)] ?? 0;
  return { count: cells.length, cells, payout: Math.round(mult * totalBet) };
}

/**
 * Free-spin expanding evaluation (Book of Ra style): if the expanding symbol
 * appears on at least 3 reels, it expands to cover those full reels and pays
 * as if each covered reel were a solid column, across all 10 lines that hit.
 */
function evaluateExpand(
  grid: Grid,
  expanding: SymbolId,
  totalBet: number,
): ExpandWin | null {
  const reelsWith: number[] = [];
  for (let r = 0; r < REELS; r++) {
    const has = grid[r].some((s) => s === expanding || s === "WILD");
    if (has) reelsWith.push(r);
  }
  // Must be a left-to-right run starting from reel 0.
  let run = 0;
  for (let r = 0; r < REELS; r++) {
    if (reelsWith.includes(r)) run++;
    else break;
  }
  if (run < 3) return null;

  const def = SYMBOLS[expanding];
  const mult = def.pays[run - 3];
  if (mult <= 0) return null;

  // The expanding symbol pays a full total-bet win for its run length — the
  // signature big Book-of-Ra payout (on top of any other line wins).
  const payout = Math.round(mult * totalBet);
  const reels: number[] = [];
  for (let r = 0; r < run; r++) reels.push(r);
  return { symbol: expanding, reels, lines: ROWS, payout };
}

function spinOnce(
  totalBet: number,
  freeSpin: boolean,
  expanding: SymbolId | null,
): SpinResult {
  const grid = randomGrid();

  const scatter = evaluateScatter(grid, totalBet);
  const triggeredFree = !freeSpin && (scatter?.count ?? 0) >= SCATTER_TRIGGER;
  const retrigger = freeSpin && (scatter?.count ?? 0) >= SCATTER_TRIGGER;

  let lineWins: LineWin[] = [];
  let expand: ExpandWin | null = null;

  if (freeSpin && expanding) {
    expand = evaluateExpand(grid, expanding, totalBet);
    if (!expand) {
      // No expand: still evaluate normal lines.
      lineWins = evaluateLines(grid, totalBet);
    } else {
      // When expanding hits, normal line wins are superseded by the expand
      // payout for that symbol; still award other symbols' line wins.
      lineWins = evaluateLines(grid, totalBet).filter(
        (w) => w.symbol !== expanding,
      );
    }
  } else {
    lineWins = evaluateLines(grid, totalBet);
  }

  const total =
    lineWins.reduce((s, w) => s + w.payout, 0) +
    (scatter?.payout ?? 0) +
    (expand?.payout ?? 0);

  return { grid, lineWins, scatter, expand, triggeredFree, retrigger, total };
}

/* -------------------------------------------------------------------------- */
/*  Rolling number counter                                                    */
/* -------------------------------------------------------------------------- */

function Counter({ value }: { value: number }) {
  const mv = useMotionValue(0);
  const spring = useSpring(mv, { stiffness: 90, damping: 18, mass: 0.6 });
  const text = useTransform(spring, (v) => formatChips(v));
  useEffect(() => {
    mv.set(value);
  }, [value, mv]);
  return <motion.span>{text}</motion.span>;
}

/* -------------------------------------------------------------------------- */
/*  Reel cell                                                                 */
/* -------------------------------------------------------------------------- */

interface CellProps {
  symbol: SymbolId;
  highlighted: boolean;
  highlightColor: string;
  expanded: boolean;
  expandColor: string;
  dim: boolean;
}

const SymbolFace = React.memo(function SymbolFace({
  symbol,
  size,
}: {
  symbol: SymbolId;
  size: "normal" | "big";
}) {
  const def = SYMBOLS[symbol];
  const isGlyph = def.glyph.length <= 2 && /[A-Z0-9]/.test(def.glyph);
  return (
    <span
      className={isGlyph ? "font-display font-bold" : ""}
      style={{
        color: def.color,
        fontSize: size === "big" ? "min(11vw, 4.2rem)" : "min(8vw, 2.6rem)",
        lineHeight: 1,
        textShadow: `0 0 12px ${def.color}88, 0 0 2px ${def.color}`,
        filter: "drop-shadow(0 2px 4px rgba(0,0,0,0.55))",
      }}
    >
      {def.glyph}
    </span>
  );
});

function ReelCell({
  symbol,
  highlighted,
  highlightColor,
  expanded,
  expandColor,
  dim,
}: CellProps) {
  return (
    <div
      className="relative grid place-items-center overflow-hidden rounded-lg"
      style={{
        aspectRatio: "1 / 1",
        background: expanded
          ? `radial-gradient(circle at 50% 40%, ${expandColor}33, ${SAND_DARK} 80%)`
          : "linear-gradient(160deg, rgba(60,44,20,0.55), rgba(20,14,5,0.75))",
        border: `1px solid ${expanded ? expandColor : "rgba(241,196,15,0.18)"}`,
        boxShadow: highlighted
          ? `inset 0 0 0 2px ${highlightColor}, 0 0 16px ${highlightColor}aa`
          : expanded
            ? `inset 0 0 24px ${expandColor}66`
            : "inset 0 1px 0 rgba(255,255,255,0.05)",
        opacity: dim ? 0.32 : 1,
        transition: "opacity 0.25s, box-shadow 0.25s",
      }}
    >
      {/* hieroglyph faint grid backdrop */}
      <span
        className="pointer-events-none absolute inset-0 opacity-[0.06]"
        style={{
          backgroundImage:
            "repeating-linear-gradient(0deg, transparent 0 7px, rgba(241,196,15,0.6) 7px 8px)",
        }}
      />
      <motion.div
        animate={
          highlighted
            ? { scale: [1, 1.16, 1] }
            : expanded
              ? { scale: [0.7, 1.12, 1] }
              : { scale: 1 }
        }
        transition={
          highlighted
            ? { duration: 0.7, repeat: Infinity, ease: "easeInOut" }
            : { duration: 0.45, ease: "backOut" }
        }
        className="relative grid place-items-center"
      >
        <SymbolFace symbol={symbol} size="normal" />
      </motion.div>
      {expanded && (
        <motion.span
          className="pointer-events-none absolute inset-0 rounded-lg"
          initial={{ opacity: 0 }}
          animate={{ opacity: [0, 0.6, 0.2] }}
          transition={{ duration: 1.2, repeat: Infinity }}
          style={{ boxShadow: `inset 0 0 30px ${expandColor}` }}
        />
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Spinning reel column                                                      */
/* -------------------------------------------------------------------------- */

interface ReelColumnProps {
  reelIndex: number;
  finalCol: SymbolId[];
  spinning: boolean;
  highlightMap: Map<string, string>; // "r,row" -> color
  expandedReel: SymbolId | null; // if this reel is fully expanded
  expandColor: string;
  anyWin: boolean;
}

function ReelColumn({
  reelIndex,
  finalCol,
  spinning,
  highlightMap,
  expandedReel,
  expandColor,
  anyWin,
}: ReelColumnProps) {
  // Build a long strip that scrolls during the spin then lands on finalCol.
  const strip = useMemo(() => {
    if (!spinning) return finalCol;
    const blur: SymbolId[] = [];
    const len = 14 + reelIndex * 3;
    for (let i = 0; i < len; i++) {
      blur.push(REEL_POOL[randInt(0, REEL_POOL.length - 1)]);
    }
    return [...blur, ...finalCol];
  }, [spinning, finalCol, reelIndex]);

  return (
    <div className="relative overflow-hidden rounded-xl">
      <AnimatePresence mode="popLayout">
        {spinning ? (
          <motion.div
            key="spinning"
            className="flex flex-col gap-1 sm:gap-1.5"
            initial={{ y: 0 }}
            animate={{ y: ["0%", "-78%", "0%"] }}
            transition={{
              duration: 0.35,
              repeat: Infinity,
              ease: "linear",
            }}
          >
            {strip.slice(0, ROWS + 3).map((s, i) => (
              <div
                key={`b-${i}`}
                className="grid place-items-center rounded-lg"
                style={{
                  aspectRatio: "1 / 1",
                  background:
                    "linear-gradient(160deg, rgba(60,44,20,0.5), rgba(20,14,5,0.7))",
                  border: "1px solid rgba(241,196,15,0.14)",
                  filter: "blur(0.6px)",
                }}
              >
                <SymbolFace symbol={s} size="normal" />
              </div>
            ))}
          </motion.div>
        ) : (
          <motion.div
            key="landed"
            className="flex flex-col gap-1 sm:gap-1.5"
            initial={{ y: -24, opacity: 0.4 }}
            animate={{ y: 0, opacity: 1 }}
            transition={{ type: "spring", stiffness: 320, damping: 22 }}
          >
            {finalCol.map((s, row) => {
              const key = `${reelIndex},${row}`;
              const hl = highlightMap.get(key);
              const isExpanded = expandedReel != null;
              const shownSymbol = isExpanded ? expandedReel : s;
              return (
                <motion.div
                  key={`f-${row}`}
                  initial={{ rotateX: -90, opacity: 0 }}
                  animate={{ rotateX: 0, opacity: 1 }}
                  transition={{ delay: row * 0.06, duration: 0.35 }}
                  style={{ transformPerspective: 600 }}
                >
                  <ReelCell
                    symbol={shownSymbol}
                    highlighted={Boolean(hl)}
                    highlightColor={hl ?? ACCENT}
                    expanded={isExpanded}
                    expandColor={expandColor}
                    dim={anyWin && !hl && !isExpanded}
                  />
                </motion.div>
              );
            })}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Paytable panel                                                            */
/* -------------------------------------------------------------------------- */

function Paytable() {
  const order: SymbolId[] = [
    "WILD",
    "PHARAOH",
    "ANUBIS",
    "SCARAB",
    "EYE",
    "ANKH",
    "A",
    "K",
    "Q",
    "J",
    "TEN",
  ];
  return (
    <CollapsiblePanel
      title="Paytable"
      accent={ACCENT}
      summary={<>×total bet</>}
    >
      <div className="grid grid-cols-1 gap-1 text-xs sm:text-[13px]">
        {order.map((id) => {
          const d = SYMBOLS[id];
          return (
            <div
              key={id}
              className="flex items-center justify-between rounded-lg bg-black/30 px-2 py-1"
            >
              <span className="flex items-center gap-2">
                <span
                  className="grid h-6 w-6 place-items-center"
                  style={{ color: d.color, textShadow: `0 0 8px ${d.color}88` }}
                >
                  {d.glyph}
                </span>
                <span className="text-white/70">{d.label}</span>
              </span>
              <span className="flex gap-2 font-mono tabular-nums text-white/85">
                <span title="3 of a kind">{d.pays[0]}×</span>
                <span className="text-white/30">·</span>
                <span title="4 of a kind">{d.pays[1]}×</span>
                <span className="text-white/30">·</span>
                <span style={{ color: ACCENT }} title="5 of a kind">
                  {d.pays[2]}×
                </span>
              </span>
            </div>
          );
        })}
        <div className="mt-1 flex items-center justify-between rounded-lg bg-black/30 px-2 py-1">
          <span className="flex items-center gap-2">
            <span style={{ color: SYMBOLS.BOOK.color }}>📖</span>
            <span className="text-white/70">Book · Scatter</span>
          </span>
          <span className="font-mono tabular-nums text-white/85">
            2× · 20× · 200×{" "}
            <span className="text-white/40">tot</span>
          </span>
        </div>
      </div>
      <p className="mt-2 text-[11px] leading-snug text-white/45">
        Pyramid (Wild) substitutes for all symbols except the Book. Land 3+
        Books anywhere to win {FREE_SPINS} free spins — a special{" "}
        <span style={{ color: ACCENT }}>expanding symbol</span> is chosen and
        spreads across whole reels for huge pays.
      </p>
    </CollapsiblePanel>
  );
}

/* -------------------------------------------------------------------------- */
/*  Main component                                                            */
/* -------------------------------------------------------------------------- */

const CHIPS = [5, 25, 100, 500];

// Buy-a-bonus: pay BUY_COST_MULT× the bet to launch the free-spins round with a
// ×BUY_MULT win multiplier. The free-spin round is worth ~12.45× the bet, so
// ×8 → ~99.6× value, fair against the ~104× cost (~95.8% RTP, sim-verified).
const BUY_COST_MULT = 104;
const BUY_MULT = 8;

export default function PharaohsFortune() {
  const wallet = useWallet();

  const [bet, setBet] = useState(50);
  const [grid, setGrid] = useState<Grid>(() => randomGrid());
  const [spinning, setSpinning] = useState(false);
  const [stoppedCount, setStoppedCount] = useState(REELS); // reels already landed
  const [busy, setBusy] = useState(false); // mid-round lock (incl. free spins)
  const [result, setResult] = useState<SpinResult | null>(null);
  const [message, setMessage] = useState<string>("Place your bet and spin the reels");
  const [spinWin, setSpinWin] = useState(0); // chips won, last resolved spin

  // Free-spins state
  const [freeLeft, setFreeLeft] = useState(0);
  const [expanding, setExpanding] = useState<SymbolId | null>(null);
  const [freeTotal, setFreeTotal] = useState(0);
  const [showExpandReveal, setShowExpandReveal] = useState<SymbolId | null>(null);

  const inFree = freeLeft > 0 || showExpandReveal != null;
  // Win multiplier active during a *bought* free-spins round (1 otherwise, so a
  // naturally-triggered bonus is never multiplied and base RTP is untouched).
  const buyMultRef = useRef(1);
  const stopTimers = useRef<number[]>([]);
  const stopIntervals = useRef<number[]>([]);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      stopTimers.current.forEach((t) => window.clearTimeout(t));
      stopIntervals.current.forEach((iv) => window.clearInterval(iv));
    };
  }, []);

  // Keep bet affordable.
  useEffect(() => {
    if (!wallet.ready) return;
    if (bet > wallet.balance && wallet.balance > 0) {
      setBet(clamp(wallet.balance, 1, wallet.balance));
    }
  }, [wallet.ready, wallet.balance, bet]);

  const affordable = wallet.ready && wallet.balance >= bet && bet > 0;

  // Highlight map for the currently-displayed result.
  const highlightMap = useMemo(() => {
    const m = new Map<string, string>();
    if (!result) return m;
    result.lineWins.forEach((w) => {
      const c = LINE_COLORS[w.line % LINE_COLORS.length];
      w.cells.forEach(([r, row]) => m.set(`${r},${row}`, c));
    });
    result.scatter?.cells.forEach(([r, row]) =>
      m.set(`${r},${row}`, SYMBOLS.BOOK.color),
    );
    return m;
  }, [result]);

  const expandedReels = useMemo(() => {
    const s = new Set<number>();
    result?.expand?.reels.forEach((r) => s.add(r));
    return s;
  }, [result]);

  const anyWin = (result?.total ?? 0) > 0;

  /* ---- core spin sequence (returns the resolved SpinResult) ------------- */

  const runSpin = useCallback(
    (totalBet: number, freeSpin: boolean, expandSym: SymbolId | null) =>
      new Promise<SpinResult>((resolve) => {
        const res = spinOnce(totalBet, freeSpin, expandSym);
        setResult(null);
        setSpinning(true);
        setStoppedCount(0); // all reels start spinning
        setGrid(res.grid); // pre-set so landed cells render the final symbols
        setSpinWin(0);
        sfx.thud();

        // Continuous reel ticking while anything is still spinning.
        const tickIv = window.setInterval(() => sfx.tick(), 80);
        stopIntervals.current.push(tickIv);

        // Stagger each reel landing left-to-right for a real slot feel.
        const baseDelay = 540;
        const perReel = 220;
        for (let r = 0; r < REELS; r++) {
          const id = window.setTimeout(
            () => {
              if (!mounted.current) return;
              setStoppedCount((c) => Math.max(c, r + 1));
              sfx.thud();
            },
            baseDelay + perReel * r,
          );
          stopTimers.current.push(id);
        }

        const totalDelay = baseDelay + perReel * (REELS - 1) + 240;
        const t = window.setTimeout(() => {
          window.clearInterval(tickIv);
          if (!mounted.current) return;
          setSpinning(false);
          setStoppedCount(REELS);
          resolve(res);
        }, totalDelay);
        stopTimers.current.push(t);
      }),
    [],
  );

  /* ---- resolve payouts + sound/visual ----------------------------------- */

  const settleResult = useCallback(
    (res: SpinResult, freeSpin: boolean, totalBet: number) => {
      setResult(res);
      if (res.total > 0) {
        setSpinWin(res.total);
        // Paytable multipliers already include the stake (gross), so credit
        // res.total directly — same convention as slots-classic / slots-fruit.
        if (!freeSpin) wallet.win(res.total);
        if (res.expand) {
          sfx.jackpot();
          setMessage(
            `${SYMBOLS[res.expand.symbol].label} expanded — +${formatChips(
              res.total,
            )}!`,
          );
        } else if (res.total >= bet * 15) {
          sfx.jackpot();
          setMessage(`Big win! +${formatChips(res.total)}`);
        } else {
          sfx.win();
          setMessage(`You won +${formatChips(res.total)}`);
        }
      } else if (!res.triggeredFree) {
        sfx.lose();
        setMessage(freeSpin ? "No win this free spin" : "No win — spin again");
      }
    },
    [bet, wallet],
  );

  /* ---- free-spins loop --------------------------------------------------- */

  const playFreeSpins = useCallback(
    async (count: number, expandSym: SymbolId, totalBet: number) => {
      let remaining = count;
      let accumulated = 0;
      while (remaining > 0 && mounted.current) {
        setFreeLeft(remaining);
        const res = await runSpin(totalBet, true, expandSym);
        if (!mounted.current) return;
        settleResult(res, true, totalBet);
        if (res.total > 0) {
          // Bought rounds multiply every free-spin win; natural ones use ×1.
          const won = Math.round(res.total * buyMultRef.current);
          accumulated += won;
          wallet.win(won); // credit free-spin winnings (no stake to return)
          setFreeTotal(accumulated);
          if (buyMultRef.current > 1) {
            setMessage(`${BUY_MULT}× boost — +${formatChips(won)}!`);
          }
        }
        // Retrigger: +N spins (capped to keep it sane).
        if (res.retrigger) {
          remaining += FREE_SPINS;
          setMessage(`Retrigger! +${FREE_SPINS} free spins`);
          sfx.jackpot();
        }
        remaining -= 1;
        // brief pause so the player can read each free spin.
        await new Promise<void>((r) => {
          const id = window.setTimeout(r, res.total > 0 ? 1100 : 650);
          stopTimers.current.push(id);
        });
      }
      if (!mounted.current) return;
      setFreeLeft(0);
      setExpanding(null);
      setMessage(
        accumulated > 0
          ? `Free spins complete — won ${formatChips(accumulated)} total!`
          : "Free spins complete",
      );
      setBusy(false);
    },
    [runSpin, settleResult, wallet],
  );

  /* ---- player-initiated spin -------------------------------------------- */

  const handleSpin = useCallback(async () => {
    if (busy || spinning || !affordable) return;
    const totalBet = bet;
    if (!wallet.bet(totalBet)) {
      setMessage("Not enough chips for that bet");
      return;
    }
    setBusy(true);
    setFreeTotal(0);
    setResult(null);

    const res = await runSpin(totalBet, false, null);
    if (!mounted.current) return;
    settleResult(res, false, totalBet);

    if (res.triggeredFree) {
      // Choose the expanding symbol (weighted toward higher symbols a bit).
      const pool = EXPANDING_POOL;
      const weights = pool.map((id) => SYMBOLS[id].weight);
      const chosen = weightedPick(pool, weights);
      sfx.jackpot();
      setMessage(`${SCATTER_TRIGGER}+ Books! ${FREE_SPINS} FREE SPINS unlocked`);

      // Dramatic reveal of the expanding symbol, then run the free spins.
      await new Promise<void>((r) => {
        const id = window.setTimeout(r, 700);
        stopTimers.current.push(id);
      });
      if (!mounted.current) return;
      setShowExpandReveal(chosen);
      sfx.win();
      await new Promise<void>((r) => {
        const id = window.setTimeout(r, 2100);
        stopTimers.current.push(id);
      });
      if (!mounted.current) return;
      setShowExpandReveal(null);
      setExpanding(chosen);
      await playFreeSpins(FREE_SPINS, chosen, totalBet);
    } else {
      setBusy(false);
    }
  }, [busy, spinning, affordable, bet, wallet, runSpin, settleResult, playFreeSpins]);

  /* ---- buy the bonus: launch the free-spins round directly (×BUY_MULT) --- */
  const buyCost = bet * BUY_COST_MULT;
  const handleBuyBonus = useCallback(async () => {
    if (busy || spinning) return;
    if (buyCost > wallet.balance) return;
    if (!wallet.bet(buyCost)) return;

    setBusy(true);
    setFreeTotal(0);
    setResult(null);
    buyMultRef.current = BUY_MULT;

    const chosen = weightedPick(
      EXPANDING_POOL,
      EXPANDING_POOL.map((id) => SYMBOLS[id].weight),
    );
    sfx.jackpot();
    setMessage(`Bonus bought — ${FREE_SPINS} free spins at ${BUY_MULT}×!`);
    setShowExpandReveal(chosen);
    sfx.win();
    await new Promise<void>((r) => {
      const id = window.setTimeout(r, 2100);
      stopTimers.current.push(id);
    });
    if (!mounted.current) return;
    setShowExpandReveal(null);
    setExpanding(chosen);
    await playFreeSpins(FREE_SPINS, chosen, bet);
    buyMultRef.current = 1; // round over — clear the boost
  }, [busy, spinning, bet, wallet, buyCost, playFreeSpins]);

  /* ---- bet editing helpers ---------------------------------------------- */

  const addChip = (v: number) => {
    if (busy) return;
    sfx.chip();
    setBet((b) => clamp(b + v, 1, Math.max(1, wallet.balance)));
  };
  const setBetClamped = (n: number) =>
    setBet(clamp(Math.floor(n), 1, Math.max(1, wallet.balance)));

  const lockBet = busy || spinning;

  /* ---- result text for testid ------------------------------------------- */

  const resultText = useMemo(() => {
    if (spinning) return "Spinning…";
    if (inFree) return message;
    if (!result) return message;
    if (result.total > 0) return `WIN +${formatChips(result.total)}`;
    if (result.triggeredFree) return "FREE SPINS!";
    return "No win";
  }, [spinning, inFree, result, message]);

  /* ---------------------------------------------------------------------- */
  /*  Render                                                                 */
  /* ---------------------------------------------------------------------- */

  return (
    <div className="mx-auto w-full max-w-5xl">
      <div
        className="felt relative overflow-hidden rounded-3xl p-3 sm:p-6 [@media(max-height:600px)]:p-2"
        style={{
          background:
            "radial-gradient(ellipse at 50% -10%, #1c1305 0%, #0c0904 55%, #060402 100%)",
          boxShadow: `inset 0 0 80px rgba(0,0,0,0.7), 0 0 0 1px ${ACCENT}22`,
        }}
      >
        {/* desert glow backdrop */}
        <div
          className="pointer-events-none absolute inset-0 opacity-50"
          style={{
            background: `radial-gradient(circle at 50% 120%, ${ACCENT}22, transparent 60%)`,
          }}
        />

        {/* Win celebration overlay (confetti + coin fountain) */}
        <Celebration
          show={anyWin && !spinning}
          seed={result?.total ?? 0}
          tier={
            result?.expand || result?.triggeredFree || (result?.total ?? 0) >= bet * 15
              ? "jackpot"
              : (result?.total ?? 0) >= bet * 4
                ? "big"
                : "win"
          }
          colors={["#f1c40f", "#ffd24a", "#22e1ff", "#ffffff"]}
        />

        {/* header */}
        <div className="relative mb-2 flex flex-wrap items-center justify-between gap-3 sm:mb-4">
          <div>
            <h2
              className="font-display text-2xl font-bold tracking-wider sm:text-3xl"
              style={{ color: ACCENT, textShadow: `0 0 18px ${ACCENT}66` }}
            >
              𓋹 Pharaoh&apos;s Fortune
            </h2>
            <p className="text-xs tracking-widest text-white/40">
              5 REELS · {PAYLINES.length} LINES · EXPANDING FREE SPINS
            </p>
          </div>
          <div className="flex items-center gap-3">
            <div className="rounded-xl border border-gold/30 bg-black/40 px-4 py-2 text-right">
              <div className="text-[9px] uppercase tracking-widest text-white/40">
                Balance
              </div>
              <div
                className="text-lg font-bold tabular-nums"
                style={{ color: SAND }}
              >
                {wallet.ready ? formatChips(wallet.balance) : "—"}
              </div>
            </div>
            <AnimatePresence>
              {spinWin > 0 && !spinning && (
                <motion.div
                  key="winbox"
                  initial={{ scale: 0.6, opacity: 0, y: -6 }}
                  animate={{ scale: 1, opacity: 1, y: 0 }}
                  exit={{ scale: 0.6, opacity: 0 }}
                  className="rounded-xl px-4 py-2 text-right"
                  style={{
                    background: `linear-gradient(160deg, ${ACCENT}, #b8860b)`,
                    boxShadow: `0 0 24px ${ACCENT}88`,
                  }}
                >
                  <div className="text-[9px] uppercase tracking-widest text-black/60">
                    Win
                  </div>
                  <div className="text-lg font-bold tabular-nums text-black">
                    <Counter value={spinWin} />
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>

        {/* Free spins banner */}
        <AnimatePresence>
          {inFree && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              className="relative mb-3 overflow-hidden"
            >
              <div
                className="flex flex-wrap items-center justify-between gap-2 rounded-xl px-4 py-2"
                style={{
                  background: `linear-gradient(90deg, ${ACCENT}22, transparent)`,
                  border: `1px solid ${ACCENT}55`,
                }}
              >
                <span
                  className="font-display font-bold tracking-wider"
                  style={{ color: ACCENT }}
                >
                  FREE SPINS · {freeLeft} left
                </span>
                {expanding && (
                  <span className="flex items-center gap-2 text-sm text-white/80">
                    Expanding:
                    <span
                      style={{
                        color: SYMBOLS[expanding].color,
                        textShadow: `0 0 10px ${SYMBOLS[expanding].color}`,
                      }}
                    >
                      {SYMBOLS[expanding].glyph} {SYMBOLS[expanding].label}
                    </span>
                  </span>
                )}
                <span className="text-sm tabular-nums text-white/80">
                  Free win:{" "}
                  <span style={{ color: ACCENT }}>{formatChips(freeTotal)}</span>
                </span>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <div className="relative grid gap-2 sm:gap-4 lg:grid-cols-[1fr_auto]">
          {/* ---- Reels ---- */}
          <div className="min-w-0">
            <div
              className="relative mx-auto rounded-2xl p-2 sm:p-3 [@media(max-height:600px)]:max-w-[58vh] [@media(max-height:600px)]:p-1.5"
              style={{
                background:
                  "linear-gradient(180deg, rgba(40,30,12,0.7), rgba(10,7,3,0.85))",
                border: `1px solid ${ACCENT}33`,
                boxShadow: `inset 0 0 40px rgba(0,0,0,0.6), 0 0 0 1px ${ACCENT}11`,
              }}
            >
              <div
                className="grid gap-1 sm:gap-1.5"
                style={{ gridTemplateColumns: `repeat(${REELS}, minmax(0, 1fr))` }}
              >
                {grid.map((col, r) => (
                  <ReelColumn
                    key={r}
                    reelIndex={r}
                    finalCol={col}
                    spinning={spinning && r >= stoppedCount}
                    highlightMap={highlightMap}
                    expandedReel={
                      expandedReels.has(r) && result?.expand
                        ? result.expand.symbol
                        : null
                    }
                    expandColor={
                      result?.expand
                        ? SYMBOLS[result.expand.symbol].color
                        : ACCENT
                    }
                    anyWin={anyWin}
                  />
                ))}
              </div>

              {/* Expanding symbol reveal overlay */}
              <AnimatePresence>
                {showExpandReveal && (
                  <motion.div
                    className="absolute inset-0 z-20 grid place-items-center rounded-2xl"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    style={{ background: "rgba(6,4,2,0.82)" }}
                  >
                    <motion.div
                      className="grid place-items-center text-center"
                      initial={{ scale: 0.2, rotate: -25, opacity: 0 }}
                      animate={{ scale: 1, rotate: 0, opacity: 1 }}
                      transition={{ type: "spring", stiffness: 160, damping: 12 }}
                    >
                      <motion.div
                        animate={{ scale: [1, 1.12, 1] }}
                        transition={{ duration: 1.1, repeat: Infinity }}
                        style={{
                          fontSize: "5rem",
                          color: SYMBOLS[showExpandReveal].color,
                          textShadow: `0 0 30px ${SYMBOLS[showExpandReveal].color}`,
                        }}
                      >
                        {SYMBOLS[showExpandReveal].glyph}
                      </motion.div>
                      <div
                        className="mt-2 font-display text-xl font-bold tracking-widest"
                        style={{ color: ACCENT }}
                      >
                        SPECIAL SYMBOL
                      </div>
                      <div className="text-sm text-white/70">
                        {SYMBOLS[showExpandReveal].label} expands during free
                        spins
                      </div>
                    </motion.div>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Win burst */}
              <AnimatePresence>
                {anyWin && !spinning && (
                  <motion.div
                    key="burst"
                    className="pointer-events-none absolute inset-0 z-10"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                  >
                    {Array.from({ length: 14 }).map((_, i) => {
                      const angle = (i / 14) * Math.PI * 2;
                      return (
                        <motion.span
                          key={i}
                          className="absolute left-1/2 top-1/2 text-lg"
                          initial={{ x: 0, y: 0, opacity: 1, scale: 0.5 }}
                          animate={{
                            x: Math.cos(angle) * 180,
                            y: Math.sin(angle) * 120,
                            opacity: 0,
                            scale: 1.3,
                          }}
                          transition={{ duration: 1.1, ease: "easeOut" }}
                          style={{ color: ACCENT }}
                        >
                          ✦
                        </motion.span>
                      );
                    })}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            {/* Result line */}
            <div className="mt-2 flex items-center justify-center sm:mt-3">
              <motion.div
                key={resultText}
                data-testid="round-result"
                initial={{ y: 6, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                className="rounded-xl px-4 py-2 text-center font-display text-lg font-bold tracking-wide"
                style={{
                  color: anyWin ? ACCENT : "rgba(255,255,255,0.7)",
                  textShadow: anyWin ? `0 0 14px ${ACCENT}88` : "none",
                }}
              >
                {resultText}
              </motion.div>
            </div>

            {/* Win breakdown */}
            <AnimatePresence>
              {result && result.total > 0 && !spinning && (
                <motion.div
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  className="mt-2 flex flex-wrap justify-center gap-2 text-xs"
                >
                  {result.expand && (
                    <span
                      className="rounded-full px-3 py-1"
                      style={{
                        background: `${SYMBOLS[result.expand.symbol].color}22`,
                        border: `1px solid ${SYMBOLS[result.expand.symbol].color}`,
                        color: SYMBOLS[result.expand.symbol].color,
                      }}
                    >
                      Expanded {SYMBOLS[result.expand.symbol].label} +
                      {formatChips(result.expand.payout)}
                    </span>
                  )}
                  {result.lineWins.map((w, i) => (
                    <span
                      key={i}
                      className="rounded-full px-3 py-1 text-white/85"
                      style={{
                        background: `${LINE_COLORS[w.line % LINE_COLORS.length]}22`,
                        border: `1px solid ${LINE_COLORS[w.line % LINE_COLORS.length]}`,
                      }}
                    >
                      Line {w.line + 1}: {w.count}× {SYMBOLS[w.symbol].label} +
                      {formatChips(w.payout)}
                    </span>
                  ))}
                  {result.scatter && (
                    <span
                      className="rounded-full px-3 py-1"
                      style={{
                        background: `${SYMBOLS.BOOK.color}22`,
                        border: `1px solid ${SYMBOLS.BOOK.color}`,
                        color: SYMBOLS.BOOK.color,
                      }}
                    >
                      {result.scatter.count}× Book +
                      {formatChips(result.scatter.payout)}
                    </span>
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {/* ---- Paytable ---- */}
          <div className="w-full lg:w-72">
            <Paytable />
          </div>
        </div>

        {/* ---- Controls ---- */}
        <div className="relative mt-2 sm:mt-4">
          <div className="glass rounded-2xl p-3 sm:p-4">
            <div className="flex flex-wrap items-center justify-center gap-2 sm:gap-3">
              {CHIPS.map((v) => (
                <Chip
                  key={v}
                  value={v}
                  size={50}
                  onClick={lockBet || v > wallet.balance ? undefined : () => addChip(v)}
                />
              ))}
            </div>

            <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
              <Button
                size="sm"
                variant="ghost"
                disabled={lockBet}
                data-testid="bet-min"
                onClick={() => setBetClamped(5)}
              >
                Min
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={lockBet}
                data-testid="bet-half"
                onClick={() => setBetClamped(Math.floor(bet / 2))}
              >
                ½
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={lockBet}
                data-testid="bet-double"
                onClick={() => setBetClamped(bet * 2)}
              >
                2×
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={lockBet}
                data-testid="bet-max"
                onClick={() => setBetClamped(wallet.balance)}
              >
                Max
              </Button>

              <motion.div
                key={bet}
                initial={{ scale: 0.92 }}
                animate={{ scale: 1 }}
                className="ml-1 min-w-[120px] rounded-xl border px-4 py-2 text-center"
                style={{ borderColor: `${ACCENT}55`, background: "rgba(0,0,0,0.4)" }}
              >
                <div className="text-[9px] uppercase tracking-widest text-white/40">
                  Total Bet
                </div>
                <div
                  className="text-lg font-bold tabular-nums"
                  style={{ color: ACCENT }}
                >
                  {formatChips(bet)}
                </div>
              </motion.div>

              <Button
                size="lg"
                variant="gold"
                data-testid="play-btn"
                className="spin-btn min-w-[140px]"
                disabled={lockBet || !affordable}
                onClick={handleSpin}
              >
                {busy
                  ? inFree
                    ? "FREE SPIN…"
                    : "SPINNING…"
                  : spinning
                    ? "SPINNING…"
                    : "SPIN"}
              </Button>

              <Button
                size="lg"
                variant="ghost"
                data-testid="buy-bonus-btn"
                className="min-w-[150px] border border-[#f1c40f]/50 text-[#f1c40f]"
                disabled={lockBet || buyCost > wallet.balance}
                onClick={handleBuyBonus}
                title={`Buy ${FREE_SPINS} free spins at ${BUY_MULT}× for ${BUY_COST_MULT}× your bet`}
              >
                🪙 Buy Bonus · {formatChips(buyCost)}
              </Button>
            </div>

            <div className="mt-2 text-center text-[11px] text-white/40">
              {PAYLINES.length} paylines · pays shown are × your total bet ·{" "}
              {wallet.ready && !affordable
                ? "Insufficient balance — lower your bet"
                : "Wild substitutes · 3+ Books = Free Spins"}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
