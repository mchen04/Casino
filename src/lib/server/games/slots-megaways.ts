import { type GameSpec, assert } from "../engine";
import type { Rng } from "../rngCore";

// Server-authoritative Neon Megaways — mirrors src/games/slots-megaways.tsx.
//   6-reel cascading Megaways (2-6 rows). Ways-wins with wild substitution; a
//   rising cascade multiplier; 4+ scatters award a cash bonus. The whole spin
//   (initial grid + every cascade) resolves in one call and returns the step
//   sequence the client animates. Buy-bonus stays a guest-only demo for now.
//   RTP ~95.8% (WIN_SCALE-tuned, sim-verified incl. cascades + the win cap).

interface SymDef {
  key: string;
  weight: number;
  pay: number;
  wild?: boolean;
  scatter?: boolean;
}

const SYMBOLS: SymDef[] = [
  { key: "diamond", weight: 5, pay: 0.5 },
  { key: "amethyst", weight: 8, pay: 0.3 },
  { key: "emerald", weight: 10, pay: 0.2 },
  { key: "topaz", weight: 12, pay: 0.15 },
  { key: "ruby", weight: 14, pay: 0.1 },
  { key: "sapphire", weight: 14, pay: 0.08 },
  { key: "wild", weight: 4, pay: 0, wild: true },
  { key: "scatter", weight: 3, pay: 0, scatter: true },
];
const SYM_WEIGHTS = SYMBOLS.map((s) => s.weight);
const PAY_SYMBOLS = SYMBOLS.filter((s) => !s.scatter);

const REELS = 6;
const MIN_ROWS = 2;
const MAX_ROWS = 6;
const LEN_MULT: Record<number, number> = { 3: 1, 4: 2.5, 5: 6, 6: 15 };
const MAX_WIN_UNITS = 600;
const MULT_LADDER = [1, 2, 3, 5, 8, 12, 20];
const WIN_SCALE = 0.0125;
const MAX_CASCADES = 40;

interface Cell { id: string; key: string }

function randomSym(rng: Rng): string {
  return rng.weighted(SYMBOLS, SYM_WEIGHTS).key;
}

function makeGrid(rng: Rng, seq: { n: number }): Cell[][] {
  return Array.from({ length: REELS }, () => {
    const rows = rng.int(MIN_ROWS, MAX_ROWS);
    return Array.from({ length: rows }, () => ({ id: `c${seq.n++}`, key: randomSym(rng) }));
  });
}

function isWild(key: string): boolean {
  return key === "wild";
}

function evaluate(grid: Cell[][]): { winners: Set<string>; units: number; scatters: number } {
  const winners = new Set<string>();
  let units = 0;
  let scatters = 0;
  for (const reel of grid) for (const c of reel) if (c.key === "scatter") scatters++;

  for (const target of PAY_SYMBOLS) {
    if (target.wild) continue;
    let runLen = 0;
    const counts: number[] = [];
    const ids: string[][] = [];
    for (let r = 0; r < REELS; r++) {
      const matches = grid[r].filter((c) => c.key === target.key || isWild(c.key));
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

function cascade(grid: Cell[][], winners: Set<string>, rng: Rng, seq: { n: number }): Cell[][] {
  return grid.map((reel) => {
    const survivors = reel.filter((c) => !winners.has(c.id));
    const need = reel.length - survivors.length;
    const fresh = Array.from({ length: need }, () => ({ id: `c${seq.n++}`, key: randomSym(rng) }));
    return [...fresh, ...survivors];
  });
}

export const slotsMegawaysSpec: GameSpec<Record<string, never>> = {
  slug: "slots-megaways",
  minBet: 5,
  maxBet: 1_000_000,
  validate: (params) => {
    assert(params === undefined || params === null || typeof params === "object", "Invalid params");
    return {};
  },
  resolve: (bet, _params, rng) => {
    const seq = { n: 0 };
    let current = makeGrid(rng, seq);
    const initialGrid = current;
    const steps: { winners: string[]; mult: number; win: number; nextGrid: Cell[][] }[] = [];
    let total = 0;
    let scatterBonus = 0;
    let firstScatters = 0;
    let cascadeNum = 0;

    for (let i = 0; i < MAX_CASCADES; i++) {
      const res = evaluate(current);
      if (cascadeNum === 0) {
        firstScatters = res.scatters;
        if (res.scatters >= 4) {
          scatterBonus = Math.round(bet * (res.scatters - 2));
          total += scatterBonus;
        }
      }
      if (res.units <= 0 || res.winners.size === 0) break;
      const mult = MULT_LADDER[Math.min(cascadeNum, MULT_LADDER.length - 1)];
      const winChips = Math.round(bet * res.units * mult * WIN_SCALE);
      total += winChips;
      const next = cascade(current, res.winners, rng, seq);
      steps.push({ winners: [...res.winners], mult, win: winChips, nextGrid: next });
      current = next;
      cascadeNum++;
    }

    return {
      payout: total,
      outcome: { initialGrid, steps, scatterBonus, scatters: firstScatters, total },
    };
  },
};
