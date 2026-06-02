import { type GameSpec, assert } from "../engine";

// Server-authoritative Lucky Sevens (3-reel, center payline) — mirrors
// src/games/slots-classic.tsx. RTP ≈ 95.2% (4.8% house edge, sim-verified).
//   Buy-bonus (10 pre-paid spins at 10×) needs server-held state, so it stays a
//   guest-only demo for now; normal + auto spins are fully server-authoritative.

type SymKey = "7" | "BAR" | "BELL" | "CHERRY" | "LEMON" | "PLUM";

const SYM_KEYS: SymKey[] = ["7", "BAR", "BELL", "CHERRY", "LEMON", "PLUM"];
const SYM_WEIGHTS = [2, 4, 6, 8, 11, 11];
const LABEL: Record<SymKey, string> = {
  "7": "Lucky 7", BAR: "Bar", BELL: "Bell", CHERRY: "Cherry", LEMON: "Lemon", PLUM: "Plum",
};

type Tier = "jackpot" | "big" | "win" | "small" | "loss";

interface LineOutcome {
  multiplier: number;
  label: string;
  tier: Tier;
}

function evaluateLine(line: SymKey[]): LineOutcome {
  const [a, b, c] = line;
  if (a === b && b === c) {
    switch (a) {
      case "7": return { multiplier: 100, label: "JACKPOT — Triple Sevens!", tier: "jackpot" };
      case "BAR": return { multiplier: 40, label: "Triple Bars!", tier: "big" };
      case "BELL": return { multiplier: 20, label: "Triple Bells!", tier: "big" };
      case "CHERRY": return { multiplier: 12, label: "Triple Cherries!", tier: "win" };
      default: return { multiplier: 6, label: `Triple ${LABEL[a]}s!`, tier: "win" };
    }
  }
  const cherryCount = line.filter((s) => s === "CHERRY").length;
  if (cherryCount === 2) return { multiplier: 2, label: "Two Cherries", tier: "small" };
  if (cherryCount === 1) return { multiplier: 1, label: "Cherry — money back", tier: "small" };
  return { multiplier: 0, label: "No win — spin again", tier: "loss" };
}

function winningReels(line: SymKey[], multiplier: number): boolean[] {
  if (multiplier === 0) return [false, false, false];
  const [a, b, c] = line;
  if (a === b && b === c) return [true, true, true];
  return line.map((s) => s === "CHERRY");
}

export const slotsClassicSpec: GameSpec<Record<string, never>> = {
  slug: "slots-classic",
  minBet: 5,
  maxBet: 1_000_000,
  validate: (params) => {
    assert(params === undefined || params === null || typeof params === "object", "Invalid params");
    return {};
  },
  resolve: (bet, _params, rng) => {
    const line = [
      rng.weighted(SYM_KEYS, SYM_WEIGHTS),
      rng.weighted(SYM_KEYS, SYM_WEIGHTS),
      rng.weighted(SYM_KEYS, SYM_WEIGHTS),
    ];
    const o = evaluateLine(line);
    return {
      payout: bet * o.multiplier,
      outcome: {
        line,
        multiplier: o.multiplier,
        label: o.label,
        tier: o.tier,
        winReels: winningReels(line, o.multiplier),
      },
    };
  },
};
