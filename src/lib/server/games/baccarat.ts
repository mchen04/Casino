import { type GameSpec, validateSpots, assert } from "../engine";
import { makeDeck } from "../../cards";
import { dealCoup, type Resolution } from "../../baccarat";

// Server-authoritative Baccarat (Punto Banco) — mirrors src/games/baccarat.tsx.
//   8-deck shoe, official third-card tableau (lib/baccarat.dealCoup).
//   Player 1:1 (2×), Banker 0.95:1 (1.95×, 5% commission), Tie 8:1 (9×),
//   Player/Banker Pair 11:1 (12×). Player/Banker spots PUSH on a tie (return 1×).

type SpotId = "player" | "banker" | "tie" | "ppair" | "bpair";
const KEYS: readonly SpotId[] = ["player", "banker", "tie", "ppair", "bpair"];

function grossFor(spot: SpotId, stake: number, res: Resolution): number {
  if (stake <= 0) return 0;
  switch (spot) {
    case "player":
      if (res.outcome === "player") return stake * 2;
      if (res.outcome === "tie") return stake; // push
      return 0;
    case "banker":
      if (res.outcome === "banker") return stake * 1.95;
      if (res.outcome === "tie") return stake; // push
      return 0;
    case "tie":
      return res.outcome === "tie" ? stake * 9 : 0;
    case "ppair":
      return res.playerPair ? stake * 12 : 0;
    case "bpair":
      return res.bankerPair ? stake * 12 : 0;
  }
}

interface BaccaratParams {
  spots: Record<string, unknown>;
}

export const baccaratSpec: GameSpec<BaccaratParams> = {
  slug: "baccarat",
  minBet: 5,
  maxBet: 1_000_000,
  validate: (params) => {
    assert(params && typeof params === "object", "Missing params");
    return { spots: params as Record<string, unknown> };
  },
  resolve: (bet, { spots }, rng) => {
    const placed = validateSpots(spots, KEYS, bet, 1_000_000);
    const shoe = rng.shuffle(makeDeck(8));
    const res = dealCoup(shoe);

    let gross = 0;
    for (const k of KEYS) gross += grossFor(k, placed[k], res);

    return {
      payout: gross,
      outcome: {
        playerCards: res.playerCards,
        bankerCards: res.bankerCards,
        playerTotal: res.playerTotal,
        bankerTotal: res.bankerTotal,
        result: res.outcome,
        playerPair: res.playerPair,
        bankerPair: res.bankerPair,
        natural: res.natural,
      },
    };
  },
};
