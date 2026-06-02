import crypto from "crypto";
import { makeRng, type Rng } from "./rngCore";

/**
 * Server-side cryptographically-seeded RNG. Feeds the shared rngCore the same
 * distribution helpers the client uses, but draws from crypto.randomBytes
 * instead of Math.random, so outcomes are generated on the server and cannot be
 * predicted or chosen by the client. Distributions match the client helpers
 * exactly, so every game's audited house edge is preserved.
 */
export type { Rng };

/** 53-bit uniform in [0, 1) from 7 crypto-random bytes. */
function cryptoFloat(): number {
  const b = crypto.randomBytes(7);
  let v = 0;
  for (let i = 0; i < 7; i++) v = v * 256 + b[i];
  return v / 2 ** 56;
}

export { makeRng };
export const rng = makeRng(cryptoFloat);
