import type { Rng } from "./rngCore";

/**
 * Contract for a STATELESS one-shot game (bet → single random resolution →
 * payout). The client sends only { game, bet, params }. The server validates,
 * draws the outcome, and computes the payout. The client can never send an
 * outcome or a payout, so the most it controls is choosing (house-negative) bet
 * parameters.
 */
export interface ResolveOutput {
  /** Total chips returned to the player: 0 on a loss, stake×multiplier on a win. */
  payout: number;
  /** Game-specific detail the client animates toward (e.g. the dice roll). */
  outcome: Record<string, unknown>;
}

export interface GameSpec<P = unknown> {
  slug: string;
  minBet: number;
  maxBet: number;
  /**
   * Validate + normalise client params. MUST throw a GameError on anything
   * out of range so payout math can never be driven to an absurd multiplier.
   */
  validate: (params: unknown) => P;
  /** Pure resolution: given a validated bet + params and an RNG, decide the result. */
  resolve: (bet: number, params: P, rng: Rng) => ResolveOutput;
}

export class GameError extends Error {}

const REGISTRY = new Map<string, GameSpec<unknown>>();

export function register<P>(spec: GameSpec<P>): void {
  REGISTRY.set(spec.slug, spec as unknown as GameSpec<unknown>);
}

export function getSpec(slug: string): GameSpec<unknown> | undefined {
  return REGISTRY.get(slug);
}

export function registeredGames(): string[] {
  return [...REGISTRY.keys()];
}

// ---- shared validation helpers used by every resolver -------------------

export function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new GameError(msg);
}

export function num(v: unknown, name: string): number {
  assert(typeof v === "number" && Number.isFinite(v), `Invalid ${name}`);
  return v as number;
}

export function intIn(v: unknown, min: number, max: number, name: string): number {
  const n = num(v, name);
  assert(Number.isInteger(n) && n >= min && n <= max, `${name} out of range`);
  return n;
}

export function oneOf<T extends string>(v: unknown, allowed: readonly T[], name: string): T {
  assert(typeof v === "string" && (allowed as readonly string[]).includes(v), `Invalid ${name}`);
  return v as T;
}

/** A non-negative integer in [0, max]. Used for per-spot chip amounts. */
export function nonNegInt(v: unknown, max: number, name: string): number {
  const n = num(v, name);
  assert(Number.isInteger(n) && n >= 0 && n <= max, `${name} out of range`);
  return n;
}

export function bool(v: unknown, name: string): boolean {
  assert(typeof v === "boolean", `Invalid ${name}`);
  return v;
}

/**
 * Validate a multi-spot bet: each spot is a non-negative integer, at least one
 * spot is positive, and the spots sum EXACTLY to the accepted total `bet`. This
 * makes it impossible to under-fund a spread or smuggle a payout-bearing spot
 * the player never paid for.
 */
export function validateSpots<K extends string>(
  raw: unknown,
  keys: readonly K[],
  bet: number,
  maxPerSpot: number,
): Record<K, number> {
  assert(raw && typeof raw === "object", "Missing bets");
  const r = raw as Record<string, unknown>;
  const out = {} as Record<K, number>;
  let sum = 0;
  let positive = 0;
  for (const k of keys) {
    const amt = nonNegInt(r[k], maxPerSpot, k);
    out[k] = amt;
    sum += amt;
    if (amt > 0) positive++;
  }
  assert(positive > 0, "No bet placed");
  assert(sum === bet, "Bet spots must sum to the stake");
  return out;
}
