import { type GameSpec, intIn, assert } from "../engine";

// Server-authoritative Speed Bingo — mirrors src/games/bingo.tsx.
//   1-4 cards, each costs the per-card bet. The hopper draws (server crypto RNG)
//   until every card has its first line (or LINE_CAP); each card pays by HOW FAST
//   its own first line landed (SPEED_LADDER). An early line (<= BONUS_THRESHOLD)
//   chases a BLACKOUT jackpot. RTP ~92% (sim-verified).
//
//   Cards come from the client (so the betting preview is what's played) but are
//   VALIDATED strictly — a rigged card (duplicate numbers / out-of-range) would
//   daub faster and is rejected. The draw is server-random, so RTP is identical
//   for any valid card; the client cannot gain an edge by choosing cards.

const FREE = 0;
const COLS = ["B", "I", "N", "G", "O"] as const;
const COL_RANGES: Record<string, [number, number]> = {
  B: [1, 15], I: [16, 30], N: [31, 45], G: [46, 60], O: [61, 75],
};
const LINE_CAP = 46;
const BONUS_THRESHOLD = 20;
const BO_CAP = 62;
const BLACKOUT_MULT = 80;
const SPEED_LADDER: { maxBalls: number; mult: number }[] = [
  { maxBalls: 16, mult: 11 },
  { maxBalls: 20, mult: 6.5 },
  { maxBalls: 24, mult: 4.2 },
  { maxBalls: 28, mult: 2.6 },
  { maxBalls: 32, mult: 1.55 },
  { maxBalls: 37, mult: 0.95 },
  { maxBalls: 42, mult: 0.62 },
  { maxBalls: Infinity, mult: 0.4 },
];
const lineMultFor = (n: number) =>
  (SPEED_LADDER.find((s) => n <= s.maxBalls) ?? SPEED_LADDER[SPEED_LADDER.length - 1]).mult;

// 12 winning lines (rows, cols, 2 diagonals) as [col,row] lists.
const WIN_LINES: [number, number][][] = (() => {
  const lines: [number, number][][] = [];
  for (let r = 0; r < 5; r++) lines.push([0, 1, 2, 3, 4].map((c) => [c, r] as [number, number]));
  for (let c = 0; c < 5; c++) lines.push([0, 1, 2, 3, 4].map((r) => [c, r] as [number, number]));
  lines.push([0, 1, 2, 3, 4].map((i) => [i, i] as [number, number]));
  lines.push([0, 1, 2, 3, 4].map((i) => [i, 4 - i] as [number, number]));
  return lines;
})();

type Card = number[][]; // cells[col][row]

const isDaubed = (card: Card, c: number, r: number, calls: Set<number>) =>
  card[c][r] === FREE || calls.has(card[c][r]);

function hasLine(card: Card, calls: Set<number>): boolean {
  return WIN_LINES.some((line) => line.every(([c, r]) => isDaubed(card, c, r, calls)));
}
function isBlackout(card: Card, calls: Set<number>): boolean {
  for (let c = 0; c < 5; c++) for (let r = 0; r < 5; r++) if (!isDaubed(card, c, r, calls)) return false;
  return true;
}

/** Strictly validate one 5×5 card: each column distinct + in its B/I/N/G/O
 *  range, center FREE. Rejects rigged cards that could daub faster. */
function validateCard(raw: unknown): Card {
  assert(Array.isArray(raw) && raw.length === 5, "Card must have 5 columns");
  const card: Card = [];
  for (let c = 0; c < 5; c++) {
    const col = (raw as unknown[])[c];
    assert(Array.isArray(col) && col.length === 5, "Each column needs 5 cells");
    const [lo, hi] = COL_RANGES[COLS[c]];
    const seen = new Set<number>();
    const cells: number[] = [];
    for (let r = 0; r < 5; r++) {
      const v = (col as unknown[])[r];
      if (c === 2 && r === 2) {
        assert(v === FREE, "Center cell must be FREE");
        cells.push(FREE);
        continue;
      }
      const n = intIn(v, lo, hi, "card cell");
      assert(!seen.has(n), "Duplicate number in a column");
      seen.add(n);
      cells.push(n);
    }
    card.push(cells);
  }
  return card;
}

interface BingoParams {
  cards: Card[];
}

export const bingoSpec: GameSpec<BingoParams> = {
  slug: "bingo",
  minBet: 5,
  maxBet: 1_000_000,
  validate: (params) => {
    assert(params && typeof params === "object", "Missing params");
    const p = params as Record<string, unknown>;
    assert(Array.isArray(p.cards) && p.cards.length >= 1 && p.cards.length <= 4, "1-4 cards");
    return { cards: (p.cards as unknown[]).map(validateCard) };
  },
  resolve: (bet, { cards }, rng) => {
    const numCards = cards.length;
    // Per-card stake; the accepted bet is the total across all cards.
    assert(bet % numCards === 0, "Stake must split evenly across cards");
    const perCard = bet / numCards;
    assert(perCard >= 5, "Per-card stake below minimum");

    const bag = rng.shuffle(Array.from({ length: 75 }, (_, i) => i + 1));
    const calls: number[] = [];
    const firstLine = cards.map(() => 0);
    let bonus = false;
    let bagIdx = 0;

    for (;;) {
      const cap = bonus ? BO_CAP : LINE_CAP;
      if (bagIdx >= bag.length || calls.length >= cap) break;
      calls.push(bag[bagIdx++]);
      const drawn = calls.length;
      const calledSet = new Set(calls);

      if (!bonus) {
        let allLined = true;
        cards.forEach((card, i) => {
          if (firstLine[i] === 0) {
            if (hasLine(card, calledSet)) firstLine[i] = drawn;
            else allLined = false;
          }
        });
        if (allLined) {
          const earliest = Math.min(...firstLine.filter((n) => n > 0));
          if (earliest <= BONUS_THRESHOLD && drawn < BO_CAP) {
            bonus = true;
            continue;
          }
          break;
        }
      } else if (cards.some((card) => isBlackout(card, calledSet))) {
        break;
      }
    }

    const finalCalls = new Set(calls);
    let gross = 0;
    const results = cards.map((card, i) => {
      const flb = firstLine[i];
      let pattern: "none" | "line" | "blackout" = "none";
      let mult = 0;
      if (bonus && isBlackout(card, finalCalls)) {
        pattern = "blackout";
        mult = BLACKOUT_MULT;
      } else if (flb > 0) {
        pattern = "line";
        mult = lineMultFor(flb);
      }
      const payout = perCard * mult;
      gross += payout;
      return { index: i, pattern, firstLineBall: flb, mult, payout };
    });

    return {
      payout: gross,
      outcome: {
        balls: calls,
        ballsDrawn: calls.length,
        bonusPhase: bonus,
        perCard: results,
      },
    };
  },
};
