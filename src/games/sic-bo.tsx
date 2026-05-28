"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useWallet } from "@/lib/wallet";
import { randInt } from "@/lib/rng";
import { sfx } from "@/lib/sound";
import { formatChips, formatDelta } from "@/lib/format";
import { CountingNumber } from "@/components/CountingNumber";
import { Button } from "@/components/ui/Button";
import { Chip } from "@/components/ui/Chip";

/* ----------------------------------------------------------------------------
 * Sic Bo — three dice.
 *
 * Bet types & payouts (multiplier x = win(stake * x), x already includes stake):
 *  - SMALL  : total 4..10, LOSES on any triple. 1:1  -> x2
 *  - BIG    : total 11..17, LOSES on any triple. 1:1 -> x2
 *  - SPECIFIC TRIPLE (pick 1-6): all three match -> 150:1 -> x151
 *  - ANY TRIPLE : any three-of-a-kind -> 24:1 -> x25
 *  - SPECIFIC DOUBLE (pick 1-6): chosen number appears >=2 -> 8:1 -> x9
 *  - SINGLE NUMBER (1-6): appears once/twice/thrice -> 1:1 / 2:1 / 3:1
 *        (x2 / x3 / x4 respectively — stake-inclusive)
 *  - TOTAL bets:
 *        4 & 17 -> 50:1  (x51)
 *        5 & 16 -> 18:1  (x19)
 *        6 & 15 -> 14:1  (x15)
 *        7 & 14 -> 12:1  (x13)
 *        8 & 13 -> 8:1   (x9)
 *        9,10,11,12 -> 6:1 (x7)
 * ------------------------------------------------------------------------- */

type Die = 1 | 2 | 3 | 4 | 5 | 6;
type Phase = "betting" | "rolling" | "resolved";

const ACCENT = "#fd79a8";
const ACCENT_DEEP = "#b83267";
const WIN_GREEN = "#34c759";
const LOSE_RED = "#e3342f";

const CHIP_DENOMS = [5, 25, 100, 500, 1000];
const MIN_BET = 5;

/* ---- Bet identity --------------------------------------------------------- */
// A bet key is a string. We parse it on settle. Examples:
//   "small" | "big" | "anyTriple"
//   "single:3"        single number 3
//   "double:5"        specific double of 5
//   "triple:6"        specific triple of 6
//   "total:9"         total equals 9

type BetKey = string;

interface RollResult {
  dice: [Die, Die, Die];
  total: number;
  counts: Record<Die, number>; // how many of each face
  isTriple: boolean;
  tripleFace: Die | null;
}

/** Total -> (multiplier including stake). */
function totalMultiplier(total: number): number {
  switch (total) {
    case 4:
    case 17:
      return 51; // 50:1
    case 5:
    case 16:
      return 19; // 18:1
    case 6:
    case 15:
      return 15; // 14:1
    case 7:
    case 14:
      return 13; // 12:1
    case 8:
    case 13:
      return 9; // 8:1
    case 9:
    case 10:
    case 11:
    case 12:
      return 7; // 6:1
    default:
      return 0;
  }
}

function totalPaysLabel(total: number): string {
  const x = totalMultiplier(total);
  return x > 0 ? `${x - 1}:1` : "—";
}

/**
 * Returns the gross multiplier (stake-inclusive) for ONE bet key against a
 * roll. 0 means the bet lost (credit nothing).
 */
function settleBet(key: BetKey, r: RollResult): number {
  if (key === "small") {
    if (r.isTriple) return 0; // any triple loses small/big
    return r.total >= 4 && r.total <= 10 ? 2 : 0;
  }
  if (key === "big") {
    if (r.isTriple) return 0;
    return r.total >= 11 && r.total <= 17 ? 2 : 0;
  }
  if (key === "anyTriple") {
    return r.isTriple ? 25 : 0; // 24:1
  }
  const [kind, raw] = key.split(":");
  const n = Number(raw); // face (1-6) for single/double/triple, total (4-17) for total
  if (kind === "single") {
    const c = r.counts[n as Die] ?? 0;
    // appears once/twice/thrice -> 1:1 / 2:1 / 3:1 -> x2 / x3 / x4
    return c > 0 ? c + 1 : 0;
  }
  if (kind === "double") {
    return (r.counts[n as Die] ?? 0) >= 2 ? 9 : 0; // 8:1
  }
  if (kind === "triple") {
    return r.isTriple && r.tripleFace === n ? 151 : 0; // 150:1
  }
  if (kind === "total") {
    return r.total === n ? totalMultiplier(n) : 0;
  }
  return 0;
}

