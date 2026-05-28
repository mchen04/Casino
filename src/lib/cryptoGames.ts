// Shared math for the "crypto-style" instant games (dice, limbo, crash).
// All three draw from the same inverse-uniform distribution with a house edge
// folded into the payout, not the draw.

export const HOUSE_EDGE = 0.01;

/**
 * Draw a crash-style multiplier from the inverse-uniform distribution:
 *   m = (1 - edge) / (1 - U),  U ∈ [0, 1)
 * Returns a value >= 1. Used directly by Limbo; floor with `toCrashPoint` for Crash.
 */
export function rollMultiplier(edge = HOUSE_EDGE): number {
  const r = Math.min(Math.max(Math.random(), 0), 0.999999);
  return Math.max(1, (1 - edge) / (1 - r));
}

/** Truncate a raw multiplier to a 2-decimal crash point (>= 1.00). */
export function toCrashPoint(m: number): number {
  return Math.max(1, Math.floor(m * 100) / 100);
}

/**
 * Fair-with-edge payout multiplier (includes the returned stake) for a given
 * win probability in (0,1]:  payout = (1 - edge) / p.  Used by Dice.
 */
export function payoutForChance(winChance01: number, edge = HOUSE_EDGE): number {
  if (winChance01 <= 0) return 0;
  return (1 - edge) / winChance01;
}

/**
 * Win probability (0..1) of reaching a target multiplier:
 *   p = min(1, (1 - edge) / target).  Used by Limbo.
 */
export function winChanceForTarget(targetMultiplier: number, edge = HOUSE_EDGE): number {
  if (targetMultiplier <= 0) return 0;
  return Math.min(1, (1 - edge) / targetMultiplier);
}
