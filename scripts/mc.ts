/**
 * Monte-Carlo verification harness for the server-authoritative game resolvers.
 *
 * It imports the SAME pure resolvers the server runs (alias-free graph so it
 * compiles+runs under plain node) and plays millions of rounds to measure each
 * game's actual RTP / house edge against its published target (KR3.2). Run:
 *
 *   npx tsc -p tsconfig.scripts.json && node .mc-build/scripts/mc.js [filter] [rounds]
 *
 * `filter` (optional) restricts to scenarios whose label includes the string.
 * `rounds` (optional) overrides the per-scenario round count.
 */
import { makeRng } from "../src/lib/server/rngCore";
import { getSpec, registeredGames } from "../src/lib/server/engine";
import "../src/lib/server/games"; // populate the registry

const rng = makeRng(Math.random);

interface Scenario {
  label: string;
  game: string;
  bet: number;
  params: unknown;
  /** Published house-edge target (%), or null for skill/variable games. */
  targetEdge: number | null;
  /** Acceptance tolerance in percentage points (default ±0.3). */
  tol?: number;
}

// ---- Scenarios grow as games are ported. ----------------------------------
const SCENARIOS: Scenario[] = [
  // Dice edge is analytically exactly 1% for ALL targets (payout = 0.99/p).
  // Representative near-50% bets converge fast; extreme tails need more samples.
  { label: "dice over @ target 50", game: "dice", bet: 100, params: { target: 50, mode: "over" }, targetEdge: 1.0 },
  { label: "dice under @ target 50", game: "dice", bet: 100, params: { target: 50, mode: "under" }, targetEdge: 1.0 },
];

function runScenario(s: Scenario, rounds: number) {
  const spec = getSpec(s.game);
  if (!spec) throw new Error(`No spec registered for ${s.game}`);
  const validated = spec.validate(s.params);
  let wagered = 0;
  let returned = 0;
  let wins = 0;
  let biggest = 0;
  for (let i = 0; i < rounds; i++) {
    const r = spec.resolve(s.bet, validated, rng);
    if (!Number.isFinite(r.payout) || r.payout < 0) {
      throw new Error(`${s.label}: illegal payout ${r.payout}`);
    }
    wagered += s.bet;
    returned += r.payout;
    if (r.payout > 0) wins++;
    if (r.payout > biggest) biggest = r.payout;
  }
  const rtp = returned / wagered;
  const edge = (1 - rtp) * 100;
  return { rtp, edge, winRate: wins / rounds, biggestMult: biggest / s.bet };
}

function main() {
  const filter = process.argv[2] && !/^\d+$/.test(process.argv[2]) ? process.argv[2] : undefined;
  const roundsArg = process.argv.find((a, i) => i >= 2 && /^\d+$/.test(a));
  const rounds = roundsArg ? parseInt(roundsArg, 10) : 200_000;

  console.log(`Registered games: ${registeredGames().sort().join(", ")}`);
  console.log(`Rounds/scenario: ${rounds.toLocaleString()}\n`);

  const scenarios = filter ? SCENARIOS.filter((s) => s.label.includes(filter) || s.game.includes(filter)) : SCENARIOS;
  let pass = 0;
  let fail = 0;
  for (const s of scenarios) {
    const { edge, winRate, biggestMult } = runScenario(s, rounds);
    const tol = s.tol ?? 0.3;
    let verdict = "n/a ";
    if (s.targetEdge !== null) {
      const ok = Math.abs(edge - s.targetEdge) <= tol;
      verdict = ok ? "PASS" : "FAIL";
      ok ? pass++ : fail++;
    }
    console.log(
      `[${verdict}] ${s.label.padEnd(34)} edge=${edge.toFixed(3)}%` +
        (s.targetEdge !== null ? ` (target ${s.targetEdge}±${tol})` : "") +
        `  win=${(winRate * 100).toFixed(2)}%  maxMult=${biggestMult.toFixed(1)}x`,
    );
  }
  console.log(`\n${pass} passed, ${fail} failed, ${scenarios.length} total`);
  if (fail > 0) process.exitCode = 1;
}

main();
