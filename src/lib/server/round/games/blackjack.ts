import { type RoundGame, RoundStep, GameError } from "../engine";
import { makeShoe, blackjackTotal, type Card } from "../../../cards";

// Server-authoritative Blackjack — mirrors src/games/blackjack.tsx.
//   6 decks, dealer STANDS on all 17 (S17), blackjack pays 3:2, double on any
//   two cards, split up to 4 hands (split aces get one card each and stand),
//   insurance pays 2:1, dealer peeks for a natural. Each round draws from a
//   freshly shuffled 6-deck shoe persisted in the round state, so every card the
//   client shows was dealt by the server. No surrender (not offered by the UI).
//   Basic strategy → ~0.5% house edge (6-deck, S17, DAS).

const DECKS = 6;
const isBJ = (cards: Card[]) => cards.length === 2 && blackjackTotal(cards).total === 21;

interface BJHand {
  cards: Card[];
  bet: number;
  done: boolean;
  doubled: boolean;
  isSplitAces: boolean;
}
interface BJState {
  shoe: Card[];
  dealer: Card[]; // [up, hole]
  hands: BJHand[];
  active: number;
  bet: number;
  insurance: number;
  awaitingInsurance: boolean;
}

function handActions(s: BJState): string[] {
  const h = s.hands[s.active];
  const acts = ["hit", "stand"];
  if (h && h.cards.length === 2 && !h.done) {
    acts.push("double");
    if (h.cards[0].rank === h.cards[1].rank && s.hands.length < 4) acts.push("split");
  }
  return acts;
}

const handView = (h: BJHand) => ({
  cards: h.cards,
  bet: h.bet,
  done: h.done,
  doubled: h.doubled,
  total: blackjackTotal(h.cards).total,
});

function playView(s: BJState): Record<string, unknown> {
  return {
    playerHands: s.hands.map(handView),
    dealerUp: s.dealer[0],
    active: s.active,
    insurance: s.insurance,
  };
}

/** Dealer draws to >= 17, standing on all 17 (S17). */
function dealerDrawOut(shoe: Card[], dealer: Card[]): { dealer: Card[]; shoe: Card[] } {
  const d = [...dealer];
  const s = [...shoe];
  let guard = 0;
  while (guard++ < 25 && blackjackTotal(d).total < 17) d.push(s.shift() as Card);
  return { dealer: d, shoe: s };
}

/** Compute total payout + per-hand outcomes for a fully-resolved round. */
function settle(
  hands: BJHand[],
  dealer: Card[],
  naturalsCheck: boolean,
  insBet: number,
): { payout: number; outcomes: string[] } {
  const dealerTotal = blackjackTotal(dealer).total;
  const dealerBJ = isBJ(dealer);
  const dealerBust = dealerTotal > 21;
  let payout = 0;
  const outcomes: string[] = [];
  for (const h of hands) {
    const pTotal = blackjackTotal(h.cards).total;
    const pBJ = naturalsCheck && isBJ(h.cards) && hands.length === 1 && !h.doubled;
    let outcome: string;
    let pay = 0;
    if (pTotal > 21) outcome = "bust";
    else if (pBJ && dealerBJ) {
      outcome = "push";
      pay = h.bet;
    } else if (pBJ) {
      outcome = "blackjack";
      pay = h.bet * 2.5; // 3:2 incl. stake
    } else if (dealerBJ) outcome = "lose";
    else if (dealerBust) {
      outcome = "win";
      pay = h.bet * 2;
    } else if (pTotal > dealerTotal) {
      outcome = "win";
      pay = h.bet * 2;
    } else if (pTotal < dealerTotal) outcome = "lose";
    else {
      outcome = "push";
      pay = h.bet;
    }
    payout += pay;
    outcomes.push(outcome);
  }
  if (insBet > 0 && dealerBJ) payout += insBet * 3; // insurance 2:1 (stake + 2x)
  return { payout: Math.round(payout * 100) / 100, outcomes };
}

/** All player hands are done — play the dealer (if needed) and settle. */
function finishRound(s: BJState, debit?: number): RoundStep<BJState> {
  const anyLive = s.hands.some((h) => blackjackTotal(h.cards).total <= 21);
  let dealer = s.dealer;
  if (anyLive) dealer = dealerDrawOut(s.shoe, s.dealer).dealer;
  const { payout, outcomes } = settle(s.hands, dealer, false, s.insurance);
  return {
    publicView: { playerHands: s.hands.map(handView), dealer, outcomes, insurance: s.insurance },
    actions: [],
    done: true,
    payout,
    debit,
  };
}

