import { type RoundGame, GameError } from "../engine";
import { intIn, assert } from "../../engine";

// Server-authoritative Mines — mirrors src/games/mines.tsx.
//   5×5 grid; the player sets a mine count (1-24). Pick tiles: a GEM grows the
//   multiplier, a MINE ends the round (stake lost). Cash out (after >=1 gem) to
//   bank bet × mult. Multiplier = (1/P(survive k picks)) × (1-edge), so the house
//   edge is exactly 1% for ANY cash-out point. Mine positions are committed
//   (hidden) at the start, so each pick is judged against them — unbeatable.

const TILES = 25;
const HOUSE_EDGE = 0.01;

function multiplierFor(mines: number, safe: number): number {
  if (safe <= 0) return 1;
  const maxSafe = TILES - mines;
  const picks = Math.min(safe, maxSafe);
  let raw = 1;
  for (let i = 0; i < picks; i++) raw *= (TILES - i) / (TILES - mines - i);
  return raw * (1 - HOUSE_EDGE);
}

interface MinesParams {
  mines: number;
}
interface MinesState {
  mines: number;
  minePos: number[];
  picked: number[];
}

export const minesGame: RoundGame<MinesState, MinesParams> = {
  slug: "mines",
  minBet: 5,
  maxBet: 1_000_000,
  validate: (params) => {
    assert(params && typeof params === "object", "Missing params");
    return { mines: intIn((params as Record<string, unknown>).mines, 1, 24, "mines") };
  },
  start: (_bet, { mines }, rng) => {
    const minePos = rng
      .shuffle(Array.from({ length: TILES }, (_, i) => i))
      .slice(0, mines)
      .sort((a, b) => a - b);
    return {
      state: { mines, minePos, picked: [] },
      publicView: { mines, tiles: TILES },
      actions: ["pick", "cashout"],
      done: false,
      payout: 0,
    };
  },
  act: (state, bet, action, payload) => {
    const s = state as MinesState;

    if (action === "cashout") {
      assert(s.picked.length >= 1, "Pick a tile first");
      const mult = multiplierFor(s.mines, s.picked.length);
      return {
        publicView: { safe: s.picked.length, mult, cashedOut: true, minePositions: s.minePos },
        actions: [],
        done: true,
        payout: bet * mult,
      };
    }
    if (action !== "pick") throw new GameError("Invalid action");

    const idx = intIn((payload as { index?: unknown } | undefined)?.index, 0, TILES - 1, "index");
    assert(!s.picked.includes(idx), "Tile already picked");

    if (s.minePos.includes(idx)) {
      return {
        publicView: { index: idx, kind: "mine", minePositions: s.minePos, picked: s.picked, mult: 0 },
        actions: [],
        done: true,
        payout: 0,
      };
    }

    const picked = [...s.picked, idx];
    const safe = picked.length;
    const mult = multiplierFor(s.mines, safe);

    if (safe >= TILES - s.mines) {
      // Cleared every gem — auto-win at the max multiplier.
      return {
        publicView: { index: idx, kind: "gem", safe, mult, cleared: true, minePositions: s.minePos },
        actions: [],
        done: true,
        payout: bet * mult,
      };
    }
    return {
      state: { ...s, picked },
      publicView: { index: idx, kind: "gem", safe, mult },
      actions: ["pick", "cashout"],
      done: false,
      payout: 0,
    };
  },
};
