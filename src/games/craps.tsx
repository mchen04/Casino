"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useWallet } from "@/lib/wallet";
import { sfx } from "@/lib/sound";
import { randInt } from "@/lib/rng";
import { formatChips, formatDelta } from "@/lib/format";
import { Button } from "@/components/ui/Button";
import { Chip } from "@/components/ui/Chip";

/* ----------------------------------------------------------------------------
 * CRAPS — two dice on the felt.
 *
 * Money model (settles exactly through useWallet):
 *  - Committing a wager calls bet(amount): chips LEAVE the wallet immediately.
 *  - On each roll every active wager is resolved:
 *      win  -> win(stake * multiplier)   (multiplier already includes stake)
 *      push -> win(stake)                (refund)
 *      lose -> credit nothing            (chips already deducted)
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
 * ------------------------------------------------------------------------- */

const ACCENT = "#e67e22";
const WIN_GREEN = "#34d399";
const LOSE_RED = "#f87171";

const CHIP_DENOMS = [5, 25, 100, 500, 1000];

type Phase = "betting" | "rolling";

/** Wager spots that take a base stake from chips. */
type LineKey = "pass" | "dontPass" | "field" | "place6" | "place8";

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

const PAYTABLE: { label: string; pays: string }[] = [
  { label: "Pass / Don't Pass", pays: "1 : 1" },
  { label: "Pass Odds · point 4/10", pays: "2 : 1" },
  { label: "Pass Odds · point 5/9", pays: "3 : 2" },
  { label: "Pass Odds · point 6/8", pays: "6 : 5" },
  { label: "Field · 3,4,9,10,11", pays: "1 : 1" },
  { label: "Field · 2", pays: "2 : 1" },
  { label: "Field · 12", pays: "3 : 1" },
  { label: "Place 6 / Place 8", pays: "7 : 6" },
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

function Die({ value, size = 72, rolling }: { value: number; size?: number; rolling: boolean }) {
  const cells: { r: number; c: number; on: boolean }[] = [];
  const on = new Set((PIPS[value] ?? []).map(([r, c]) => `${r}-${c}`));
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) cells.push({ r, c, on: on.has(`${r}-${c}`) });
  }
  return (
    <motion.div
      animate={
        rolling
          ? { rotate: [0, -18, 22, -12, 0], y: [0, -26, -6, -18, 0] }
          : { rotate: 0, y: 0 }
      }
      transition={
        rolling
          ? { duration: 0.5, repeat: Infinity, ease: "easeInOut" }
          : { type: "spring", stiffness: 320, damping: 16 }
      }
      style={{ width: size, height: size }}
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

/* ----------------------------- Counter -------------------------------- */

function Counter({ value, prefix = "" }: { value: number; prefix?: string }) {
  const [display, setDisplay] = useState(value);
  const raf = useRef<number | null>(null);
  const from = useRef(value);

  useEffect(() => {
    from.current = display;
    const start = performance.now();
    const delta = value - from.current;
    const dur = 520;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / dur);
      const eased = 1 - Math.pow(1 - t, 3);
      setDisplay(Math.round(from.current + delta * eased));
      if (t < 1) raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => {
      if (raf.current) cancelAnimationFrame(raf.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  return (
    <span className="tabular-nums">
      {prefix}
      {formatChips(display)}
    </span>
  );
}

/* ----------------------------- Game ----------------------------------- */

let logId = 0;

export default function Craps() {
  const wallet = useWallet();

  // Active wagers (chips already deducted from wallet once committed).
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

  const [chip, setChip] = useState(25);
  const [phase, setPhase] = useState<Phase>("betting");
  const [point, setPoint] = useState<number | null>(null);

  const [dice, setDice] = useState<DiceResult>({ a: 1, b: 1, total: 2 });
  const [rolling, setRolling] = useState(false);

  const [resultText, setResultText] = useState("Place your bets, then roll.");
  const [resultTone, setResultTone] = useState<"win" | "lose" | "info" | "point">("info");
  const [lastDelta, setLastDelta] = useState(0);
  const [burst, setBurst] = useState(0);

  const [log, setLog] = useState<LogEntry[]>([]);

  const rollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (rollTimer.current) clearTimeout(rollTimer.current);
    };
  }, []);

  const pushLog = useCallback((text: string, tone: LogEntry["tone"]) => {
    setLog((l) => [{ id: ++logId, text, tone }, ...l].slice(0, 7));
  }, []);

  const totalOnTable = useMemo(
    () =>
      bets.pass +
      bets.dontPass +
      bets.field +
      bets.place6 +
      bets.place8 +
      passOdds +
      dontOdds,
    [bets, passOdds, dontOdds],
  );

  const comeOut = point === null;
  const idle = phase !== "rolling";

  // ---- placing wagers (each commits chips immediately via bet()) ----

  const placeOnSpot = useCallback(
    (key: LineKey) => {
      if (rolling) return;
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
      if (!wallet.bet(chip)) {
        sfx.lose();
        setResultText("Not enough chips for that.");
        setResultTone("info");
        return;
      }
      sfx.chip();
      setBets((b) => ({ ...b, [key]: b[key] + chip }));
    },
    [rolling, comeOut, bets, chip, wallet],
  );

  const addPassOdds = useCallback(() => {
    if (rolling || comeOut || bets.pass === 0) return;
    if (!wallet.bet(chip)) {
      sfx.lose();
      return;
    }
    sfx.chip();
    setPassOdds((o) => o + chip);
  }, [rolling, comeOut, bets.pass, chip, wallet]);

  const addDontOdds = useCallback(() => {
    if (rolling || comeOut || bets.dontPass === 0) return;
    if (!wallet.bet(chip)) {
      sfx.lose();
      return;
    }
    sfx.chip();
    setDontOdds((o) => o + chip);
  }, [rolling, comeOut, bets.dontPass, chip, wallet]);

  // Clear all *un-committed-but-removable* wagers and refund them. Only allowed
  // pre-roll. Place / Field / odds may be taken down anytime there's no roll in
  // progress; Pass/Don't contracts can only be removed during come-out.
  const clearBets = useCallback(() => {
    if (rolling) return;
    // Compute refund from current state values BEFORE touching state, to avoid
    // the React StrictMode double-invoker causing a doubled wallet.win() call.
    let refund = bets.field + bets.place6 + bets.place8;
    if (comeOut) refund += bets.pass + bets.dontPass + passOdds + dontOdds;
    setBets((b) => {
      const next = { ...b };
      // Field & place always removable when idle.
      next.field = 0;
      next.place6 = 0;
      next.place8 = 0;
      // Contracts only when come-out.
      if (comeOut) {
        next.pass = 0;
        next.dontPass = 0;
      }
      return next;
    });
    if (comeOut) {
      setPassOdds(0);
      setDontOdds(0);
    }
    if (refund > 0) {
      wallet.win(refund);
      sfx.chip();
    }
  }, [rolling, comeOut, bets, passOdds, dontOdds, wallet]);

  // ---- resolution math for one roll ----

  const resolveRoll = useCallback(
    (res: DiceResult) => {
      const t = res.total;
      let payout = 0; // gross credited this roll
      let staked = 0; // chips that were riding (for delta display)
      const events: { text: string; tone: LogEntry["tone"] }[] = [];
      let newPoint = point;
      const nextBets: Record<LineKey, number> = { ...bets };
      let nextPassOdds = passOdds;
      let nextDontOdds = dontOdds;

      // ---------- FIELD (one-roll, always resolves) ----------
      if (bets.field > 0) {
        staked += bets.field;
        if (t === 2) {
          payout += bets.field * 3; // 2:1 -> 3x money
          events.push({ text: `Field hits 2 — pays 2:1 (+${bets.field * 2})`, tone: "win" });
        } else if (t === 12) {
          payout += bets.field * 4; // 3:1 -> 4x money
          events.push({ text: `Field hits 12 — pays 3:1 (+${bets.field * 3})`, tone: "win" });
        } else if (t === 3 || t === 4 || t === 9 || t === 10 || t === 11) {
          payout += bets.field * 2; // 1:1
          events.push({ text: `Field hits ${t} — pays 1:1 (+${bets.field})`, tone: "win" });
        } else {
          events.push({ text: `Field loses on ${t} (-${bets.field})`, tone: "lose" });
        }
        nextBets.field = 0; // field is settled every roll
      }

      // ---------- PLACE 6 / PLACE 8 ----------
      const settlePlace = (key: "place6" | "place8", num: number) => {
        if (bets[key] <= 0) return;
        if (t === num) {
          // Bet stays working; only the 7:6 profit is paid out.
          const profit = (bets[key] / 6) * 7;
          payout += profit;
          events.push({ text: `Place ${num} hits — pays 7:6 (+${Math.round(profit)})`, tone: "win" });
        } else if (t === 7) {
          staked += bets[key];
          events.push({ text: `Place ${num} loses on the 7 (-${bets[key]})`, tone: "lose" });
          nextBets[key] = 0;
        }
      };
      settlePlace("place6", 6);
      settlePlace("place8", 8);

      // ---------- PASS / DON'T PASS (+ odds) ----------
      if (comeOut) {
        // COME-OUT ROLL
        if (bets.pass > 0) {
          if (t === 7 || t === 11) {
            staked += bets.pass;
            payout += bets.pass * 2;
            events.push({ text: `Pass wins on ${t}! (+${bets.pass})`, tone: "win" });
            nextBets.pass = 0;
          } else if (t === 2 || t === 3 || t === 12) {
            staked += bets.pass;
            events.push({ text: `Craps ${t} — Pass loses (-${bets.pass})`, tone: "lose" });
            nextBets.pass = 0;
          }
          // else: point set, pass stays working (handled below)
        }
        if (bets.dontPass > 0) {
          if (t === 2 || t === 3) {
            staked += bets.dontPass;
            payout += bets.dontPass * 2;
            events.push({ text: `Don't Pass wins on ${t}! (+${bets.dontPass})`, tone: "win" });
            nextBets.dontPass = 0;
          } else if (t === 7 || t === 11) {
            staked += bets.dontPass;
            events.push({ text: `Don't Pass loses on ${t} (-${bets.dontPass})`, tone: "lose" });
            nextBets.dontPass = 0;
          } else if (t === 12) {
            staked += bets.dontPass;
            payout += bets.dontPass; // push refund
            events.push({ text: `12 — Don't Pass pushes`, tone: "info" });
            nextBets.dontPass = 0;
          }
        }
        // Establish the point on 4,5,6,8,9,10.
        if (t === 4 || t === 5 || t === 6 || t === 8 || t === 9 || t === 10) {
          newPoint = t;
          events.push({ text: `Point is ${t}. Roll it again before a 7.`, tone: "point" });
        }
      } else {
        // POINT PHASE — point is a number
        const p = point as number;
        if (t === p) {
          // Pass + pass odds WIN; don't pass + odds LOSE.
          if (bets.pass > 0) {
            staked += bets.pass;
            payout += bets.pass * 2;
            events.push({ text: `Point ${p} repeats — Pass wins! (+${bets.pass})`, tone: "win" });
            nextBets.pass = 0;
          }
          if (passOdds > 0) {
            const r = passOddsProfit(p);
            const profit = (passOdds * r.num) / r.den;
            staked += passOdds;
            payout += passOdds + profit;
            events.push({
              text: `Pass odds win ${r.num}:${r.den} (+${Math.round(profit)})`,
              tone: "win",
            });
            nextPassOdds = 0;
          }
          if (bets.dontPass > 0) {
            staked += bets.dontPass;
            events.push({ text: `Point hit — Don't Pass loses (-${bets.dontPass})`, tone: "lose" });
            nextBets.dontPass = 0;
          }
          if (dontOdds > 0) {
            staked += dontOdds;
            events.push({ text: `Don't odds lose (-${dontOdds})`, tone: "lose" });
            nextDontOdds = 0;
          }
          newPoint = null;
        } else if (t === 7) {
          // SEVEN OUT — Pass + odds LOSE; Don't pass + odds WIN. Place bets lose
          // too (handled above). This ends the shooter's hand.
          if (bets.pass > 0) {
            staked += bets.pass;
            events.push({ text: `Seven out — Pass loses (-${bets.pass})`, tone: "lose" });
            nextBets.pass = 0;
          }
          if (passOdds > 0) {
            staked += passOdds;
            events.push({ text: `Pass odds lose (-${passOdds})`, tone: "lose" });
            nextPassOdds = 0;
          }
          if (bets.dontPass > 0) {
            staked += bets.dontPass;
            payout += bets.dontPass * 2;
            events.push({ text: `Seven out — Don't Pass wins! (+${bets.dontPass})`, tone: "win" });
            nextBets.dontPass = 0;
          }
          if (dontOdds > 0) {
            const r = dontOddsProfit(p);
            const profit = (dontOdds * r.num) / r.den;
            staked += dontOdds;
            payout += dontOdds + profit;
            events.push({
              text: `Don't odds win ${r.num}:${r.den} (+${Math.round(profit)})`,
              tone: "win",
            });
            nextDontOdds = 0;
          }
          newPoint = null;
        }
        // any other number: pass/don't & odds ride untouched
      }

      // Credit the wallet exactly once.
      const grossRounded = Math.round(payout);
      if (grossRounded > 0) wallet.win(grossRounded);

      // Net delta vs chips that were riding this roll (already deducted on placement).
      const net = grossRounded - Math.round(staked);

      return {
        events,
        net,
        gross: grossRounded,
        nextBets,
        nextPassOdds,
        nextDontOdds,
        newPoint,
      };
    },
    [bets, passOdds, dontOdds, comeOut, point, wallet],
  );

  // ---- the roll action ----

  const roll = useCallback(() => {
    if (rolling) return;
    if (totalOnTable <= 0) {
      sfx.lose();
      setResultText("Place at least one bet to roll.");
      setResultTone("info");
      return;
    }
    sfx.thud();
    setPhase("rolling");
    setRolling(true);
    setLastDelta(0);
    setResultText(comeOut ? "Come-out roll…" : `Rolling for the point (${point})…`);
    setResultTone("info");

    // tumble ticks for feel
    let ticks = 0;
    const tickIv = setInterval(() => {
      ticks++;
      sfx.tick();
      setDice({ a: randInt(1, 6), b: randInt(1, 6), total: 0 });
      if (ticks >= 5) clearInterval(tickIv);
    }, 110);

    rollTimer.current = setTimeout(() => {
      clearInterval(tickIv);
      const a = randInt(1, 6);
      const b = randInt(1, 6);
      const res: DiceResult = { a, b, total: a + b };
      setDice(res);

      const out = resolveRoll(res);

      setBets(out.nextBets);
      setPassOdds(out.nextPassOdds);
      setDontOdds(out.nextDontOdds);
      setPoint(out.newPoint);
      setRolling(false);
      setPhase("betting");

      // result text + sound
      const won = out.net > 0;
      const lost = out.net < 0;
      let headline: string;
      let tone: LogEntry["tone"];
      if (out.events.length === 0) {
        headline = `Rolled ${res.total} — no action.`;
        tone = "info";
      } else if (won) {
        headline = `Rolled ${res.total} — you win ${formatDelta(out.net)}!`;
        tone = "win";
      } else if (lost) {
        headline = `Rolled ${res.total} — down ${formatChips(Math.abs(out.net))}.`;
        tone = "lose";
      } else {
        headline = `Rolled ${res.total}.`;
        tone = out.newPoint && comeOut ? "point" : "info";
      }
      setResultText(headline);
      setResultTone(tone);
      setLastDelta(out.net);
      out.events.forEach((e) => pushLog(e.text, e.tone));

      if (won) {
        setBurst((n) => n + 1);
        if (out.net >= chip * 6) sfx.jackpot();
        else sfx.win();
      } else if (lost) {
        sfx.lose();
      } else if (out.newPoint && comeOut) {
        sfx.thud();
      } else {
        sfx.card();
      }
    }, 720);
  }, [rolling, totalOnTable, comeOut, point, resolveRoll, pushLog, chip]);

  // Pull everything down and refund (only allowed when idle & between hands ideally).
  const resetHand = useCallback(() => {
    setLog([]);
    setLastDelta(0);
    setResultText("Place your bets, then roll.");
    setResultTone("info");
  }, []);

  // ---------------------------- render --------------------------------

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

        {/* header row: title + puck */}
        <div className="relative flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-display text-2xl font-bold tracking-wide" style={{ color: ACCENT }}>
              Craps
            </h2>
            <p className="text-xs text-white/50">Roll the bones — Pass, Don't Pass, Field & Place.</p>
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

        {/* DICE STAGE */}
        <div className="relative my-5">
          <div
            className="relative grid place-items-center rounded-2xl py-8"
            style={{
              background: "radial-gradient(ellipse at center, rgba(0,0,0,0.25), rgba(0,0,0,0.05))",
              border: "1px solid rgba(255,255,255,0.06)",
            }}
          >
            <div className="flex items-center gap-6">
              <Die value={dice.a} rolling={rolling} />
              <Die value={dice.b} rolling={rolling} />
            </div>

            {/* total badge */}
            <AnimatePresence>
              {!rolling && (
                <motion.div
                  key={`tot-${dice.total}-${log.length}`}
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
                  {dice.total}
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
          </div>
        </div>

        {/* RESULT TEXT */}
        <div className="mb-4 text-center">
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
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
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

        {/* CHIP SELECTOR + ACTIONS */}
        <div className="glass mt-4 rounded-2xl p-3 sm:p-4">
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
                <Counter value={totalOnTable} />
              </div>
            </div>

            <Button
              size="sm"
              variant="ghost"
              data-testid="clear-btn"
              disabled={rolling || totalOnTable === 0}
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
        <div className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-2">
          {/* Roll log */}
          <div className="glass rounded-2xl p-3">
            <div className="mb-2 text-[10px] uppercase tracking-widest text-white/40">
              Roll Log
            </div>
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
          </div>

          {/* Paytable */}
          <div className="glass rounded-2xl p-3">
            <div className="mb-2 text-[10px] uppercase tracking-widest text-white/40">
              Payouts
            </div>
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
          </div>
        </div>
      </div>
    </div>
  );
}
