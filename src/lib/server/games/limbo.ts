import { type GameSpec, num, assert } from "../engine";
import { HOUSE_EDGE } from "../../cryptoGames";

// Server-authoritative Limbo — mirrors src/games/limbo.tsx exactly.
//   target ∈ [1.01, 1_000_000], rounded to 2 decimals.
//   result = max(1, (1 - edge) / (1 - u)),  u ∈ [0, 0.999999]
//   win iff result >= target → pays bet × target (target includes stake).
// Edge is exactly ~1% by construction (EV = winChance × target = (1-edge)).

const MIN_TARGET = 1.01;
const MAX_TARGET = 1_000_000;

interface LimboParams {
  target: number;
}

export const limboSpec: GameSpec<LimboParams> = {
  slug: "limbo",
  minBet: 5,
  maxBet: 1_000_000,
  validate: (params) => {
    assert(params && typeof params === "object", "Missing params");
    const p = params as Record<string, unknown>;
    const raw = num(p.target, "target");
    const target = Math.round(Math.min(Math.max(raw, MIN_TARGET), MAX_TARGET) * 100) / 100;
    return { target };
  },
  resolve: (bet, { target }, rng) => {
    const u = Math.min(Math.max(rng.float(), 0), 0.999999);
    const result = Math.max(1, (1 - HOUSE_EDGE) / (1 - u));
    const won = result >= target;
    return {
      payout: won ? bet * target : 0,
      outcome: { result, target, won },
    };
  },
};
