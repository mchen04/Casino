import { type RoundGame, GameError } from "../engine";
import { nonNegInt, assert } from "../../engine";
import { evaluate3, ThreeCardCategory, makeDeck, rankValue, type Card } from "../../../cards";

// Server-authoritative Three Card Poker — mirrors src/games/three-card-poker.tsx.
//   Ante + optional Pair Plus side bet. See 3 cards, then PLAY (match the ante)
//   or FOLD. Dealer qualifies on Queen-high+. Single deck.
//     Pair Plus (on the player's hand): Pair 1:1, Flush 3:1, Straight 6:1,
//       Trips 30:1, Straight Flush 40:1.
//     Ante Bonus (on the player's hand, regardless of dealer): Straight 1:1,
//       Trips 4:1, Straight Flush 5:1.
//     Dealer doesn't qualify → Ante 1:1, Play pushes.
//     Dealer qualifies → beat it: Ante + Play 1:1; tie: push; lose: lose both.
//   Optimal play: PLAY on Q-6-4 or better, else FOLD (~3.46% edge on the ante).

const DEALER_QUALIFY_VALUE = 12;

const PAIR_PLUS: Partial<Record<ThreeCardCategory, number>> = {
  [ThreeCardCategory.StraightFlush]: 40,
  [ThreeCardCategory.ThreeOfAKind]: 30,
  [ThreeCardCategory.Straight]: 6,
  [ThreeCardCategory.Flush]: 3,
  [ThreeCardCategory.Pair]: 1,
};
const ANTE_BONUS: Partial<Record<ThreeCardCategory, number>> = {
  [ThreeCardCategory.StraightFlush]: 5,
  [ThreeCardCategory.ThreeOfAKind]: 4,
  [ThreeCardCategory.Straight]: 1,
};

const highValue = (cards: Card[]) => cards.reduce((m, c) => Math.max(m, rankValue(c.rank)), 0);

interface TCPParams {
  pairPlus: number;
}
interface TCPState {
  playerCards: Card[];
  dealerCards: Card[];
  ante: number;
  pairPlus: number;
}

export const threeCardPokerGame: RoundGame<TCPState, TCPParams> = {
  slug: "three-card-poker",
  minBet: 5,
  maxBet: 1_000_000,
  validate: (params) => {
    assert(params && typeof params === "object", "Missing params");
    return { pairPlus: nonNegInt((params as Record<string, unknown>).pairPlus, 1_000_000, "pairPlus") };
  },
  start: (ante, { pairPlus }, rng) => {
    const deck = rng.shuffle(makeDeck(1));
    const playerCards = [deck[0], deck[1], deck[2]];
    const dealerCards = [deck[3], deck[4], deck[5]];
    return {
      state: { playerCards, dealerCards, ante, pairPlus },
      publicView: { playerCards, pairPlus },
      actions: ["play", "fold"],
      done: false,
      payout: 0,
      // Reserve the Play stake (= ante) + the Pair Plus side bet alongside the ante.
      debit: ante + pairPlus,
    };
  },
  act: (state, ante, action) => {
    const s = state as TCPState;
    const pRank = evaluate3(s.playerCards);
    const ppOdds = PAIR_PLUS[pRank.category] ?? 0;
    const ppReturn = s.pairPlus > 0 && ppOdds > 0 ? s.pairPlus * (ppOdds + 1) : 0;

    if (action === "fold") {
      // Ante forfeited; the reserved Play stake is refunded; Pair Plus already stands.
      return {
        publicView: { playerCards: s.playerCards, dealerCards: s.dealerCards, outcome: "fold", playerHand: pRank.name },
        actions: [],
        done: true,
        payout: ppReturn + ante, // play refund
      };
    }
    if (action !== "play") throw new GameError("Invalid action");

    const dRank = evaluate3(s.dealerCards);
    const dealerQualified = dRank.category > ThreeCardCategory.HighCard || highValue(s.dealerCards) >= DEALER_QUALIFY_VALUE;

    let total = ppReturn;
    const abOdds = ANTE_BONUS[pRank.category] ?? 0;
    if (abOdds > 0) total += ante * abOdds; // ante bonus, pure profit

    let outcome: string;
    if (!dealerQualified) {
      total += ante * 2 + ante; // ante 1:1 + play push
      outcome = "win";
    } else {
      const cmp = pRank.score - dRank.score;
      if (cmp > 0) {
        total += ante * 2 + ante * 2; // ante + play 1:1
        outcome = "win";
      } else if (cmp === 0) {
        total += ante + ante; // push both
        outcome = "push";
      } else {
        outcome = "lose";
      }
    }

    return {
      publicView: {
        playerCards: s.playerCards,
        dealerCards: s.dealerCards,
        dealerQualified,
        outcome,
        playerHand: pRank.name,
        dealerHand: dRank.name,
      },
      actions: [],
      done: true,
      payout: total,
    };
  },
};
