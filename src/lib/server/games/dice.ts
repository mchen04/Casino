import { type GameSpec, intIn, oneOf, assert } from "../engine";
import { payoutForChance } from "@/lib/cryptoGames";

// Server-authoritative Dice — mirrors src/games/dice.tsx exactly.
//   roll ∈ [0, 100), target ∈ [2, 98], mode over/under.
//   winChance = over ? (100-target)/100 : target/100
//   payout multiplier = payoutForChance(winChance)  (≈1% edge)

const MIN_TARGET = 2;
const MAX_TARGET = 98;

interface DiceParams {
  target: number;
  mode: "over" | "under";
}

const winChance = (target: number, mode: "over" | "under") =>
  mode === "over" ? (100 - target) / 100 : target / 100;

export const diceSpec: GameSpec<DiceParams> = {
  slug: "dice",
  minBet: 5,
  maxBet: 1_000_000,
  validate: (params) => {
    assert(params && typeof params === "object", "Missing params");
    const p = params as Record<string, unknown>;
    return {
      target: intIn(p.target, MIN_TARGET, MAX_TARGET, "target"),
      mode: oneOf(p.mode, ["over", "under"] as const, "mode"),
    };
  },
  resolve: (bet, { target, mode }, rng) => {
    const roll = rng.range(0, 100); // [0, 100)
    const mult = payoutForChance(winChance(target, mode));
    const won = mode === "over" ? roll > target : roll < target;
    return {
      payout: won ? bet * mult : 0,
      outcome: { roll, target, mode, won, multiplier: mult },
    };
  },
};
