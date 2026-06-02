import { type RoundGame, GameError } from "../engine";
import { intIn, assert } from "../../engine";

// Server-authoritative Craps — mirrors src/games/craps.tsx. The whole table
// (point, bets, odds, hardways, repeaters, working flag) lives in the round
// state; the client only sends decisions and animates the server's dice. Bets
// are DEBITED atomically when placed; winning rolls and take-downs CREDIT the
// authoritative balance mid-round (via RoundStep.credit). The dice are rolled
// with the crypto RNG server-side, so no roll or payout can be forged.
//
//   Line   : Pass 1:1 (7/11 win, 2/3/12 lose on come-out; then point), Don't Pass
//            (2/3 win, 7/11 lose, 12 push). Odds pay TRUE odds (no edge).
//   Field  : one-roll — 2 pays 2:1, 12 pays 3:1, 3/4/9/10/11 pay 1:1, else lose.
//   Place 6/8 : 7:6 when it rolls before a 7 (bet stays working).
//   Hardways  : hard 4/10 7:1, hard 6/8 9:1 (lose on the easy way or a 7).
//   Repeaters : a number must repeat N× before a seven-out for a big prop payout.
//   Place/hardway/repeaters only "work" on the come-out when the working flag is on.

const SPOTS = ["pass", "dontPass", "field", "place6", "place8"] as const;
type LineKey = (typeof SPOTS)[number];

const HARD = { hard4: 4, hard6: 6, hard8: 8, hard10: 10 } as const;
type HardKey = keyof typeof HARD;
const HARD_PAYS: Record<HardKey, number> = { hard4: 7, hard6: 9, hard8: 9, hard10: 7 };

interface RepeaterDef { num: number; target: number; pays: number; }
const REPEATERS: RepeaterDef[] = [
  { num: 2, target: 2, pays: 25 }, { num: 3, target: 3, pays: 30 },
  { num: 4, target: 4, pays: 38 }, { num: 5, target: 5, pays: 42 },
  { num: 6, target: 6, pays: 46 }, { num: 8, target: 6, pays: 46 },
  { num: 9, target: 5, pays: 42 }, { num: 10, target: 4, pays: 38 },
  { num: 11, target: 3, pays: 30 }, { num: 12, target: 2, pays: 25 },
];
const REP_BY_NUM = new Map(REPEATERS.map((r) => [r.num, r]));

const MAX_BET = 1_000_000;

