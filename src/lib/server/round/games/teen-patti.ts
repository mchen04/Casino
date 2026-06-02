import { type RoundGame, GameError } from "../engine";
import { makeDeck, rankValue, type Card } from "../../../cards";

// Server-authoritative Teen Patti — mirrors src/games/teen-patti.tsx.
//   Boot (ante), see 3 cards, FOLD (lose boot) or PLAY (match the boot). Showdown
//   vs the dealer's 3 cards using Teen Patti ranking (Trail > Pure Seq > Seq >
//   Color > Pair > High). Win pays 1:1 + a bonus (Trail 5:1, Pure Seq 3:1, Seq
//   1:1) MINUS a 15% house commission on the winnings — which is what gives the
//   ~3.3% edge (the bare showdown is a symmetric ~0% game). Tie pushes. Single
//   deck; both hands committed at the deal (dealer hidden until play/fold).

enum TPCategory { HighCard = 0, Pair = 1, Color = 2, Sequence = 3, PureSequence = 4, Trail = 5 }
const COMMISSION = 0.15;

function evaluateTeenPatti(cards: Card[]): { category: TPCategory; score: number } {
  const values = cards.map((c) => rankValue(c.rank)).sort((a, b) => b - a);
  const suits = cards.map((c) => c.suit);
  const isFlush = suits.every((s) => s === suits[0]);
  const distinct = [...new Set(values)].sort((a, b) => b - a);

  let straightHigh = 0;
  if (distinct.length === 3) {
    if (distinct[0] - distinct[2] === 2) straightHigh = distinct[0];
    else if (distinct[0] === 14 && distinct[1] === 3 && distinct[2] === 2) straightHigh = 3; // A-2-3
  }
  const isSequence = straightHigh > 0;
  const isTrail = distinct.length === 1;

  let category: TPCategory;
  let tiebreak: number[];
  if (isTrail) {
    category = TPCategory.Trail;
    tiebreak = [values[0]];
  } else if (isSequence && isFlush) {
    category = TPCategory.PureSequence;
    tiebreak = [straightHigh];
  } else if (isSequence) {
    category = TPCategory.Sequence;
    tiebreak = [straightHigh];
  } else if (isFlush) {
    category = TPCategory.Color;
    tiebreak = values;
  } else if (values[0] === values[1] || values[1] === values[2]) {
    category = TPCategory.Pair;
    const pairVal = values[0] === values[1] ? values[0] : values[1];
    const kicker = values[0] === values[1] ? values[2] : values[0];
    tiebreak = [pairVal, kicker];
  } else {
    category = TPCategory.HighCard;
    tiebreak = values;
  }
  let score = category;
  for (let i = 0; i < 3; i++) score = score * 15 + (tiebreak[i] ?? 0);
  return { category, score };
}

const bonusFor = (cat: TPCategory): number =>
  cat === TPCategory.Trail ? 5 : cat === TPCategory.PureSequence ? 3 : cat === TPCategory.Sequence ? 1 : 0;

interface TPState {
  playerCards: Card[];
  dealerCards: Card[];
  boot: number;
}

export const teenPattiGame: RoundGame<TPState, Record<string, never>> = {
  slug: "teen-patti",
  minBet: 5,
  maxBet: 500_000,
  validate: () => ({}),
  start: (boot, _params, rng) => {
    const deck = rng.shuffle(makeDeck(1));
    return {
      state: { playerCards: deck.slice(0, 3), dealerCards: deck.slice(3, 6), boot },
      publicView: { playerCards: deck.slice(0, 3) },
      actions: ["play", "fold"],
      done: false,
      payout: 0,
    };
  },
  act: (state, boot, action) => {
    const s = state as TPState;
    if (action === "fold") {
      return {
        publicView: { playerCards: s.playerCards, dealerCards: s.dealerCards, outcome: "fold" },
        actions: [],
        done: true,
        payout: 0, // boot forfeited
      };
    }
    if (action !== "play") throw new GameError("Invalid action");

    const p = evaluateTeenPatti(s.playerCards);
    const d = evaluateTeenPatti(s.dealerCards);
    const totalBet = boot * 2; // boot + matched play stake

    let payout: number;
    let outcome: string;
    if (p.score > d.score) {
      const bonus = bonusFor(p.category);
      const grossProfit = totalBet + totalBet * bonus;
      const netProfit = grossProfit * (1 - COMMISSION);
      payout = totalBet + netProfit; // stake returned + commissioned profit
      outcome = "win";
    } else if (p.score === d.score) {
      payout = totalBet; // push
      outcome = "push";
    } else {
      payout = 0;
      outcome = "lose";
    }

    return {
      publicView: { playerCards: s.playerCards, dealerCards: s.dealerCards, outcome },
      actions: [],
      done: true,
      payout: Math.round(payout * 100) / 100,
      debit: boot, // the matched play stake
    };
  },
};
