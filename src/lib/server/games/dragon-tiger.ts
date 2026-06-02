import { type GameSpec, validateSpots, assert } from "../engine";
import { makeDeck, type Card, type Rank } from "../../cards";

// Server-authoritative Dragon Tiger — mirrors src/games/dragon-tiger.tsx.
//   One card to Dragon, one to Tiger from an 8-deck shoe (Ace LOW = 1 .. K = 13).
//   Higher card wins its side 1:1 (returns 2× the spot).
//   Tie (equal rank) pays 8:1 (returns 9×); on a tie, Dragon/Tiger spots lose
//     HALF (return 0.5× the spot). Suit Tie (equal rank + suit) pays 50:1 (51×).
//   Tie / Suit-Tie spots lose entirely on any non-tie.
//
// validate() can't see the accepted `bet` (the engine validates that
// separately), so it only coerces the spot object's shape; the exact
// sum-equals-stake check runs in resolve() via validateSpots(bet).

type BetKey = "dragon" | "tiger" | "tie" | "suitTie";
const KEYS: readonly BetKey[] = ["dragon", "tiger", "tie", "suitTie"];

const DT_VALUE: Record<Rank, number> = {
  A: 1, "2": 2, "3": 3, "4": 4, "5": 5, "6": 6, "7": 7,
  "8": 8, "9": 9, "10": 10, J: 11, Q: 12, K: 13,
};

interface DTParams {
  spots: Record<string, unknown>;
}

export const dragonTigerSpec: GameSpec<DTParams> = {
  slug: "dragon-tiger",
  minBet: 5,
  maxBet: 1_000_000,
  validate: (params) => {
    assert(params && typeof params === "object", "Missing params");
    return { spots: params as Record<string, unknown> };
  },
  resolve: (bet, { spots }, rng) => {
    const placed = validateSpots(spots, KEYS, bet, 1_000_000);

    const deck = rng.shuffle(makeDeck(8));
    const d = deck[0] as Card;
    const t = deck[1] as Card;
    const dv = DT_VALUE[d.rank];
    const tv = DT_VALUE[t.rank];
    const isTie = dv === tv;
    const isSuitTie = isTie && d.suit === t.suit;
    const winner: BetKey | "tie" = isTie ? "tie" : dv > tv ? "dragon" : "tiger";

    let gross = 0;
    if (isTie) {
      gross += placed.dragon / 2;
      gross += placed.tiger / 2;
      gross += placed.tie * 9;
      if (isSuitTie) gross += placed.suitTie * 51;
    } else {
      gross += placed[winner] * 2;
    }

    return {
      payout: gross,
      outcome: { dragonCard: d, tigerCard: t, winner, isTie, isSuitTie },
    };
  },
};
