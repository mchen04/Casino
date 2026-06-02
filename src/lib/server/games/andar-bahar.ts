import { type GameSpec, oneOf, assert } from "../engine";
import { makeDeck, type Card, SUIT_COLOR } from "../../cards";

// Server-authoritative Andar Bahar — mirrors src/games/andar-bahar.tsx.
//   Fresh single 52-card deck. The last card is the Joker. Cards are dealt
//   alternately starting with the side set by the Joker's colour (black→Andar,
//   red→Bahar) until a card matches the Joker's RANK — that side wins.
//   The first-deal side carries the edge and pays 0.9:1 (returns 1.9×); the
//   other side pays 1:1 (returns 2×).

type Side = "andar" | "bahar";

interface ABParams {
  side: Side;
}

interface Dealt {
  card: Card;
  side: Side;
  seq: number;
  isMatch: boolean;
}

export const andarBaharSpec: GameSpec<ABParams> = {
  slug: "andar-bahar",
  minBet: 5,
  maxBet: 1_000_000,
  validate: (params) => {
    assert(params && typeof params === "object", "Missing params");
    const p = params as Record<string, unknown>;
    return { side: oneOf(p.side, ["andar", "bahar"] as const, "side") };
  },
  resolve: (bet, { side }, rng) => {
    const deck = rng.shuffle(makeDeck(1));
    const joker = deck.pop() as Card;
    const start: Side = SUIT_COLOR[joker.suit] === "black" ? "andar" : "bahar";

    const sequence: Dealt[] = [];
    let cur: Side = start;
    let winner: Side = start;
    let seq = 0;
    for (const c of deck) {
      const isMatch = c.rank === joker.rank;
      sequence.push({ card: c, side: cur, seq, isMatch });
      seq++;
      if (isMatch) {
        winner = cur;
        break;
      }
      cur = cur === "andar" ? "bahar" : "andar";
    }

    const won = winner === side;
    const mult = side === start ? 1.9 : 2;
    return {
      payout: won ? bet * mult : 0,
      outcome: { joker, startSide: start, winner, cards: sequence.length, sequence },
    };
  },
};
