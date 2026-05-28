// Pure Pai Gow Poker hand-evaluation / house-way logic.
// Joker plumbing, 5-card (semi-wild) and 2-card evaluators, the high-beats-low
// foul check, and the "house way" auto-arrange. No React / wallet / DOM here.

import {
  type Card,
  type Rank,
  type Suit,
  type HandRank,
  HandCategory,
  RANKS,
  SUITS,
  rankValue,
  makeDeck,
  evaluate5,
} from "@/lib/cards";
import { shuffle } from "@/lib/rng";

export const JOKER_ID = "JOKER#0";

// ---------------------------------------------------------------------------
// Joker plumbing
// ---------------------------------------------------------------------------

/** The single joker card. Rank/suit are placeholders; identity is by id. */
export const JOKER: Card = { rank: "A", suit: "spades", id: JOKER_ID };

export function isJoker(c: Card): boolean {
  return c.id === JOKER_ID;
}

/** Build the 53-card Pai Gow deck: a standard deck + one joker, shuffled. */
export function makePaiGowDeck(): Card[] {
  return shuffle([...makeDeck(1), JOKER]);
}

// ---------------------------------------------------------------------------
// 5-card evaluation with semi-wild joker
// ---------------------------------------------------------------------------

const ALL_RANK_SUIT: { rank: Rank; suit: Suit }[] = (() => {
  const out: { rank: Rank; suit: Suit }[] = [];
  for (const rank of RANKS) for (const suit of SUITS) out.push({ rank, suit });
  return out;
})();

/**
 * Evaluate exactly 5 cards, substituting a joker (if present) to maximise the
 * hand. Pai Gow rule: joker only completes a straight/flush, otherwise it is
 * an Ace. We approximate this faithfully by trying every substitution and
 * keeping the best — for straights/flushes that yields the completed hand;
 * for everything else, substituting the missing Ace (Ace-high / pair of aces)
 * is always the best non-straight/flush result, matching the rule.
 */
export function evalFive(cards: Card[]): HandRank {
  const jokerIdx = cards.findIndex(isJoker);
  if (jokerIdx === -1) return evaluate5(cards);

  // Cards already on the table (excluding the joker) constrain which physical
  // card the joker could "be", but for ranking we only care about rank/suit
  // achievable — duplicates of an existing card are impossible, so skip them.
  const present = new Set(
    cards.filter((c) => !isJoker(c)).map((c) => `${c.rank}|${c.suit}`),
  );

  let best: HandRank | null = null;
  for (const sub of ALL_RANK_SUIT) {
    if (present.has(`${sub.rank}|${sub.suit}`)) continue;
    const trial = cards.slice();
    trial[jokerIdx] = { rank: sub.rank, suit: sub.suit, id: "JOKER-SUB" };
    const r = evaluate5(trial);
    if (!best || r.score > best.score) best = r;
  }
  // Fallback (should never trigger): joker as plain Ace of an unused suit.
  if (!best) best = evaluate5(cards.map((c) => (isJoker(c) ? { ...JOKER } : c)));
  return best;
}

// ---------------------------------------------------------------------------
// 2-card (low) evaluation — pair beats high card; joker plays as an Ace.
// ---------------------------------------------------------------------------

export interface LowRank {
  pair: boolean;
  /** Sorted high values for tiebreak (most significant first). */
  tiebreak: number[];
  score: number;
  label: string;
}

function lowValue(c: Card): number {
  // In a 2-card hand the joker is always an Ace (it can never make a
  // straight/flush of length 2 that beats a pair).
  return isJoker(c) ? 14 : rankValue(c.rank);
}

function rankLabel(v: number): string {
  const map: Record<number, string> = {
    14: "A",
    13: "K",
    12: "Q",
    11: "J",
    10: "10",
  };
  return map[v] ?? String(v);
}

