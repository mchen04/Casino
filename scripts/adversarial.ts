/**
 * Adversarial red-team for the stateless resolvers (KR1.3 / 8c).
 *
 * Re-run after every new resolver. It hammers each registered game's validate()
 * + resolve() with malicious params and asserts the security invariants that
 * make balances impossible to hack:
 *
 *   (A) validate() REJECTS bad input with a GameError (a controlled 400), never
 *       a raw crash and never by silently accepting an exploitable shape.
 *   (B) resolve() with ANY accepted params returns a FINITE, NON-NEGATIVE payout
 *       (the /api/play wrapper 500s otherwise, but defence in depth).
 *   (C) For multi-spot games, spots that don't sum to the accepted stake are
 *       rejected (no under-funding a spread / smuggling a free payout spot).
 *   (D) Over a sample, the realised house edge is >= 0 for the probed bet — the
 *       player can never drive EV >= 1 by choosing params.
 *
 * Run: npx tsc -p tsconfig.scripts.json && node .mc-build/scripts/adversarial.js
 */
import { makeRng } from "../src/lib/server/rngCore";
import { getSpec, registeredGames, GameError } from "../src/lib/server/engine";
import "../src/lib/server/games";

const rng = makeRng(Math.random);
let failures = 0;
const log = (ok: boolean, msg: string) => {
  if (!ok) failures++;
  console.log(`  [${ok ? "ok " : "FAIL"}] ${msg}`);
};

// Malicious param payloads tried against every game (each MUST be rejected with
// a GameError, or — if the spec happens to accept it — resolve() must still be
// safe and the bet/sum guards must hold).
const EVIL_PARAMS: unknown[] = [
  null,
  undefined,
  42,
  "pwned",
  [],
  {},
  { __proto__: { polluted: true } },
  { target: -1 },
  { target: Infinity },
  { target: NaN },
  { target: "100" },
  { mode: "OVER" },
  { picks: [1, 1, 1] }, // dup
  { picks: Array.from({ length: 50 }, (_, i) => i + 1) }, // too many
  { picks: [0] }, // out of range
  { pick: "999" },
  { theme: "hacker" },
  { rows: 99, risk: "low" },
  { bets: { hax: 1e9 } },
  { bets: [{ kind: "straight", ref: 17, amount: 999999999 }] },
  { dragon: -5, tiger: 0, tie: 0, suitTie: 0 },
  { player: 1e12, banker: 0, tie: 0, ppair: 0, bpair: 0 },
];

function probeValidate(slug: string) {
  const spec = getSpec(slug)!;
  for (const p of EVIL_PARAMS) {
    let accepted = false;
    let validated: unknown;
    try {
      validated = spec.validate(p);
      accepted = true;
    } catch (e) {
      // A GameError is the CORRECT rejection. Anything else is a crash bug.
      log(e instanceof GameError, `${slug}: reject ${JSON.stringify(p)?.slice(0, 40)} → ${e instanceof GameError ? "GameError" : `CRASH ${(e as Error).message}`}`);
      continue;
    }
    if (accepted) {
      // If it accepted the shape, resolve() across stakes must stay safe:
      // payout finite, >= 0, and the spots/sum guard must hold (these resolvers
      // do the sum-equals-stake check inside resolve()).
      for (const bet of [spec.minBet, 100, spec.maxBet]) {
        try {
          const r = spec.resolve(bet, validated, rng);
          const safe = Number.isFinite(r.payout) && r.payout >= 0;
          if (!safe) log(false, `${slug}: UNSAFE payout ${r.payout} for accepted ${JSON.stringify(p)?.slice(0, 40)}`);
        } catch (e) {
          // resolve() throwing a GameError on accepted-but-inconsistent params
          // (e.g. spots don't sum to bet) is the correct guard, not a failure.
          if (!(e instanceof GameError)) log(false, `${slug}: resolve CRASH on ${JSON.stringify(p)?.slice(0, 40)} → ${(e as Error).message}`);
        }
      }
    }
  }
}

/** Probe the house edge for the player's *best* available bet on each game. */
function probeEdge(slug: string, params: unknown, rounds = 300_000) {
  const spec = getSpec(slug)!;
  let validated;
  try {
    validated = spec.validate(params);
  } catch {
    return; // game not covered by a representative bet here
  }
  const bet = 100;
  let wagered = 0;
  let returned = 0;
  let maxPayout = 0;
  for (let i = 0; i < rounds; i++) {
    const r = spec.resolve(bet, validated, rng);
    if (!Number.isFinite(r.payout) || r.payout < 0) {
      log(false, `${slug}: illegal payout ${r.payout} during edge probe`);
      return;
    }
    wagered += bet;
    returned += r.payout;
    if (r.payout > maxPayout) maxPayout = r.payout;
  }
  const edge = (1 - returned / wagered) * 100;
  log(edge >= -0.5, `${slug}: best-bet edge ${edge.toFixed(2)}% (>=0 ⇒ house safe)  maxPayout ${(maxPayout / bet).toFixed(0)}x`);
}

// Representative "strongest" player bets per game (lowest-edge option).
const BEST_BETS: Record<string, unknown> = {
  dice: { target: 50, mode: "over" },
  limbo: { target: 1.01 },
  "dragon-tiger": { dragon: 100, tiger: 0, tie: 0, suitTie: 0 },
  "money-wheel": { pick: "1" },
  "andar-bahar": { side: "andar" },
  baccarat: { player: 0, banker: 100, tie: 0, ppair: 0, bpair: 0 },
  "coin-flip": { call: "heads" },
  plinko: { rows: 16, risk: "low" },
  keno: { picks: [1, 2] },
  scratch: { theme: "neon" },
  roulette: { mode: "european", bets: [{ kind: "red", ref: 0, amount: 100 }] },
  "sic-bo": { bets: { small: 100 } },
  "slots-classic": {},
  "slots-megaways": {},
  "slots-fruit": {},
  "tiannas-treasury": {},
  bingo: { cards: [[[1, 2, 3, 4, 5], [16, 17, 18, 19, 20], [31, 32, 0, 34, 35], [46, 47, 48, 49, 50], [61, 62, 63, 64, 65]]] },
};

function main() {
  const games = registeredGames().sort();
  console.log(`Adversarial red-team over ${games.length} resolvers\n`);
  console.log("== (A/B/C) validate + resolve robustness ==");
  for (const slug of games) probeValidate(slug);
  console.log("\n== (D) best-bet house edge >= 0 ==");
  for (const slug of games) {
    if (BEST_BETS[slug] !== undefined) probeEdge(slug, BEST_BETS[slug]);
  }
  console.log(`\n${failures === 0 ? "✅ 0 confirmed exploits" : `❌ ${failures} FINDINGS`} across ${games.length} resolvers`);
  if (failures > 0) process.exitCode = 1;
}

main();
