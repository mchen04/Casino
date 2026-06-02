import { type GameSpec, assert } from "../engine";
import type { Rng } from "../rngCore";

// ===========================================================================
// TIANNA'S TREASURY — the flagship. A 6-reel Megaways-style cascading slot,
// built server-authoritative from the ground up. The ENTIRE spin (initial grid
// + every tumble + free-spin round + the Vault burst) is computed in one call
// with the crypto RNG and returned as a step sequence the client animates. The
// client cannot influence any outcome.
//
// Signature mechanics (the "insane" loop):
//   * Variable Megaways — each of 6 reels shows 2-7 symbols → up to 117,649 ways.
//   * Cascading tumbles — winning symbols explode, new ones fall, ways recompute.
//   * Rising multiplier meter — every successive tumble bumps the multiplier
//     (1,2,3,5,8,13,... Fibonacci-feel, capped) so chains "feel uncapped".
//   * Tianna's "T" wild — substitutes for any pay symbol; lands only on the
//     middle reels for that signature clone-burst tension.
//   * Tianna's Vault — 4+ VAULT scatters trigger free spins whose multiplier
//     NEVER resets between spins (the "cashouts you can't make sense of" meter).
//
// House edge is documented + tuned by Monte-Carlo (PAY_SCALE), not by anything
// the client sends. Everything is bounded: cascades and free spins are capped.
// ===========================================================================

const REELS = 6;
const MIN_BET = 5;

// Reel heights are drawn from this weighted set (favouring 3-5, with rare 6/7
// for the big-ways moments). Index = height 2..7.
const HEIGHT_WEIGHTS = [0, 0, 3, 6, 6, 4, 2, 1]; // heights 2..7 at indices 2..7

type Sym =
  | "T" // wild
  | "CROWN"
  | "GEM"
  | "RING"
  | "STAR"
  | "HEART"
  | "A"
  | "K"
  | "Q"
  | "VAULT"; // scatter

const PAY_SYMBOLS: Sym[] = ["CROWN", "GEM", "RING", "STAR", "HEART", "A", "K", "Q"];

// Per-cell draw weights. T (wild) + VAULT (scatter) are rare; low symbols common.
const SYMBOL_WEIGHTS: Record<Sym, number> = {
  CROWN: 5, GEM: 6, RING: 7, STAR: 10, HEART: 11, A: 14, K: 15, Q: 16,
  T: 4, VAULT: 3,
};

// Pay (per WAY) for a win spanning 3/4/5/6 reels, as a fraction of the bet.
// Tuned globally by PAY_SCALE so the measured RTP lands at ~95% (Monte-Carlo).
const PAY3: Record<string, number> = {
  CROWN: 0.5, GEM: 0.4, RING: 0.3, STAR: 0.2, HEART: 0.16, A: 0.1, K: 0.08, Q: 0.06,
};
const LEN_BONUS: Record<number, number> = { 3: 1, 4: 3, 5: 9, 6: 25 };
const PAY_SCALE = 0.0334; // global RTP knob (MC-tuned to ~94-95% RTP / ~5-6% edge)

// Rising multiplier meter per successive tumble (Fibonacci-feel), capped.
const MULT_LADDER = [1, 2, 3, 5, 8, 13, 21, 34, 55, 88];
const MAX_CASCADES = 24;

// Vault free spins: 4/5/6 scatters award this many spins; the multiplier meter
// carries across the whole round (never resets) for the signature crescendo.
const FREE_SPINS: Record<number, number> = { 4: 8, 5: 12, 6: 20 };
// Scatter cash pay (fraction of bet) for 3/4/5/6 scatters anywhere.
const SCATTER_PAY: Record<number, number> = { 3: 1, 4: 2, 5: 10, 6: 50 };

interface WayWin {
  symbol: Sym;
  length: number; // reels 1..length
  ways: number;
  /** Winning cell coords [reel, row] across the contributing reels. */
  cells: [number, number][];
  /** Raw pay before the tumble multiplier, in bet units. */
  base: number;
}

interface TumbleStep {
  /** The grid BEFORE this tumble's wins are removed (reels of symbol rows). */
  grid: Sym[][];
  wins: WayWin[];
  multiplier: number;
  /** Win credited this step (bet units × multiplier). */
  win: number;
}

interface SpinResult {
  steps: TumbleStep[];
  win: number; // total bet-unit win for this spin (incl. multiplier)
  endMultiplier: number;
}

function drawCell(rng: Rng, reel: number): Sym {
  // T wild lands only on the middle reels (1..4) — its signature placement.
  const syms = Object.keys(SYMBOL_WEIGHTS) as Sym[];
  const weights = syms.map((s) => {
    if (s === "T" && (reel === 0 || reel === REELS - 1)) return 0;
    return SYMBOL_WEIGHTS[s];
  });
  return rng.weighted(syms, weights);
}

function buildGrid(rng: Rng): Sym[][] {
  const grid: Sym[][] = [];
  for (let r = 0; r < REELS; r++) {
    const height = rng.weighted(
      [2, 3, 4, 5, 6, 7],
      [HEIGHT_WEIGHTS[2], HEIGHT_WEIGHTS[3], HEIGHT_WEIGHTS[4], HEIGHT_WEIGHTS[5], HEIGHT_WEIGHTS[6], HEIGHT_WEIGHTS[7]],
    );
    const reel: Sym[] = [];
    for (let h = 0; h < height; h++) reel.push(drawCell(rng, r));
    grid.push(reel);
  }
  return grid;
}

