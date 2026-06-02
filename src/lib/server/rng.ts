import crypto from "crypto";

/**
 * Server-side cryptographically-seeded RNG. Mirrors the helper surface of the
 * client's lib/rng.ts but draws from crypto.randomBytes instead of Math.random,
 * so outcomes are generated on the server and cannot be predicted or chosen by
 * the client. Distributions match the client helpers exactly, so every game's
 * audited house edge is preserved.
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

/** 53-bit uniform in [0, 1) from 7 crypto-random bytes. */
function cryptoFloat(): number {
  const b = crypto.randomBytes(7);
  let v = 0;
  for (let i = 0; i < 7; i++) v = v * 256 + b[i];
  return v / 2 ** 56;
}

export function makeRng(float: () => number = cryptoFloat): Rng {
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

export const rng = makeRng();
