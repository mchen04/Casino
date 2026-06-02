import { type GameSpec, oneOf, assert } from "../engine";

// Server-authoritative Big Six Money Wheel — mirrors src/games/money-wheel.tsx.
//   54 segments: 1×24, 2×15, 5×7, 10×4, 20×2, JOKER×1, CASINO×1.
//   Each segment equally likely. A win on spot S pays S.mult : 1 (returns
//   stake × (mult + 1)); the two logo segments pay 40:1.

interface SpotDef {
  key: string;
  mult: number;
  count: number;
}
const SPOTS: SpotDef[] = [
  { key: "1", mult: 1, count: 24 },
  { key: "2", mult: 2, count: 15 },
  { key: "5", mult: 5, count: 7 },
  { key: "10", mult: 10, count: 4 },
  { key: "20", mult: 20, count: 2 },
  { key: "joker", mult: 40, count: 1 },
  { key: "casino", mult: 40, count: 1 },
];
const KEYS = SPOTS.map((s) => s.key) as [string, ...string[]];
const BY_KEY = new Map(SPOTS.map((s) => [s.key, s]));

interface MWParams {
  pick: string;
}

export const moneyWheelSpec: GameSpec<MWParams> = {
  slug: "money-wheel",
  minBet: 5,
  maxBet: 1_000_000,
  validate: (params) => {
    assert(params && typeof params === "object", "Missing params");
    const p = params as Record<string, unknown>;
    return { pick: oneOf(p.pick, KEYS, "pick") };
  },
  resolve: (bet, { pick }, rng) => {
    // Land a segment uniformly across all 54 (weight each spot by its count).
    const landed = rng.weighted(SPOTS, SPOTS.map((s) => s.count));
    const matched = landed.key === pick;
    const pickSpot = BY_KEY.get(pick)!;
    return {
      payout: matched ? bet * (pickSpot.mult + 1) : 0,
      outcome: { landedKey: landed.key, landedMult: landed.mult, matched },
    };
  },
};
