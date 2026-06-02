/**
 * Pure, environment-agnostic RNG core. Holds the `Rng` interface and the
 * distribution helpers (range/int/pick/shuffle/chance/weighted) as functions of
 * a single `float(): number` source.
 *
 * This module has NO node/browser dependencies so it can be imported by:
 *   - the server (server/rng.ts feeds it crypto.randomBytes)            → authoritative
 *   - the client guest demo (lib/clientRng.ts feeds it Math.random)     → local-only
 *   - resolvers / Monte-Carlo harnesses (any float source)
 *
 * Because every game resolver draws ONLY through this surface, the exact same
 * resolve() code produces identically-shaped outcomes server-side and in the
 * guest demo — the only difference is the entropy source.
 */
export interface Rng {
  float(): number; // uniform [0, 1)
  range(min: number, max: number): number; // uniform float [min, max)
  int(min: number, max: number): number; // uniform integer [min, max] inclusive
  pick<T>(arr: readonly T[]): T;
  shuffle<T>(arr: readonly T[]): T[];
  chance(p: number): boolean;
  weighted<T>(items: readonly T[], weights: readonly number[]): T;
}

export function makeRng(float: () => number): Rng {
  const range = (min: number, max: number) => min + float() * (max - min);
  const int = (min: number, max: number) => Math.floor(min + float() * (max - min + 1));
  return {
    float,
    range,
    int,
    pick: <T,>(arr: readonly T[]): T => arr[Math.floor(float() * arr.length)],
    shuffle: <T,>(arr: readonly T[]): T[] => {
      const a = arr.slice();
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(float() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a;
    },
    chance: (p: number) => float() < p,
    weighted: <T,>(items: readonly T[], weights: readonly number[]): T => {
      const total = weights.reduce((s, w) => s + w, 0);
      let r = float() * total;
      for (let i = 0; i < items.length; i++) {
        r -= weights[i];
        if (r < 0) return items[i];
      }
      return items[items.length - 1];
    },
  };
}
