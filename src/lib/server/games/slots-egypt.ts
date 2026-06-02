import { type GameSpec, assert } from "../engine";
import type { Rng } from "../rngCore";

// Server-authoritative Pharaoh's Fortune — mirrors src/games/slots-egypt.tsx.
//   5x3, 10 paylines, WILD substitution, BOOK scatter. 3+ Books award 10 free
//   spins with a random EXPANDING symbol (Book-of-Ra style); 3+ Books retrigger.
//   Base + every free spin resolve inline in one /api/play call; the client
//   animates the returned sequence. RTP ~96.8% (≈3.2% edge, sim-verified).
//   Buy-bonus (×N super spins) stays a guest-only demo for now.

type SymbolId = "PHARAOH" | "ANUBIS" | "SCARAB" | "EYE" | "ANKH" | "WILD" | "BOOK" | "A" | "K" | "Q" | "J" | "TEN";

interface SymbolDef { id: SymbolId; weight: number; pays: [number, number, number] }
const SYMBOLS: Record<SymbolId, SymbolDef> = {
  PHARAOH: { id: "PHARAOH", weight: 4, pays: [11, 80, 528] },
  ANUBIS: { id: "ANUBIS", weight: 5, pays: [8, 48, 317] },
  SCARAB: { id: "SCARAB", weight: 6, pays: [7, 32, 212] },
  EYE: { id: "EYE", weight: 7, pays: [5, 21, 132] },
  ANKH: { id: "ANKH", weight: 8, pays: [4, 16, 92] },
  A: { id: "A", weight: 11, pays: [2.6, 8, 48] },
  K: { id: "K", weight: 12, pays: [2.1, 7, 37] },
  Q: { id: "Q", weight: 13, pays: [1.6, 5.2, 26] },
  J: { id: "J", weight: 14, pays: [1.4, 4, 21] },
  TEN: { id: "TEN", weight: 15, pays: [1.1, 3.2, 16] },
  WILD: { id: "WILD", weight: 3, pays: [13, 106, 793] },
  BOOK: { id: "BOOK", weight: 3, pays: [0, 0, 0] },
};
const SCATTER_PAYS: Record<number, number> = { 3: 2, 4: 20, 5: 200 };
const EXPANDING_POOL: SymbolId[] = ["PHARAOH", "ANUBIS", "SCARAB", "EYE", "ANKH"];
const REEL_POOL: SymbolId[] = Object.values(SYMBOLS).flatMap((s) => Array<SymbolId>(s.weight).fill(s.id));

const REELS = 5;
const ROWS = 3;
const FREE_SPINS = 10;
const SCATTER_TRIGGER = 3;
const MAX_FREE_SPINS = 80; // boundedness cap on retrigger chains

const PAYLINES: number[][] = [
  [1, 1, 1, 1, 1], [0, 0, 0, 0, 0], [2, 2, 2, 2, 2], [0, 1, 2, 1, 0], [2, 1, 0, 1, 2],
  [0, 0, 1, 2, 2], [2, 2, 1, 0, 0], [1, 0, 1, 2, 1], [1, 2, 1, 0, 1], [0, 1, 1, 1, 0],
];

type Grid = SymbolId[][];

