"use client";

import { useCallback, useRef } from "react";
import { useWallet } from "./wallet";
import { apiRound } from "./auth-client";
import { getRoundGame } from "./server/round/engine";
import { clientRng } from "./clientRng";
import "./server/round/games"; // side-effect: register stateful games (pure → client-safe)

const round2 = (n: number): number => Math.round(n * 100) / 100;

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
  /**
   * Credit the round's payout into the displayed balance. In deferred mode the
   * bet/ante is debited up front but the winnings are withheld until the caller
   * invokes this — typically once the reveal animation (e.g. the dealer drawing
   * out) finishes, so the header never shows the result before the game is done.
   * Idempotent, and only meaningful on the terminal (done) step; a no-op
   * otherwise or in immediate mode.
   */
  settle: () => void;
}

export interface RoundOptions {
  /**
   * Debit the bet/ante immediately but withhold the payout until `settle()`.
   * Use for games whose terminal step is followed by a reveal animation, so the
   * balance doesn't jump to the final figure before the animation plays out.
   */
  defer?: boolean;
  /**
   * Defer THIS step's ENTIRE balance change (not just a terminal payout) until
   * settle() — for games that credit winnings on a NON-terminal step, like a
   * craps roll. Leaves multi-step debits (split/raise/double) on other games
   * untouched, since those don't pass this flag.
   */
  deferStep?: boolean;
}

const NOOP = () => {};

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
    async (game: string, bet: number, params: unknown, opts?: RoundOptions): Promise<RoundHandle> => {
      const defer = opts?.defer ?? false;

      if (serverAuthoritative) {
        const r = await apiRound({ op: "start", game, bet, params });
        if (r.done && defer) {
          // Terminal on the first step (e.g. a natural). Debit now, hold the win.
          const payout = r.payout ?? 0;
          applyServerBalance(round2(r.balance - payout), { wagered: bet });
          let settled = false;
          const settle = () => {
            if (settled) return;
            settled = true;
            applyServerBalance(r.balance, { returned: payout, biggestWin: payout, settled: true });
          };
          return { roundId: r.roundId, done: r.done, publicView: r.publicView, actions: r.actions ?? [], payout: r.payout, balance: r.balance, settle };
        }
        applyServerBalance(
          r.balance,
          r.done
            ? { wagered: bet, returned: r.payout ?? 0, biggestWin: r.payout ?? 0, settled: true }
            : { wagered: bet },
        );
        return { roundId: r.roundId, done: r.done, publicView: r.publicView, actions: r.actions ?? [], payout: r.payout, balance: r.balance, settle: NOOP };
      }

      // ---- Guest demo: run the identical RoundGame locally ----
      const g = getRoundGame(game);
      if (!g) throw new Error("Unknown game");
      if (!Number.isInteger(bet) || bet < g.minBet || bet > g.maxBet) throw new Error("Invalid bet");
      if (!localBet(bet)) throw new Error("Insufficient balance");
      const step = g.start(bet, g.validate(params), clientRng);
      if (step.debit && step.debit > 0) localBet(step.debit);
      if (step.done) {
        const payout = step.payout ?? 0;
        let settled = false;
        const settle = () => {
          if (settled) return;
          settled = true;
          if (payout > 0) win(payout);
        };
        if (!defer) settle();
        guest.current = null;
        return { done: true, publicView: step.publicView, actions: [], payout: step.payout, balance: balance - bet + payout, settle: defer ? settle : NOOP };
      }
      guest.current = { game, bet, state: step.state };
      return { roundId: "guest", done: false, publicView: step.publicView, actions: step.actions ?? [], balance: balance - bet, settle: NOOP };
    },
    [serverAuthoritative, localBet, win, balance, applyServerBalance],
  );

  const act = useCallback(
    async (roundId: string, action: string, payload?: unknown, opts?: RoundOptions): Promise<RoundHandle> => {
      const defer = opts?.defer ?? false;
      const deferStep = opts?.deferStep ?? false;

      if (serverAuthoritative) {
        const r = await apiRound({ op: "act", roundId, action, payload });
        if (deferStep) {
          // Defer THIS step's ENTIRE balance change until settle() — for a
          // non-terminal credit like a craps roll. Multi-step debits on other
          // games don't pass deferStep, so their chips still leave immediately.
          let settled = false;
          const settle = () => {
            if (settled) return;
            settled = true;
            applyServerBalance(
              r.balance,
              r.done ? { returned: r.payout ?? 0, biggestWin: r.payout ?? 0, settled: true } : {},
            );
          };
          return { roundId: r.roundId, done: r.done, publicView: r.publicView, actions: r.actions ?? [], payout: r.payout, balance: r.balance, settle };
        }
        if (r.done && defer) {
          const payout = r.payout ?? 0;
          applyServerBalance(round2(r.balance - payout), {});
          let settled = false;
          const settle = () => {
            if (settled) return;
            settled = true;
            applyServerBalance(r.balance, { returned: payout, biggestWin: payout, settled: true });
          };
          return { roundId: r.roundId, done: r.done, publicView: r.publicView, actions: r.actions ?? [], payout: r.payout, balance: r.balance, settle };
        }
        applyServerBalance(
          r.balance,
          r.done ? { returned: r.payout ?? 0, biggestWin: r.payout ?? 0, settled: true } : {},
        );
        return { roundId: r.roundId, done: r.done, publicView: r.publicView, actions: r.actions ?? [], payout: r.payout, balance: r.balance, settle: NOOP };
      }

      const gs = guest.current;
      if (!gs) throw new Error("No active round");
      const g = getRoundGame(gs.game);
      if (!g) throw new Error("Unknown game");
      const step = g.act(gs.state, gs.bet, action, payload, clientRng);
      if (step.debit && step.debit > 0) localBet(step.debit);
      if (step.done) {
        const payout = step.payout ?? 0;
        let settled = false;
        const settle = () => {
          if (settled) return;
          settled = true;
          if (payout > 0) win(payout);
        };
        if (!defer) settle();
        guest.current = null;
        return { done: true, publicView: step.publicView, actions: [], payout: step.payout, balance, settle: defer ? settle : NOOP };
      }
      gs.state = step.state;
      // Mid-round credit (e.g. a craps roll's winnings or a takedown refund).
      // Apply it now, or defer to the caller's reveal when { deferStep } was set.
      const midCredit = step.credit ?? 0;
      let midSettled = false;
      const settleMid = () => {
        if (midSettled) return;
        midSettled = true;
        if (midCredit > 0) win(midCredit);
      };
      if (!deferStep) settleMid();
      return { roundId: "guest", done: false, publicView: step.publicView, actions: step.actions ?? [], balance, settle: deferStep ? settleMid : NOOP };
    },
    [serverAuthoritative, localBet, win, balance, applyServerBalance],
  );

  return { start, act };
}