function rollDice(): RollResult {
  const dice: [Die, Die, Die] = [
    randInt(1, 6) as Die,
    randInt(1, 6) as Die,
    randInt(1, 6) as Die,
  ];
  const counts: Record<Die, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
  for (const d of dice) counts[d] += 1;
  const total = dice[0] + dice[1] + dice[2];
  const isTriple = dice[0] === dice[1] && dice[1] === dice[2];
  return { dice, total, counts, isTriple, tripleFace: isTriple ? dice[0] : null };
}

/* ---- Pip layouts for dice faces ------------------------------------------ */
// 3x3 grid positions (col,row 0..2). Each face lights specific cells.
const PIP_MAP: Record<Die, [number, number][]> = {
  1: [[1, 1]],
  2: [[0, 0], [2, 2]],
  3: [[0, 0], [1, 1], [2, 2]],
  4: [[0, 0], [2, 0], [0, 2], [2, 2]],
  5: [[0, 0], [2, 0], [1, 1], [0, 2], [2, 2]],
  6: [[0, 0], [2, 0], [0, 1], [2, 1], [0, 2], [2, 2]],
};

/* ---- A single 3D-ish rolling die ----------------------------------------- */
function DiceCube({
  face,
  rolling,
  delay,
  highlight,
  size = 84,
}: {
  face: Die;
  rolling: boolean;
  delay: number;
  highlight: boolean;
  size?: number;
}) {
  const pips = PIP_MAP[face];
  return (
    <motion.div
      className="relative grid place-items-center"
      style={{ width: size, height: size, perspective: 600 }}
      animate={
        rolling
          ? {
              y: [0, -size * 0.7, 0, -size * 0.35, 0],
              rotate: [0, 220, 480, 700, 900],
            }
          : { y: [0, -8, 0], rotate: 0 }
      }
      transition={
        rolling
          ? { duration: 0.9, ease: "easeInOut", delay, times: [0, 0.25, 0.5, 0.75, 1] }
          : { duration: 0.4, delay }
      }
    >
      <motion.div
        className="relative rounded-[22%]"
        style={{
          width: size,
          height: size,
          transformStyle: "preserve-3d",
          background: "linear-gradient(150deg,#ffffff 0%,#f4f0f5 55%,#d9d2dd 100%)",
          boxShadow: highlight
            ? `0 0 0 3px ${ACCENT}, 0 0 28px ${ACCENT}cc, 0 12px 24px rgba(0,0,0,0.5), inset 0 -6px 12px rgba(0,0,0,0.18)`
            : "0 12px 22px rgba(0,0,0,0.5), inset 0 -6px 12px rgba(0,0,0,0.18), inset 0 4px 8px rgba(255,255,255,0.7)",
        }}
        animate={
          rolling
            ? { rotateX: [0, 360, 720, 1080], rotateY: [0, 270, 540, 810] }
            : { rotateX: 0, rotateY: 0 }
        }
        transition={
          rolling
            ? { duration: 0.9, ease: "easeOut", delay }
            : { duration: 0.4, delay }
        }
      >
        {/* glossy highlight */}
        <span
          className="pointer-events-none absolute rounded-[22%]"
          style={{
            inset: "8%",
            background:
              "radial-gradient(circle at 32% 26%, rgba(255,255,255,0.9), transparent 45%)",
          }}
        />
        {/* pip grid */}
        <div
          className="absolute grid"
          style={{
            inset: "16%",
            gridTemplateColumns: "repeat(3,1fr)",
            gridTemplateRows: "repeat(3,1fr)",
          }}
        >
          {Array.from({ length: 9 }).map((_, i) => {
            const col = i % 3;
            const row = Math.floor(i / 3);
            const on = pips.some(([c, rr]) => c === col && rr === row);
            return (
              <div key={i} className="grid place-items-center">
                {on && (
                  <span
                    className="rounded-full"
                    style={{
                      width: size * 0.15,
                      height: size * 0.15,
                      background: "radial-gradient(circle at 35% 30%,#5a2336,#1c0a12)",
                      boxShadow: "inset 0 1px 2px rgba(255,255,255,0.4)",
                    }}
                  />
                )}
              </div>
            );
          })}
        </div>
      </motion.div>
    </motion.div>
  );
}

