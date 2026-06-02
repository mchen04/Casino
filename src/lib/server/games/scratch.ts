import { type GameSpec, oneOf, assert } from "../engine";
import type { Rng } from "../rngCore";

// Server-authoritative Scratch Cards — mirrors src/games/scratch.tsx.
//   Pick a theme; the server pre-rolls the 3×3 card. A weighted draw decides
//   win/lose + which symbol wins; three of a symbol pays its multiplier × stake.
//   The grid layout is cosmetic — only the prize decides money — but the server
//   produces the exact cells + win positions so the client reveals the same card.

const GRID = 9;

interface PrizeDef {
  key: string;
  mult: number;
  weight: number;
}
interface ThemeDef {
  id: string;
  loseWeight: number;
  prizes: PrizeDef[];
}

const THEMES: Record<string, ThemeDef> = {
  gold: {
    id: "gold",
    loseWeight: 3150,
    prizes: [
      { key: "coin", mult: 2, weight: 760 },
      { key: "pick", mult: 4, weight: 290 },
      { key: "nugget", mult: 10, weight: 62 },
      { key: "bar", mult: 30, weight: 12 },
      { key: "crown", mult: 250, weight: 1 },
    ],
  },
  sevens: {
    id: "sevens",
    loseWeight: 3450,
    prizes: [
      { key: "cherry", mult: 2, weight: 740 },
      { key: "bell", mult: 5, weight: 255 },
      { key: "bar", mult: 12, weight: 52 },
      { key: "seven", mult: 40, weight: 9 },
      { key: "diamond7", mult: 300, weight: 1 },
    ],
  },
  neon: {
    id: "neon",
    loseWeight: 3650,
    prizes: [
      { key: "star", mult: 2, weight: 760 },
      { key: "bolt", mult: 5, weight: 260 },
      { key: "gem", mult: 15, weight: 44 },
      { key: "ring", mult: 60, weight: 7 },
      { key: "trophy", mult: 400, weight: 1 },
    ],
  },
};
const THEME_KEYS = Object.keys(THEMES) as [string, ...string[]];

/** Fill non-winning cells so NO symbol reaches a count of 3. */
function fillNoTriple(theme: ThemeDef, fixed: Map<number, string>, rng: Rng): string[] {
  const keys = theme.prizes.map((p) => p.key);
  const cells: string[] = new Array(GRID).fill("");
  const tally = new Map<string, number>();
  for (const [idx, k] of fixed) {
    cells[idx] = k;
    tally.set(k, (tally.get(k) ?? 0) + 1);
  }
  const open: number[] = [];
  for (let i = 0; i < GRID; i++) if (!fixed.has(i)) open.push(i);
  for (const idx of rng.shuffle(open)) {
    const cand = keys.filter((k) => (tally.get(k) ?? 0) < 2);
    const pool = cand.length > 0 ? cand : keys;
    const choice = rng.pick(pool);
    cells[idx] = choice;
    tally.set(choice, (tally.get(choice) ?? 0) + 1);
  }
  return cells;
}

interface ScratchParams {
  theme: string;
}

export const scratchSpec: GameSpec<ScratchParams> = {
  slug: "scratch",
  minBet: 5,
  maxBet: 1_000_000,
  validate: (params) => {
    assert(params && typeof params === "object", "Missing params");
    const p = params as Record<string, unknown>;
    return { theme: oneOf(p.theme, THEME_KEYS, "theme") };
  },
  resolve: (bet, { theme: themeKey }, rng) => {
    const theme = THEMES[themeKey];
    const options: (PrizeDef | null)[] = [null, ...theme.prizes];
    const weights = [theme.loseWeight, ...theme.prizes.map((p) => p.weight)];
    const prize = rng.weighted(options, weights);

    if (!prize) {
      return {
        payout: 0,
        outcome: { theme: themeKey, cells: fillNoTriple(theme, new Map(), rng), prizeKey: null, winCells: [], multiplier: 0 },
      };
    }

    const positions = rng.shuffle(Array.from({ length: GRID }, (_, i) => i)).slice(0, 3);
    const fixed = new Map<number, string>();
    for (const pos of positions) fixed.set(pos, prize.key);
    const cells = fillNoTriple(theme, fixed, rng);
    return {
      payout: bet * prize.mult,
      outcome: {
        theme: themeKey,
        cells,
        prizeKey: prize.key,
        winCells: positions.slice().sort((a, b) => a - b),
        multiplier: prize.mult,
      },
    };
  },
};
