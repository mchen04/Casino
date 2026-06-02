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

  // Limbo edge is analytically ~1% for all targets; target 2 has low variance.
  { label: "limbo target 2.0", game: "limbo", bet: 100, params: { target: 2 }, targetEdge: 1.0 },
  { label: "limbo target 5.0 (info)", game: "limbo", bet: 100, params: { target: 5 }, targetEdge: null },

  // Dragon Tiger (8-deck). Published edges: Dragon/Tiger ~3.73%, Tie ~ high.
  { label: "dragon-tiger: dragon", game: "dragon-tiger", bet: 100, params: { dragon: 100, tiger: 0, tie: 0, suitTie: 0 }, targetEdge: 3.73, tol: 0.4 },
  { label: "dragon-tiger: tiger", game: "dragon-tiger", bet: 100, params: { dragon: 0, tiger: 100, tie: 0, suitTie: 0 }, targetEdge: 3.73, tol: 0.4 },
  { label: "dragon-tiger: tie 8:1", game: "dragon-tiger", bet: 100, params: { dragon: 0, tiger: 0, tie: 100, suitTie: 0 }, targetEdge: null },
  { label: "dragon-tiger: suitTie 50:1", game: "dragon-tiger", bet: 100, params: { dragon: 0, tiger: 0, tie: 0, suitTie: 100 }, targetEdge: null },

  // Money Wheel — published best-bet edge 11.11% on the "1" segment.
  { label: "money-wheel: 1 (best)", game: "money-wheel", bet: 100, params: { pick: "1" }, targetEdge: 11.11, tol: 0.3 },
  { label: "money-wheel: 20", game: "money-wheel", bet: 100, params: { pick: "20" }, targetEdge: null },
  { label: "money-wheel: joker 40:1", game: "money-wheel", bet: 100, params: { pick: "joker" }, targetEdge: null },

  // Andar Bahar — published ~2.58% (1.9× on the first-deal edge side).
  { label: "andar-bahar: andar", game: "andar-bahar", bet: 100, params: { side: "andar" }, targetEdge: 2.58, tol: 0.4 },
  { label: "andar-bahar: bahar", game: "andar-bahar", bet: 100, params: { side: "bahar" }, targetEdge: 2.58, tol: 0.4 },

  // Baccarat — published Banker 1.06%, Player 1.24%, Tie ~14.4% (8-deck).
  { label: "baccarat: banker", game: "baccarat", bet: 100, params: { player: 0, banker: 100, tie: 0, ppair: 0, bpair: 0 }, targetEdge: 1.06, tol: 0.3 },
  { label: "baccarat: player", game: "baccarat", bet: 100, params: { player: 100, banker: 0, tie: 0, ppair: 0, bpair: 0 }, targetEdge: 1.24, tol: 0.3 },
  { label: "baccarat: tie 8:1", game: "baccarat", bet: 100, params: { player: 0, banker: 0, tie: 100, ppair: 0, bpair: 0 }, targetEdge: 14.4, tol: 0.6 },
  { label: "baccarat: ppair 11:1", game: "baccarat", bet: 100, params: { player: 0, banker: 0, tie: 0, ppair: 100, bpair: 0 }, targetEdge: null },

  // Coin Flip — fair 50/50, pays 1.96× → 2% edge.
  { label: "coin-flip: heads", game: "coin-flip", bet: 100, params: { call: "heads" }, targetEdge: 2.0, tol: 0.3 },

  // Plinko — Stake-style tables; report as-coded edge (target ~1% headline).
  { label: "plinko 8/low", game: "plinko", bet: 100, params: { rows: 8, risk: "low" }, targetEdge: null },
  { label: "plinko 12/medium", game: "plinko", bet: 100, params: { rows: 12, risk: "medium" }, targetEdge: null },
  { label: "plinko 16/high", game: "plinko", bet: 100, params: { rows: 16, risk: "high" }, targetEdge: null },

  // Keno — table tuned to ~90-92% RTP (8-10% edge) for every pick count.
  { label: "keno pick-2", game: "keno", bet: 100, params: { picks: [1, 2] }, targetEdge: null },
  { label: "keno pick-5", game: "keno", bet: 100, params: { picks: [1, 2, 3, 4, 5] }, targetEdge: null },
  { label: "keno pick-10", game: "keno", bet: 100, params: { picks: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] }, targetEdge: null },

  // Scratch — per-theme RTP ~0.90-0.93 (8-10% edge).
  { label: "scratch gold", game: "scratch", bet: 100, params: { theme: "gold" }, targetEdge: null },
  { label: "scratch sevens", game: "scratch", bet: 100, params: { theme: "sevens" }, targetEdge: null },
  { label: "scratch neon", game: "scratch", bet: 100, params: { theme: "neon" }, targetEdge: null },
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
