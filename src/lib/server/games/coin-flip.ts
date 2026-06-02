import { type GameSpec, oneOf, assert } from "../engine";

// Server-authoritative Coin Flip (single mode) — mirrors src/games/coin-flip.tsx.
//   Fair 50/50 coin; a correct call pays 1.96× (≈2% house edge).
//   Streak/let-it-ride mode stays a client-side guest demo until the stateful
//   /api/round machine can hold a riding pot (single flips are fully secure now).

const PAYOUT = 1.96;

interface CoinFlipParams {
  call: "heads" | "tails";
}

export const coinFlipSpec: GameSpec<CoinFlipParams> = {
  slug: "coin-flip",
  minBet: 5,
  maxBet: 1_000_000,
  validate: (params) => {
    assert(params && typeof params === "object", "Missing params");
    const p = params as Record<string, unknown>;
    return { call: oneOf(p.call, ["heads", "tails"] as const, "call") };
  },
  resolve: (bet, { call }, rng) => {
    const landed = rng.chance(0.5) ? "heads" : "tails";
    const won = landed === call;
    return {
      payout: won ? bet * PAYOUT : 0,
      outcome: { call, landed, won },
    };
  },
};
