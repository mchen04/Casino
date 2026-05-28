// Playing-card primitives + a poker hand evaluator shared by every card game.

import { shuffle } from "./rng";

export type Suit = "spades" | "hearts" | "diamonds" | "clubs";
export type Rank =
  | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "10"
  | "J" | "Q" | "K" | "A";

export interface Card {
  rank: Rank;
  suit: Suit;
  /** Stable unique id across a (possibly multi-deck) shoe, e.g. "AH#0". */
  id: string;
}

export const SUITS: Suit[] = ["spades", "hearts", "diamonds", "clubs"];
export const RANKS: Rank[] = [
  "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A",
];

export const SUIT_SYMBOL: Record<Suit, string> = {
  spades: "♠",
  hearts: "♥",
  diamonds: "♦",
  clubs: "♣",
};

export const SUIT_COLOR: Record<Suit, "red" | "black"> = {
  spades: "black",
  clubs: "black",
  hearts: "red",
  diamonds: "red",
};

/** Poker rank value, Ace high (A=14). */
export function rankValue(rank: Rank): number {
  switch (rank) {
    case "A":
      return 14;
    case "K":
      return 13;
    case "Q":
      return 12;
    case "J":
      return 11;
    case "10":
      return 10;
    default:
      return parseInt(rank, 10);
  }
}

/** Blackjack value of a single card (Ace counted as 11; caller demotes to 1). */
export function blackjackValue(rank: Rank): number {
  if (rank === "A") return 11;
  if (rank === "K" || rank === "Q" || rank === "J") return 10;
  return parseInt(rank, 10);
}

/** Best blackjack total for a hand, demoting aces from 11→1 as needed. */
export function blackjackTotal(cards: Card[]): { total: number; soft: boolean } {
  let total = 0;
  let aces = 0;
  for (const c of cards) {
    total += blackjackValue(c.rank);
    if (c.rank === "A") aces++;
  }
  let soft = aces > 0;
  while (total > 21 && aces > 0) {
    total -= 10;
    aces--;
    soft = aces > 0 && total <= 21;
  }
  return { total, soft: soft && total <= 21 };
}

/** Build a fresh, ORDERED shoe of `decks` 52-card decks (not shuffled). */
export function makeDeck(decks = 1): Card[] {
  const cards: Card[] = [];
  for (let d = 0; d < decks; d++) {
    for (const suit of SUITS) {
      for (const rank of RANKS) {
        cards.push({ rank, suit, id: `${rank}${suit[0].toUpperCase()}#${d}` });
      }
    }
  }
  return cards;
}

/** Build and shuffle a shoe in one call. */
export function makeShoe(decks = 1): Card[] {
  return shuffle(makeDeck(decks));
}

// ----------------------------------------------------------------------------
// Poker hand evaluation
// ----------------------------------------------------------------------------

export enum HandCategory {
  HighCard = 0,
  Pair = 1,
  TwoPair = 2,
  ThreeOfAKind = 3,
  Straight = 4,
  Flush = 5,
  FullHouse = 6,
  FourOfAKind = 7,
  StraightFlush = 8,
  RoyalFlush = 9,
}

export const HAND_NAMES: Record<HandCategory, string> = {
  [HandCategory.HighCard]: "High Card",
  [HandCategory.Pair]: "Pair",
  [HandCategory.TwoPair]: "Two Pair",
  [HandCategory.ThreeOfAKind]: "Three of a Kind",
  [HandCategory.Straight]: "Straight",
  [HandCategory.Flush]: "Flush",
  [HandCategory.FullHouse]: "Full House",
  [HandCategory.FourOfAKind]: "Four of a Kind",
  [HandCategory.StraightFlush]: "Straight Flush",
  [HandCategory.RoyalFlush]: "Royal Flush",
};

export interface HandRank {
  category: HandCategory;
  name: string;
  /** Tiebreaker vector, most significant first. Compare lexicographically. */
  tiebreak: number[];
  /** Single comparable score (higher is better). */
  score: number;
}

function tiebreakToScore(category: HandCategory, tiebreak: number[]): number {
  // Pack into a single base-15 number: category is most significant.
  let score = category;
  for (let i = 0; i < 5; i++) {
    score = score * 15 + (tiebreak[i] ?? 0);
  }
  return score;
}

