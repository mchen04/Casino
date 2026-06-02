import { type RoundGame, GameError } from "../engine";
import { num, assert } from "../../engine";
import { HOUSE_EDGE } from "../../../cryptoGames";

// Server-authoritative Crash — mirrors src/games/crash.tsx.
//   At launch the server draws a HIDDEN crash point from the inverse-uniform
//   distribution (1% edge baked in) and stamps a start time. The multiplier
//   climbs as m = GROWTH ^ elapsedSeconds. The client animates the climb WITHOUT
//   knowing the crash point and sends a "cashout" with the multiplier it is
//   locking in. The server pays stake × m iff m < crashPoint, else the player
//   busted. Because the crash point stays hidden until settle, a cash-out at any
//   blindly-chosen m has EV = (1 − edge): P(crash > m) = (1−edge)/m, so
//   m × (1−edge)/m = 1 − edge. The claimed m is validated to never exceed what
//   the elapsed server time allows (GROWTH ^ elapsed), so the client can neither
//   forge a multiplier the clock hasn't reached nor learn/steer the crash point.

export const CRASH_GROWTH = 1.07; // multiplier per second — shared with the client animation
const MIN_CRASH = 1; // a crash point of 1.00 is an instant bust (no win possible)

const floor2 = (m: number) => Math.floor(m * 100) / 100;

interface CrashState {
  crashPoint: number;
  startMs: number;
}

/** Largest multiplier the elapsed server time can justify (anti-forgery bound). */
function elapsedMultiplier(startMs: number): number {
  const elapsedSec = Math.max(0, (Date.now() - startMs) / 1000);
  return Math.max(1, Math.pow(CRASH_GROWTH, elapsedSec));
}

export const crashGame: RoundGame<CrashState, Record<string, never>> = {
  slug: "crash",
  minBet: 5,
  maxBet: 1_000_000,
  validate: () => ({}),
  start: (_bet, _params, rng) => {
    const u = Math.min(Math.max(rng.float(), 0), 0.999999);
    const crashPoint = Math.max(MIN_CRASH, floor2((1 - HOUSE_EDGE) / (1 - u)));
    return {
      // crashPoint is NEVER in publicView — revealing it would let the client
      // cash out one tick below it every round and defeat the house edge.
      state: { crashPoint, startMs: Date.now() },
      publicView: { growth: CRASH_GROWTH },
      actions: ["cashout"],
      done: false,
      payout: 0,
    };
  },
  act: (state, bet, action, payload) => {
    const s = state as CrashState;
    if (action !== "cashout") throw new GameError("Invalid action");

    const claimed = num((payload as Record<string, unknown>)?.multiplier, "multiplier");
    assert(claimed >= 1, "multiplier out of range");

    // Lock in at the claimed multiplier, but never above what the elapsed server
    // time permits — so a client cannot claim a multiplier the climb hasn't
    // reached yet. (Latency makes the allowed bound slightly exceed the client's
    // display, so an honest cash-out always settles at exactly the shown value.)
    const realized = floor2(Math.min(claimed, elapsedMultiplier(s.startMs)));
    const busted = realized >= s.crashPoint;

    return {
      publicView: {
        crashPoint: s.crashPoint,
        multiplier: realized,
        busted,
      },
      actions: [],
      done: true,
      payout: busted ? 0 : Math.round(bet * realized * 100) / 100,
    };
  },
};
