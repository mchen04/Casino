"use client";

import { useCallback, useRef } from "react";
import { useWallet } from "./wallet";
import { apiRound } from "./auth-client";
import { getRoundGame } from "./server/round/engine";
import { clientRng } from "./clientRng";
import "./server/round/games"; // side-effect: register stateful games (pure → client-safe)

/**
 * Normalised handle for one step of a stateful round. `publicView` is the SAME
 * shape whether it came from /api/round (logged-in) or the local guest demo,
 * because the SAME RoundGame runs in both — server with crypto RNG + real money,
 * guest with Math.random + local wallet.
 */
export interface RoundHandle {
  roundId?: string;
  done: boolean;
  publicView: Record<string, unknown>;
  actions: string[];
  payout?: number;
  balance: number;
}

/**
 * Hook returning { start, act } for stateful games. Logged-in users hit
 * /api/round (server owns the hidden state + payout + atomic settle); guests run
 * the identical RoundGame locally, holding the state in a ref. Throws on
 * rejection (invalid bet / insufficient funds / network) — callers unwind UI.
 */
export function usePlayRound() {
  const { serverAuthoritative, bet: localBet, win, balance, applyServerBalance } = useWallet();
  const guest = useRef<{ game: string; bet: number; state: unknown } | null>(null);

  const start = useCallback(
    async (game: string, bet: number, params: unknown): Promise<RoundHandle> => {
      if (serverAuthoritative) {
        const r = await apiRound({ op: "start", game, bet, params });
        applyServerBalance(
          r.balance,
          r.done
            ? { wagered: bet, returned: r.payout ?? 0, biggestWin: r.payout ?? 0, settled: true }
            : { wagered: bet },
        );
        return { roundId: r.roundId, done: r.done, publicView: r.publicView, actions: r.actions ?? [], payout: r.payout, balance: r.balance };
      }

      // ---- Guest demo: run the identical RoundGame locally ----
      const g = getRoundGame(game);
      if (!g) throw new Error("Unknown game");
      if (!Number.isInteger(bet) || bet < g.minBet || bet > g.maxBet) throw new Error("Invalid bet");
      if (!localBet(bet)) throw new Error("Insufficient balance");
      const step = g.start(bet, g.validate(params), clientRng);
      if (step.debit && step.debit > 0) localBet(step.debit);
      if (step.done) {
        if ((step.payout ?? 0) > 0) win(step.payout!);
        guest.current = null;
        return { done: true, publicView: step.publicView, actions: [], payout: step.payout, balance: balance - bet + (step.payout ?? 0) };
      }
      guest.current = { game, bet, state: step.state };
      return { roundId: "guest", done: false, publicView: step.publicView, actions: step.actions ?? [], balance: balance - bet };
    },
    [serverAuthoritative, localBet, win, balance, applyServerBalance],
  );

  const act = useCallback(
    async (roundId: string, action: string, payload?: unknown): Promise<RoundHandle> => {
      if (serverAuthoritative) {
        const r = await apiRound({ op: "act", roundId, action, payload });
        applyServerBalance(
          r.balance,
          r.done ? { returned: r.payout ?? 0, biggestWin: r.payout ?? 0, settled: true } : {},
        );
        return { roundId: r.roundId, done: r.done, publicView: r.publicView, actions: r.actions ?? [], payout: r.payout, balance: r.balance };
      }

      const gs = guest.current;
      if (!gs) throw new Error("No active round");
      const g = getRoundGame(gs.game);
      if (!g) throw new Error("Unknown game");
      const step = g.act(gs.state, gs.bet, action, payload, clientRng);
      if (step.debit && step.debit > 0) localBet(step.debit);
      if (step.done) {
        if ((step.payout ?? 0) > 0) win(step.payout!);
        guest.current = null;
        return { done: true, publicView: step.publicView, actions: [], payout: step.payout, balance };
      }
      gs.state = step.state;
      return { roundId: "guest", done: false, publicView: step.publicView, actions: step.actions ?? [], balance };
    },
    [serverAuthoritative, localBet, win, balance, applyServerBalance],
  );

  return { start, act };
}
