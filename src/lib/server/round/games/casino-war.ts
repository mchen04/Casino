import { type RoundGame, GameError } from "../engine";
import { makeDeck, rankValue, type Card } from "../../../cards";

// Server-authoritative Casino War — mirrors src/games/casino-war.tsx.
//   Highest card wins (Ace high). On a tie the player may SURRENDER (lose half)
//   or GO TO WAR (match the bet; dealer burns 3, deals one more each):
//     straight win  → 2× (net +stake)        straight loss → 0
//     surrender     → 0.5× (net -stake/2)
//     war win       → original pushes + war bet 1:1  → returns 3× (net +stake)
//     war tie       → war bet pushes + original 2:1   → returns 4× (net +2×stake)
//     war loss      → 0 (net -2×stake)
//   Optimal play is to GO TO WAR on every tie. 6-deck shoe.
//   The war cards are committed (pre-dealt, hidden) at the tie, so the player
//   can never influence the war outcome by choosing to fight.

interface WarState {
  bet: number;
  playerCard: Card;
  dealerCard: Card;
  burn: Card[];
  playerWar: Card;
  dealerWar: Card;
}

export const casinoWarGame: RoundGame<WarState, Record<string, never>> = {
  slug: "casino-war",
  minBet: 5,
  maxBet: 1_000_000,
  validate: () => ({}),
  start: (bet, _params, rng) => {
    const deck = rng.shuffle(makeDeck(6));
    const playerCard = deck[0];
    const dealerCard = deck[1];
    const pv = rankValue(playerCard.rank);
    const dv = rankValue(dealerCard.rank);

    if (pv > dv) {
      return { publicView: { playerCard, dealerCard, outcome: "win" }, actions: [], done: true, payout: bet * 2 };
    }
    if (pv < dv) {
      return { publicView: { playerCard, dealerCard, outcome: "lose" }, actions: [], done: true, payout: 0 };
    }

    // Tie — commit the war cards now (burn 3, then one each), hidden until war.
    const state: WarState = {
      bet,
      playerCard,
      dealerCard,
      burn: [deck[2], deck[3], deck[4]],
      playerWar: deck[5],
      dealerWar: deck[6],
    };
    return {
      state,
      publicView: { playerCard, dealerCard, outcome: "tie" },
      actions: ["surrender", "war"],
      done: false, // multi-step: awaiting surrender/war
      payout: 0,
    };
  },
  act: (state, bet, action) => {
    const s = state as WarState;
    if (action === "surrender") {
      return {
        publicView: { playerCard: s.playerCard, dealerCard: s.dealerCard, outcome: "surrender" },
        actions: [],
        done: true,
        payout: bet / 2,
      };
    }
    if (action === "war") {
      const pv = rankValue(s.playerWar.rank);
      const dv = rankValue(s.dealerWar.rank);
      let outcome: string;
      let payout: number;
      if (pv > dv) {
        outcome = "war-win";
        payout = bet * 3; // original pushes (1×) + war bet 1:1 (2×)
      } else if (pv === dv) {
        outcome = "war-tie";
        payout = bet * 4; // war bet pushes (1×) + original 2:1 bonus (3×)
      } else {
        outcome = "war-lose";
        payout = 0;
      }
      return {
        publicView: {
          playerCard: s.playerCard,
          dealerCard: s.dealerCard,
          burn: s.burn,
          playerWar: s.playerWar,
          dealerWar: s.dealerWar,
          outcome,
        },
        actions: [],
        done: true,
        payout,
        debit: bet, // the war match (additional stake)
      };
    }
    throw new GameError("Invalid action");
  },
};
