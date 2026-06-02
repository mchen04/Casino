import { type RoundGame, GameError } from "../engine";
import { rankValue, RANKS, SUITS, type Card } from "../../../cards";
import type { Rng } from "../../rngCore";

// Server-authoritative Hi-Lo — mirrors src/games/hi-lo.tsx's pricing.
//   Guess higher-or-same / strictly lower than the current card (Ace high). Each
//   correct guess multiplies the running payout by the fair step (1/p × (1-edge));
//   one wrong guess loses the bet. Cash out anytime to bank bet × mult.
//   Cards are drawn RANK-UNIFORM (with replacement), exactly matching the
//   rank-based odds the step pricing assumes → a clean 3% edge per guess.
//   Each card is drawn server-side at decision time, so it can't be predicted.

const HOUSE_EDGE = 0.03;
const RANK_COUNT = 13;

function odds(current: Card): { pHigher: number; pLower: number } {
  const v = rankValue(current.rank);
  return { pHigher: (15 - v) / RANK_COUNT, pLower: (v - 2) / RANK_COUNT };
}
function stepFor(p: number): number {
  return p <= 0 ? 0 : (1 / p) * (1 - HOUSE_EDGE);
}
function drawCard(rng: Rng, seq: number): Card {
  const rank = rng.pick(RANKS);
  const suit = rng.pick(SUITS);
  return { rank, suit, id: `${rank}${suit[0].toUpperCase()}#${seq}` };
}

interface HiLoState {
  current: Card;
  bet: number;
  mult: number;
  seq: number;
}

function viewFor(current: Card, mult: number, extra: Record<string, unknown> = {}) {
  const { pHigher, pLower } = odds(current);
  return { current, mult, pHigher, pLower, higherStep: stepFor(pHigher), lowerStep: stepFor(pLower), ...extra };
}

export const hiLoGame: RoundGame<HiLoState, Record<string, never>> = {
  slug: "hi-lo",
  minBet: 5,
  maxBet: 1_000_000,
  validate: () => ({}),
  start: (bet, _params, rng) => {
    const current = drawCard(rng, 0);
    return {
      state: { current, bet, mult: 1, seq: 1 },
      publicView: viewFor(current, 1),
      actions: ["higher", "lower", "cashout"],
      done: false,
      payout: 0,
    };
  },
  act: (state, bet, action, _payload, rng) => {
    const s = state as HiLoState;

    if (action === "cashout") {
      return { publicView: { mult: s.mult, cashedOut: true }, actions: [], done: true, payout: bet * s.mult };
    }
    if (action !== "higher" && action !== "lower") throw new GameError("Invalid action");

    const next = drawCard(rng, s.seq);
    const c = rankValue(s.current.rank);
    const n = rankValue(next.rank);
    const correct = action === "higher" ? n >= c : n < c;
    const { pHigher, pLower } = odds(s.current);

    if (!correct) {
      return { publicView: { revealed: next, busted: true, mult: s.mult }, actions: [], done: true, payout: 0 };
    }
    const p = action === "higher" ? pHigher : pLower;
    const mult = s.mult * stepFor(p);
    return {
      state: { current: next, bet, mult, seq: s.seq + 1 },
      publicView: viewFor(next, mult, { revealed: next, correct: true }),
      actions: ["higher", "lower", "cashout"],
      done: false,
      payout: 0,
    };
  },
};
