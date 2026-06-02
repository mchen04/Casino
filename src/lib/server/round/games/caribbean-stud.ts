import { type RoundGame, GameError } from "../engine";
import { evaluate5, HandCategory, makeDeck, rankValue, type Card } from "../../../cards";

// Server-authoritative Caribbean Stud — mirrors src/games/caribbean-stud.tsx.
//   Ante, then see 5 cards + the dealer's up-card and RAISE (= 2× ante) or FOLD.
//   Dealer qualifies with Ace-King high or better (any pair+). Dealer doesn't
//   qualify → ante 1:1, raise pushes. Dealer qualifies + you win → ante 1:1 and
//   the raise pays per the paytable (Pair/HighCard 1:1 … Royal 100:1). Lose →
//   lose both; tie → push. Single deck; all 10 cards committed at the deal (only
//   the dealer up-card is shown until the raise/fold decision). ~5.22% ante edge.

const RAISE_TABLE: Partial<Record<HandCategory, number>> = {
  [HandCategory.RoyalFlush]: 100,
  [HandCategory.StraightFlush]: 50,
  [HandCategory.FourOfAKind]: 20,
  [HandCategory.FullHouse]: 7,
  [HandCategory.Flush]: 5,
  [HandCategory.Straight]: 4,
  [HandCategory.ThreeOfAKind]: 3,
  [HandCategory.TwoPair]: 2,
  [HandCategory.Pair]: 1,
};
const raiseMultiplierFor = (cat: HandCategory) => RAISE_TABLE[cat] ?? 1; // High Card / Pair → 1:1

function dealerQualifies(hand: Card[]): boolean {
  if (evaluate5(hand).category > HandCategory.HighCard) return true;
  const vals = new Set(hand.map((c) => rankValue(c.rank)));
  return vals.has(14) && vals.has(13); // Ace-King high
}

interface CSState {
  playerCards: Card[];
  dealerCards: Card[];
  ante: number;
}

export const caribbeanStudGame: RoundGame<CSState, Record<string, never>> = {
  slug: "caribbean-stud",
  minBet: 5,
  maxBet: 500_000,
  validate: () => ({}),
  start: (ante, _params, rng) => {
    const deck = rng.shuffle(makeDeck(1));
    const playerCards = deck.slice(0, 5);
    const dealerCards = deck.slice(5, 10);
    return {
      state: { playerCards, dealerCards, ante },
      publicView: { playerCards, dealerUp: dealerCards[0] },
      actions: ["raise", "fold"],
      done: false,
      payout: 0,
    };
  },
  act: (state, ante, action) => {
    const s = state as CSState;

    if (action === "fold") {
      return {
        publicView: { playerCards: s.playerCards, dealerCards: s.dealerCards, outcome: "fold" },
        actions: [],
        done: true,
        payout: 0, // ante forfeited
      };
    }
    if (action !== "raise") throw new GameError("Invalid action");

    const raiseAmt = ante * 2;
    const pEval = evaluate5(s.playerCards);
    const dEval = evaluate5(s.dealerCards);
    const dQual = dealerQualifies(s.dealerCards);

    let payout = 0;
    let outcome: string;
    if (!dQual) {
      payout = ante * 2 + raiseAmt; // ante 1:1 + raise push
      outcome = "win";
    } else {
      const cmp = pEval.score - dEval.score;
      if (cmp > 0) {
        const mult = raiseMultiplierFor(pEval.category);
        payout = ante * 2 + raiseAmt + raiseAmt * mult; // ante 1:1 + raise per paytable
        outcome = "win";
      } else if (cmp === 0) {
        payout = ante + raiseAmt; // push both
        outcome = "push";
      } else {
        outcome = "lose";
      }
    }

    return {
      publicView: {
        playerCards: s.playerCards,
        dealerCards: s.dealerCards,
        dealerQualified: dQual,
        outcome,
        playerHand: pEval.name,
        dealerHand: dEval.name,
        raiseMult: dQual && pEval.score > dEval.score ? raiseMultiplierFor(pEval.category) : 0,
      },
      actions: [],
      done: true,
      payout,
      debit: raiseAmt, // the raise (2× ante)
    };
  },
};
