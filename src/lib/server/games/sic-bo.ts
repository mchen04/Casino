import { type GameSpec, nonNegInt, assert } from "../engine";

// Server-authoritative Sic Bo — mirrors src/games/sic-bo.tsx.
//   Three dice. Bet keys: small | big | anyTriple | single:N | double:N |
//   triple:N | total:N. Multipliers (stake-inclusive) per the standard paytable.

type Die = 1 | 2 | 3 | 4 | 5 | 6;

interface RollResult {
  dice: [Die, Die, Die];
  total: number;
  counts: Record<Die, number>;
  isTriple: boolean;
  tripleFace: Die | null;
}

function totalMultiplier(total: number): number {
  switch (total) {
    case 4: case 17: return 61; // 60:1
    case 5: case 16: return 31; // 30:1
    case 6: case 15: return 19; // 18:1
    case 7: case 14: return 13; // 12:1
    case 8: case 13: return 9; // 8:1
    case 9: case 10: case 11: case 12: return 7; // 6:1
    default: return 0;
  }
}

function settleBet(key: string, r: RollResult): number {
  if (key === "small") return r.isTriple ? 0 : r.total >= 4 && r.total <= 10 ? 2 : 0;
  if (key === "big") return r.isTriple ? 0 : r.total >= 11 && r.total <= 17 ? 2 : 0;
  if (key === "anyTriple") return r.isTriple ? 31 : 0; // 30:1
  const [kind, raw] = key.split(":");
  const n = Number(raw);
  if (kind === "single") {
    const c = r.counts[n as Die] ?? 0;
    return c > 0 ? c + 1 : 0; // 1:1 / 2:1 / 3:1
  }
  if (kind === "double") return (r.counts[n as Die] ?? 0) >= 2 ? 11 : 0; // 10:1
  if (kind === "triple") return r.isTriple && r.tripleFace === n ? 181 : 0; // 180:1
  if (kind === "total") return r.total === n ? totalMultiplier(n) : 0;
  return 0;
}

/** Validate that a bet key is one the paytable recognises. */
function validKey(key: string): boolean {
  if (key === "small" || key === "big" || key === "anyTriple") return true;
  const [kind, raw] = key.split(":");
  const n = Number(raw);
  if (!Number.isInteger(n)) return false;
  if (kind === "single" || kind === "double" || kind === "triple") return n >= 1 && n <= 6;
  if (kind === "total") return n >= 4 && n <= 17;
  return false;
}

interface SicBoParams {
  bets: Record<string, number>;
}

export const sicBoSpec: GameSpec<SicBoParams> = {
  slug: "sic-bo",
  minBet: 5,
  maxBet: 1_000_000,
  validate: (params) => {
    assert(params && typeof params === "object", "Missing params");
    const p = params as Record<string, unknown>;
    assert(p.bets && typeof p.bets === "object", "Missing bets");
    const raw = p.bets as Record<string, unknown>;
    const bets: Record<string, number> = {};
    for (const [key, amt] of Object.entries(raw)) {
      assert(validKey(key), "Unknown bet");
      bets[key] = nonNegInt(amt, 1_000_000, "bet amount");
    }
    return { bets };
  },
  resolve: (bet, { bets }, rng) => {
    const entries = Object.entries(bets);
    const sum = entries.reduce((s, [, a]) => s + a, 0);
    assert(sum === bet, "Bets must sum to the stake");
    assert(entries.some(([, a]) => a > 0), "No bet placed");

    const dice: [Die, Die, Die] = [
      rng.int(1, 6) as Die,
      rng.int(1, 6) as Die,
      rng.int(1, 6) as Die,
    ];
    const counts: Record<Die, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
    for (const d of dice) counts[d] += 1;
    const total = dice[0] + dice[1] + dice[2];
    const isTriple = dice[0] === dice[1] && dice[1] === dice[2];
    const r: RollResult = { dice, total, counts, isTriple, tripleFace: isTriple ? dice[0] : null };

    let payout = 0;
    for (const [key, amt] of entries) {
      if (amt > 0) payout += amt * settleBet(key, r);
    }

    return {
      payout,
      outcome: { dice, total, isTriple, tripleFace: r.tripleFace },
    };
  },
};
