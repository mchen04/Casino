"use client";

import { useCallback } from "react";
import { useWallet } from "./wallet";
import { apiPlay } from "./auth-client";
import { getSpec } from "./server/engine";
import { clientRng } from "./clientRng";
import "./server/games"; // side-effect: populate the spec registry (resolvers are pure → client-safe)

const round2 = (n: number): number => Math.round(n * 100) / 100;

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
  /**
   * Credit the payout into the displayed balance. In deferred mode the bet is
   * debited up front but the winnings are withheld until the caller invokes this
   * — typically once the win animation finishes, so the header never reveals the
   * result before the game is done. Idempotent. A no-op in immediate mode (the
   * round already settled).
   */
  settle: () => void;
}

export interface PlayOptions {
  /**
   * Debit the bet immediately but withhold the payout until `settle()` is called.
   * Use for games with a post-result reveal animation (slots, wheels) so the
   * balance doesn't jump to the final figure before the animation plays out.
   * Defaults to false (bet + payout both applied immediately).
   */
  defer?: boolean;
}

const NOOP = () => {};

/**
 * Hook returning a `playRound(game, bet, params, opts?)` function used by every
 * stateless game. Logged-in users hit /api/play (server owns RNG + payout +
 * balance); guests resolve locally against the identical registered spec so the
 * demo mirrors the real game exactly without ever touching the server wallet.
 *
 * Throws on rejection (invalid bet / insufficient funds / network) — callers
 * should catch and unwind any optimistic UI.
 */
export function usePlayStateless() {
  const { serverAuthoritative, play, applyServerBalance, bet: localBet, win, balance, beginBet } = useWallet();

  return useCallback(
    async (
      game: string,
      rawAmount: number,
      params: unknown,
      opts?: PlayOptions,
    ): Promise<StatelessRound> => {
      const defer = opts?.defer ?? false;
      // Stakes are whole chips, but the displayed balance can carry cents from
      // fair payouts. Floor a (possibly fractional) "Max"/clamp amount to the
      // affordable whole-chip stake so it's never rejected as a non-integer bet.
      const amount = Math.floor(rawAmount);

      if (serverAuthoritative) {
        if (!defer) {
          const r = await play(game, amount, params);
          return { outcome: r.outcome, payout: r.payout, bet: r.bet, balance: r.balance, settle: NOOP };
        }
        // Deferred: take the authoritative result, but only DEBIT the bet now so
        // the header shows (balance − bet) during the animation. The payout (and
        // the round/returned/biggest-win stats) land on settle(), after the reveal.
        const r = await apiPlay(game, amount, params);
        applyServerBalance(round2(r.balance - r.payout), { wagered: amount });
        const endBet = beginBet();
        let settled = false;
        const settle = () => {
          if (settled) return;
          settled = true;
          applyServerBalance(r.balance, { returned: r.payout, biggestWin: r.payout, settled: true });
          endBet();
        };
        return { outcome: r.outcome, payout: r.payout, bet: r.bet, balance: r.balance, settle };
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
      const endBet = defer ? beginBet() : NOOP;
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        if (payout > 0) win(payout);
        endBet();
      };
      // Immediate mode credits the win up front; deferred mode waits for settle().
      if (!defer) settle();
      return {
        outcome: res.outcome,
        payout,
        bet: amount,
        balance: round2(balance - amount + payout),
        settle: defer ? settle : NOOP,
      };
    },
    [serverAuthoritative, play, applyServerBalance, localBet, win, balance, beginBet],
  );
}
