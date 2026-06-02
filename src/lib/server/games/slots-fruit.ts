import { type GameSpec, assert } from "../engine";
import type { Rng } from "../rngCore";

// Server-authoritative Fruit Frenzy — mirrors src/games/slots-fruit.tsx.
//   5×3, 10 fixed paylines, wild (STAR) substitution, SCATTER free spins.
//   3+ scatters award 8 free spins; 3+ during free spins RETRIGGER (+8). The
//   whole thing (base + every natural free spin) resolves in ONE call and the
//   client animates the returned sequence. RTP ~96.97% (≈3% edge, sim-verified).
//   Buy-bonus (×10 super spins) stays a guest-only demo for now.

type SymKey = "CHERRY" | "LEMON" | "ORANGE" | "PLUM" | "GRAPE" | "MELON" | "BELL" | "STAR" | "SCATTER";

interface SymDef { key: SymKey; weight: number; pay: [number, number, number]; wild?: boolean; scatter?: boolean }

const SYMBOLS: Record<SymKey, SymDef> = {
  CHERRY: { key: "CHERRY", weight: 26, pay: [0.8, 2.5, 8] },
  LEMON: { key: "LEMON", weight: 24, pay: [0.8, 2.7, 9] },
  ORANGE: { key: "ORANGE", weight: 22, pay: [1.1, 3.3, 12] },
  PLUM: { key: "PLUM", weight: 20, pay: [1.6, 4.8, 16] },
  GRAPE: { key: "GRAPE", weight: 18, pay: [2.3, 6.5, 23] },
  MELON: { key: "MELON", weight: 14, pay: [3, 10, 40] },
  BELL: { key: "BELL", weight: 10, pay: [6, 23, 98] },
  STAR: { key: "STAR", weight: 6, pay: [12, 46, 190], wild: true },
  SCATTER: { key: "SCATTER", weight: 5, pay: [0, 0, 0], scatter: true },
};
const SYM_KEYS = Object.keys(SYMBOLS) as SymKey[];

const REELS = 5;
const ROWS = 3;
const LINES = 10;
const FREE_SPINS_AWARD = 8;
const SCATTERS_FOR_FREE = 3;
const MAX_FREE_SPINS = 80; // boundedness cap on retrigger chains

const PAYLINES: number[][] = [
  [1, 1, 1, 1, 1], [0, 0, 0, 0, 0], [2, 2, 2, 2, 2], [0, 1, 2, 1, 0], [2, 1, 0, 1, 2],
  [1, 0, 0, 0, 1], [1, 2, 2, 2, 1], [0, 0, 1, 2, 2], [2, 2, 1, 0, 0], [1, 0, 1, 2, 1],
];

// Wild slightly rarer on the outer reels (matches the client's per-reel strips).
function reelWeights(reelIndex: number): number[] {
  return SYM_KEYS.map((k) => {
    const def = SYMBOLS[k];
    let w = def.weight;
    if (def.wild && (reelIndex === 0 || reelIndex === REELS - 1)) w *= 0.6;
    return w;
  });
}
const REEL_WEIGHTS = Array.from({ length: REELS }, (_, r) => reelWeights(r));

type Grid = SymKey[][]; // grid[reel][row]

function spinGrid(rng: Rng): Grid {
  return Array.from({ length: REELS }, (_, r) =>
    Array.from({ length: ROWS }, () => rng.weighted(SYM_KEYS, REEL_WEIGHTS[r])),
  );
}

interface LineWin { line: number; symbol: SymKey; count: number; multiplier: number; cells: { reel: number; row: number }[] }
interface SpinEval { grid: Grid; lineWins: LineWin[]; scatterCount: number; totalMultiplier: number }

function evaluateSpin(grid: Grid): SpinEval {
  const lineWins: LineWin[] = [];
  let totalMultiplier = 0;

  for (let li = 0; li < LINES; li++) {
    const pattern = PAYLINES[li];
    const lineSyms: SymKey[] = pattern.map((row, reel) => grid[reel]?.[row] ?? "CHERRY");

    let base: SymKey | null = null;
    for (const s of lineSyms) {
      if (s === "SCATTER") break;
      if (s !== "STAR") { base = s; break; }
    }
    if (base === null) {
      if (lineSyms[0] === "STAR") base = "STAR";
      else continue;
    }

    let count = 0;
    const cells: { reel: number; row: number }[] = [];
    for (let reel = 0; reel < REELS; reel++) {
      const s = lineSyms[reel];
      if (s === base || s === "STAR") {
        count++;
        cells.push({ reel, row: pattern[reel] ?? 0 });
      } else break;
    }

    if (count >= 3) {
      const mult = SYMBOLS[base].pay[count - 3] ?? 0;
      if (mult > 0) {
        lineWins.push({ line: li, symbol: base, count, multiplier: mult, cells: cells.slice(0, count) });
        totalMultiplier += mult;
      }
    }
  }

  let scatterCount = 0;
  for (let reel = 0; reel < REELS; reel++) for (let row = 0; row < ROWS; row++) if (grid[reel]?.[row] === "SCATTER") scatterCount++;

  return { grid, lineWins, scatterCount, totalMultiplier };
}

export const slotsFruitSpec: GameSpec<Record<string, never>> = {
  slug: "slots-fruit",
  minBet: 5,
  maxBet: 1_000_000,
  validate: (params) => {
    assert(params === undefined || params === null || typeof params === "object", "Invalid params");
    return {};
  },
  resolve: (bet, _params, rng) => {
    const base = evaluateSpin(spinGrid(rng));
    let total = bet * base.totalMultiplier;

    // Natural free spins (no extra stake) resolved inline, with retriggers.
    let freeLeft = base.scatterCount >= SCATTERS_FOR_FREE ? FREE_SPINS_AWARD : 0;
    const freeSpinsAwarded = freeLeft;
    const freeSpins: SpinEval[] = [];
    let played = 0;
    while (freeLeft > 0 && played < MAX_FREE_SPINS) {
      freeLeft--;
      played++;
      const fs = evaluateSpin(spinGrid(rng));
      total += bet * fs.totalMultiplier;
      if (fs.scatterCount >= SCATTERS_FOR_FREE) freeLeft += FREE_SPINS_AWARD;
      freeSpins.push(fs);
    }

    return {
      payout: Math.round(total * 100) / 100,
      outcome: {
        base,
        freeSpins,
        freeSpinsAwarded,
        freeSpinsPlayed: played,
        totalWin: Math.round(total * 100) / 100,
      },
    };
  },
};
