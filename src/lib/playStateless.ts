"use client";

import { useCallback } from "react";
import { useWallet } from "./wallet";
import { getSpec } from "./server/engine";
import { clientRng } from "./clientRng";
import "./server/games"; // side-effect: populate the spec registry (resolvers are pure → client-safe)

/**
 * The result of one stateless round, normalised so a game's animation code is
 * identical whether the outcome came from the authoritative server or the guest
 * demo. `outcome` is the SAME shape in both paths because the SAME resolver runs
 * in both (server = crypto RNG + real money, guest = Math.random + local demo).
 */
export interface StatelessRound {
  /** Game-specific detail to animate toward (e.g. the dice roll, the slot grid). */
  outcome: Record<string, unknown>;
  /** Total chips returned this round: 0 on a loss, stake × multiplier on a win. */
  payout: number;
  /** The accepted stake. */
  bet: number;
  /** Best-effort post-round balance (authoritative for logged-in users). */
  balance: number;
}

/**
 * Hook returning a `playRound(game, bet, params)` function used by every
 * stateless game. Logged-in users hit /api/play (server owns RNG + payout +
 * balance); guests resolve locally against the identical registered spec so the
 * demo mirrors the real game exactly without ever touching the server wallet.
 *
 * Throws on rejection (invalid bet / insufficient funds / network) — callers
 * should catch and unwind any optimistic UI.
 */
export function usePlayStateless() {
  const { serverAuthoritative, play, bet: localBet, win, balance } = useWallet();

  return useCallback(
    async (game: string, amount: number, params: unknown): Promise<StatelessRound> => {
      if (serverAuthoritative) {
        const r = await play(game, amount, params);
        return { outcome: r.outcome, payout: r.payout, bet: r.bet, balance: r.balance };
      }

      // ---- Guest demo: resolve locally with the EXACT server spec ----
      const spec = getSpec(game);
      if (!spec) throw new Error("Unknown game");
      if (!Number.isInteger(amount) || amount < spec.minBet || amount > spec.maxBet) {
        throw new Error("Invalid bet");
      }
      if (!localBet(amount)) throw new Error("Insufficient balance");
      const validated = spec.validate(params);
      const res = spec.resolve(amount, validated, clientRng);
      const payout = Math.max(0, res.payout);
      if (payout > 0) win(payout);
      return {
        outcome: res.outcome,
        payout,
        bet: amount,
        balance: Math.round((balance - amount + payout) * 100) / 100,
      };
    },
    [serverAuthoritative, play, localBet, win, balance],
  );
}
