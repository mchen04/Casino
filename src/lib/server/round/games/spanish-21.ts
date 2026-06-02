import { type RoundGame, RoundStep, GameError } from "../engine";
import { makeDeck, blackjackTotal, type Card } from "../../../cards";

// Server-authoritative Spanish 21 — mirrors src/games/spanish-21.tsx, with the
// CORRECT (Wizard of Odds) bonus payouts.
//   • 6 Spanish decks: a 52-card deck with every rank-"10" spot card removed
//     (J/Q/K stay), 288 cards. Dealer STANDS on all 17 (S17). Dealer peeks.
//   • A player total of 21 ALWAYS wins; a 2-card player 21 (blackjack) BEATS the
//     dealer's blackjack and pays 3:2. Double on any number of cards; split up
//     to 4 hands (split aces are playable). No insurance/surrender.
//   • Bonus 21s (only when NOT doubled and NOT from a split): 5-card 21 → 3:2,
//     6-card → 2:1, 7+-card → 3:1; 6-7-8 / 7-7-7 mixed → 3:2, same-suit → 2:1,
//     spades → 3:1. The bonus odds REPLACE even money (they are not added to it)
//     and are void on a doubled or split hand. ~0.4% house edge with S17.

const isBJ = (cards: Card[]) => cards.length === 2 && blackjackTotal(cards).total === 21;

function spanishShoe(decks: number): Card[] {
  return makeDeck(decks).filter((c) => c.rank !== "10");
}

/** Bonus multiplier on a winning player 21 (0 = none). Void after split/double. */
function bonusMult(cards: Card[], fromSplit: boolean, doubled: boolean): number {
  if (fromSplit || doubled) return 0;
  if (blackjackTotal(cards).total !== 21) return 0;
  if (cards.length === 3) {
    const ranks = cards.map((c) => c.rank).sort();
    const suits = cards.map((c) => c.suit);
    const allSpades = suits.every((s) => s === "spades");
    const sameSuit = suits.every((s) => s === suits[0]);
    const is678 = ranks.join() === ["6", "7", "8"].sort().join();
    const is777 = ranks.every((r) => r === "7");
    if (is678 || is777) return allSpades ? 3 : sameSuit ? 2 : 1.5;
  }
  if (cards.length >= 7) return 3;
  if (cards.length === 6) return 2;
  if (cards.length === 5) return 1.5;
  return 0;
}

interface S21Hand {
  cards: Card[];
  bet: number;
  done: boolean;
  doubled: boolean;
  fromSplit: boolean;
}
interface S21State {
  shoe: Card[];
  dealer: Card[]; // [up, hole]
  hands: S21Hand[];
  active: number;
  bet: number;
}

const DECKS = 6;

function handActions(s: S21State): string[] {
  const h = s.hands[s.active];
  if (!h || h.done) return [];
  const acts = ["hit", "stand", "double"]; // double allowed on any number of cards
  if (
    h.cards.length === 2 &&
    h.cards[0].rank === h.cards[1].rank &&
    s.hands.length < 4
  ) {
    acts.push("split");
  }
  return acts;
}

const handView = (h: S21Hand) => ({
  cards: h.cards,
  bet: h.bet,
  done: h.done,
  doubled: h.doubled,
  fromSplit: h.fromSplit,
  total: blackjackTotal(h.cards).total,
});

const playView = (s: S21State): Record<string, unknown> => ({
  playerHands: s.hands.map(handView),
  dealerUp: s.dealer[0],
  active: s.active,
});

/** Dealer draws to >= 17, standing on ALL 17 incl. soft (S17). */
function dealerDrawOut(shoe: Card[], dealer: Card[]): Card[] {
  const d = [...dealer];
  const s = [...shoe];
  let guard = 0;
  while (guard++ < 40 && blackjackTotal(d).total < 17) d.push(s.shift() as Card);
  return d;
}

/** Per-hand payout for a fully-played round (naturals handled separately). */
function settleHands(hands: S21Hand[], dealer: Card[]): { payout: number; outcomes: string[] } {
  const dTotal = blackjackTotal(dealer).total;
  const dBust = dTotal > 21;
  let payout = 0;
  const outcomes: string[] = [];
  for (const h of hands) {
    const pTotal = blackjackTotal(h.cards).total;
    let outcome: string;
    let pay = 0;
    if (pTotal > 21) {
      outcome = "bust";
    } else if (pTotal === 21) {
      // A player 21 ALWAYS wins; a bonus (if any) replaces even money.
      const mult = bonusMult(h.cards, h.fromSplit, h.doubled);
      outcome = mult > 0 ? "bonus" : "twentyone";
      pay = mult > 0 ? h.bet * (1 + mult) : h.bet * 2;
    } else if (dBust) {
      outcome = "win";
      pay = h.bet * 2;
    } else if (pTotal > dTotal) {
      outcome = "win";
      pay = h.bet * 2;
    } else if (pTotal < dTotal) {
      outcome = "lose";
    } else {
      outcome = "push";
      pay = h.bet;
    }
    payout += pay;
    outcomes.push(outcome);
  }
  return { payout: Math.round(payout * 100) / 100, outcomes };
}

