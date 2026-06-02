import type { Rng } from "../rngCore";
import { GameError } from "../engine";

/**
 * Contract for a STATEFUL multi-step game (start → decision(s) → settle), played
 * through /api/round. The server holds the full hidden state (dealer hole cards,
 * the deck, etc.) in Redis; the client only ever sees `publicView` and chooses
 * among `actions`. Because the outcome is committed server-side at `start` and
 * every decision is validated against the stored state, the client can never
 * forge a result, replay a settled round, or coerce a payout.
 */
export interface RoundStep<S> {
  /** Full hidden round state to persist (only read while `!done`). */
  state?: S;
  /** Sanitised view the client may see (never leaks unrevealed cards). */
  publicView: Record<string, unknown>;
  /** Decisions the client may submit next (empty ⇒ round is over). */
  actions: string[];
  /** True when the round is finished and `payout` must be credited. */
  done: boolean;
  /** Total chips returned to the player on settle (0 on a loss). */
  payout: number;
  /**
   * Additional chips to DEBIT atomically as part of this step (e.g. a blackjack
   * double/split, an ante raise, the casino-war "go to war" match). The engine
   * debits this from the authoritative balance before persisting the step.
   */
  debit?: number;
}

export interface RoundGame<S = unknown, P = unknown> {
  slug: string;
  minBet: number;
  maxBet: number;
  /** Validate + normalise the client's start params (throws GameError on bad input). */
  validate: (params: unknown) => P;
  /** Begin a round: the bet is already debited by the engine. */
  start: (bet: number, params: P, rng: Rng) => RoundStep<S>;
  /** Apply a player decision to the stored state. */
  act: (state: S, bet: number, action: string, payload: unknown, rng: Rng) => RoundStep<S>;
}

const REGISTRY = new Map<string, RoundGame>();

export function registerRound<S, P>(game: RoundGame<S, P>): void {
  REGISTRY.set(game.slug, game as unknown as RoundGame);
}
export function getRoundGame(slug: string): RoundGame | undefined {
  return REGISTRY.get(slug);
}
export function registeredRoundGames(): string[] {
  return [...REGISTRY.keys()];
}

export { GameError };
