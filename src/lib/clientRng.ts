import { makeRng, type Rng } from "./server/rngCore";

/**
 * Client-side RNG for the GUEST DEMO ONLY. Backed by Math.random — this never
 * touches money on the server; logged-in users always resolve through the
 * server's crypto RNG via /api/play. Because it feeds the SAME rngCore helpers
 * the server uses, a resolver's outcome shape is identical in both paths, so the
 * animation code is shared and a guest's local demo mirrors the real game.
 */
export const clientRng: Rng = makeRng(Math.random);