interface CrapsState {
  point: number | null;
  working: boolean;
  bets: Record<LineKey, number>;
  passOdds: number;
  dontOdds: number;
  hard: Record<HardKey, number>;
  rep: Record<number, number>;
  repCount: Record<number, number>;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function freshState(): CrapsState {
  return {
    point: null,
    working: false,
    bets: { pass: 0, dontPass: 0, field: 0, place6: 0, place8: 0 },
    passOdds: 0,
    dontOdds: 0,
    hard: { hard4: 0, hard6: 0, hard8: 0, hard10: 0 },
    rep: {},
    repCount: {},
  };
}

/** Pass-odds true multiplier (profit ratio) for a point. */
function passOddsProfit(point: number): number {
  if (point === 4 || point === 10) return 2; // 2:1
  if (point === 5 || point === 9) return 3 / 2; // 3:2
  return 6 / 5; // 6/8 → 6:5
}
/** Don't-pass odds invert (lay against the point). */
function dontOddsProfit(point: number): number {
  if (point === 4 || point === 10) return 1 / 2; // 1:2
  if (point === 5 || point === 9) return 2 / 3; // 2:3
  return 5 / 6; // 6/8 → 5:6
}

const die = (rng: { float(): number }) => Math.floor(rng.float() * 6) + 1;

/** Resolve one roll: mutate a COPY of state, return the gross credited. */
function resolveRoll(prev: CrapsState, a: number, b: number): { state: CrapsState; gross: number; total: number } {
  const t = a + b;
  const isHard = a === b;
  const comeOut = prev.point === null;
  const multiActive = !comeOut || prev.working;
  const s: CrapsState = {
    ...prev,
    bets: { ...prev.bets },
    hard: { ...prev.hard },
    rep: { ...prev.rep },
    repCount: { ...prev.repCount },
  };
  let gross = 0;

  // FIELD — one-roll.
  if (s.bets.field > 0) {
    if (t === 2) gross += s.bets.field * 3;
    else if (t === 12) gross += s.bets.field * 4;
    else if (t === 3 || t === 4 || t === 9 || t === 10 || t === 11) gross += s.bets.field * 2;
    s.bets.field = 0;
  }

  // PLACE 6 / 8 and HARDWAYS — only when working.
  if (multiActive) {
    for (const [key, num] of [["place6", 6], ["place8", 8]] as const) {
      const stake = s.bets[key];
      if (stake <= 0) continue;
      if (t === num) gross += (stake / 6) * 7; // 7:6 profit; bet stays working
      else if (t === 7) s.bets[key] = 0; // lose on the 7
    }
    for (const hk of Object.keys(HARD) as HardKey[]) {
      const stake = s.hard[hk];
      if (stake <= 0) continue;
      const num = HARD[hk];
      if (t === num) {
        if (isHard) gross += stake * (HARD_PAYS[hk] + 1); // win, taken down
        s.hard[hk] = 0; // resolved either way (hard win or easy loss)
      } else if (t === 7) {
        s.hard[hk] = 0; // lose on the 7
      }
    }
  }

  // PASS / DON'T PASS (+ odds).
  if (comeOut) {
    if (s.bets.pass > 0) {
      if (t === 7 || t === 11) { gross += s.bets.pass * 2; s.bets.pass = 0; }
      else if (t === 2 || t === 3 || t === 12) s.bets.pass = 0;
    }
    if (s.bets.dontPass > 0) {
      if (t === 2 || t === 3) { gross += s.bets.dontPass * 2; s.bets.dontPass = 0; }
      else if (t === 7 || t === 11) s.bets.dontPass = 0;
      else if (t === 12) { gross += s.bets.dontPass; s.bets.dontPass = 0; } // push
    }
    if (t === 4 || t === 5 || t === 6 || t === 8 || t === 9 || t === 10) s.point = t;
  } else {
    const p = prev.point as number;
    if (t === p) {
      if (s.bets.pass > 0) { gross += s.bets.pass * 2; s.bets.pass = 0; }
      if (s.passOdds > 0) { gross += s.passOdds + s.passOdds * passOddsProfit(p); s.passOdds = 0; }
      if (s.bets.dontPass > 0) s.bets.dontPass = 0; // don't loses when the point hits
      if (s.dontOdds > 0) s.dontOdds = 0;
      s.point = null;
    } else if (t === 7) {
      // SEVEN OUT — pass/odds lose; don't pass/odds win. (Place/hardways already
      // cleared above.) Repeaters clear below.
      if (s.bets.pass > 0) s.bets.pass = 0;
      if (s.passOdds > 0) s.passOdds = 0;
      if (s.bets.dontPass > 0) { gross += s.bets.dontPass * 2; s.bets.dontPass = 0; }
      if (s.dontOdds > 0) { gross += s.dontOdds + s.dontOdds * dontOddsProfit(p); s.dontOdds = 0; }
      s.point = null;
    }
  }

  // REPEATERS — a seven-out clears them; come-out sevens do not.
  const sevenOut = !comeOut && t === 7;
  for (const def of REPEATERS) {
    const stake = s.rep[def.num] ?? 0;
    if (stake <= 0) continue;
    if (sevenOut) {
      delete s.rep[def.num];
      delete s.repCount[def.num];
    } else if (t === def.num) {
      const c = (s.repCount[def.num] ?? 0) + 1;
      if (c >= def.target) {
        gross += stake * (def.pays + 1);
        delete s.rep[def.num];
        delete s.repCount[def.num];
      } else {
        s.repCount[def.num] = c;
      }
    }
  }

  return { state: s, gross: round2(gross), total: t };
}

/** Total chips returnable on a take-down at the current phase. */
function takeableRefund(s: CrapsState, includeLine: boolean): number {
  let r = s.bets.field + s.bets.place6 + s.bets.place8 +
    s.hard.hard4 + s.hard.hard6 + s.hard.hard8 + s.hard.hard10;
  if (includeLine) r += s.bets.pass + s.bets.dontPass + s.passOdds + s.dontOdds;
  return round2(r);
}

function publicState(s: CrapsState, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    point: s.point,
    working: s.working,
    bets: s.bets,
    passOdds: s.passOdds,
    dontOdds: s.dontOdds,
    hard: s.hard,
    rep: s.rep,
    repCount: s.repCount,
    ...extra,
  };
}