/** Count of a symbol (incl. wilds) on a reel, plus the matching row indices. */
function matchRows(reel: Sym[], symbol: Sym): number[] {
  const rows: number[] = [];
  for (let i = 0; i < reel.length; i++) {
    if (reel[i] === symbol || reel[i] === "T") rows.push(i);
  }
  return rows;
}

/** Evaluate all leftmost-consecutive Megaways way-wins on a grid. */
function evalWays(grid: Sym[][], bet: number): WayWin[] {
  const wins: WayWin[] = [];
  for (const symbol of PAY_SYMBOLS) {
    let ways = 1;
    let length = 0;
    const cells: [number, number][] = [];
    for (let r = 0; r < REELS; r++) {
      const rows = matchRows(grid[r], symbol);
      if (rows.length === 0) break;
      ways *= rows.length;
      length = r + 1;
      for (const row of rows) cells.push([r, row]);
    }
    if (length >= 3) {
      const base = (PAY3[symbol] ?? 0) * LEN_BONUS[Math.min(length, 6)] * ways * PAY_SCALE * bet;
      if (base > 0) {
        // Trim recorded cells to the contributing reels only.
        const used = cells.filter(([r]) => r < length);
        wins.push({ symbol, length, ways, cells: used, base });
      }
    }
  }
  return wins;
}

/** Remove winning cells and tumble: survivors fall down, new symbols fill top. */
function tumble(grid: Sym[][], wins: WayWin[], rng: Rng): Sym[][] {
  const remove: Set<string>[] = grid.map(() => new Set<string>());
  for (const w of wins) for (const [r, row] of w.cells) remove[r].add(String(row));
  const next: Sym[][] = [];
  for (let r = 0; r < REELS; r++) {
    const survivors = grid[r].filter((_, i) => !remove[r].has(String(i)));
    const need = grid[r].length - survivors.length;
    const fresh: Sym[] = [];
    for (let i = 0; i < need; i++) fresh.push(drawCell(rng, r));
    // New symbols fall in on top, survivors keep their order below.
    next.push([...fresh, ...survivors]);
  }
  return next;
}

/** Resolve one full spin: initial grid + all tumbles. `startMult` seeds the
 *  meter (free spins carry it across spins so it never resets). */
function resolveSpin(rng: Rng, bet: number, startMultIndex: number): SpinResult {
  let grid = buildGrid(rng);
  const steps: TumbleStep[] = [];
  let multIndex = startMultIndex;
  let total = 0;
  for (let c = 0; c < MAX_CASCADES; c++) {
    const wins = evalWays(grid, bet);
    const multiplier = MULT_LADDER[Math.min(multIndex, MULT_LADDER.length - 1)];
    if (wins.length === 0) {
      steps.push({ grid, wins: [], multiplier, win: 0 });
      break;
    }
    const baseSum = wins.reduce((s, w) => s + w.base, 0);
    const win = baseSum * multiplier;
    total += win;
    steps.push({ grid, wins, multiplier, win });
    grid = tumble(grid, wins, rng);
    multIndex++; // every winning tumble bumps the meter
  }
  return { steps, win: total, endMultiplier: MULT_LADDER[Math.min(multIndex, MULT_LADDER.length - 1)] };
}

/** Count VAULT scatters across a grid. */
function scatterCount(grid: Sym[][]): number {
  let n = 0;
  for (const reel of grid) for (const s of reel) if (s === "VAULT") n++;
  return n;
}

interface TTParams {
  // No client-controllable params — the bet is the only input.
  [k: string]: unknown;
}

export const tiannasTreasurySpec: GameSpec<TTParams> = {
  slug: "tiannas-treasury",
  minBet: MIN_BET,
  maxBet: 200_000,
  validate: (params) => {
    assert(params === undefined || params === null || typeof params === "object", "Invalid params");
    return {};
  },
  resolve: (bet, _params, rng) => {
    // ---- Base spin ----
    const base = resolveSpin(rng, bet, 0);
    const scatters = scatterCount(base.steps[0].grid);

    let total = base.win;
    const scatterPay = (SCATTER_PAY[Math.min(scatters, 6)] ?? 0) * bet;
    total += scatterPay;

    // ---- Tianna's Vault free spins (4+ scatters) — multiplier never resets ----
    const freeSpinCount = FREE_SPINS[Math.min(scatters, 6)] ?? 0;
    const freeSpins: SpinResult[] = [];
    if (freeSpinCount > 0) {
      let carryMultIndex = 1; // vault starts the meter hot at ×2
      for (let i = 0; i < freeSpinCount; i++) {
        const fs = resolveSpin(rng, bet, carryMultIndex);
        freeSpins.push(fs);
        total += fs.win;
        // Carry the meter forward by how many tumbles won this spin (min +1 so it
        // always climbs), so the round builds toward an "uncapped" crescendo.
        const climbed = fs.steps.filter((s) => s.win > 0).length;
        carryMultIndex += Math.max(1, climbed);
      }
    }

    const payout = bet === 0 ? 0 : Math.round(total * 100) / 100;

    return {
      payout,
      outcome: {
        base,
        scatters,
        scatterPay,
        freeSpinCount,
        freeSpins,
        totalWin: payout,
        bigWin: payout >= bet * 20,
      },
    };
  },
};