/** All hands done → play the dealer (if any live hand) and settle. */
function finishRound(s: S21State, debit?: number): RoundStep<S21State> {
  const anyLive = s.hands.some((h) => blackjackTotal(h.cards).total <= 21);
  const dealer = anyLive ? dealerDrawOut(s.shoe, s.dealer) : s.dealer;
  const { payout, outcomes } = settleHands(s.hands, dealer);
  return {
    publicView: { playerHands: s.hands.map(handView), dealer, outcomes },
    actions: [],
    done: true,
    payout,
    debit,
  };
}

function advance(s: S21State, debit?: number): RoundStep<S21State> {
  let next = s.active;
  while (next < s.hands.length && s.hands[next].done) next++;
  if (next < s.hands.length) {
    const ns = { ...s, active: next };
    return { state: ns, publicView: playView(ns), actions: handActions(ns), done: false, payout: 0, debit };
  }
  return finishRound(s, debit);
}

export const spanish21Game: RoundGame<S21State, Record<string, never>> = {
  slug: "spanish-21",
  minBet: 5,
  maxBet: 100_000, // base bet; splits/doubles debit incrementally and re-check balance
  validate: () => ({}),
  start: (bet, _params, rng) => {
    const shoe = rng.shuffle(spanishShoe(DECKS));
    const p1 = shoe.shift() as Card;
    const d1 = shoe.shift() as Card;
    const p2 = shoe.shift() as Card;
    const d2 = shoe.shift() as Card;
    const dealer = [d1, d2];
    const hand: S21Hand = { cards: [p1, p2], bet, done: false, doubled: false, fromSplit: false };
    const base: S21State = { shoe, dealer, hands: [hand], active: 0, bet };

    // Dealer peek + player natural resolved at the deal.
    const playerBJ = isBJ([p1, p2]);
    const dealerBJ = isBJ(dealer);
    if (playerBJ) {
      // Player blackjack always wins (beats a dealer blackjack), pays 3:2.
      return {
        publicView: { playerHands: [handView(hand)], dealer, outcomes: ["blackjack"] },
        actions: [],
        done: true,
        payout: bet * 2.5,
      };
    }
    if (dealerBJ) {
      return {
        publicView: { playerHands: [handView(hand)], dealer, outcomes: ["lose"] },
        actions: [],
        done: true,
        payout: 0,
      };
    }
    return { state: base, publicView: playView(base), actions: handActions(base), done: false, payout: 0 };
  },
  act: (state, _bet, action) => {
    const s = state as S21State;
    const idx = s.active;
    const hand = s.hands[idx];
    if (!hand || hand.done) throw new GameError("No active hand");

    if (action === "hit") {
      const shoe = [...s.shoe];
      const cards = [...hand.cards, shoe.shift() as Card];
      const done = blackjackTotal(cards).total >= 21; // 21 always wins → auto-stand
      const hands = s.hands.map((h, i) => (i === idx ? { ...h, cards, done } : h));
      const ns: S21State = { ...s, shoe, hands };
      if (done) return advance(ns);
      return { state: ns, publicView: playView(ns), actions: handActions(ns), done: false, payout: 0 };
    }

    if (action === "stand") {
      const hands = s.hands.map((h, i) => (i === idx ? { ...h, done: true } : h));
      return advance({ ...s, hands });
    }

    if (action === "double") {
      if (blackjackTotal(hand.cards).total >= 21) throw new GameError("Cannot double");
      const shoe = [...s.shoe];
      const cards = [...hand.cards, shoe.shift() as Card];
      const hands = s.hands.map((h, i) =>
        i === idx ? { ...h, cards, bet: h.bet * 2, doubled: true, done: true } : h,
      );
      return advance({ ...s, shoe, hands }, hand.bet); // debit the doubled portion
    }

    if (action === "split") {
      if (hand.cards.length !== 2 || hand.cards[0].rank !== hand.cards[1].rank)
        throw new GameError("Cannot split this hand");
      if (s.hands.length >= 4) throw new GameError("Maximum hands reached");
      const shoe = [...s.shoe];
      const left = shoe.shift() as Card;
      const right = shoe.shift() as Card;
      const handA: S21Hand = { cards: [hand.cards[0], left], bet: hand.bet, done: false, doubled: false, fromSplit: true };
      const handB: S21Hand = { cards: [hand.cards[1], right], bet: hand.bet, done: false, doubled: false, fromSplit: true };
      // A split hand that immediately makes 21 auto-stands (still wins, no bonus).
      handA.done = blackjackTotal(handA.cards).total >= 21;
      handB.done = blackjackTotal(handB.cards).total >= 21;
      const hands = [...s.hands.slice(0, idx), handA, handB, ...s.hands.slice(idx + 1)];
      const ns: S21State = { ...s, shoe, hands };
      if (handA.done) return advance(ns, hand.bet); // active hand finished at the split
      return { state: ns, publicView: playView(ns), actions: handActions(ns), done: false, payout: 0, debit: hand.bet };
    }

    throw new GameError("Invalid action");
  },
};