export function evalLow(cards: Card[]): LowRank {
  const vals = cards.map(lowValue).sort((a, b) => b - a);
  const pair = vals[0] === vals[1];
  // pair flag dominates, then high values.
  const score = (pair ? 1 : 0) * 1_000_000 + vals[0] * 1000 + (vals[1] ?? 0);
  const label = pair
    ? `Pair of ${rankLabel(vals[0])}s`
    : `${rankLabel(vals[0])} High`;
  return { pair, tiebreak: vals, score, label };
}

// ---------------------------------------------------------------------------
// House Way — arrange 7 cards into a legal { high(5), low(2) } split.
// ---------------------------------------------------------------------------

export interface Split {
  high: Card[]; // 5
  low: Card[]; // 2
}

/** All ways to choose the 2 low cards (then the rest are high). */
function* lowChoices(cards: Card[]): Generator<Split> {
  for (let i = 0; i < cards.length; i++) {
    for (let j = i + 1; j < cards.length; j++) {
      const low = [cards[i], cards[j]];
      const high = cards.filter((_, k) => k !== i && k !== j);
      yield { high, low };
    }
  }
}

/** A split is legal iff the 5-card high hand strictly outranks the 2-card low. */
function isLegal(split: Split): boolean {
  const h = evalFive(split.high);
  const l = evalLow(split.low);
  // Compare across hand types: any made 5-card hand (pair+) clearly beats a
  // 2-card hand, but high-card-vs-high-card and pair-vs-pair need value checks.
  return highBeatsLow(h, l);
}

/**
 * Does the 5-card HIGH hand outrank the 2-card LOW hand? The low hand can only
 * be a pair or high card, so we compare on that footing.
 */
export function highBeatsLow(high: HandRank, low: LowRank): boolean {
  const highIsPairPlus = high.category >= HandCategory.Pair;
  if (highIsPairPlus && !low.pair) return true; // pair+ beats any 2-card high card
  if (!highIsPairPlus && low.pair) return false; // 5-card high card loses to a low pair (foul)

  if (high.category === HandCategory.Pair && low.pair) {
    // Compare the pair ranks: high hand's pair value vs low pair value.
    const highPair = high.tiebreak[0];
    const lowPair = low.tiebreak[0];
    return highPair > lowPair; // equal -> not strictly greater -> foul
  }
  if (!highIsPairPlus && !low.pair) {
    // Both high card: compare top card of each.
    return high.tiebreak[0] > low.tiebreak[0];
  }
  // high is two-pair+ (>= TwoPair) vs low pair -> high wins.
  return true;
}

const STRENGTH = (c: Card) => (isJoker(c) ? 15 : rankValue(c.rank));

/**
 * House Way: find the legal split whose HIGH hand is strongest, while keeping
 * the LOW hand as strong as possible without fouling. This mirrors the common
 * casino heuristic: keep the best 5-card hand in back, push the two highest
 * remaining to the front — never fouling.
 */
export function houseWay(cards: Card[]): Split {
  let best: { split: Split; highScore: number; lowScore: number } | null = null;
  for (const split of lowChoices(cards)) {
    if (!isLegal(split)) continue;
    const highScore = evalFive(split.high).score;
    const lowScore = evalLow(split.low).score;
    if (
      !best ||
      highScore > best.highScore ||
      (highScore === best.highScore && lowScore > best.lowScore)
    ) {
      best = { split, highScore, lowScore };
    }
  }
  // Guaranteed at least one legal split exists for any 7 cards (e.g. best 5 in
  // back, two lowest in front). Fallback keeps TS happy.
  if (best) return sortSplit(best.split);
  const sorted = [...cards].sort((a, b) => STRENGTH(b) - STRENGTH(a));
  return sortSplit({ high: sorted.slice(0, 5), low: sorted.slice(5, 7) });
}

/** Sort each sub-hand high→low for stable, readable display. */
function sortSplit(split: Split): Split {
  return {
    high: [...split.high].sort((a, b) => STRENGTH(b) - STRENGTH(a)),
    low: [...split.low].sort((a, b) => STRENGTH(b) - STRENGTH(a)),
  };
}
