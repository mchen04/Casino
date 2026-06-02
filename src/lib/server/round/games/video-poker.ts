import { type RoundGame, GameError } from "../engine";
import { evaluate5, HandCategory, makeDeck, type Card } from "../../../cards";

// Server-authoritative Video Poker (9/6 Jacks or Better) — mirrors
// src/games/video-poker.tsx. Deal 5 from a single deck, the player picks which to
// HOLD, the rest are replaced from the same committed deck, then the 5-card hand
// pays per the 9/6 paytable. Payout = perCoin * totalBet, with the Royal Flush
// jumping from 250 to 800 per coin at the 5-coin (max) bet. Optimal play → 99.54%
// RTP (~0.46% house edge). The deck is committed at the deal, so the player holds
// blind and can never see or steer the replacement cards.

type PayKey =
  | "royal" | "straightFlush" | "fourKind" | "fullHouse" | "flush"
  | "straight" | "threeKind" | "twoPair" | "jacksOrBetter";

const PAYTABLE: Record<PayKey, { perCoin: number; perCoinMax: number }> = {
  royal: { perCoin: 250, perCoinMax: 800 },
  straightFlush: { perCoin: 50, perCoinMax: 50 },
  fourKind: { perCoin: 25, perCoinMax: 25 },
  fullHouse: { perCoin: 9, perCoinMax: 9 },
  flush: { perCoin: 6, perCoinMax: 6 },
  straight: { perCoin: 4, perCoinMax: 4 },
  threeKind: { perCoin: 3, perCoinMax: 3 },
  twoPair: { perCoin: 2, perCoinMax: 2 },
  jacksOrBetter: { perCoin: 1, perCoinMax: 1 },
};

const VALID_COIN_VALUES = new Set([5, 25, 100]);

function payKeyFor(cards: Card[]): PayKey | null {
  const hand = evaluate5(cards);
  switch (hand.category) {
    case HandCategory.RoyalFlush: return "royal";
    case HandCategory.StraightFlush: return "straightFlush";
    case HandCategory.FourOfAKind: return "fourKind";
    case HandCategory.FullHouse: return "fullHouse";
    case HandCategory.Flush: return "flush";
    case HandCategory.Straight: return "straight";
    case HandCategory.ThreeOfAKind: return "threeKind";
    case HandCategory.TwoPair: return "twoPair";
    case HandCategory.Pair:
      return (hand.tiebreak[0] ?? 0) >= 11 ? "jacksOrBetter" : null; // J/Q/K/A
    default:
      return null;
  }
}

interface VPParams {
  coins: number;
}
interface VPState {
  shoe: Card[];
  hand: Card[];
  coins: number;
}

export const videoPokerGame: RoundGame<VPState, VPParams> = {
  slug: "video-poker",
  minBet: 5,
  maxBet: 500, // 5 coins x 100
  validate: (params) => {
    const coins = (params as Record<string, unknown>)?.coins;
    if (typeof coins !== "number" || !Number.isInteger(coins) || coins < 1 || coins > 5)
      throw new GameError("Invalid coins");
    return { coins };
  },
  start: (bet, { coins }, rng) => {
    // bet must equal coins * a valid coin value — otherwise a client could claim
    // the 5-coin Royal bonus on an off-denomination wager.
    if (bet % coins !== 0 || !VALID_COIN_VALUES.has(bet / coins))
      throw new GameError("Bet inconsistent with coins");
    const deck = rng.shuffle(makeDeck(1));
    const hand = deck.slice(0, 5);
    return {
      state: { shoe: deck.slice(5), hand, coins },
      publicView: { hand },
      actions: ["draw"],
      done: false,
      payout: 0,
    };
  },
  act: (state, bet, action, payload) => {
    const s = state as VPState;
    if (action !== "draw") throw new GameError("Invalid action");

    const raw = (payload as Record<string, unknown>)?.held;
    if (!Array.isArray(raw) || raw.length !== 5) throw new GameError("Invalid hold mask");
    const held = raw.map((v) => v === true);

    const shoe = [...s.shoe];
    const final = s.hand.map((c, i) => (held[i] ? c : (shoe.shift() as Card)));

    const key = payKeyFor(final);
    const perCoin = key ? (s.coins === 5 ? PAYTABLE[key].perCoinMax : PAYTABLE[key].perCoin) : 0;
    const gross = perCoin * bet; // bet = total bet = coins * coinValue

    return {
      publicView: { hand: final, key, perCoin },
      actions: [],
      done: true,
      payout: gross,
    };
  },
};
