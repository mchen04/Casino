"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useWallet } from "@/lib/wallet";
import { usePlayRound } from "@/lib/playRound";
import { sfx } from "@/lib/sound";
import { randInt } from "@/lib/rng";
import { formatChips, formatDelta } from "@/lib/format";
import { CountingNumber } from "@/components/CountingNumber";
import { CollapsiblePanel } from "@/components/CollapsiblePanel";
import { Button } from "@/components/ui/Button";
import { Chip } from "@/components/ui/Chip";
import { Celebration } from "@/components/Celebration";

/* ----------------------------------------------------------------------------
 * CRAPS — two dice on the felt.
 *
 * Money model (SERVER-AUTHORITATIVE — settles through /api/round):
 *  - A session is opened lazily with roundStart("craps", 0, {}) (no money down).
 *  - Committing a wager sends act("place", { spot, amount }): the SERVER debits
 *    the chips and returns the new table (publicView) — the single source of truth.
 *  - A roll sends act("roll"): the server rolls two crypto-RNG dice, resolves
 *    every bet, CREDITS the winnings (publicView.gross), and returns the table.
 *  - Take-downs send act("takedown"); leaving the table sends act("leave").
 *  - After every action we mirror publicView into local render state. The client
 *    never computes payouts — it only animates the server's dice + result.
 *  - Bets that neither win nor lose stay "working" on the table for the next roll.
 *
 * Come-out roll (no point):
 *   Pass     wins 2:1-money (1:1) on 7/11, loses on 2/3/12 (craps).
 *   Don'tPass wins on 2/3, pushes on 12, loses on 7/11.
 *   Any 4,5,6,8,9,10 sets the POINT.
 * Point phase: roll until the point repeats (Pass wins 1:1 / Don't loses)
 *   or a 7 (Pass loses / Don't wins 1:1). Odds may be taken behind the line.
 *   True odds: 4/10 -> 2:1, 5/9 -> 3:2, 6/8 -> 6:5  (Pass odds).
 *              Don't-pass (laying) odds invert: 4/10 -> 1:2, 5/9 -> 2:3, 6/8 -> 5:6.
 * FIELD (one-roll): 2 pays 2:1, 12 pays 3:1, 3/4/9/10/11 pay 1:1; 5/6/7/8 lose.
 * PLACE 6 / PLACE 8: win 7:6 when the number rolls before a 7; lose on 7.
 *
 * HARDWAYS (multi-roll): hard 4/10 pay 7:1, hard 6/8 pay 9:1. Win when the number
 *   is thrown as a double; lose when it's thrown "easy" or a 7 shows. (Edges
 *   11.1% / 9.1%.) Like place bets they are OFF on the come-out unless the
 *   player turns them ON via the "working on come-out" switch.
 * REPEATER BETS (hand-long prop): pick a number; it must repeat its target count
 *   before a seven-out to pay big. Reset only on a seven-out (a 7 in the point
 *   phase) — come-out sevens don't end the hand. Payouts re-priced so each sits
 *   at a ~9-12% house edge (Monte-Carlo verified over 4M hands).
 *
 * "Working on come-out" toggle: real craps turns place/hardway bets OFF for the
 *   come-out roll by default. The switch lets you keep them working — this is the
 *   "turn it on before my come-out roll" control.
 * Set-the-dice: choose each die's face before a throw (superstition). The throw
 *   is always fair & random — setting only changes the dice you start with.
 * ------------------------------------------------------------------------- */

const ACCENT = "#e67e22";
const WIN_GREEN = "#34d399";
const LOSE_RED = "#f87171";

const CHIP_DENOMS = [5, 25, 100, 500, 1000];

type Phase = "betting" | "rolling";

/** Wager spots that take a base stake from chips. */
type LineKey = "pass" | "dontPass" | "field" | "place6" | "place8";
type HardKey = "hard4" | "hard6" | "hard8" | "hard10";

interface DiceResult {
  a: number;
  b: number;
  total: number;
}

interface LogEntry {
  id: number;
  text: string;
  tone: "win" | "lose" | "info" | "point";
}

interface SpotDef {
  key: LineKey;
  label: string;
  sub: string;
  pays: string;
}

const SPOTS: SpotDef[] = [
  { key: "pass", label: "PASS LINE", sub: "Win 7/11 · 1:1", pays: "1 : 1" },
  { key: "dontPass", label: "DON'T PASS", sub: "Win 2/3 · push 12", pays: "1 : 1" },
  { key: "field", label: "FIELD", sub: "2,3,4,9,10,11,12", pays: "1:1 / 2:1 / 3:1" },
  { key: "place6", label: "PLACE 6", sub: "6 before 7", pays: "7 : 6" },
  { key: "place8", label: "PLACE 8", sub: "8 before 7", pays: "7 : 6" },
];

interface HardDef {
  key: HardKey;
  num: number;
  /** Profit multiplier paid as pays:1 (gross = stake + stake*pays). */
  pays: number;
  label: string;
}

const HARD_DEFS: HardDef[] = [
  { key: "hard4", num: 4, pays: 7, label: "HARD 4" },
  { key: "hard6", num: 6, pays: 9, label: "HARD 6" },
  { key: "hard8", num: 8, pays: 9, label: "HARD 8" },
  { key: "hard10", num: 10, pays: 7, label: "HARD 10" },
];

interface RepeaterDef {
  num: number;
  /** How many times the number must repeat before a seven-out. */
  target: number;
  /** Profit multiplier paid as pays:1. */
  pays: number;
}

// Payouts re-priced from the simulated win probabilities so every repeater sits
// at ~9-12% house edge (the "standard" 40:1–90:1 table is wildly +EV here).
const REPEATER_DEFS: RepeaterDef[] = [
  { num: 2, target: 2, pays: 25 },
  { num: 3, target: 3, pays: 30 },
  { num: 4, target: 4, pays: 38 },
  { num: 5, target: 5, pays: 42 },
  { num: 6, target: 6, pays: 46 },
  { num: 8, target: 6, pays: 46 },
  { num: 9, target: 5, pays: 42 },
  { num: 10, target: 4, pays: 38 },
  { num: 11, target: 3, pays: 30 },
  { num: 12, target: 2, pays: 25 },
];

const PAYTABLE: { label: string; pays: string }[] = [
  { label: "Pass / Don't Pass", pays: "1 : 1" },
  { label: "Pass Odds · point 4/10", pays: "2 : 1" },
  { label: "Pass Odds · point 5/9", pays: "3 : 2" },
  { label: "Pass Odds · point 6/8", pays: "6 : 5" },
  { label: "Field · 3,4,9,10,11", pays: "1 : 1" },
  { label: "Field · 2", pays: "2 : 1" },
  { label: "Field · 12", pays: "3 : 1" },
  { label: "Place 6 / Place 8", pays: "7 : 6" },
  { label: "Hard 4 / Hard 10", pays: "7 : 1" },
  { label: "Hard 6 / Hard 8", pays: "9 : 1" },
];

/** Pass-odds true multiplier (profit ratio) for a given point. */
function passOddsProfit(point: number): { num: number; den: number } {
  if (point === 4 || point === 10) return { num: 2, den: 1 };
  if (point === 5 || point === 9) return { num: 3, den: 2 };
  return { num: 6, den: 5 }; // 6 or 8
}