const CONTINUE = (s: CrapsState, extra: Record<string, unknown>, debit?: number, credit?: number) => ({
  state: s,
  publicView: publicState(s, extra),
  actions: ["place", "takedown", "working", "roll", "leave"],
  done: false,
  payout: 0,
  debit,
  credit,
});

export const crapsGame: RoundGame<CrapsState, Record<string, never>> = {
  slug: "craps",
  minBet: 0, // the session opens with no money down; bets are placed via actions
  maxBet: 0,
  validate: () => ({}),
  start: () => CONTINUE(freshState(), {}),
  act: (state, _bet, action, payload, rng) => {
    const s = state as CrapsState;
    const p = (payload ?? {}) as Record<string, unknown>;

    if (action === "working") {
      const on = p.on === true;
      return CONTINUE({ ...s, working: on }, {});
    }

    if (action === "place") {
      const spot = typeof p.spot === "string" ? p.spot : "";
      const amount = intIn(p.amount, 1, MAX_BET, "amount");
      const comeOut = s.point === null;
      const ns: CrapsState = {
        ...s, bets: { ...s.bets }, hard: { ...s.hard }, rep: { ...s.rep }, repCount: { ...s.repCount },
      };
      if (spot === "pass" || spot === "dontPass") {
        // A line contract can only be opened during the come-out (no point).
        assert(comeOut, "Can't open a line bet after the point is set");
        ns.bets[spot] += amount;
      } else if (spot === "field" || spot === "place6" || spot === "place8") {
        ns.bets[spot] += amount;
      } else if (spot === "passOdds") {
        assert(!comeOut && s.bets.pass > 0, "Pass odds need a pass bet + a point");
        ns.passOdds += amount;
      } else if (spot === "dontOdds") {
        assert(!comeOut && s.bets.dontPass > 0, "Don't odds need a don't-pass bet + a point");
        ns.dontOdds += amount;
      } else if (spot in HARD) {
        ns.hard[spot as HardKey] += amount;
      } else if (spot.startsWith("rep")) {
        const num = Number(spot.slice(3));
        assert(REP_BY_NUM.has(num), "Unknown repeater");
        assert(comeOut, "Repeaters can only be placed on the come-out");
        ns.rep[num] = (ns.rep[num] ?? 0) + amount;
        ns.repCount[num] = ns.repCount[num] ?? 0;
      } else {
        throw new GameError("Unknown bet spot");
      }
      return CONTINUE(ns, { placed: spot }, amount); // DEBIT the placed chips
    }

    if (action === "takedown") {
      const comeOut = s.point === null;
      const refund = takeableRefund(s, comeOut);
      if (refund <= 0) return CONTINUE(s, { tookDown: false });
      const ns: CrapsState = {
        ...s, bets: { ...s.bets }, hard: { hard4: 0, hard6: 0, hard8: 0, hard10: 0 },
        rep: { ...s.rep }, repCount: { ...s.repCount },
      };
      ns.bets.field = 0; ns.bets.place6 = 0; ns.bets.place8 = 0;
      if (comeOut) { ns.bets.pass = 0; ns.bets.dontPass = 0; ns.passOdds = 0; ns.dontOdds = 0; }
      return CONTINUE(ns, { tookDown: true, refund }, undefined, refund); // CREDIT the refund
    }

    if (action === "roll") {
      const a = die(rng), b = die(rng);
      const { state: ns, gross, total } = resolveRoll(s, a, b);
      return CONTINUE(ns, { dice: { a, b, total }, gross, prevPoint: s.point }, undefined, gross);
    }

    if (action === "leave") {
      // Only at the come-out — a line bet riding a point must resolve first
      // (otherwise a player could dodge the −EV point phase by walking).
      assert(s.point === null, "Make the point or seven out before you leave");
      const refund = takeableRefund(s, true); // repeaters are forfeited
      return {
        publicView: publicState(s, { left: true, refund }),
        actions: [],
        done: true,
        payout: refund,
      };
    }

    throw new GameError("Invalid action");
  },
};