/** Evaluate exactly 5 cards. */
export function evaluate5(cards: Card[]): HandRank {
  if (cards.length !== 5) {
    throw new Error(`evaluate5 expects 5 cards, got ${cards.length}`);
  }
  const values = cards.map((c) => rankValue(c.rank)).sort((a, b) => b - a);
  const suits = cards.map((c) => c.suit);
  const isFlush = suits.every((s) => s === suits[0]);

  // Count occurrences of each value.
  const counts = new Map<number, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  // Sort distinct values by (count desc, value desc).
  const byCount = [...counts.entries()].sort((a, b) =>
    b[1] - a[1] || b[0] - a[0],
  );

  // Straight detection (incl. wheel A-2-3-4-5).
  const distinct = [...new Set(values)].sort((a, b) => b - a);
  let straightHigh = 0;
  if (distinct.length === 5) {
    if (distinct[0] - distinct[4] === 4) straightHigh = distinct[0];
    else if (
      distinct[0] === 14 &&
      distinct[1] === 5 &&
      distinct[2] === 4 &&
      distinct[3] === 3 &&
      distinct[4] === 2
    ) {
      straightHigh = 5; // wheel
    }
  }
  const isStraight = straightHigh > 0;

  let category: HandCategory;
  let tiebreak: number[];

  if (isStraight && isFlush) {
    category = straightHigh === 14 ? HandCategory.RoyalFlush : HandCategory.StraightFlush;
    tiebreak = [straightHigh];
  } else if (byCount[0][1] === 4) {
    category = HandCategory.FourOfAKind;
    tiebreak = [byCount[0][0], byCount[1][0]];
  } else if (byCount[0][1] === 3 && byCount[1][1] === 2) {
    category = HandCategory.FullHouse;
    tiebreak = [byCount[0][0], byCount[1][0]];
  } else if (isFlush) {
    category = HandCategory.Flush;
    tiebreak = values;
  } else if (isStraight) {
    category = HandCategory.Straight;
    tiebreak = [straightHigh];
  } else if (byCount[0][1] === 3) {
    category = HandCategory.ThreeOfAKind;
    tiebreak = [byCount[0][0], ...byCount.slice(1).map((e) => e[0])];
  } else if (byCount[0][1] === 2 && byCount[1][1] === 2) {
    category = HandCategory.TwoPair;
    const highPair = Math.max(byCount[0][0], byCount[1][0]);
    const lowPair = Math.min(byCount[0][0], byCount[1][0]);
    const kicker = byCount[2][0];
    tiebreak = [highPair, lowPair, kicker];
  } else if (byCount[0][1] === 2) {
    category = HandCategory.Pair;
    tiebreak = [byCount[0][0], ...byCount.slice(1).map((e) => e[0])];
  } else {
    category = HandCategory.HighCard;
    tiebreak = values;
  }

  return {
    category,
    name: HAND_NAMES[category],
    tiebreak,
    score: tiebreakToScore(category, tiebreak),
  };
}

function combinations<T>(arr: T[], k: number): T[][] {
  const result: T[][] = [];
  const combo: T[] = [];
  const recurse = (start: number) => {
    if (combo.length === k) {
      result.push(combo.slice());
      return;
    }
    for (let i = start; i < arr.length; i++) {
      combo.push(arr[i]);
      recurse(i + 1);
      combo.pop();
    }
  };
  recurse(0);
  return result;
}

/** Best 5-card hand out of N cards (5,6 or 7). Returns rank + the 5 cards used. */
export function evaluateBest(cards: Card[]): HandRank & { best: Card[] } {
  if (cards.length < 5) throw new Error("evaluateBest needs >= 5 cards");
  if (cards.length === 5) return { ...evaluate5(cards), best: cards };
  let best: (HandRank & { best: Card[] }) | null = null;
  for (const combo of combinations(cards, 5)) {
    const rank = evaluate5(combo);
    if (!best || rank.score > best.score) best = { ...rank, best: combo };
  }
  return best!;
}

/** Compare two hands. >0 if a wins, <0 if b wins, 0 tie. */
export function compareHands(a: HandRank, b: HandRank): number {
  return a.score - b.score;
}

// ----------------------------------------------------------------------------
// Three-card poker ranking (distinct from 5-card; flush beats straight wins...
// actually in 3-card a STRAIGHT beats a FLUSH due to probabilities).
// Category order: StraightFlush > ThreeOfAKind > Straight > Flush > Pair > High.
// ----------------------------------------------------------------------------

export enum ThreeCardCategory {
  HighCard = 0,
  Pair = 1,
  Flush = 2,
  Straight = 3,
  ThreeOfAKind = 4,
  StraightFlush = 5,
}

export const THREE_CARD_NAMES: Record<ThreeCardCategory, string> = {
  [ThreeCardCategory.HighCard]: "High Card",
  [ThreeCardCategory.Pair]: "Pair",
  [ThreeCardCategory.Flush]: "Flush",
  [ThreeCardCategory.Straight]: "Straight",
  [ThreeCardCategory.ThreeOfAKind]: "Three of a Kind",
  [ThreeCardCategory.StraightFlush]: "Straight Flush",
};

export interface ThreeCardRank {
  category: ThreeCardCategory;
  name: string;
  tiebreak: number[];
  score: number;
}

export function evaluate3(cards: Card[]): ThreeCardRank {
  if (cards.length !== 3) throw new Error("evaluate3 expects 3 cards");
  const values = cards.map((c) => rankValue(c.rank)).sort((a, b) => b - a);
  const suits = cards.map((c) => c.suit);
  const isFlush = suits.every((s) => s === suits[0]);

  const distinct = [...new Set(values)].sort((a, b) => b - a);
  let straightHigh = 0;
  if (distinct.length === 3) {
    if (distinct[0] - distinct[2] === 2) straightHigh = distinct[0];
    else if (distinct[0] === 14 && distinct[1] === 3 && distinct[2] === 2)
      straightHigh = 3; // A-2-3 wheel
  }
  const isStraight = straightHigh > 0;
  const isTrips = distinct.length === 1;

  let category: ThreeCardCategory;
  let tiebreak: number[];

  if (isStraight && isFlush) {
    category = ThreeCardCategory.StraightFlush;
    tiebreak = [straightHigh];
  } else if (isTrips) {
    category = ThreeCardCategory.ThreeOfAKind;
    tiebreak = [values[0]];
  } else if (isStraight) {
    category = ThreeCardCategory.Straight;
    tiebreak = [straightHigh];
  } else if (isFlush) {
    category = ThreeCardCategory.Flush;
    tiebreak = values;
  } else if (values[0] === values[1] || values[1] === values[2]) {
    category = ThreeCardCategory.Pair;
    const pairVal = values[0] === values[1] ? values[0] : values[1];
    const kicker = values[0] === values[1] ? values[2] : values[0];
    tiebreak = [pairVal, kicker];
  } else {
    category = ThreeCardCategory.HighCard;
    tiebreak = values;
  }

  let score = category;
  for (let i = 0; i < 3; i++) score = score * 15 + (tiebreak[i] ?? 0);

  return { category, name: THREE_CARD_NAMES[category], tiebreak, score };
}