/** Don't-pass odds invert (you lay against the point). */
function dontOddsProfit(point: number): { num: number; den: number } {
  if (point === 4 || point === 10) return { num: 1, den: 2 };
  if (point === 5 || point === 9) return { num: 2, den: 3 };
  return { num: 5, den: 6 }; // 6 or 8
}

/** Lightweight shape of the table fields the log diff needs. */
interface RollSnapshot {
  point: number | null;
  bets: Record<LineKey, number>;
  passOdds: number;
  dontOdds: number;
  hard: Record<HardKey, number>;
  rep: Record<number, number>;
  repCount: Record<number, number>;
}

/**
 * Build the roll-log lines by DIFFING the table before vs after the server's
 * roll — never by recomputing payouts. We only describe what changed (a bet was
 * cleared, the point moved, a repeater advanced) and let the headline carry the
 * server's gross. `prev.point` is the come-out flag for this roll.
 */
function buildRollEvents(
  prev: RollSnapshot,
  next: RollSnapshot,
  total: number,
  isHard: boolean,
): { text: string; tone: LogEntry["tone"] }[] {
  const events: { text: string; tone: LogEntry["tone"] }[] = [];
  const comeOut = prev.point === null;
  const sevenOut = !comeOut && total === 7;

  // FIELD (one-roll) — resolved every roll if it was staked.
  if (prev.bets.field > 0) {
    if (total === 2) events.push({ text: `Field hits 2 — pays 2:1`, tone: "win" });
    else if (total === 12) events.push({ text: `Field hits 12 — pays 3:1`, tone: "win" });
    else if (total === 3 || total === 4 || total === 9 || total === 10 || total === 11)
      events.push({ text: `Field hits ${total} — pays 1:1`, tone: "win" });
    else events.push({ text: `Field loses on ${total} (-${formatChips(prev.bets.field)})`, tone: "lose" });
  }

  // PLACE 6 / 8 — win pays 7:6 (bet rides); lose only on a 7 (bet cleared).
  for (const [key, num] of [["place6", 6], ["place8", 8]] as const) {
    const before = prev.bets[key];
    if (before <= 0) continue;
    if (total === num && next.bets[key] === before)
      events.push({ text: `Place ${num} hits — pays 7:6`, tone: "win" });
    else if (next.bets[key] < before)
      events.push({ text: `Place ${num} loses on the 7 (-${formatChips(before)})`, tone: "lose" });
  }

  // HARDWAYS — cleared on a hit (hard win) or a loss (easy / 7).
  for (const hd of HARD_DEFS) {
    const before = prev.hard[hd.key];
    if (before <= 0 || next.hard[hd.key] >= before) continue;
    if (total === hd.num && isHard)
      events.push({ text: `${hd.label} the hard way — pays ${hd.pays}:1`, tone: "win" });
    else if (total === hd.num)
      events.push({ text: `${hd.label} down — ${hd.num} came easy (-${formatChips(before)})`, tone: "lose" });
    else events.push({ text: `${hd.label} loses on the 7 (-${formatChips(before)})`, tone: "lose" });
  }

  // PASS / DON'T PASS + odds.
  if (comeOut) {
    if (prev.bets.pass > 0 && next.bets.pass === 0) {
      if (total === 7 || total === 11) events.push({ text: `Pass wins on ${total}!`, tone: "win" });
      else events.push({ text: `Craps ${total} — Pass loses (-${formatChips(prev.bets.pass)})`, tone: "lose" });
    }
    if (prev.bets.dontPass > 0 && next.bets.dontPass === 0) {
      if (total === 2 || total === 3) events.push({ text: `Don't Pass wins on ${total}!`, tone: "win" });
      else if (total === 12) events.push({ text: `12 — Don't Pass pushes`, tone: "info" });
      else events.push({ text: `Don't Pass loses on ${total} (-${formatChips(prev.bets.dontPass)})`, tone: "lose" });
    }
    if (next.point !== null && next.point !== prev.point)
      events.push({ text: `Point is ${next.point}. Roll it again before a 7.`, tone: "point" });
  } else {
    const p = prev.point as number;
    if (total === p) {
      if (prev.bets.pass > 0) events.push({ text: `Point ${p} repeats — Pass wins!`, tone: "win" });
      if (prev.passOdds > 0) {
        const r = passOddsProfit(p);
        events.push({ text: `Pass odds win ${r.num}:${r.den}`, tone: "win" });
      }
      if (prev.bets.dontPass > 0) events.push({ text: `Point hit — Don't Pass loses (-${formatChips(prev.bets.dontPass)})`, tone: "lose" });
      if (prev.dontOdds > 0) events.push({ text: `Don't odds lose (-${formatChips(prev.dontOdds)})`, tone: "lose" });
    } else if (total === 7) {
      if (prev.bets.pass > 0) events.push({ text: `Seven out — Pass loses (-${formatChips(prev.bets.pass)})`, tone: "lose" });
      if (prev.passOdds > 0) events.push({ text: `Pass odds lose (-${formatChips(prev.passOdds)})`, tone: "lose" });
      if (prev.bets.dontPass > 0) events.push({ text: `Seven out — Don't Pass wins!`, tone: "win" });
      if (prev.dontOdds > 0) {
        const r = dontOddsProfit(p);
        events.push({ text: `Don't odds win ${r.num}:${r.den}`, tone: "win" });
      }
    }
  }

  // REPEATERS — a seven-out clears them; otherwise they advance / cash.
  for (const rd of REPEATER_DEFS) {
    const before = prev.rep[rd.num] ?? 0;
    if (before <= 0) continue;
    const after = next.rep[rd.num] ?? 0;
    if (sevenOut) {
      events.push({ text: `Repeater ${rd.num} cleared on the seven-out (-${formatChips(before)})`, tone: "lose" });
    } else if (total === rd.num) {
      if (after === 0) {
        events.push({ text: `REPEATER ${rd.num} hit ${rd.target}× — pays ${rd.pays}:1`, tone: "win" });
      } else {
        const c = next.repCount[rd.num] ?? 0;
        events.push({ text: `Repeater ${rd.num}: ${c}/${rd.target}`, tone: "point" });
      }
    }
  }

  return events;
}

/** Pip layout (1..6) as a 3x3 grid of filled positions. */
const PIPS: Record<number, [number, number][]> = {
  1: [[1, 1]],
  2: [[0, 0], [2, 2]],
  3: [[0, 0], [1, 1], [2, 2]],
  4: [[0, 0], [0, 2], [2, 0], [2, 2]],
  5: [[0, 0], [0, 2], [1, 1], [2, 0], [2, 2]],
  6: [[0, 0], [0, 2], [1, 0], [1, 2], [2, 0], [2, 2]],
};

/* ------------------------------ Die face ------------------------------ */

