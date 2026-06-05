import { type RoundGame, GameError } from "../engine";
import { assert } from "../../engine";
import { makeDeck, type Card } from "../../../cards";
import { JOKER, evalFive, evalLow, houseWay, isLegalSplit } from "../../../paiGow";

// Server-authoritative Pai Gow Poker — mirrors src/games/pai-gow-poker.tsx.
//   53-card deck (52 + one semi-wild joker). Player and dealer get 7 cards each.
//   Five aces is highest; the A-2-3-4-5 wheel is the second-highest straight.
//   The player splits into a 5-card HIGH (back) hand and a 2-card LOW (front)
//   hand; the back MUST outrank the front (else it would foul — rejected). The
//   DEALER is set by the FIXED house way (see paiGow.houseWay), which now splits
//   full houses / two pair / pairs-behind-a-flush so it can win both ways.
//   Compare back-vs-back and front-vs-front; COPIES (ties) go to the dealer:
//     win both  → pays 1.95× (1:1 minus the 5% commission)
//     one each  → push (stake back)
//     lose both → loss
//   The dealer's 7 cards stay hidden until the player commits a legal split, so
//   the client can never see the dealer hand before setting, nor forge a payout.

const COMMISSION = 0.05;

const key = (c: Card) => c.id;

interface PGState {
  player: Card[]; // 7
  dealer: Card[]; // 7 (hidden until settle)
  bet: number;
}

/** Map the house-way front cards back to their ids for a client default. */
function suggestedLowIds(seven: Card[]): string[] {
  return houseWay(seven).low.map(key);
}

export const paiGowPokerGame: RoundGame<PGState, Record<string, never>> = {
  slug: "pai-gow-poker",
  minBet: 5,
  maxBet: 250_000,
  validate: () => ({}),
  start: (bet, _params, rng) => {
    const deck = rng.shuffle([...makeDeck(1), { ...JOKER }]);
    const player = deck.slice(0, 7);
    const dealer = deck.slice(7, 14);
    return {
      state: { player, dealer, bet },
      // Only the player's 7 cards (+ a house-way suggestion) are revealed; the
      // dealer hand is committed but hidden until the player sets.
      publicView: { player, suggestedLow: suggestedLowIds(player) },
      actions: ["set"],
      done: false,
      payout: 0,
    };
  },
  act: (state, bet, action, payload) => {
    const s = state as PGState;
    if (action !== "set") throw new GameError("Invalid action");

    const raw = (payload as Record<string, unknown>)?.low;
    assert(Array.isArray(raw) && raw.length === 2, "Pick exactly two low cards");
    const lowIds = raw.map(String);
    assert(lowIds[0] !== lowIds[1], "Low cards must differ");

    const low = s.player.filter((c) => lowIds.includes(key(c)));
    assert(low.length === 2, "Unknown low cards");
    const high = s.player.filter((c) => !lowIds.includes(key(c)));

    // The back (5) MUST strictly outrank the front (2) — never allow a foul.
    if (!isLegalSplit(high, low)) throw new GameError("Foul: high hand must beat low hand");

    // Dealer is set by the fixed house way.
    const dealerSplit = houseWay(s.dealer);
    const pBack = evalFive(high);
    const pFront = evalLow(low);
    const dBack = evalFive(dealerSplit.high);
    const dFront = evalLow(dealerSplit.low);

    // Copies (ties) go to the dealer → the player must STRICTLY outrank.
    const winBack = pBack.score > dBack.score;
    const winFront = pFront.score > dFront.score;

    let outcome: string;
    let payout: number;
    if (winBack && winFront) {
      outcome = "win";
      payout = Math.round(bet * (2 - COMMISSION) * 100) / 100; // 1:1 less 5% = 1.95×
    } else if (!winBack && !winFront) {
      outcome = "lose";
      payout = 0;
    } else {
      outcome = "push";
      payout = bet;
    }

    return {
      publicView: {
        player: { high, low },
        dealer: { high: dealerSplit.high, low: dealerSplit.low },
        playerBack: pBack.name ?? "",
        dealerBack: dBack.name ?? "",
        winBack,
        winFront,
        outcome,
      },
      actions: [],
      done: true,
      payout,
    };
  },
};