/** Advance to the next live hand, or finish the round if none remain. */
function advance(s: BJState, debit?: number): RoundStep<BJState> {
  let next = s.active;
  while (next < s.hands.length && s.hands[next].done) next++;
  if (next < s.hands.length) {
    const ns = { ...s, active: next };
    return { state: ns, publicView: playView(ns), actions: handActions(ns), done: false, payout: 0, debit };
  }
  return finishRound(s, debit);
}

/** Settle naturals at the deal (dealer peek) — single hand, 2 cards. */
function settleNaturals(s: BJState, insBet: number): RoundStep<BJState> {
  const { payout, outcomes } = settle(s.hands, s.dealer, true, insBet);
  return {
    publicView: { playerHands: s.hands.map(handView), dealer: s.dealer, outcomes, insurance: insBet },
    actions: [],
    done: true,
    payout,
    debit: insBet > 0 ? insBet : undefined,
  };
}

export const blackjackGame: RoundGame<BJState, Record<string, never>> = {
  slug: "blackjack",
  minBet: 5,
  maxBet: 100_000, // base bet; splits/doubles debit incrementally and re-check balance
  validate: () => ({}),
  start: (bet, _params, rng) => {
    const shoe = rng.shuffle(makeShoe(DECKS));
    const p1 = shoe.shift() as Card;
    const d1 = shoe.shift() as Card;
    const p2 = shoe.shift() as Card;
    const d2 = shoe.shift() as Card;
    const dealer = [d1, d2];
    const hand: BJHand = { cards: [p1, p2], bet, done: false, doubled: false, isSplitAces: false };
    const base: BJState = { shoe, dealer, hands: [hand], active: 0, bet, insurance: 0, awaitingInsurance: false };

    // Insurance offer when the dealer shows an Ace.
    if (d1.rank === "A") {
      const ns = { ...base, awaitingInsurance: true };
      return {
        state: ns,
        publicView: { playerHands: [handView(hand)], dealerUp: d1, awaitingInsurance: true },
        actions: ["insurance", "decline"],
        done: false,
        payout: 0,
      };
    }

    // Dealer peek / player natural → settle at the deal.
    if (isBJ([p1, p2]) || isBJ(dealer)) return settleNaturals(base, 0);

    return { state: base, publicView: playView(base), actions: handActions(base), done: false, payout: 0 };
  },
  act: (state, bet, action, _payload) => {
    const s = state as BJState;

    // ---- Insurance decision ----
    if (s.awaitingInsurance) {
      if (action !== "insurance" && action !== "decline") throw new GameError("Invalid action");
      const insurance = action === "insurance" ? Math.floor(s.bet / 2) : 0;
      const ns: BJState = { ...s, insurance, awaitingInsurance: false };
      if (isBJ(s.dealer) || isBJ(s.hands[0].cards)) return settleNaturals(ns, insurance);
      return {
        state: ns,
        publicView: playView(ns),
        actions: handActions(ns),
        done: false,
        payout: 0,
        debit: insurance > 0 ? insurance : undefined,
      };
    }

    // ---- Player action ----
    const idx = s.active;
    const hand = s.hands[idx];
    if (!hand || hand.done) throw new GameError("No active hand");

    if (action === "hit") {
      const shoe = [...s.shoe];
      const cards = [...hand.cards, shoe.shift() as Card];
      const done = blackjackTotal(cards).total >= 21;
      const hands = s.hands.map((h, i) => (i === idx ? { ...h, cards, done } : h));
      const ns: BJState = { ...s, shoe, hands };
      if (done) return advance(ns);
      return { state: ns, publicView: playView(ns), actions: handActions(ns), done: false, payout: 0 };
    }

    if (action === "stand") {
      const hands = s.hands.map((h, i) => (i === idx ? { ...h, done: true } : h));
      return advance({ ...s, hands });
    }

    if (action === "double") {
      if (hand.cards.length !== 2) throw new GameError("Double allowed on two cards only");
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
      const splittingAces = hand.cards[0].rank === "A";
      const handA: BJHand = { cards: [hand.cards[0], left], bet: hand.bet, done: splittingAces, doubled: false, isSplitAces: splittingAces };
      const handB: BJHand = { cards: [hand.cards[1], right], bet: hand.bet, done: splittingAces, doubled: false, isSplitAces: splittingAces };
      const hands = [...s.hands.slice(0, idx), handA, handB, ...s.hands.slice(idx + 1)];
      const ns: BJState = { ...s, shoe, hands };
      if (splittingAces) return advance(ns, hand.bet); // both hands auto-stand
      return { state: ns, publicView: playView(ns), actions: handActions(ns), done: false, payout: 0, debit: hand.bet };
    }

    throw new GameError("Invalid action");
  },
};
