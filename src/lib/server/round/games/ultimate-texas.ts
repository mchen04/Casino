import { type RoundGame, GameError } from "../engine";
import { nonNegInt, assert } from "../../engine";
import { evaluateBest, HandCategory, makeDeck, type Card } from "../../../cards";

// Server-authoritative Ultimate Texas Hold'em — mirrors src/games/ultimate-texas.tsx.
//   Ante + Blind (equal) + optional Trips side bet posted up front. One Play bet:
//   4x or 3x pre-flop, else 2x on the flop, else 1x on the river, or FOLD.
//   Showdown: best 5 of (hole+board) vs dealer. Dealer qualifies on a pair+.
//     PLAY  — 1:1 on win, push on tie, loses otherwise.
//     ANTE  — 1:1 on win (pushes if the dealer doesn't qualify), push on tie.
//     BLIND — bonus paytable on a win with a straight+ (else push), loses on loss.
//     TRIPS — pays on the player's final hand regardless of the result.
//   All cards are committed at the deal; decisions only size/time the Play bet.
//   ~2.2% house edge on the ante with correct play.

const BLIND_PAY: Partial<Record<HandCategory, number>> = {
  [HandCategory.RoyalFlush]: 500,
  [HandCategory.StraightFlush]: 50,
  [HandCategory.FourOfAKind]: 10,
  [HandCategory.FullHouse]: 3,
  [HandCategory.Flush]: 1.5,
  [HandCategory.Straight]: 1,
};
const TRIPS_PAY: Partial<Record<HandCategory, number>> = {
  [HandCategory.RoyalFlush]: 50,
  [HandCategory.StraightFlush]: 40,
  [HandCategory.FourOfAKind]: 30,
  [HandCategory.FullHouse]: 8,
  [HandCategory.Flush]: 6,
  [HandCategory.Straight]: 5,
  [HandCategory.ThreeOfAKind]: 3,
};
const blindRatio = (cat: HandCategory): number => BLIND_PAY[cat] ?? 0;
const tripsRatio = (cat: HandCategory): number => TRIPS_PAY[cat] ?? -1;

interface UTHParams {
  trips: number;
}
interface UTHState {
  playerHole: Card[];
  dealerHole: Card[];
  community: Card[];
  ante: number;
  trips: number;
  street: "preflop" | "flop" | "river";
}

function showdown(s: UTHState, finalPlay: number, folded: boolean): number {
  const pHand = evaluateBest([...s.playerHole, ...s.community]);
  const dHand = evaluateBest([...s.dealerHole, ...s.community]);
  const dealerQualified = dHand.category >= HandCategory.Pair;

  let payout = 0;
  // Trips — independent of fold / outcome.
  if (s.trips > 0) {
    const tr = tripsRatio(pHand.category);
    if (tr >= 0) payout += s.trips * (tr + 1);
  }
  if (folded) return Math.round(payout * 100) / 100; // ante + blind forfeited

  const cmp = pHand.score - dHand.score;
  const win = cmp > 0;
  const tie = cmp === 0;

  // PLAY — resolved on the hands alone, independent of the dealer qualifying.
  if (win) payout += finalPlay * 2;
  else if (tie) payout += finalPlay;
  // ANTE — pushes WHENEVER the dealer fails to qualify (even on a player loss);
  // otherwise it pays 1:1 on a win and pushes on a tie.
  if (!dealerQualified) payout += s.ante;
  else if (win) payout += s.ante * 2;
  else if (tie) payout += s.ante;
  // BLIND
  if (win) {
    const ratio = blindRatio(pHand.category);
    payout += ratio > 0 ? s.ante + s.ante * ratio : s.ante;
  } else if (tie) {
    payout += s.ante;
  }
  return Math.round(payout * 100) / 100;
}

function settleStep(s: UTHState, finalPlay: number, folded: boolean, debit?: number) {
  const pHand = evaluateBest([...s.playerHole, ...s.community]);
  const dHand = evaluateBest([...s.dealerHole, ...s.community]);
  return {
    publicView: {
      playerHole: s.playerHole,
      dealerHole: s.dealerHole,
      community: s.community,
      playerHand: pHand.name,
      dealerHand: dHand.name,
      dealerQualified: dHand.category >= HandCategory.Pair,
      folded,
      outcome: folded ? "fold" : pHand.score > dHand.score ? "win" : pHand.score === dHand.score ? "push" : "lose",
    },
    actions: [],
    done: true,
    payout: showdown(s, finalPlay, folded),
    debit,
  };
}

export const ultimateTexasGame: RoundGame<UTHState, UTHParams> = {
  slug: "ultimate-texas",
  minBet: 5,
  maxBet: 100_000,
  validate: (params) => {
    assert(params && typeof params === "object", "Missing params");
    return { trips: nonNegInt((params as Record<string, unknown>).trips, 1_000_000, "trips") };
  },
  start: (ante, { trips }, rng) => {
    const deck = rng.shuffle(makeDeck(1));
    const playerHole = [deck[0], deck[2]];
    const dealerHole = [deck[1], deck[3]];
    const community = [deck[4], deck[5], deck[6], deck[7], deck[8]];
    return {
      state: { playerHole, dealerHole, community, ante, trips, street: "preflop" },
      publicView: { playerHole },
      actions: ["bet4x", "bet3x", "check"],
      done: false,
      payout: 0,
      debit: ante + trips, // blind + trips alongside the ante (the base bet)
    };
  },
  act: (state, ante, action) => {
    const s = state as UTHState;

    if (s.street === "preflop") {
      if (action === "bet4x" || action === "bet3x") {
        const play = ante * (action === "bet4x" ? 4 : 3);
        return settleStep(s, play, false, play);
      }
      if (action === "check") {
        return {
          state: { ...s, street: "flop" as const },
          publicView: { playerHole: s.playerHole, community: s.community.slice(0, 3) },
          actions: ["bet2x", "check"],
          done: false,
          payout: 0,
        };
      }
      throw new GameError("Invalid action");
    }

    if (s.street === "flop") {
      if (action === "bet2x") {
        const play = ante * 2;
        return settleStep(s, play, false, play);
      }
      if (action === "check") {
        return {
          state: { ...s, street: "river" as const },
          publicView: { playerHole: s.playerHole, community: s.community },
          actions: ["bet1x", "fold"],
          done: false,
          payout: 0,
        };
      }
      throw new GameError("Invalid action");
    }

    // river
    if (action === "bet1x") return settleStep(s, ante, false, ante);
    if (action === "fold") return settleStep(s, 0, true);
    throw new GameError("Invalid action");
  },
};
