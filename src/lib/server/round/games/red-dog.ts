import { type RoundGame, GameError } from "../engine";
import { makeDeck, rankValue, type Card } from "../../../cards";

// Server-authoritative Red Dog — mirrors src/games/red-dog.tsx (single deck).
//   Deal 2 cards. Pair → deal a 3rd: trips pays 11:1 (12×), else push (ante back).
//   Consecutive → push. Otherwise a SPREAD (ranks strictly between) is shown and
//   the player RAISES (matches the ante) or CALLS; the 3rd card must fall strictly
//   between to win, paying ratio:1 on the TOTAL wager. Spread→ratio: 1→5, 2→4,
//   3→2, 4+→1. The 3rd card is committed (hidden) at the deal, so the raise/call
//   choice can never influence it. Optimal: raise on spread >= 7. ~2.67% edge.

function ratioForSpread(sp: number): number {
  if (sp === 1) return 5;
  if (sp === 2) return 4;
  if (sp === 3) return 2;
  return 1; // 4+
}

interface RedDogState {
  ante: number;
  lo: number;
  hi: number;
  sp: number;
  card1: Card;
  card2: Card;
  third: Card;
}

export const redDogGame: RoundGame<RedDogState, Record<string, never>> = {
  slug: "red-dog",
  minBet: 5,
  maxBet: 1_000_000,
  validate: () => ({}),
  start: (ante, _params, rng) => {
    const deck = rng.shuffle(makeDeck(1));
    const card1 = deck[0];
    const card2 = deck[1];
    const third = deck[2]; // committed now, hidden until a decision
    const a = rankValue(card1.rank);
    const b = rankValue(card2.rank);
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const diff = hi - lo;

    if (diff === 0) {
      // Pair → third decides trips (11:1) vs push.
      const isTrips = rankValue(third.rank) === a;
      return {
        publicView: { card1, card2, third, outcome: isTrips ? "trips" : "push" },
        actions: [],
        done: true,
        payout: isTrips ? ante * 12 : ante,
      };
    }
    if (diff === 1) {
      return {
        publicView: { card1, card2, outcome: "push", consecutive: true },
        actions: [],
        done: true,
        payout: ante, // consecutive → push (ante returned)
      };
    }

    const sp = diff - 1;
    return {
      state: { ante, lo, hi, sp, card1, card2, third },
      publicView: { card1, card2, spread: sp }, // 3rd stays hidden
      actions: ["raise", "call"],
      done: false,
      payout: 0,
    };
  },
  act: (state, ante, action) => {
    const s = state as RedDogState;
    const resolve = (total: number, extraDebit: number) => {
      const mid = rankValue(s.third.rank);
      const between = mid > s.lo && mid < s.hi;
      const ratio = ratioForSpread(s.sp);
      const payout = between ? total * (ratio + 1) : 0;
      return {
        publicView: { card1: s.card1, card2: s.card2, third: s.third, spread: s.sp, ratio, outcome: between ? "win" : "lose" },
        actions: [] as string[],
        done: true,
        payout,
        debit: extraDebit,
      };
    };
    if (action === "call") return resolve(ante, 0);
    if (action === "raise") return resolve(ante * 2, ante); // doubles the wager
    throw new GameError("Invalid action");
  },
};
