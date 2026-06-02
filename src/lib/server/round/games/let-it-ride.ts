import { type RoundGame, GameError } from "../engine";
import { evaluate5, HandCategory, makeDeck, type Card, type HandRank } from "../../../cards";

// Server-authoritative Let It Ride — mirrors src/games/let-it-ride.tsx.
//   Three equal bets (all debited up front). See 3 cards, then two pull-back
//   decisions (bet 1, then bet 2) as two community cards are revealed; bet 3
//   always rides. Final 5-card hand pays on the paytable below (pair must be
//   10s+). Pulled-back bets are refunded; riding bets pay unit*(mult+1) on a win.
//   ~3.51% house edge on the base unit with correct (let-ride only on made/draw)
//   play. The 5 cards are fixed at the deal — decisions only pick which bets ride.

const PAYTABLE: Partial<Record<HandCategory, number>> = {
  [HandCategory.RoyalFlush]: 1000,
  [HandCategory.StraightFlush]: 200,
  [HandCategory.FourOfAKind]: 50,
  [HandCategory.FullHouse]: 11,
  [HandCategory.Flush]: 8,
  [HandCategory.Straight]: 5,
  [HandCategory.ThreeOfAKind]: 3,
  [HandCategory.TwoPair]: 2,
  [HandCategory.Pair]: 1,
};

function payoutMultiplier(rank: HandRank): number {
  if (rank.category === HandCategory.Pair) {
    const pairVal = rank.tiebreak[0] ?? 0;
    return pairVal >= 10 ? 1 : 0; // qualifying pair = tens or better
  }
  if (rank.category === HandCategory.HighCard) return 0;
  return PAYTABLE[rank.category] ?? 0;
}

interface LIRState {
  player: Card[];
  community: Card[];
  unit: number;
  bet1Active: boolean;
}

export const letItRideGame: RoundGame<LIRState, Record<string, never>> = {
  slug: "let-it-ride",
  minBet: 5,
  maxBet: 333_333, // three units must stay within the wallet's per-bet ceiling
  validate: () => ({}),
  start: (unit, _params, rng) => {
    const deck = rng.shuffle(makeDeck(1));
    const player = [deck[0], deck[1], deck[2]];
    const community = [deck[3], deck[4]];
    return {
      state: { player, community, unit, bet1Active: true },
      publicView: { playerCards: player },
      actions: ["ride1", "pull1"],
      done: false,
      payout: 0,
      debit: unit * 2, // bets 2 and 3 (bet 1 is the base wager)
    };
  },
  act: (state, unit, action) => {
    const s = state as LIRState;

    // First decision — bet 1; reveal the first community card.
    if (action === "ride1" || action === "pull1") {
      return {
        state: { ...s, bet1Active: action === "ride1" },
        publicView: { playerCards: s.player, community: [s.community[0]] },
        actions: ["ride2", "pull2"],
        done: false,
        payout: 0,
      };
    }

    // Second decision — bet 2; reveal the last card and settle.
    if (action !== "ride2" && action !== "pull2") throw new GameError("Invalid action");
    const bet2Active = action === "ride2";
    const remaining = (s.bet1Active ? 1 : 0) + (bet2Active ? 1 : 0) + 1; // bet 3 always rides

    const five = [...s.player, ...s.community];
    const rank = evaluate5(five);
    const mult = payoutMultiplier(rank);

    const pulledBack = (3 - remaining) * unit; // refunded
    const stakeInPlay = remaining * unit;
    let gross = pulledBack;
    if (mult > 0) gross += stakeInPlay * (mult + 1); // stake + profit on riding bets

    return {
      publicView: { playerCards: s.player, community: s.community, hand: rank.name, mult },
      actions: [],
      done: true,
      payout: gross,
    };
  },
};
