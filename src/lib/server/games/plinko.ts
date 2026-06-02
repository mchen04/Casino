import { type GameSpec, oneOf, intIn, assert } from "../engine";

// Server-authoritative Plinko — mirrors src/games/plinko.tsx exactly.
//   Ball makes `rows` fair left/right bounces; bucket = # of RIGHT bounces
//   (binomial). Payout = stake × PAYOUTS[rows][risk][bucket] (mult includes
//   stake). The server returns the exact bounce sequence so the client animates
//   the same trajectory it paid out on.

type Risk = "low" | "medium" | "high";

const PAYOUTS: Record<number, Record<Risk, number[]>> = {
  8: {
    low: [5.6, 2.1, 1.1, 1, 0.5, 1, 1.1, 2.1, 5.6],
    medium: [13, 3, 1.3, 0.7, 0.4, 0.7, 1.3, 3, 13],
    high: [29, 4, 1.5, 0.3, 0.2, 0.3, 1.5, 4, 29],
  },
  12: {
    low: [10, 3, 1.6, 1.4, 1.1, 1, 0.5, 1, 1.1, 1.4, 1.6, 3, 10],
    medium: [22, 8, 3.5, 1.6, 1, 0.7, 0.6, 0.7, 1, 1.6, 3.5, 8, 22],
    high: [66, 15, 4, 2, 1.1, 0.5, 0.3, 0.5, 1.1, 2, 4, 15, 66],
  },
  16: {
    low: [18, 6, 3, 1.8, 1.4, 1.2, 1, 0.9, 0.76, 0.9, 1, 1.2, 1.4, 1.8, 3, 6, 18],
    medium: [110, 41, 10, 5, 3, 1.5, 1, 0.5, 0.3, 0.5, 1, 1.5, 3, 5, 10, 41, 110],
    high: [1000, 130, 26, 9, 4, 2, 0.2, 0.2, 0.2, 0.2, 0.2, 2, 4, 9, 26, 130, 1000],
  },
};

interface PlinkoParams {
  rows: number;
  risk: Risk;
}

export const plinkoSpec: GameSpec<PlinkoParams> = {
  slug: "plinko",
  minBet: 5,
  maxBet: 1_000_000,
  validate: (params) => {
    assert(params && typeof params === "object", "Missing params");
    const p = params as Record<string, unknown>;
    const rows = intIn(p.rows, 8, 16, "rows");
    assert(rows === 8 || rows === 12 || rows === 16, "rows out of range");
    return { rows, risk: oneOf(p.risk, ["low", "medium", "high"] as const, "risk") };
  },
  resolve: (bet, { rows, risk }, rng) => {
    const bounces: boolean[] = [];
    let rights = 0;
    for (let i = 0; i < rows; i++) {
      const right = rng.chance(0.5);
      bounces.push(right);
      if (right) rights++;
    }
    const bucket = rights; // 0..rows
    const mult = PAYOUTS[rows][risk][bucket];
    return {
      payout: bet * mult,
      outcome: { rows, risk, bucket, multiplier: mult, bounces },
    };
  },
};