/* ---- A generic bet cell --------------------------------------------------- */
function BetCell({
  testid,
  title,
  sub,
  pays,
  amount,
  win,
  loseDim,
  disabled,
  onClick,
  className = "",
  children,
}: {
  testid: string;
  title: string;
  sub?: string;
  pays?: string;
  amount: number;
  win: boolean;
  loseDim: boolean;
  disabled: boolean;
  onClick: () => void;
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <motion.button
      type="button"
      data-testid={testid}
      onClick={onClick}
      disabled={disabled}
      whileHover={disabled ? undefined : { y: -2, scale: 1.015 }}
      whileTap={disabled ? undefined : { scale: 0.97 }}
      animate={
        win
          ? { boxShadow: `0 0 0 2px ${ACCENT}, 0 0 26px ${ACCENT}aa` }
          : { boxShadow: "0 0 0 1px rgba(255,255,255,0.08)" }
      }
      transition={{ duration: 0.3 }}
      className={`relative flex flex-col items-center justify-center gap-0.5 overflow-hidden rounded-xl px-2 py-2.5 text-center ${
        disabled ? "cursor-not-allowed" : "cursor-pointer"
      } ${className}`}
      style={{
        background: win
          ? `linear-gradient(180deg,${ACCENT}33,${ACCENT}14)`
          : "rgba(255,255,255,0.04)",
        opacity: loseDim ? 0.4 : 1,
      }}
    >
      {win && (
        <motion.span
          className="pointer-events-none absolute inset-0"
          initial={{ x: "-120%" }}
          animate={{ x: "120%" }}
          transition={{ duration: 0.8, repeat: Infinity, repeatDelay: 0.6 }}
          style={{
            background:
              "linear-gradient(105deg,transparent 35%,rgba(255,255,255,0.35) 50%,transparent 65%)",
          }}
        />
      )}
      <div className="font-display text-[13px] font-bold leading-tight text-white sm:text-sm">
        {title}
      </div>
      {children}
      {sub && (
        <div className="text-[9px] uppercase tracking-wider text-white/45">{sub}</div>
      )}
      {pays && (
        <div
          className="text-[10px] font-bold tabular-nums"
          style={{ color: ACCENT }}
        >
          {pays}
        </div>
      )}
      {/* placed chip badge */}
      <AnimatePresence>
        {amount > 0 && (
          <motion.div
            key={amount}
            initial={{ scale: 0, y: -14, opacity: 0 }}
            animate={{ scale: 1, y: 0, opacity: 1 }}
            exit={{ scale: 0, opacity: 0 }}
            transition={{ type: "spring", stiffness: 420, damping: 20 }}
            className="absolute right-1 top-1 grid h-7 min-w-[28px] place-items-center rounded-full px-1.5 text-[10px] font-black tabular-nums text-ink"
            style={{
              background: "linear-gradient(180deg,#f5d060,#caa022)",
              boxShadow: "0 2px 8px rgba(0,0,0,0.5)",
            }}
          >
            {formatChips(amount)}
          </motion.div>
        )}
      </AnimatePresence>
    </motion.button>
  );
}