function Die({
  value,
  size = 72,
  rolling,
  onClick,
}: {
  value: number;
  size?: number;
  rolling: boolean;
  onClick?: () => void;
}) {
  const cells: { r: number; c: number; on: boolean }[] = [];
  const on = new Set((PIPS[value] ?? []).map(([r, c]) => `${r}-${c}`));
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) cells.push({ r, c, on: on.has(`${r}-${c}`) });
  }
  return (
    <motion.div
      onClick={onClick}
      animate={
        rolling
          ? { rotate: [0, -120, 140, -80, 30, 0], y: [0, -30, -8, -22, -4, 0] }
          : { rotate: 0, y: 0 }
      }
      transition={
        rolling
          ? { duration: 0.42, repeat: Infinity, ease: "easeInOut" }
          : { type: "spring", stiffness: 320, damping: 16 }
      }
      style={{ width: size, height: size, cursor: onClick ? "pointer" : "default" }}
      className="relative shrink-0"
    >
      <div
        className="absolute inset-0 rounded-2xl"
        style={{
          background: "linear-gradient(150deg,#fdfdfd 0%,#e9eaee 55%,#cfd2d9 100%)",
          boxShadow:
            "0 10px 22px rgba(0,0,0,0.5), inset 0 2px 3px rgba(255,255,255,0.9), inset 0 -6px 10px rgba(0,0,0,0.18)",
          border: "1px solid rgba(0,0,0,0.12)",
        }}
      />
      <div
        className="absolute grid"
        style={{
          inset: size * 0.14,
          gridTemplateColumns: "repeat(3,1fr)",
          gridTemplateRows: "repeat(3,1fr)",
        }}
      >
        {cells.map((cell, i) => (
          <div key={i} className="grid place-items-center">
            {cell.on && (
              <span
                className="rounded-full"
                style={{
                  width: size * 0.17,
                  height: size * 0.17,
                  background: "radial-gradient(circle at 35% 30%, #4a4a4a, #111 70%)",
                  boxShadow: "inset 0 1px 1px rgba(255,255,255,0.4), 0 1px 1px rgba(0,0,0,0.5)",
                }}
              />
            )}
          </div>
        ))}
      </div>
    </motion.div>
  );
}

/* ----------------------------- Game ----------------------------------- */

let logId = 0;

const EMPTY_HARD: Record<HardKey, number> = { hard4: 0, hard6: 0, hard8: 0, hard10: 0 };

/** The full table the server returns after every action. */
interface CrapsPublicView {
  point: number | null;
  working: boolean;
  bets: Record<LineKey, number>;
  passOdds: number;
  dontOdds: number;
  hard: Record<HardKey, number>;
  rep: Record<number, number>;
  repCount: Record<number, number>;
  dice?: DiceResult;
  gross?: number;
  prevPoint?: number | null;
  placed?: string;
  tookDown?: boolean;
  refund?: number;
  left?: boolean;
}