function randomGrid(rng: Rng): Grid {
  const grid: Grid = [];
  for (let r = 0; r < REELS; r++) {
    const col: SymbolId[] = [];
    const bag = rng.shuffle(REEL_POOL);
    let bi = 0;
    const seen = new Set<SymbolId>();
    for (let row = 0; row < ROWS; row++) {
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

function matches(s: SymbolId, target: SymbolId): boolean {
  if (s === target) return true;
  if (target === "BOOK") return false;
  return s === "WILD";
}

interface LineWin { line: number; symbol: SymbolId; count: number; cells: [number, number][]; payout: number }
interface ScatterWin { count: number; cells: [number, number][]; payout: number }
interface ExpandWin { symbol: SymbolId; reels: number[]; payout: number }
interface SpinResult { grid: Grid; lineWins: LineWin[]; scatter: ScatterWin | null; expand: ExpandWin | null; triggeredFree: boolean; retrigger: boolean; total: number }

function evaluateLines(grid: Grid, totalBet: number): LineWin[] {
  const wins: LineWin[] = [];
  PAYLINES.forEach((line, lineIdx) => {
    const first = grid[0][line[0]];
    let lead: SymbolId = first;
    if (first === "WILD") {
      for (let r = 1; r < REELS; r++) {
        const s = grid[r][line[r]];
        if (s !== "WILD" && s !== "BOOK") { lead = s; break; }
      }
    }
    if (lead === "BOOK") return;
    const cells: [number, number][] = [];
    let count = 0;
    for (let r = 0; r < REELS; r++) {
      const s = grid[r][line[r]];
      if (matches(s, lead)) { count++; cells.push([r, line[r]]); }
      else break;
    }
    if (count >= 3) {
      const mult = SYMBOLS[lead].pays[count - 3];
      if (mult > 0) wins.push({ line: lineIdx, symbol: lead, count, cells, payout: mult * totalBet });
    }
  });
  return wins;
}

function evaluateScatter(grid: Grid, totalBet: number): ScatterWin | null {
  const cells: [number, number][] = [];
  for (let r = 0; r < REELS; r++) for (let row = 0; row < ROWS; row++) if (grid[r][row] === "BOOK") cells.push([r, row]);
  if (cells.length < SCATTER_TRIGGER) return null;
  const mult = SCATTER_PAYS[Math.min(5, cells.length)] ?? 0;
  return { count: cells.length, cells, payout: mult * totalBet };
}

function evaluateExpand(grid: Grid, expanding: SymbolId, totalBet: number): ExpandWin | null {
  let run = 0;
  for (let r = 0; r < REELS; r++) {
    if (grid[r].some((s) => s === expanding || s === "WILD")) run++;
    else break;
  }
  if (run < 3) return null;
  const mult = SYMBOLS[expanding].pays[run - 3];
  if (mult <= 0) return null;
  const reels: number[] = [];
  for (let r = 0; r < run; r++) reels.push(r);
  return { symbol: expanding, reels, payout: mult * totalBet };
}

function spinOnce(rng: Rng, totalBet: number, freeSpin: boolean, expanding: SymbolId | null): SpinResult {
  const grid = randomGrid(rng);
  const scatter = evaluateScatter(grid, totalBet);
  const triggeredFree = !freeSpin && (scatter?.count ?? 0) >= SCATTER_TRIGGER;
  const retrigger = freeSpin && (scatter?.count ?? 0) >= SCATTER_TRIGGER;

  let lineWins: LineWin[] = [];
  let expand: ExpandWin | null = null;
  if (freeSpin && expanding) {
    expand = evaluateExpand(grid, expanding, totalBet);
    if (!expand) lineWins = evaluateLines(grid, totalBet);
    else lineWins = evaluateLines(grid, totalBet).filter((w) => w.symbol !== expanding);
  } else {
    lineWins = evaluateLines(grid, totalBet);
  }

  const total = lineWins.reduce((s, w) => s + w.payout, 0) + (scatter?.payout ?? 0) + (expand?.payout ?? 0);
  return { grid, lineWins, scatter, expand, triggeredFree, retrigger, total };
}

export const slotsEgyptSpec: GameSpec<Record<string, never>> = {
  slug: "slots-egypt",
  minBet: 5,
  maxBet: 1_000_000,
  validate: (params) => {
    assert(params === undefined || params === null || typeof params === "object", "Invalid params");
    return {};
  },
  resolve: (bet, _params, rng) => {
    const base = spinOnce(rng, bet, false, null);
    let total = base.total;

    let expanding: SymbolId | null = null;
    const freeSpins: SpinResult[] = [];
    let freeSpinsAwarded = 0;
    let played = 0;

    if (base.triggeredFree) {
      expanding = rng.pick(EXPANDING_POOL);
      freeSpinsAwarded = FREE_SPINS;
      let remaining = FREE_SPINS;
      while (remaining > 0 && played < MAX_FREE_SPINS) {
        const fs = spinOnce(rng, bet, true, expanding);
        total += fs.total;
        if (fs.retrigger) remaining += FREE_SPINS;
        remaining -= 1;
        played += 1;
        freeSpins.push(fs);
      }
    }

    return {
      payout: Math.round(total * 100) / 100,
      outcome: { base, freeSpins, expanding, freeSpinsAwarded, freeSpinsPlayed: played, totalWin: Math.round(total * 100) / 100 },
    };
  },
};
