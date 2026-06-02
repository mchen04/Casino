import { type GameSpec, oneOf, nonNegInt, assert } from "../engine";

// Server-authoritative Roulette — mirrors src/games/roulette.tsx.
//   European (37 pockets: 0-36) or American (38: 0-36 + 00). Uniform pocket.
//   Straight 35:1 (returns 36×), even-money 1:1 (2×), dozen/column 2:1 (3×).
//   Edge: European 2.70%, American 5.26% (the green pocket(s) are the edge).

type Pocket = number | "00";
type BetKind = "straight" | "red" | "black" | "odd" | "even" | "low" | "high" | "dozen" | "column";

const RED_SET = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);

const PAYOUT: Record<BetKind, number> = {
  straight: 36, red: 2, black: 2, odd: 2, even: 2, low: 2, high: 2, dozen: 3, column: 3,
};
const KINDS = Object.keys(PAYOUT) as [BetKind, ...BetKind[]];

function pocketColor(p: Pocket): "green" | "red" | "black" {
  if (p === 0 || p === "00") return "green";
  return RED_SET.has(p as number) ? "red" : "black";
}

function betWins(kind: BetKind, ref: Pocket, p: Pocket): boolean {
  if (p === 0 || p === "00") return kind === "straight" && ref === p;
  const n = p as number;
  switch (kind) {
    case "straight": return ref === p;
    case "red": return RED_SET.has(n);
    case "black": return !RED_SET.has(n);
    case "odd": return n % 2 === 1;
    case "even": return n % 2 === 0;
    case "low": return n >= 1 && n <= 18;
    case "high": return n >= 19 && n <= 36;
    case "dozen":
      return ref === 1 ? n >= 1 && n <= 12 : ref === 2 ? n >= 13 && n <= 24 : n >= 25 && n <= 36;
    case "column":
      return n % 3 === (ref === 3 ? 0 : (ref as number));
  }
}

interface PlacedBet {
  kind: BetKind;
  ref: Pocket;
  amount: number;
}
interface RouletteParams {
  mode: "european" | "american";
  bets: PlacedBet[];
}

function parseRef(v: unknown): Pocket {
  if (v === "00") return "00";
  assert(typeof v === "number" && Number.isInteger(v), "Invalid bet ref");
  return v as number;
}

export const rouletteSpec: GameSpec<RouletteParams> = {
  slug: "roulette",
  minBet: 5,
  maxBet: 1_000_000,
  validate: (params) => {
    assert(params && typeof params === "object", "Missing params");
    const p = params as Record<string, unknown>;
    const mode = oneOf(p.mode, ["european", "american"] as const, "mode");
    assert(Array.isArray(p.bets) && p.bets.length > 0, "No bets placed");
    const bets: PlacedBet[] = (p.bets as unknown[]).map((raw) => {
      assert(raw && typeof raw === "object", "Invalid bet");
      const b = raw as Record<string, unknown>;
      return {
        kind: oneOf(b.kind, KINDS, "bet kind"),
        ref: parseRef(b.ref),
        amount: nonNegInt(b.amount, 1_000_000, "bet amount"),
      };
    });
    return { mode, bets };
  },
  resolve: (bet, { mode, bets }, rng) => {
    // Defence in depth: the placed bets must sum to the accepted stake.
    const sum = bets.reduce((s, b) => s + b.amount, 0);
    assert(sum === bet, "Bets must sum to the stake");
    assert(bets.some((b) => b.amount > 0), "No bet placed");

    const pockets: Pocket[] = Array.from({ length: 37 }, (_, i) => i);
    if (mode === "american") pockets.push("00");
    const landed = rng.pick(pockets);

    let payout = 0;
    for (const b of bets) {
      if (b.amount > 0 && betWins(b.kind, b.ref, landed)) payout += b.amount * PAYOUT[b.kind];
    }

    return {
      payout,
      outcome: { pocket: landed, color: pocketColor(landed), mode },
    };
  },
};
