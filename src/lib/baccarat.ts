// Pure Punto Banco baccarat logic: card-point values, hand totals, and the
// official third-card drawing tableau / coup resolution. No React, wallet,
// DOM, or animation — just the math, given a shoe slice to consume.

import { type Card, type Rank } from "@/lib/cards";

/** Baccarat point value of a single card. A=1, 2-9 face, 10/J/Q/K = 0. */
export function baccaratValue(rank: Rank): number {
  if (rank === "A") return 1;
  if (rank === "10" || rank === "J" || rank === "Q" || rank === "K") return 0;
  return parseInt(rank, 10);
}

/** Hand total = sum of card values mod 10. */
export function handTotal(cards: Card[]): number {
  let t = 0;
  for (const c of cards) t += baccaratValue(c.rank);
  return t % 10;
}

export type Outcome = "player" | "banker" | "tie";

export interface Resolution {
  playerCards: Card[];
  bankerCards: Card[];
  playerTotal: number;
  bankerTotal: number;
  outcome: Outcome;
  playerPair: boolean;
  bankerPair: boolean;
  natural: boolean;
}

/**
 * Deal a full coup applying the official drawing rules and return the final
 * hands + result. Pure given the shoe slice it consumes.
 */
export function dealCoup(shoe: Card[]): Resolution {
  // Shoe is consumed front-to-back: P, B, P, B, then draws.
  let i = 0;
  const next = () => shoe[i++];

  const playerCards: Card[] = [next(), next()];
  const bankerCards: Card[] = [next(), next()];

  const playerPair = playerCards[0].rank === playerCards[1].rank;
  const bankerPair = bankerCards[0].rank === bankerCards[1].rank;

  let pTotal = handTotal(playerCards);
  let bTotal = handTotal(bankerCards);

  const playerNatural = pTotal >= 8;
  const bankerNatural = bTotal >= 8;
  const natural = playerNatural || bankerNatural;

  // Naturals: both stand.
  if (!natural) {
    let playerThirdValue: number | null = null;

    // Player rule: draws on 0-5, stands on 6-7.
    if (pTotal <= 5) {
      const third = next();
      playerCards.push(third);
      playerThirdValue = baccaratValue(third.rank);
      pTotal = handTotal(playerCards);
    }

    // Banker rule.
    let bankerDraws = false;
    if (playerThirdValue === null) {
      // Player stood: banker draws on 0-5, stands 6-7.
      bankerDraws = bTotal <= 5;
    } else {
      const p = playerThirdValue;
      switch (bTotal) {
        case 0:
        case 1:
        case 2:
          bankerDraws = true;
          break;
        case 3:
          bankerDraws = p !== 8;
          break;
        case 4:
          bankerDraws = p >= 2 && p <= 7;
          break;
        case 5:
          bankerDraws = p >= 4 && p <= 7;
          break;
        case 6:
          bankerDraws = p === 6 || p === 7;
          break;
        default: // 7
          bankerDraws = false;
      }
    }

    if (bankerDraws) {
      bankerCards.push(next());
      bTotal = handTotal(bankerCards);
    }
  }

  const outcome: Outcome =
    pTotal > bTotal ? "player" : bTotal > pTotal ? "banker" : "tie";

  return {
    playerCards,
    bankerCards,
    playerTotal: pTotal,
    bankerTotal: bTotal,
    outcome,
    playerPair,
    bankerPair,
    natural,
  };
}
