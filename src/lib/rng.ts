// Lightweight random helpers. Uses Math.random under the hood — this is play
// money, not a regulated RNG, but each draw is independent and unbiased enough
// for game feel. All helpers are pure functions of Math.random().

/** Random float in [min, max). */
export function randFloat(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

/** Random integer in [min, max] inclusive. */
export function randInt(min: number, max: number): number {
  return Math.floor(min + Math.random() * (max - min + 1));
}

/** Pick a uniformly random element. Returns undefined for empty arrays. */
export function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

/** Fisher–Yates shuffle. Returns a NEW array; does not mutate the input. */
export function shuffle<T>(arr: readonly T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** True with probability p (0..1). */
export function chance(p: number): boolean {
  return Math.random() < p;
}

/** Weighted pick. weights[i] is the relative weight of items[i]. */
export function weightedPick<T>(items: readonly T[], weights: readonly number[]): T {
  const total = weights.reduce((s, w) => s + w, 0);
  let r = Math.random() * total;
  for (let i = 0; i < items.length; i++) {
    r -= weights[i];
    if (r < 0) return items[i];
  }
  return items[items.length - 1];
}

/** Clamp helper. */
export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}