export default function Craps() {
  const wallet = useWallet();
  // The server owns the whole table (point, bets, odds, hardways, repeaters,
  // working flag). The client only routes decisions through /api/round and
  // animates the dice the server rolls back. No wallet.bet/win here — the
  // playRound hook applies the authoritative balance itself.
  const { start: roundStart, act: roundAct } = usePlayRound();
  const roundIdRef = useRef<string | null>(null);
  // Generation token: bumped on every action / unmount so stale async (a slow
  // roll animation, an in-flight place) can't write to a table that moved on.
  const genRef = useRef(0);
  // Serialize server calls so a double-tap can't fire two overlapping actions.
  const acting = useRef(false);

  // Active wagers (mirrored from the server's publicView after each action).
  const [bets, setBets] = useState<Record<LineKey, number>>({
    pass: 0,
    dontPass: 0,
    field: 0,
    place6: 0,
    place8: 0,
  });
  // Odds behind the line (only valid after a point is established).
  const [passOdds, setPassOdds] = useState(0);
  const [dontOdds, setDontOdds] = useState(0);
  // Hardway wagers + hand-long repeater wagers (stake by number) and their progress.
  const [hardBets, setHardBets] = useState<Record<HardKey, number>>({ ...EMPTY_HARD });
  const [repeaterBets, setRepeaterBets] = useState<Record<number, number>>({});
  const [repeaterCounts, setRepeaterCounts] = useState<Record<number, number>>({});

  // Place/hardway bets work on the come-out only when this is ON.
  const [workingOnComeOut, setWorkingOnComeOut] = useState(false);
  // Superstition: the faces the player "sets" before a throw (cosmetic only).
  const [presetDice, setPresetDice] = useState<{ a: number; b: number } | null>(null);

  const [chip, setChip] = useState(25);
  const [phase, setPhase] = useState<Phase>("betting");
  const [point, setPoint] = useState<number | null>(null);

  const [dice, setDice] = useState<DiceResult>({ a: 1, b: 1, total: 2 });
  const [rolling, setRolling] = useState(false);

  const [resultText, setResultText] = useState("Place your bets, then roll.");
  const [resultTone, setResultTone] = useState<"win" | "lose" | "info" | "point">("info");
  const [lastDelta, setLastDelta] = useState(0);
  const [burst, setBurst] = useState(0);
  // Win-celebration overlay: armed only on a notable roll (big multiple of the
  // resolving stake or a high-pay prop). `celebrate` re-fires when `burst` bumps.
  const [celebrate, setCelebrate] = useState(false);
  const [celebrateTier, setCelebrateTier] = useState<"win" | "big" | "jackpot">("win");

  const [log, setLog] = useState<LogEntry[]>([]);

  // All roll timers + the face-cycle interval, cleared on unmount (and re-roll)
  // to avoid setState-after-unmount during the async throw sequence.
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const clearRollTimers = useCallback(() => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
    if (tickRef.current) {
      clearInterval(tickRef.current);
      tickRef.current = null;
    }
  }, []);
  // On unmount drop any pending roll animation AND invalidate stale async.
  useEffect(
    () => () => {
      genRef.current++;
      clearRollTimers();
    },
    [clearRollTimers],
  );

  const pushLog = useCallback((text: string, tone: LogEntry["tone"]) => {
    setLog((l) => [{ id: ++logId, text, tone }, ...l].slice(0, 8));
  }, []);

  // Mirror the server's table into the local render state (single source of
  // truth). Does NOT touch `dice` — the roll animation owns that so it can
  // tumble toward the server result.
  const syncFromPublicView = useCallback((pv: CrapsPublicView) => {
    setBets({
      pass: pv.bets.pass,
      dontPass: pv.bets.dontPass,
      field: pv.bets.field,
      place6: pv.bets.place6,
      place8: pv.bets.place8,
    });
    setPassOdds(pv.passOdds);
    setDontOdds(pv.dontOdds);
    setHardBets({
      hard4: pv.hard.hard4,
      hard6: pv.hard.hard6,
      hard8: pv.hard.hard8,
      hard10: pv.hard.hard10,
    });
    setRepeaterBets({ ...pv.rep });
    setRepeaterCounts({ ...pv.repCount });
    setWorkingOnComeOut(pv.working);
    setPoint(pv.point);
  }, []);

  // Open a session lazily (the base bet is 0 — no money down). Returns the
  // roundId, or null if the server rejected the open.
  const ensureRound = useCallback(async (): Promise<string | null> => {
    if (roundIdRef.current) return roundIdRef.current;
    try {
      const res = await roundStart("craps", 0, {});
      roundIdRef.current = res.roundId ?? null;
      syncFromPublicView(res.publicView as unknown as CrapsPublicView);
      return roundIdRef.current;
    } catch {
      return null;
    }
  }, [roundStart, syncFromPublicView]);

  // Open the session on mount so the table is live before the first action.
  useEffect(() => {
    void ensureRound();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const repeaterTotal = useMemo(
    () => Object.values(repeaterBets).reduce((s, v) => s + v, 0),
    [repeaterBets],
  );
  const hardTotal = useMemo(
    () => hardBets.hard4 + hardBets.hard6 + hardBets.hard8 + hardBets.hard10,
    [hardBets],
  );

  const totalOnTable = useMemo(
    () =>
      bets.pass +
      bets.dontPass +
      bets.field +
      bets.place6 +
      bets.place8 +
      passOdds +
      dontOdds +
      hardTotal +
      repeaterTotal,
    [bets, passOdds, dontOdds, hardTotal, repeaterTotal],
  );

  const comeOut = point === null;
  const idle = phase !== "rolling";
  /** Do place & hardway bets resolve this roll? Always in the point phase; on the
   *  come-out only if the player has turned them on. */
  const multiActive = !comeOut || workingOnComeOut;

  // ---- placing wagers (the SERVER debits each placement) ----

  /** Route one server action, sync from the returned table, surface errors.
   *  Returns the publicView on success, or null if it failed / was superseded. */
  const sendAction = useCallback(
    async (
      action: string,
      payload?: unknown,
    ): Promise<CrapsPublicView | null> => {
      if (acting.current) return null;
      acting.current = true;
      const gen = ++genRef.current;
      try {
        const rid = await ensureRound();
        if (!rid) {
          setResultText("Couldn't open the table — try again.");
          setResultTone("info");
          return null;
        }
        const res = await roundAct(rid, action, payload);
        if (gen !== genRef.current) return null;
        const pv = res.publicView as unknown as CrapsPublicView;
        // A "leave" closes the session: reopen a fresh one for the next bets.
        if (res.done) roundIdRef.current = null;
        else syncFromPublicView(pv);
        return pv;
      } catch (err) {
        if (gen !== genRef.current) return null;
        const msg = err instanceof Error ? err.message : "That bet isn't allowed.";
        sfx.lose();
        setResultText(msg);
        setResultTone("info");
        return null;
      } finally {
        acting.current = false;
      }
    },
    [ensureRound, roundAct, syncFromPublicView],
  );

  const placeOnSpot = useCallback(
    (key: LineKey) => {
      if (rolling || acting.current) return;
      // Pass / Don't Pass contract can only be added during come-out (no point).
      if ((key === "pass" || key === "dontPass") && !comeOut && bets[key] === 0) {
        sfx.lose();
        setResultText("Can't open a line bet after the point is set.");
        setResultTone("info");
        return;
      }
      if (chip > wallet.balance) {
        sfx.lose();
        setResultText("Not enough chips for that.");
        setResultTone("info");
        return;
      }
      sfx.chip();
      void sendAction("place", { spot: key, amount: chip });
    },
    [rolling, comeOut, bets, chip, wallet.balance, sendAction],
  );

  const placeHardway = useCallback(
    (key: HardKey) => {
      if (rolling || acting.current) return;
      if (chip > wallet.balance) {
        sfx.lose();
        setResultText("Not enough chips for that.");
        setResultTone("info");
        return;
      }
      sfx.chip();
      void sendAction("place", { spot: key, amount: chip });
    },
    [rolling, chip, wallet.balance, sendAction],
  );

  const placeRepeater = useCallback(
    (num: number) => {
      if (rolling || acting.current) return;
      // Repeaters track a whole shooter's hand — they can only be opened on the
      // come-out (before a point), and once placed they ride until they hit or
      // a seven-out clears them.
      if (!comeOut) {
        sfx.lose();
        setResultText("Repeaters can only be placed on the come-out.");
        setResultTone("info");
        return;
      }
      if (chip > wallet.balance) {
        sfx.lose();
        setResultText("Not enough chips for that.");
        setResultTone("info");
        return;
      }
      sfx.chip();
      void sendAction("place", { spot: `rep${num}`, amount: chip });
    },
    [rolling, comeOut, chip, wallet.balance, sendAction],
  );

  const addPassOdds = useCallback(() => {
    if (rolling || acting.current || comeOut || bets.pass === 0) return;
    if (chip > wallet.balance) {
      sfx.lose();
      return;
    }
    sfx.chip();
    void sendAction("place", { spot: "passOdds", amount: chip });
  }, [rolling, comeOut, bets.pass, chip, wallet.balance, sendAction]);

  const addDontOdds = useCallback(() => {
    if (rolling || acting.current || comeOut || bets.dontPass === 0) return;
    if (chip > wallet.balance) {
      sfx.lose();
      return;
    }
    sfx.chip();
    void sendAction("place", { spot: "dontOdds", amount: chip });
  }, [rolling, comeOut, bets.dontPass, chip, wallet.balance, sendAction]);

  // Take down removable wagers; the SERVER refunds them (field/place/hardways
  // always; line bets + odds only during the come-out; repeaters never). At the
  // come-out (no money left on the table) this also leaves the table — closing
  // the session and refunding anything takeable.
  const clearBets = useCallback(async () => {
    if (rolling || acting.current) return;
    const pv = await sendAction("takedown");
    if (pv && (pv.refund ?? 0) > 0) sfx.chip();
  }, [rolling, sendAction]);

  // ---- the roll action (cinematic toss; SERVER decides the dice) ----

  const roll = useCallback(() => {
    if (rolling || acting.current) return;
    if (totalOnTable <= 0) {
      sfx.lose();
      setResultText("Place at least one bet to roll.");
      setResultTone("info");
      return;
    }
    clearRollTimers();

    // Snapshot the table BEFORE the roll so we can diff for the log.
    const prev: RollSnapshot = {
      point,
      bets: { ...bets },
      passOdds,
      dontOdds,
      hard: { ...hardBets },
      rep: { ...repeaterBets },
      repCount: { ...repeaterCounts },
    };

    // The throw begins on the faces the player "set" (or the last result), then
    // tumbles toward the SERVER's result (set once the response lands).
    const startA = presetDice?.a ?? dice.a;
    const startB = presetDice?.b ?? dice.b;

    sfx.thud();
    setPhase("rolling");
    setRolling(true);
    setCelebrate(false);
    setLastDelta(0);
    setResultText(comeOut ? "Come-out roll…" : `Rolling for the point (${point})…`);
    setResultTone("info");
    setDice({ a: startA, b: startB, total: startA + startB });
    setPresetDice(null); // a set is consumed by the throw

    const gen = ++genRef.current;
    // The server's landed dice (filled in by the in-flight act("roll")).
    const landed: { res: DiceResult | null } = { res: null };

    // Fire the authoritative roll. The hook credits winnings + balance itself.
    acting.current = true;
    const rollPromise: Promise<{ pv: CrapsPublicView | null; error?: string; settle?: () => void }> = (async () => {
      try {
        const rid = roundIdRef.current ?? (await ensureRound());
        if (!rid) return { pv: null, error: "Couldn't open the table — try again." };
        // Defer this roll's whole balance change so its winnings stay hidden
        // until the dice land (settle() is called from the resolve timer below).
        const r = await roundAct(rid, "roll", undefined, { deferStep: true });
        const pv = r.publicView as unknown as CrapsPublicView;
        if (pv.dice) landed.res = pv.dice;
        return { pv, settle: r.settle };
      } catch (err) {
        return { pv: null, error: err instanceof Error ? err.message : "Roll failed." };
      } finally {
        acting.current = false;
      }
    })();

    // tumble ticks while the dice fly across the felt
    let ticks = 0;
    tickRef.current = setInterval(() => {
      ticks++;
      sfx.tick();
      setDice({ a: randInt(1, 6), b: randInt(1, 6), total: 0 });
      if (ticks >= 11 && tickRef.current) {
        clearInterval(tickRef.current);
        tickRef.current = null;
      }
    }, 80);

    // Lock the faces while the camera zooms back in (≈82% through the throw).
    // If the server's dice have landed by now, snap to them; otherwise the
    // resolve step below sets the final faces.
    timers.current.push(
      setTimeout(() => {
        if (gen !== genRef.current) return;
        if (tickRef.current) {
          clearInterval(tickRef.current);
          tickRef.current = null;
        }
        if (landed.res) setDice(landed.res);
      }, 1180),
    );

    // Resolve once the dice have landed AND the server responded.
    timers.current.push(
      setTimeout(() => {
        void rollPromise.then(({ pv, error, settle }) => {
          // Dice have landed — NOW apply the withheld roll balance, so the header
          // never shows the win before the dice finish tumbling. Idempotent, and
          // the wallet provider outlives this view, so it books even on unmount.
          settle?.();
          if (gen !== genRef.current) return;

          if (tickRef.current) {
            clearInterval(tickRef.current);
            tickRef.current = null;
          }
          setRolling(false);
          setPhase("betting");

          if (!pv || !pv.dice) {
            // Roll rejected (e.g. session lost) — never leave the UI stuck.
            setDice({ a: startA, b: startB, total: startA + startB });
            sfx.lose();
            setResultText(error ?? "Roll failed — try again.");
            setResultTone("info");
            return;
          }

          const res = pv.dice;
          const gross = pv.gross ?? 0;
          setDice(res);
          syncFromPublicView(pv);

          // Build the log by diffing prev vs the server's table — no payouts recomputed.
          const next: RollSnapshot = {
            point: pv.point,
            bets: pv.bets,
            passOdds: pv.passOdds,
            dontOdds: pv.dontOdds,
            hard: pv.hard,
            rep: pv.rep,
            repCount: pv.repCount,
          };
          const events = buildRollEvents(prev, next, res.total, res.a === res.b);

          const pointSet = prev.point === null && pv.point !== null && pv.point !== prev.point;
          const won = gross > 0;
          let headline: string;
          let tone: LogEntry["tone"];
          if (won) {
            headline = `Rolled ${res.total} — you win ${formatDelta(gross)}!`;
            tone = "win";
          } else if (events.some((e) => e.tone === "lose")) {
            headline = `Rolled ${res.total}.`;
            tone = "lose";
          } else if (pointSet) {
            headline = `Rolled ${res.total}.`;
            tone = "point";
          } else if (events.length === 0) {
            headline = `Rolled ${res.total} — no action.`;
            tone = "info";
          } else {
            headline = `Rolled ${res.total}.`;
            tone = "info";
          }
          setResultText(headline);
          setResultTone(tone);
          setLastDelta(gross > 0 ? gross : 0);
          events.forEach((e) => pushLog(e.text, e.tone));

          if (won) {
            setBurst((n) => n + 1);
            // A high-pay prop (hardway / repeater) cashed this roll?
            const propHit = events.some(
              (e) => e.tone === "win" && (/the hard way/.test(e.text) || /^REPEATER/.test(e.text)),
            );
            // Notable: a big prop or a meaningful pile vs. the chip in hand.
            const notable = propHit || gross >= chip * 8;
            setCelebrate(notable);
            setCelebrateTier(propHit ? "jackpot" : gross >= chip * 12 ? "big" : "win");
            if (gross >= chip * 12) sfx.jackpot();
            else sfx.win();
          } else {
            setCelebrate(false);
            if (events.some((e) => e.tone === "lose")) sfx.lose();
            else if (pointSet) sfx.thud();
            else sfx.card();
          }
        });
      }, 1480),
    );
  }, [
    rolling,
    totalOnTable,
    comeOut,
    point,
    presetDice,
    dice,
    bets,
    passOdds,
    dontOdds,
    hardBets,
    repeaterBets,
    repeaterCounts,
    ensureRound,
    roundAct,
    syncFromPublicView,
    pushLog,
    chip,
    clearRollTimers,
  ]);

  // Clear the on-screen log (between hands).
  const resetHand = useCallback(() => {
    setLog([]);
    setLastDelta(0);
    setResultText("Place your bets, then roll.");
    setResultTone("info");
  }, []);

  // Working-on-come-out toggle — the SERVER owns the flag (place/hardways/
  // repeaters only resolve on the come-out when it's on). Optimistically flip
  // the UI, then reconcile from the returned table.
  const toggleWorking = useCallback(() => {
    if (rolling || acting.current) return;
    sfx.click();
    const next = !workingOnComeOut;
    setWorkingOnComeOut(next);
    void sendAction("working", { on: next });
  }, [rolling, workingOnComeOut, sendAction]);

  // Cycle a set-die face (1→2→…→6→1). Establishes a preset on first touch.
  const cycleSetDie = useCallback(
    (which: "a" | "b") => {
      if (rolling) return;
      sfx.click();
      setPresetDice((p) => {
        const base = p ?? { a: dice.a, b: dice.b };
        const nextVal = (base[which] % 6) + 1;
        return { ...base, [which]: nextVal };
      });
    },
    [rolling, dice.a, dice.b],
  );

  // ---------------------------- render --------------------------------

  // Faces shown on the felt: a live "set" overrides the last result while idle.
  const showA = !rolling && presetDice ? presetDice.a : dice.a;
  const showB = !rolling && presetDice ? presetDice.b : dice.b;
  const showTotal = !rolling && presetDice ? presetDice.a + presetDice.b : dice.total;

  const pointBadge = (n: number) => {
    const active = point === n;
    return (
      <motion.div
        key={n}
        animate={active ? { scale: [1, 1.12, 1] } : { scale: 1 }}
        transition={{ duration: 0.5 }}
        className="grid h-9 w-9 place-items-center rounded-lg border text-sm font-bold tabular-nums"
        style={{
          borderColor: active ? ACCENT : "rgba(255,255,255,0.12)",
          background: active ? `${ACCENT}26` : "rgba(255,255,255,0.03)",
          color: active ? ACCENT : "rgba(255,255,255,0.45)",
          boxShadow: active ? `0 0 14px ${ACCENT}80` : "none",
        }}
      >
        {n}
      </motion.div>
    );
  };

  const toneColor =
    resultTone === "win"
      ? WIN_GREEN
      : resultTone === "lose"
        ? LOSE_RED
        : resultTone === "point"
          ? ACCENT
          : "rgba(255,255,255,0.75)";

  return (
    <div className="mx-auto w-full max-w-5xl">
      <div
        className="felt relative overflow-hidden rounded-3xl p-4 sm:p-6"
        style={{
          boxShadow: `inset 0 0 120px rgba(0,0,0,0.45), 0 0 0 1px ${ACCENT}30`,
        }}
      >
        {/* ambient accent glow */}
        <div
          className="pointer-events-none absolute -right-24 -top-24 h-72 w-72 rounded-full blur-3xl"
          style={{ background: `${ACCENT}33` }}
        />

        {/* win celebration — only fires on a notable roll (armed in the roll resolve step) */}
        <Celebration
          show={celebrate}
          seed={burst}
          tier={celebrateTier}
          colors={["#e67e22", "#ffd24a", "#22e1ff", "#ffffff"]}
        />

        {/* header row: title + puck */}
        <div className="relative flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-display text-2xl font-bold tracking-wide" style={{ color: ACCENT }}>
              Craps
            </h2>
            <p className="text-xs text-white/50">
              Pass, Don't Pass, Field, Place, Hardways &amp; Repeaters · 1.41% on the line
            </p>
          </div>

          {/* PUCK */}
          <div className="flex items-center gap-3">
            <div className="flex gap-1.5">{[4, 5, 6, 8, 9, 10].map(pointBadge)}</div>
            <motion.div
              animate={comeOut ? { rotate: [0, 6, -6, 0] } : { scale: [1, 1.08, 1] }}
              transition={{ duration: 0.6 }}
              className="grid h-16 w-16 place-items-center rounded-full text-center font-display font-bold"
              style={{
                background: comeOut
                  ? "radial-gradient(circle at 50% 35%, #1a1a1a, #000)"
                  : "radial-gradient(circle at 50% 35%, #fff, #d9dbe0)",
                color: comeOut ? "#888" : "#0c5c2c",
                border: comeOut ? "3px solid #444" : `3px solid ${WIN_GREEN}`,
                boxShadow: comeOut
                  ? "0 6px 16px rgba(0,0,0,0.6)"
                  : `0 0 22px ${WIN_GREEN}99, 0 6px 16px rgba(0,0,0,0.6)`,
              }}
            >
              <div className="leading-none">
                <div className="text-[10px] tracking-widest">{comeOut ? "OFF" : "ON"}</div>
                {!comeOut && <div className="text-xl tabular-nums">{point}</div>}
              </div>
            </motion.div>
          </div>
        </div>

        {/* DICE STAGE — cinematic zoom-out / toss-across / zoom-in throw */}
        <div className="relative my-3 sm:my-5 [@media(max-height:600px)]:my-2">
          <motion.div
            className="relative grid place-items-center overflow-hidden rounded-2xl py-5 sm:py-8 [@media(max-height:600px)]:py-3"
            style={{
              background: "radial-gradient(ellipse at center, rgba(0,0,0,0.25), rgba(0,0,0,0.05))",
              border: "1px solid rgba(255,255,255,0.06)",
              transformOrigin: "50% 60%",
            }}
            animate={{ scale: rolling ? [1, 0.78, 0.8, 1.12, 1] : 1 }}
            transition={
              rolling
                ? { duration: 1.46, times: [0, 0.16, 0.52, 0.86, 1], ease: "easeInOut" }
                : { duration: 0.3 }
            }
          >
            {/* speed streaks while the dice fly */}
            <AnimatePresence>
              {rolling && (
                <motion.div
                  className="pointer-events-none absolute inset-0"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: [0, 0.5, 0.5, 0] }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 1.46, times: [0, 0.25, 0.7, 1] }}
                  style={{
                    background:
                      "repeating-linear-gradient(115deg, transparent 0 18px, rgba(255,255,255,0.05) 18px 19px)",
                  }}
                />
              )}
            </AnimatePresence>

            {/* the dice carriage: tossed in an arc from the shooter's side */}
            <motion.div
              className="flex items-center gap-6"
              animate={
                rolling
                  ? { x: [210, 150, -36, 8, 0], y: [26, -84, -18, -4, 0], rotate: [0, 140, 260, 350, 360] }
                  : { x: 0, y: 0, rotate: 0 }
              }
              transition={
                rolling
                  ? { duration: 1.46, times: [0, 0.28, 0.62, 0.85, 1], ease: [0.22, 0.7, 0.2, 1] }
                  : { type: "spring", stiffness: 300, damping: 18 }
              }
            >
              <Die value={showA} rolling={rolling} />
              <Die value={showB} rolling={rolling} />
            </motion.div>

            {/* set-the-dice badge */}
            <AnimatePresence>
              {!rolling && presetDice && (
                <motion.div
                  initial={{ opacity: 0, y: -6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  className="absolute left-3 top-3 rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider"
                  style={{ background: `${ACCENT}26`, color: ACCENT, border: `1px solid ${ACCENT}66` }}
                >
                  Dice set
                </motion.div>
              )}
            </AnimatePresence>

            {/* total badge */}
            <AnimatePresence>
              {!rolling && (
                <motion.div
                  key={`tot-${showTotal}-${log.length}`}
                  initial={{ opacity: 0, y: 8, scale: 0.8 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0 }}
                  className="mt-5 rounded-full px-5 py-1.5 font-display text-lg font-bold tabular-nums"
                  style={{
                    color: "#fff",
                    background: `${ACCENT}22`,
                    border: `1px solid ${ACCENT}66`,
                  }}
                >
                  {showTotal}
                </motion.div>
              )}
            </AnimatePresence>

            {/* win burst */}
            <AnimatePresence>
              {lastDelta > 0 && (
                <motion.div
                  key={`burst-${burst}`}
                  initial={{ opacity: 0, scale: 0.4, y: 10 }}
                  animate={{ opacity: 1, scale: 1, y: -6 }}
                  exit={{ opacity: 0, scale: 0.6 }}
                  transition={{ type: "spring", stiffness: 280, damping: 14 }}
                  className="pointer-events-none absolute -top-3 rounded-full px-4 py-1.5 font-display text-lg font-bold"
                  style={{
                    color: "#04210f",
                    background: WIN_GREEN,
                    boxShadow: `0 0 26px ${WIN_GREEN}`,
                  }}
                >
                  {formatDelta(lastDelta)}
                </motion.div>
              )}
            </AnimatePresence>
            {/* sparks */}
            <AnimatePresence>
              {lastDelta > 0 &&
                Array.from({ length: 10 }).map((_, i) => (
                  <motion.span
                    key={`spark-${burst}-${i}`}
                    initial={{ opacity: 1, x: 0, y: 0, scale: 1 }}
                    animate={{
                      opacity: 0,
                      x: Math.cos((i / 10) * Math.PI * 2) * 120,
                      y: Math.sin((i / 10) * Math.PI * 2) * 80 - 10,
                      scale: 0,
                    }}
                    transition={{ duration: 0.8, ease: "easeOut" }}
                    className="pointer-events-none absolute h-2 w-2 rounded-full"
                    style={{ background: i % 2 ? WIN_GREEN : ACCENT }}
                  />
                ))}
            </AnimatePresence>
          </motion.div>
        </div>

        {/* RESULT TEXT */}
        <div className="mb-2 text-center sm:mb-4">
          <motion.div
            key={resultText}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            data-testid="round-result"
            className="font-display text-base font-bold sm:text-lg"
            style={{ color: toneColor }}
          >
            {resultText}
          </motion.div>
        </div>

        {/* BET LAYOUT */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {SPOTS.map((spot) => {
            const amount = bets[spot.key];
            const locked =
              (spot.key === "pass" || spot.key === "dontPass") && !comeOut && amount === 0;
            const sleeping =
              (spot.key === "place6" || spot.key === "place8") && comeOut && !workingOnComeOut;
            return (
              <motion.button
                key={spot.key}
                type="button"
                data-testid={`spot-${spot.key}`}
                onClick={() => placeOnSpot(spot.key)}
                disabled={rolling || locked}
                whileHover={!rolling && !locked ? { y: -3 } : undefined}
                whileTap={!rolling && !locked ? { scale: 0.97 } : undefined}
                className="relative flex flex-col items-start gap-1 rounded-xl border p-3 text-left disabled:opacity-40"
                style={{
                  borderColor: amount > 0 ? ACCENT : "rgba(255,255,255,0.12)",
                  background:
                    amount > 0
                      ? `linear-gradient(160deg, ${ACCENT}26, rgba(0,0,0,0.25))`
                      : "rgba(255,255,255,0.04)",
                  boxShadow: amount > 0 ? `0 0 16px ${ACCENT}55` : "none",
                }}
              >
                <div className="font-display text-xs font-bold tracking-wide text-white">
                  {spot.label}
                </div>
                <div className="text-[10px] leading-tight text-white/45">{spot.sub}</div>
                <div className="text-[10px] font-semibold" style={{ color: ACCENT }}>
                  {spot.pays}
                </div>
                {sleeping && (
                  <span className="absolute right-1.5 bottom-1.5 rounded bg-black/50 px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-wider text-white/50">
                    off
                  </span>
                )}
                <AnimatePresence>
                  {amount > 0 && (
                    <motion.div
                      initial={{ scale: 0, rotate: -30 }}
                      animate={{ scale: 1, rotate: 0 }}
                      exit={{ scale: 0 }}
                      className="absolute -right-2 -top-2"
                    >
                      <div className="grid place-items-center rounded-full bg-black/80 px-2 py-1 text-[11px] font-bold text-white ring-1 ring-white/30 tabular-nums">
                        {formatChips(amount)}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </motion.button>
            );
          })}
        </div>

        {/* ODDS row (only meaningful after a point) */}
        <div className="mt-2 grid grid-cols-1 gap-3 sm:mt-3 sm:grid-cols-2">
          <div
            className="flex items-center justify-between rounded-xl border p-3"
            style={{
              borderColor: passOdds > 0 ? ACCENT : "rgba(255,255,255,0.12)",
              background: "rgba(255,255,255,0.04)",
            }}
          >
            <div>
              <div className="font-display text-xs font-bold text-white">PASS ODDS</div>
              <div className="text-[10px] text-white/45">
                {comeOut
                  ? "Available after a point"
                  : `True odds ${passOddsProfit(point as number).num}:${passOddsProfit(point as number).den}`}
              </div>
              <div className="mt-0.5 text-[11px] font-bold tabular-nums text-white/80">
                {formatChips(passOdds)}
              </div>
            </div>
            <Button
              size="sm"
              variant="ghost"
              data-testid="add-pass-odds"
              disabled={rolling || comeOut || bets.pass === 0 || chip > wallet.balance}
              onClick={addPassOdds}
            >
              + Odds
            </Button>
          </div>

          <div
            className="flex items-center justify-between rounded-xl border p-3"
            style={{
              borderColor: dontOdds > 0 ? ACCENT : "rgba(255,255,255,0.12)",
              background: "rgba(255,255,255,0.04)",
            }}
          >
            <div>
              <div className="font-display text-xs font-bold text-white">DON'T ODDS</div>
              <div className="text-[10px] text-white/45">
                {comeOut
                  ? "Available after a point"
                  : `Lay ${dontOddsProfit(point as number).num}:${dontOddsProfit(point as number).den}`}
              </div>
              <div className="mt-0.5 text-[11px] font-bold tabular-nums text-white/80">
                {formatChips(dontOdds)}
              </div>
            </div>
            <Button
              size="sm"
              variant="ghost"
              data-testid="add-dont-odds"
              disabled={rolling || comeOut || bets.dontPass === 0 || chip > wallet.balance}
              onClick={addDontOdds}
            >
              + Odds
            </Button>
          </div>
        </div>

        {/* HARDWAYS */}
        <div className="mt-2 sm:mt-4">
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-[10px] uppercase tracking-widest text-white/40">Hardways</span>
            <span className="text-[10px] text-white/40">
              {multiActive ? "working" : "OFF on come-out"}
            </span>
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {HARD_DEFS.map((hd) => {
              const amount = hardBets[hd.key];
              const sleeping = !multiActive;
              return (
                <motion.button
                  key={hd.key}
                  type="button"
                  data-testid={`spot-${hd.key}`}
                  onClick={() => placeHardway(hd.key)}
                  disabled={rolling}
                  whileHover={!rolling ? { y: -3 } : undefined}
                  whileTap={!rolling ? { scale: 0.97 } : undefined}
                  className="relative flex flex-col items-start gap-0.5 rounded-xl border p-3 text-left disabled:opacity-40"
                  style={{
                    borderColor: amount > 0 ? ACCENT : "rgba(255,255,255,0.12)",
                    background:
                      amount > 0
                        ? `linear-gradient(160deg, ${ACCENT}26, rgba(0,0,0,0.25))`
                        : "rgba(255,255,255,0.04)",
                    boxShadow: amount > 0 ? `0 0 16px ${ACCENT}55` : "none",
                  }}
                >
                  <div className="font-display text-xs font-bold tracking-wide text-white">
                    {hd.label}
                  </div>
                  <div className="text-[10px] leading-tight text-white/45">the hard way</div>
                  <div className="text-[10px] font-semibold" style={{ color: ACCENT }}>
                    {hd.pays} : 1
                  </div>
                  {amount > 0 && sleeping && (
                    <span className="absolute right-1.5 bottom-1.5 rounded bg-black/50 px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-wider text-white/50">
                      off
                    </span>
                  )}
                  <AnimatePresence>
                    {amount > 0 && (
                      <motion.div
                        initial={{ scale: 0, rotate: -30 }}
                        animate={{ scale: 1, rotate: 0 }}
                        exit={{ scale: 0 }}
                        className="absolute -right-2 -top-2"
                      >
                        <div className="grid place-items-center rounded-full bg-black/80 px-2 py-1 text-[11px] font-bold text-white ring-1 ring-white/30 tabular-nums">
                          {formatChips(amount)}
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </motion.button>
              );
            })}
          </div>
        </div>

        {/* REPEATERS */}
        <div className="mt-2 sm:mt-4">
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-[10px] uppercase tracking-widest text-white/40">
              Repeater Bets
            </span>
            <span className="text-[10px] text-white/40">
              {comeOut ? "hit the count before a seven-out" : "locked — hand in progress"}
            </span>
          </div>
          <div className="grid grid-cols-5 gap-2 sm:grid-cols-10">
            {REPEATER_DEFS.map((rd) => {
              const amount = repeaterBets[rd.num] ?? 0;
              const count = repeaterCounts[rd.num] ?? 0;
              const canPlace = !rolling && comeOut;
              const pct = Math.min(100, (count / rd.target) * 100);
              return (
                <motion.button
                  key={rd.num}
                  type="button"
                  data-testid={`repeater-${rd.num}`}
                  onClick={() => placeRepeater(rd.num)}
                  disabled={!canPlace}
                  whileHover={canPlace ? { y: -2 } : undefined}
                  whileTap={canPlace ? { scale: 0.95 } : undefined}
                  className="relative flex flex-col items-center gap-0.5 rounded-lg border p-2 disabled:cursor-not-allowed"
                  style={{
                    borderColor: amount > 0 ? ACCENT : "rgba(255,255,255,0.1)",
                    background:
                      amount > 0
                        ? `linear-gradient(160deg, ${ACCENT}26, rgba(0,0,0,0.3))`
                        : "rgba(255,255,255,0.03)",
                    opacity: !canPlace && amount === 0 ? 0.45 : 1,
                    boxShadow: amount > 0 ? `0 0 14px ${ACCENT}55` : "none",
                  }}
                >
                  <span className="font-display text-base font-extrabold leading-none text-white">
                    {rd.num}
                  </span>
                  <span className="text-[9px] font-semibold leading-none" style={{ color: ACCENT }}>
                    {rd.target}× · {rd.pays}:1
                  </span>
                  {/* progress */}
                  <span className="mt-1 h-1 w-full overflow-hidden rounded-full bg-white/10">
                    <span
                      className="block h-full rounded-full transition-all"
                      style={{ width: `${pct}%`, background: WIN_GREEN }}
                    />
                  </span>
                  <span className="text-[8px] tabular-nums text-white/45">
                    {count}/{rd.target}
                  </span>
                  {amount > 0 && (
                    <span className="absolute -right-1.5 -top-1.5 grid place-items-center rounded-full bg-black/80 px-1.5 py-0.5 text-[9px] font-bold text-white ring-1 ring-white/30 tabular-nums">
                      {formatChips(amount)}
                    </span>
                  )}
                </motion.button>
              );
            })}
          </div>
        </div>

        {/* SET DICE + WORKING TOGGLE */}
        <div className="mt-2 grid grid-cols-1 gap-3 sm:mt-4 sm:grid-cols-2">
          {/* Set the dice */}
          <div className="glass flex items-center justify-between gap-3 rounded-2xl p-3">
            <div className="min-w-0">
              <div className="text-[10px] uppercase tracking-widest text-white/40">Set the dice</div>
              <div className="text-[10px] leading-tight text-white/45">
                Tap a die to set its face. For luck only — the roll is always fair.
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Die value={presetDice?.a ?? dice.a} size={34} rolling={false} onClick={() => cycleSetDie("a")} />
              <Die value={presetDice?.b ?? dice.b} size={34} rolling={false} onClick={() => cycleSetDie("b")} />
              <Button
                size="sm"
                variant="ghost"
                data-testid="clear-set"
                disabled={rolling || !presetDice}
                onClick={() => {
                  sfx.click();
                  setPresetDice(null);
                }}
              >
                Clear
              </Button>
            </div>
          </div>

          {/* Working-on-come-out toggle */}
          <button
            type="button"
            data-testid="working-toggle"
            disabled={rolling}
            onClick={toggleWorking}
            className="glass flex items-center justify-between gap-3 rounded-2xl p-3 text-left disabled:opacity-50"
          >
            <div className="min-w-0">
              <div className="text-[10px] uppercase tracking-widest text-white/40">
                Place &amp; hardways on come-out
              </div>
              <div className="text-[10px] leading-tight text-white/45">
                Turn your multi-roll bets ON so they work on the come-out roll.
              </div>
            </div>
            <span
              className="relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors"
              style={{ background: workingOnComeOut ? WIN_GREEN : "rgba(255,255,255,0.15)" }}
            >
              <motion.span
                layout
                className="absolute h-5 w-5 rounded-full bg-white shadow"
                animate={{ left: workingOnComeOut ? 22 : 2 }}
                transition={{ type: "spring", stiffness: 500, damping: 32 }}
              />
            </span>
          </button>
        </div>

        {/* CHIP SELECTOR + ACTIONS */}
        <div className="glass mt-2 rounded-2xl p-3 sm:mt-4 sm:p-4">
          <div className="flex flex-wrap items-center justify-center gap-2 sm:gap-3">
            {CHIP_DENOMS.map((v) => (
              <Chip
                key={v}
                value={v}
                size={52}
                selected={chip === v}
                onClick={
                  rolling || v > wallet.balance
                    ? undefined
                    : () => {
                        sfx.click();
                        setChip(v);
                      }
                }
              />
            ))}
          </div>

          <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
            <div className="rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-center">
              <div className="text-[9px] uppercase tracking-widest text-white/40">On Table</div>
              <div className="text-base font-bold tabular-nums" style={{ color: ACCENT }}>
                <CountingNumber value={totalOnTable} className="tabular-nums" />
              </div>
            </div>

            <Button
              size="sm"
              variant="ghost"
              data-testid="clear-btn"
              disabled={rolling || bets.field + bets.place6 + bets.place8 + hardTotal + (comeOut ? bets.pass + bets.dontPass + passOdds + dontOdds : 0) === 0}
              onClick={clearBets}
            >
              {comeOut ? "Clear / Take Down" : "Take Down"}
            </Button>

            <Button
              size="lg"
              variant="gold"
              data-testid="play-btn"
              disabled={rolling || totalOnTable <= 0}
              onClick={roll}
            >
              {rolling ? "Rolling…" : comeOut ? "Roll (Come-Out)" : `Roll for ${point}`}
            </Button>

            <Button
              size="sm"
              variant="ghost"
              data-testid="reset-log"
              disabled={rolling || log.length === 0}
              onClick={resetHand}
            >
              Clear Log
            </Button>
          </div>

          <div className="mt-2 text-center text-[11px] text-white/40">
            Selected chip:{" "}
            <span className="font-semibold" style={{ color: ACCENT }}>
              {formatChips(chip)}
            </span>{" "}
            · Balance:{" "}
            <span className="font-semibold text-white/70">{formatChips(wallet.balance)}</span>
            {!idle && " · roll in progress"}
          </div>
        </div>

        {/* LOG + PAYTABLE */}
        <div className="mt-2 grid grid-cols-1 gap-3 sm:mt-4 lg:grid-cols-2">
          {/* Roll log */}
          <CollapsiblePanel title="Roll Log" accent={ACCENT}>
            <div className="min-h-[88px] space-y-1">
              <AnimatePresence initial={false}>
                {log.length === 0 && (
                  <div className="text-xs text-white/35">No rolls yet this session.</div>
                )}
                {log.map((e) => (
                  <motion.div
                    key={e.id}
                    initial={{ opacity: 0, x: -10 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0 }}
                    className="text-xs"
                    style={{
                      color:
                        e.tone === "win"
                          ? WIN_GREEN
                          : e.tone === "lose"
                            ? LOSE_RED
                            : e.tone === "point"
                              ? ACCENT
                              : "rgba(255,255,255,0.6)",
                    }}
                  >
                    {e.text}
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>
          </CollapsiblePanel>

          {/* Paytable */}
          <CollapsiblePanel title="Payouts" accent={ACCENT} summary={<>1.41% on the line</>}>
            <div className="grid grid-cols-1 gap-y-1 sm:grid-cols-2 sm:gap-x-4">
              {PAYTABLE.map((row) => (
                <div
                  key={row.label}
                  className="flex items-center justify-between border-b border-white/5 py-0.5 text-[11px]"
                >
                  <span className="text-white/60">{row.label}</span>
                  <span className="font-semibold tabular-nums" style={{ color: ACCENT }}>
                    {row.pays}
                  </span>
                </div>
              ))}
            </div>
            <div className="mt-2 text-[10px] leading-snug text-white/40">
              Repeaters pay 25:1–46:1 when a number repeats its count before a seven-out
              (~9–12% edge). Hardways &amp; place bets are OFF on the come-out unless you turn
              them on above.
            </div>
          </CollapsiblePanel>
        </div>
      </div>
    </div>
  );
}