/* ---- Mini pip cluster for the single-number / double / triple cells ------ */
function MiniDie({ face, size = 26 }: { face: Die; size?: number }) {
  const pips = PIP_MAP[face];
  return (
    <div
      className="grid rounded-md"
      style={{
        width: size,
        height: size,
        gridTemplateColumns: "repeat(3,1fr)",
        gridTemplateRows: "repeat(3,1fr)",
        padding: size * 0.14,
        background: "linear-gradient(150deg,#ffffff,#d9d2dd)",
        boxShadow: "inset 0 -2px 4px rgba(0,0,0,0.2),0 1px 2px rgba(0,0,0,0.4)",
      }}
    >
      {Array.from({ length: 9 }).map((_, i) => {
        const col = i % 3;
        const row = Math.floor(i / 3);
        const on = pips.some(([c, rr]) => c === col && rr === row);
        return (
          <div key={i} className="grid place-items-center">
            {on && (
              <span
                className="rounded-full"
                style={{ width: size * 0.16, height: size * 0.16, background: "#1c0a12" }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ---- Win burst particles -------------------------------------------------- */
function WinBurst() {
  const bits = useMemo(
    () =>
      Array.from({ length: 26 }).map((_, i) => ({
        id: i,
        angle: (i / 26) * Math.PI * 2,
        dist: 90 + Math.random() * 130,
        size: 6 + Math.random() * 10,
        rot: Math.random() * 360,
        color: i % 3 === 0 ? "#f5d060" : i % 3 === 1 ? ACCENT : "#fff",
        delay: Math.random() * 0.12,
      })),
    [],
  );
  return (
    <div className="pointer-events-none absolute inset-0 grid place-items-center">
      {bits.map((b) => (
        <motion.span
          key={b.id}
          className="absolute rounded-[2px]"
          initial={{ x: 0, y: 0, scale: 0, opacity: 1, rotate: 0 }}
          animate={{
            x: Math.cos(b.angle) * b.dist,
            y: Math.sin(b.angle) * b.dist,
            scale: [0, 1.2, 0.6],
            opacity: [1, 1, 0],
            rotate: b.rot,
          }}
          transition={{ duration: 1.1, delay: b.delay, ease: "easeOut" }}
          style={{ width: b.size, height: b.size, background: b.color }}
        />
      ))}
    </div>
  );
}

/* -------------------------------------------------------------------------- */

export default function SicBo() {
  const wallet = useWallet();

  const [bets, setBets] = useState<Record<BetKey, number>>({});
  const [chip, setChip] = useState(25);
  const [phase, setPhase] = useState<Phase>("betting");

  const [dice, setDice] = useState<[Die, Die, Die]>([1, 1, 1]);
  const [result, setResult] = useState<RollResult | null>(null);
  const [resultText, setResultText] = useState("");
  const [netDelta, setNetDelta] = useState(0);
  const [lastStake, setLastStake] = useState(0);
  const [showBurst, setShowBurst] = useState(false);
  const [winningKeys, setWinningKeys] = useState<Set<BetKey>>(new Set());
  const [history, setHistory] = useState<number[]>([]); // recent totals

  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(
    () => () => {
      timers.current.forEach(clearTimeout);
    },
    [],
  );
  const after = useCallback((ms: number, fn: () => void) => {
    const id = setTimeout(fn, ms);
    timers.current.push(id);
  }, []);

  const totalStake = useMemo(
    () => Object.values(bets).reduce((s, v) => s + v, 0),
    [bets],
  );
  const activeBetCount = useMemo(
    () => Object.values(bets).filter((v) => v > 0).length,
    [bets],
  );
  const isBetting = phase === "betting";
  const revealed = phase === "resolved";
  const canRoll = isBetting && totalStake >= MIN_BET && totalStake <= wallet.balance;

  const placedAmt = useCallback((key: BetKey) => bets[key] ?? 0, [bets]);

  const addBet = useCallback(
    (key: BetKey) => {
      if (!isBetting) return;
      const room = wallet.balance - totalStake;
      if (room <= 0) {
        sfx.lose();
        return;
      }
      const inc = Math.min(chip, room);
      sfx.chip();
      setBets((b) => ({ ...b, [key]: (b[key] ?? 0) + inc }));
    },
    [isBetting, wallet.balance, totalStake, chip],
  );

  const clearBets = useCallback(() => {
    if (!isBetting) return;
    sfx.click();
    setBets({});
  }, [isBetting]);

  const { win: walletWin, bet: walletBet } = wallet;
  const resolve = useCallback(
    (r: RollResult, stake: number, placed: Record<BetKey, number>) => {
      let gross = 0;
      const winners = new Set<BetKey>();
      let topMult = 0;
      for (const [key, amt] of Object.entries(placed)) {
        if (amt <= 0) continue;
        const mult = settleBet(key, r);
        if (mult > 0) {
          gross += amt * mult;
          winners.add(key);
          topMult = Math.max(topMult, mult);
        }
      }
      if (gross > 0) walletWin(gross);

      const net = gross - stake;
      setResult(r);
      setNetDelta(net);
      setWinningKeys(winners);
      setHistory((h) => [r.total, ...h].slice(0, 16));

      const faceTxt = r.dice.join(" · ");
      let txt = `🎲 ${faceTxt}  =  ${r.total}`;
      if (r.isTriple) txt += `  ·  TRIPLE ${r.tripleFace}`;
      txt +=
        net > 0 ? `  ·  ${formatDelta(net)}` : net < 0 ? `  ·  ${formatDelta(net)}` : `  ·  Push`;
      setResultText(txt);

      if (net > 0) {
        if (topMult >= 25) sfx.jackpot();
        else sfx.win();
        setShowBurst(true);
        after(1500, () => setShowBurst(false));
      } else if (net < 0) {
        sfx.lose();
      } else {
        sfx.thud();
      }
      setPhase("resolved");
    },
    [walletWin, after],
  );

  const roll = useCallback(() => {
    if (!canRoll) return;
    const stake = totalStake;
    if (!walletBet(stake)) {
      sfx.lose();
      return;
    }
    const placed = { ...bets };
    setLastStake(stake);
    setNetDelta(0);
    setResult(null);
    setResultText("");
    setShowBurst(false);
    setWinningKeys(new Set());

    const r = rollDice();
    setDice(r.dice);
    setPhase("rolling");
    sfx.thud();
    // tick clatter while the dice tumble
    [120, 280, 440, 620, 800].forEach((t) => after(t, () => sfx.tick()));
    // settle once the tumble settles
    after(1180, () => resolve(r, stake, placed));
  }, [canRoll, totalStake, walletBet, bets, after, resolve]);

  const newRound = useCallback(() => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
    sfx.click();
    setPhase("betting");
    setResult(null);
    setResultText("");
    setShowBurst(false);
    setNetDelta(0);
    setWinningKeys(new Set());
    // keep bets for fast re-bet but clamp to balance
    setBets((b) => {
      const tot = Object.values(b).reduce((s, v) => s + v, 0);
      return tot <= wallet.balance ? b : {};
    });
  }, [wallet.balance]);

  const liveResult = result; // null while betting/rolling

  const cellWin = useCallback((key: BetKey) => revealed && winningKeys.has(key), [
    revealed,
    winningKeys,
  ]);
  const cellDim = useCallback(
    (key: BetKey) => revealed && (bets[key] ?? 0) > 0 && !winningKeys.has(key),
    [revealed, bets, winningKeys],
  );

  /* ---- render ---- */
  return (
    <div className="mx-auto w-full max-w-5xl">
      {/* Header */}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-2xl">🎲</span>
          <div>
            <div
              className="font-display text-lg font-bold tracking-wide"
              style={{ color: ACCENT, textShadow: `0 0 16px ${ACCENT}66` }}
            >
              Sic&nbsp;Bo
            </div>
            <div className="text-[11px] uppercase tracking-widest text-white/40">
              Three dice · pick your fortune
            </div>
          </div>
        </div>
        {/* recent totals trail */}
        <div className="flex items-center gap-1">
          <span className="mr-1 text-[10px] uppercase tracking-widest text-white/35">
            Recent
          </span>
          <AnimatePresence initial={false}>
            {history.slice(0, 8).map((t, i) => (
              <motion.span
                key={`${t}-${i}-${history.length}`}
                initial={{ scale: 0, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 - i * 0.08 }}
                className="grid h-6 w-6 place-items-center rounded-full text-[11px] font-bold tabular-nums"
                style={{
                  background:
                    t >= 11 && t <= 17
                      ? "rgba(253,121,168,0.22)"
                      : "rgba(34,225,255,0.18)",
                  color: "#fff",
                }}
              >
                {t}
              </motion.span>
            ))}
          </AnimatePresence>
        </div>
      </div>

      {/* Table surface */}
      <div className="felt relative overflow-hidden rounded-3xl p-4 sm:p-6">
        <div
          className="pointer-events-none absolute inset-0 opacity-50"
          style={{
            background: `radial-gradient(circle at 50% 0%, ${ACCENT}22, transparent 55%)`,
          }}
        />

        {/* Dice arena */}
        <div className="relative mb-4 grid place-items-center">
          <div
            className="relative flex items-center justify-center gap-4 rounded-2xl px-6 py-6 sm:gap-7 sm:px-12"
            style={{
              background:
                "radial-gradient(circle at 50% 40%, rgba(0,0,0,0.35), rgba(0,0,0,0.15))",
              boxShadow: "inset 0 0 40px rgba(0,0,0,0.45)",
            }}
          >
            {dice.map((d, i) => (
              <DiceCube
                key={i}
                face={d}
                rolling={phase === "rolling"}
                delay={i * 0.08}
                highlight={
                  revealed &&
                  result !== null &&
                  // light up dice that contributed to a winning single/double/triple
                  winningKeys.size > 0 &&
                  [...winningKeys].some((k) => {
                    const [kind, raw] = k.split(":");
                    if (kind === "single" || kind === "double" || kind === "triple") {
                      return Number(raw) === d;
                    }
                    return false;
                  })
                }
              />
            ))}
            <AnimatePresence>{showBurst && <WinBurst />}</AnimatePresence>
          </div>

          {/* total readout */}
          <AnimatePresence mode="wait">
            {revealed && liveResult && (
              <motion.div
                key={liveResult.total}
                initial={{ scale: 0.4, opacity: 0, y: 8 }}
                animate={{ scale: 1, opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={{ type: "spring", stiffness: 360, damping: 18 }}
                className="mt-3 flex items-center gap-2"
              >
                <span className="text-[11px] uppercase tracking-widest text-white/45">
                  Total
                </span>
                <span
                  className="font-display text-2xl font-black tabular-nums"
                  style={{ color: ACCENT, textShadow: `0 0 18px ${ACCENT}88` }}
                >
                  {liveResult.total}
                </span>
                <span
                  className="rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider"
                  style={{
                    background:
                      liveResult.isTriple
                        ? "rgba(245,208,96,0.25)"
                        : liveResult.total <= 10
                          ? "rgba(34,225,255,0.2)"
                          : "rgba(253,121,168,0.25)",
                    color: "#fff",
                  }}
                >
                  {liveResult.isTriple
                    ? `Triple ${liveResult.tripleFace}`
                    : liveResult.total <= 10
                      ? "Small"
                      : "Big"}
                </span>
              </motion.div>
            )}
            {!revealed && (
              <motion.div
                key="hint"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="mt-3 text-center text-sm text-white/45"
              >
                {phase === "rolling"
                  ? "Rolling the dice…"
                  : totalStake > 0
                    ? "Add more chips or roll the dice."
                    : "Tap any bet spot to place chips."}
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* ===== BET GRID ===== */}
        {/* Row 1: SMALL / BIG */}
        <div className="relative grid grid-cols-2 gap-2 sm:gap-3">
          <BetCell
            testid="bet-small"
            title="SMALL"
            sub="Total 4–10"
            pays="1:1 · loses on triple"
            amount={placedAmt("small")}
            win={cellWin("small")}
            loseDim={cellDim("small")}
            disabled={!isBetting}
            onClick={() => addBet("small")}
            className="min-h-[64px]"
          />
          <BetCell
            testid="bet-big"
            title="BIG"
            sub="Total 11–17"
            pays="1:1 · loses on triple"
            amount={placedAmt("big")}
            win={cellWin("big")}
            loseDim={cellDim("big")}
            disabled={!isBetting}
            onClick={() => addBet("big")}
            className="min-h-[64px]"
          />
        </div>

        {/* Row 2: SINGLE NUMBER 1-6 */}
        <div className="relative mt-2">
          <div className="mb-1 text-[10px] uppercase tracking-widest text-white/35">
            Single number — 1:1 / 2:1 / 3:1 (×1 / ×2 / ×3 appearances)
          </div>
          <div className="grid grid-cols-6 gap-1.5 sm:gap-2">
            {([1, 2, 3, 4, 5, 6] as Die[]).map((n) => (
              <BetCell
                key={`single-${n}`}
                testid={`bet-single-${n}`}
                title=""
                amount={placedAmt(`single:${n}`)}
                win={cellWin(`single:${n}`)}
                loseDim={cellDim(`single:${n}`)}
                disabled={!isBetting}
                onClick={() => addBet(`single:${n}`)}
                className="min-h-[58px]"
              >
                <div className="grid place-items-center py-0.5">
                  <MiniDie face={n} size={28} />
                </div>
              </BetCell>
            ))}
          </div>
        </div>

        {/* Row 3: SPECIFIC DOUBLE 1-6 */}
        <div className="relative mt-2">
          <div className="mb-1 text-[10px] uppercase tracking-widest text-white/35">
            Specific double — 8:1 (chosen face appears twice+)
          </div>
          <div className="grid grid-cols-6 gap-1.5 sm:gap-2">
            {([1, 2, 3, 4, 5, 6] as Die[]).map((n) => (
              <BetCell
                key={`double-${n}`}
                testid={`bet-double-${n}`}
                title=""
                pays="8:1"
                amount={placedAmt(`double:${n}`)}
                win={cellWin(`double:${n}`)}
                loseDim={cellDim(`double:${n}`)}
                disabled={!isBetting}
                onClick={() => addBet(`double:${n}`)}
                className="min-h-[58px]"
              >
                <div className="flex items-center justify-center gap-0.5 py-0.5">
                  <MiniDie face={n} size={20} />
                  <MiniDie face={n} size={20} />
                </div>
              </BetCell>
            ))}
          </div>
        </div>

        {/* Row 4: SPECIFIC TRIPLE 1-6 + ANY TRIPLE */}
        <div className="relative mt-2">
          <div className="mb-1 text-[10px] uppercase tracking-widest text-white/35">
            Triples — specific 150:1 · any 24:1
          </div>
          <div className="grid grid-cols-7 gap-1.5 sm:gap-2">
            {([1, 2, 3, 4, 5, 6] as Die[]).map((n) => (
              <BetCell
                key={`triple-${n}`}
                testid={`bet-triple-${n}`}
                title=""
                pays="150:1"
                amount={placedAmt(`triple:${n}`)}
                win={cellWin(`triple:${n}`)}
                loseDim={cellDim(`triple:${n}`)}
                disabled={!isBetting}
                onClick={() => addBet(`triple:${n}`)}
                className="min-h-[58px]"
              >
                <div className="flex items-center justify-center gap-[1px] py-0.5">
                  <MiniDie face={n} size={15} />
                  <MiniDie face={n} size={15} />
                  <MiniDie face={n} size={15} />
                </div>
              </BetCell>
            ))}
            <BetCell
              testid="bet-any-triple"
              title="ANY"
              sub="triple"
              pays="24:1"
              amount={placedAmt("anyTriple")}
              win={cellWin("anyTriple")}
              loseDim={cellDim("anyTriple")}
              disabled={!isBetting}
              onClick={() => addBet("anyTriple")}
              className="min-h-[58px]"
            />
          </div>
        </div>

        {/* Row 5: TOTAL bets 4..17 */}
        <div className="relative mt-2">
          <div className="mb-1 text-[10px] uppercase tracking-widest text-white/35">
            Total of three dice
          </div>
          <div className="grid grid-cols-7 gap-1.5 sm:grid-cols-7 sm:gap-2">
            {Array.from({ length: 14 }, (_, i) => i + 4).map((t) => (
              <BetCell
                key={`total-${t}`}
                testid={`bet-total-${t}`}
                title={String(t)}
                pays={totalPaysLabel(t)}
                amount={placedAmt(`total:${t}`)}
                win={cellWin(`total:${t}`)}
                loseDim={cellDim(`total:${t}`)}
                disabled={!isBetting}
                onClick={() => addBet(`total:${t}`)}
                className="min-h-[50px]"
              />
            ))}
          </div>
        </div>

        {/* Result banner */}
        <div className="relative mt-4 min-h-[46px]">
          <AnimatePresence mode="wait">
            {resultText && (
              <motion.div
                key={resultText}
                data-testid="round-result"
                initial={{ opacity: 0, y: 12, scale: 0.95 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ type: "spring", stiffness: 320, damping: 22 }}
                className="mx-auto w-fit rounded-2xl px-5 py-2 text-center font-display text-base font-black sm:text-lg"
                style={{
                  color: netDelta > 0 ? "#04130c" : "#fff",
                  background:
                    netDelta > 0
                      ? "linear-gradient(180deg,#8aff80,#34c759)"
                      : netDelta < 0
                        ? "linear-gradient(180deg,#e3342f,#9a1a17)"
                        : "rgba(255,255,255,0.08)",
                  boxShadow:
                    netDelta > 0
                      ? `0 0 26px ${WIN_GREEN}88`
                      : netDelta < 0
                        ? `0 0 22px ${LOSE_RED}80`
                        : "none",
                }}
              >
                {resultText}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      {/* ===== Controls ===== */}
      <div className="mt-4 grid gap-4 lg:grid-cols-[1.5fr_1fr]">
        {/* Chip selector + stake + actions */}
        <div className="glass rounded-2xl p-4">
          <div className="mb-3 flex items-center justify-between">
            <div className="text-[11px] uppercase tracking-widest text-white/40">
              Chip size
            </div>
            <div className="flex items-center gap-4 text-right">
              <div>
                <div className="text-[10px] uppercase tracking-widest text-white/35">
                  Total bet
                </div>
                <div className="gold-text text-base font-bold tabular-nums">
                  <CountingNumber value={totalStake} />
                </div>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-widest text-white/35">
                  Spots
                </div>
                <div className="text-base font-bold tabular-nums text-white/80">
                  {activeBetCount}
                </div>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-center gap-2 sm:gap-3">
            {CHIP_DENOMS.map((v) => (
              <div key={v} className="grid place-items-center gap-1">
                <Chip
                  value={v}
                  size={50}
                  selected={chip === v}
                  onClick={
                    !isBetting
                      ? undefined
                      : () => {
                          sfx.click();
                          setChip(v);
                        }
                  }
                />
              </div>
            ))}
          </div>

          <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
            <Button
              size="sm"
              variant="ghost"
              data-testid="clear-btn"
              disabled={!isBetting || totalStake === 0}
              onClick={clearBets}
            >
              Clear bets
            </Button>

            {!revealed ? (
              <Button
                size="lg"
                variant="gold"
                data-testid="play-btn"
                disabled={!canRoll}
                onClick={roll}
              >
                {phase === "rolling" ? "Rolling…" : "Roll Dice"}
              </Button>
            ) : (
              <Button
                size="lg"
                variant="gold"
                data-testid="play-btn"
                onClick={newRound}
              >
                New Round
              </Button>
            )}
          </div>

          {totalStake > wallet.balance && isBetting && (
            <div className="mt-2 text-center text-[11px] font-semibold text-ruby">
              Bet exceeds balance — lower your stake.
            </div>
          )}

          {/* last round net */}
          <AnimatePresence>
            {revealed && (
              <motion.div
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                className="mt-3 flex items-center justify-center gap-4 text-sm"
              >
                <span className="text-white/45">Staked </span>
                <span className="tabular-nums text-white/80">
                  {formatChips(lastStake)}
                </span>
                <span className="text-white/45">·</span>
                <span
                  className="font-bold tabular-nums"
                  style={{
                    color: netDelta > 0 ? WIN_GREEN : netDelta < 0 ? LOSE_RED : "#fff",
                  }}
                >
                  <CountingNumber value={netDelta} prefix={netDelta > 0 ? "+" : ""} />
                </span>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Paytable */}
        <div className="glass rounded-2xl p-4">
          <div className="mb-2 flex items-center justify-between">
            <div className="font-display text-sm font-bold" style={{ color: ACCENT }}>
              Paytable
            </div>
            <div className="text-[10px] uppercase tracking-widest text-white/35">
              pays : 1
            </div>
          </div>
          <ul className="space-y-1 text-[12px]">
            {[
              ["Small / Big", "1:1", "total 4–10 / 11–17 · loses on any triple"],
              ["Single number", "1:1 / 2:1 / 3:1", "per appearance"],
              ["Specific double", "8:1", "chosen face appears twice+"],
              ["Any triple", "24:1", "any three of a kind"],
              ["Specific triple", "150:1", "all three match your pick"],
              ["Total 4 / 17", "50:1", ""],
              ["Total 5 / 16", "18:1", ""],
              ["Total 6 / 15", "14:1", ""],
              ["Total 7 / 14", "12:1", ""],
              ["Total 8 / 13", "8:1", ""],
              ["Total 9–12", "6:1", ""],
            ].map(([label, pays, note]) => (
              <li
                key={label}
                className="flex items-baseline justify-between gap-2 border-b border-white/5 pb-1"
              >
                <span className="text-white/80">
                  {label}
                  {note && (
                    <span className="ml-1 text-[10px] text-white/35">{note}</span>
                  )}
                </span>
                <span
                  className="shrink-0 font-bold tabular-nums"
                  style={{ color: ACCENT }}
                >
                  {pays}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
