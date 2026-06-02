/**
 * Monte-Carlo verification for STATEFUL round games (/api/round). Plays each
 * game with its OPTIMAL strategy and reports the house edge both on the initial
 * wager and on total action (element of risk).
 *
 *   npx tsc -p tsconfig.scripts.json && node .mc-build/scripts/mc-round.js [rounds]
 */
import { makeRng } from "../src/lib/server/rngCore";
import { getRoundGame } from "../src/lib/server/round/engine";
import "../src/lib/server/round/games";

const rng = makeRng(Math.random);
const BET = 100;

interface Sim { initialWagered: number; totalWagered: number; returned: number }

/** Casino War — optimal strategy: always GO TO WAR on a tie. */
function simCasinoWar(rounds: number): Sim {
  const game = getRoundGame("casino-war")!;
  let initialWagered = 0;
  let totalWagered = 0;
  let returned = 0;
  for (let i = 0; i < rounds; i++) {
    const start = game.start(BET, {}, rng);
    initialWagered += BET;
    totalWagered += BET;
    if (start.done) {
      returned += start.payout;
      continue;
    }
    const act = game.act(start.state, BET, "war", null, rng);
    totalWagered += act.debit ?? 0;
    returned += act.payout;
  }
  return { initialWagered, totalWagered, returned };
}

/** Red Dog — optimal strategy: RAISE on spread >= 7, else CALL. */
function simRedDog(rounds: number): Sim {
  const game = getRoundGame("red-dog")!;
  let initialWagered = 0;
  let totalWagered = 0;
  let returned = 0;
  for (let i = 0; i < rounds; i++) {
    const start = game.start(BET, {}, rng);
    initialWagered += BET;
    totalWagered += BET;
    if (start.done) {
      returned += start.payout;
      continue;
    }
    const sp = Number(start.publicView.spread);
    const action = sp >= 7 ? "raise" : "call";
    const act = game.act(start.state, BET, action, null, rng);
    totalWagered += act.debit ?? 0;
    returned += act.payout;
  }
  return { initialWagered, totalWagered, returned };
}

function report(label: string, s: Sim, target: number, tol: number, measure: "initial" | "action" = "initial") {
  const net = s.returned - s.totalWagered;
  const edgeInitial = (-net / s.initialWagered) * 100; // house edge on the ante
  const edgeAction = (-net / s.totalWagered) * 100; // element of risk
  const ok = Math.abs((measure === "action" ? edgeAction : edgeInitial) - target) <= tol;
  console.log(
    `[${ok ? "PASS" : "FAIL"}] ${label.padEnd(20)} edge(initial)=${edgeInitial.toFixed(3)}% ` +
      `(target ${target}±${tol} on ${measure})  edge(action)=${edgeAction.toFixed(3)}%`,
  );
  return ok;
}

function main() {
  const rounds = process.argv[2] ? parseInt(process.argv[2], 10) : 2_000_000;
  console.log(`Round games: casino-war, red-dog\nRounds: ${rounds.toLocaleString()}\n`);
  let pass = 0;
  let fail = 0;
  // This game's generous 2:1 war-tie bonus lowers the edge below the 2.88%
  // standard to the repo's documented ~2.33% (edge-on-initial ~2.4%).
  report("casino-war", simCasinoWar(rounds), 2.4, 0.3) ? pass++ : fail++;
  // Red Dog (raise on spread >= 7): documented ~2.67% element-of-risk
  // (edge-on-ante ~3.16%, the canonical single-deck figure).
  report("red-dog", simRedDog(rounds), 2.67, 0.35, "action") ? pass++ : fail++;
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exitCode = 1;
}

main();
