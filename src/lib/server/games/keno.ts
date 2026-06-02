import { type GameSpec, assert, intIn } from "../engine";

// Server-authoritative Keno — mirrors src/games/keno.tsx exactly.
//   80-number grid, pick 1-10 spots; draw 20 (shuffle 1..80, take 20).
//   Payout = stake × PAYTABLE[spots][hits] (multiplier includes the stake).
//   Each pick count returns ~90-92% (exact hypergeometric-tuned table).

const PAYTABLE: Record<number, number[]> = {
  1: [0, 3.6],
  2: [0, 1, 9],
  3: [0, 0, 3.6, 29],
  4: [0, 0, 1.7, 8.3, 66],
  5: [0, 0, 0, 4.8, 29, 240],
  6: [0, 0, 0, 2.6, 11, 63, 530],
  7: [0, 0, 0, 2, 4, 24, 160, 805],
  8: [0, 0, 0, 0, 4.1, 17, 83, 415, 1245],
  9: [0, 0, 0, 0, 2.2, 8.7, 44, 175, 760, 1740],
  10: [0, 0, 0, 0, 0, 5.7, 28, 140, 425, 1415, 2000],
};

const POOL = 80;
const DRAW_COUNT = 20;
const MAX_SPOTS = 10;

interface KenoParams {
  picks: number[];
}

export const kenoSpec: GameSpec<KenoParams> = {
  slug: "keno",
  minBet: 5,
  maxBet: 1_000_000,
  validate: (params) => {
    assert(params && typeof params === "object", "Missing params");
    const p = params as Record<string, unknown>;
    assert(Array.isArray(p.picks), "picks must be an array");
    const raw = p.picks as unknown[];
    assert(raw.length >= 1 && raw.length <= MAX_SPOTS, "pick 1-10 spots");
    const seen = new Set<number>();
    const picks: number[] = [];
    for (const v of raw) {
      const n = intIn(v, 1, POOL, "pick");
      assert(!seen.has(n), "duplicate pick");
      seen.add(n);
      picks.push(n);
    }
    return { picks };
  },
  resolve: (bet, { picks }, rng) => {
    const pool = Array.from({ length: POOL }, (_, i) => i + 1);
    const drawn = rng.shuffle(pool).slice(0, DRAW_COUNT);
    const drawnSet = new Set(drawn);
    let hits = 0;
    for (const n of picks) if (drawnSet.has(n)) hits++;
    const mult = PAYTABLE[picks.length]?.[hits] ?? 0;
    return {
      payout: bet * mult,
      outcome: { picks, drawn, hits, spots: picks.length, multiplier: mult },
    };
  },
};
