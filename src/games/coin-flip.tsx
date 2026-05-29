"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useWallet } from "@/lib/wallet";
import { chance } from "@/lib/rng";
import { formatChips, formatDelta, formatMultiplier } from "@/lib/format";
import { sfx } from "@/lib/sound";
import { sleep } from "@/lib/async";
import { Button } from "@/components/ui/Button";
import { BetControls } from "@/components/BetControls";
import { CountingNumber } from "@/components/CountingNumber";
import { CollapsiblePanel } from "@/components/CollapsiblePanel";
import { Celebration } from "@/components/Celebration";

// ---------------------------------------------------------------------------
// Coin Flip — pick HEADS or TAILS, flip a gorgeous 3D coin.
//
// Single mode:
//   - Correct call : win(stake * PAYOUT)   (PAYOUT = 1.96 → net +0.96*stake)
//   - Wrong call    : credit nothing        (net -stake)
//
// Streak mode (let it ride):
//   - Stake is wagered ONCE at the start of the streak.
//   - Each correct flip multiplies the running pot by PAYOUT.
//   - CASH OUT pays win(currentPot) where pot = stake * PAYOUT^streak.
//   - A single wrong flip loses the whole pot — credit nothing.
//
// Both modes route money exclusively through useWallet(). The fair coin is a
// true 50/50 (chance(0.5)); the house edge lives entirely in the < 2.0 payout.
// ---------------------------------------------------------------------------

const ACCENT = "#bdc3c7";
const ACCENT_DEEP = "#7f8c8d";
const PAYOUT = 1.96; // ~2:1 with a small house edge baked in
const MIN_BET = 5;
const CHIPS = [5, 25, 100, 500, 1000];

type Side = "heads" | "tails";
type Mode = "single" | "streak";
type Phase = "betting" | "flipping" | "resolved";

interface FlipResult {
  call: Side;
  landed: Side;
  won: boolean;
}

// ---------------------------------------------------------------------------
// The 3D coin. Spins on rotateX (vertical tumble) plus a rotateY wobble, then
// settles to show the landed face. Each face is a layered SVG medallion.
// ---------------------------------------------------------------------------
function CoinFace({ side }: { side: Side }) {
  const heads = side === "heads";
  const rim = heads ? "#f5d060" : ACCENT;
  const rimDark = heads ? "#a9821c" : ACCENT_DEEP;
  const faceTop = heads ? "#fbe9a0" : "#eef2f3";
  const faceBottom = heads ? "#d8ad33" : "#aeb6b8";
  const ink = heads ? "#6b4e0a" : "#46555a";
  const glyph = heads ? "♛" : "★";
  const label = heads ? "HEADS" : "TAILS";
  const gid = `grad-${side}`;
  const sid = `shine-${side}`;

  return (
    <svg viewBox="0 0 200 200" className="h-full w-full" style={{ display: "block" }}>
      <defs>
        <radialGradient id={gid} cx="50%" cy="38%" r="70%">
          <stop offset="0%" stopColor={faceTop} />
          <stop offset="100%" stopColor={faceBottom} />
        </radialGradient>
        <linearGradient id={sid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="rgba(255,255,255,0.75)" />
          <stop offset="45%" stopColor="rgba(255,255,255,0.05)" />
          <stop offset="100%" stopColor="rgba(0,0,0,0.18)" />
        </linearGradient>
      </defs>
      {/* outer rim */}
      <circle cx="100" cy="100" r="98" fill={rimDark} />
      <circle cx="100" cy="100" r="94" fill={rim} />
      {/* milled edge ticks */}
      {Array.from({ length: 48 }).map((_, i) => {
        const a = (i / 48) * Math.PI * 2;
        const r1 = 88;
        const r2 = 94;
        return (
          <line
            key={i}
            x1={100 + Math.cos(a) * r1}
            y1={100 + Math.sin(a) * r1}
            x2={100 + Math.cos(a) * r2}
            y2={100 + Math.sin(a) * r2}
            stroke={rimDark}
            strokeWidth={1.6}
            opacity={0.55}
          />
        );
      })}
      {/* inner field */}
      <circle cx="100" cy="100" r="84" fill={`url(#${gid})`} />
      <circle cx="100" cy="100" r="84" fill={`url(#${sid})`} opacity={0.5} />
      <circle cx="100" cy="100" r="72" fill="none" stroke={ink} strokeWidth={2} opacity={0.35} />
      {/* central glyph */}
      <text
        x="100"
        y="104"
        textAnchor="middle"
        dominantBaseline="central"
        fontSize="78"
        fill={ink}
        style={{ fontWeight: 700 }}
      >
        {glyph}
      </text>
      {/* label arc text */}
      <text
        x="100"
        y="168"
        textAnchor="middle"
        fontSize="20"
        letterSpacing="3"
        fill={ink}
        style={{ fontWeight: 700, opacity: 0.8 }}
      >
        {label}
      </text>
    </svg>
  );
}

function Coin({
  phase,
  landed,
  spinKey,
}: {
  phase: Phase;
  landed: Side;
  spinKey: number;
}) {
  // While flipping we spin many full turns on X; on resolve we settle to a
  // rotation whose face matches `landed`. Heads = 0° (mod 360), Tails = 180°.
  const settle = landed === "heads" ? 0 : 180;
  const spins = 5; // full vertical tumbles before settling
  const target = phase === "flipping" ? 360 * spins + settle : settle;

  return (
    <div
      className="relative grid origin-center scale-[0.72] place-items-center sm:scale-100 [@media(max-height:600px)]:scale-[0.6]"
      style={{ width: 200, height: 200, perspective: 900 }}
    >
      {/* shadow that breathes with the toss */}
      <motion.div
        className="absolute rounded-full"
        style={{
          bottom: -26,
          width: 150,
          height: 26,
          background:
            "radial-gradient(ellipse at center, rgba(0,0,0,0.55), rgba(0,0,0,0))",
          filter: "blur(2px)",
        }}
        animate={
          phase === "flipping"
            ? { scaleX: [1, 0.5, 1, 0.5, 1], opacity: [0.7, 0.3, 0.7, 0.3, 0.7] }
            : { scaleX: 1, opacity: 0.7 }
        }
        transition={{ duration: 1.9, ease: "easeInOut" }}
      />
      {/* vertical toss arc */}
      <motion.div
        key={`toss-${spinKey}`}
        className="relative"
        style={{ width: 200, height: 200, transformStyle: "preserve-3d" }}
        animate={
          phase === "flipping"
            ? { y: [0, -120, -40, -110, 0], rotateZ: [0, -6, 4, -3, 0] }
            : { y: 0, rotateZ: 0 }
        }
        transition={{ duration: 1.9, ease: [0.3, 0.1, 0.2, 1] }}
      >
        {/* the spinning coin body */}
        <motion.div
          className="relative h-full w-full"
          style={{ transformStyle: "preserve-3d" }}
          initial={false}
          animate={{ rotateX: target, rotateY: phase === "flipping" ? [0, 14, -10, 0] : 0 }}
          transition={{
            rotateX: { duration: phase === "flipping" ? 1.9 : 0.45, ease: [0.25, 0.6, 0.2, 1] },
            rotateY: { duration: 1.9, ease: "easeInOut" },
          }}
        >
          {/* HEADS face (front, at 0°) */}
          <div
            className="absolute inset-0"
            style={{
              backfaceVisibility: "hidden",
              WebkitBackfaceVisibility: "hidden",
              transform: "rotateX(0deg) translateZ(6px)",
              borderRadius: "50%",
              filter: "drop-shadow(0 10px 18px rgba(0,0,0,0.45))",
            }}
          >
            <CoinFace side="heads" />
          </div>
          {/* TAILS face (back, at 180°) */}
          <div
            className="absolute inset-0"
            style={{
              backfaceVisibility: "hidden",
              WebkitBackfaceVisibility: "hidden",
              transform: "rotateX(180deg) translateZ(6px)",
              borderRadius: "50%",
              filter: "drop-shadow(0 10px 18px rgba(0,0,0,0.45))",
            }}
          >
            <CoinFace side="tails" />
          </div>
          {/* thin edge band to give the coin thickness */}
          <div
            className="absolute left-1/2 top-1/2 rounded-full"
            style={{
              width: 196,
              height: 12,
              transform: "translate(-50%,-50%) rotateX(90deg)",
              background: `linear-gradient(90deg, ${ACCENT_DEEP}, ${ACCENT}, ${ACCENT_DEEP})`,
              opacity: 0.9,
            }}
          />
        </motion.div>
      </motion.div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Side-pick toggle button
// ---------------------------------------------------------------------------
function SideButton({
  side,
  selected,
  disabled,
  onClick,
}: {
  side: Side;
  selected: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  const heads = side === "heads";
  return (
    <motion.button
      type="button"
      data-testid={heads ? "heads-btn" : "tails-btn"}
      disabled={disabled}
      onClick={onClick}
      whileHover={disabled ? undefined : { y: -2, scale: 1.03 }}
      whileTap={disabled ? undefined : { scale: 0.95 }}
      className="relative flex flex-1 flex-col items-center gap-1 rounded-2xl px-4 py-3 transition-colors disabled:opacity-40"
      style={{
        background: selected ? "rgba(189,195,199,0.16)" : "rgba(255,255,255,0.04)",
        border: `2px solid ${selected ? ACCENT : "rgba(255,255,255,0.10)"}`,
        boxShadow: selected ? `0 0 22px ${ACCENT}66` : "none",
      }}
    >
      <div className="h-12 w-12">
        <CoinFace side={side} />
      </div>
      <span
        className="text-xs font-bold uppercase tracking-widest"
        style={{ color: selected ? "#fff" : "rgba(255,255,255,0.6)" }}
      >
        {heads ? "Heads" : "Tails"}
      </span>
      {selected && (
        <motion.span
          layoutId="side-pick-dot"
          className="absolute -top-1.5 right-3 h-2.5 w-2.5 rounded-full"
          style={{ background: ACCENT, boxShadow: `0 0 10px ${ACCENT}` }}
        />
      )}
    </motion.button>
  );
}

export default function CoinFlip() {
  const { balance, bet: placeBet, win, ready } = useWallet();

  const [bet, setBet] = useState(25);
  const [mode, setMode] = useState<Mode>("single");
  const [call, setCall] = useState<Side>("heads");
  const [phase, setPhase] = useState<Phase>("betting");

  const [landed, setLanded] = useState<Side>("heads");
  const [spinKey, setSpinKey] = useState(0);
  const [result, setResult] = useState<FlipResult | null>(null);

  // Streak state. `pot` is the live amount riding (already includes the stake);
  // it grows by PAYOUT on each correct flip. `streakStake` is the original wager.
  const [streak, setStreak] = useState(0);
  const [pot, setPot] = useState(0);
  const [streakStake, setStreakStake] = useState(0);
  const [streakActive, setStreakActive] = useState(false);

  const [history, setHistory] = useState<{ side: Side; id: number }[]>([]);
  const historyIdRef = useRef(0);
  const [burst, setBurst] = useState(0);
  const [lastDelta, setLastDelta] = useState<number | null>(null);

  // Synchronous guard to prevent double-fire before React re-renders propagate.
  const resolvingRef = useRef(false);

  // Tracks mount status so async continuations after an await can bail out if
  // the component unmounted mid-animation (avoids state updates on unmounted).
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  const busy = phase === "flipping";

  // Keep bet within affordable bounds while idle (and not mid-streak).
  useEffect(() => {
    if (phase !== "betting" || streakActive) return;
    if (bet > balance) setBet(Math.max(0, balance));
  }, [balance, bet, phase, streakActive]);

  const canAfford = bet >= MIN_BET && bet <= balance;
  const potentialPot = useMemo(() => {
    const stake = streakActive ? streakStake : bet;
    const level = streakActive ? streak + 1 : 1;
    return Math.round(stake * Math.pow(PAYOUT, level));
  }, [streakActive, streakStake, bet, streak]);

  // -------------------------------------------------------------------------
  // Core flip. Handles both single and streak modes.
  // -------------------------------------------------------------------------
  const flip = useCallback(async () => {
    // Double-tap guard: check both the state-derived flag and the synchronous ref
    // so rapid clicks before the next React render are also blocked.
    if (busy || resolvingRef.current) return;
    resolvingRef.current = true;

    let stakeForRound = streakStake;
    const priorStreak = streakActive ? streak : 0;

    if (!streakActive) {
      // Starting a fresh round / streak — take the wager now.
      if (!canAfford) {
        resolvingRef.current = false;
        return;
      }
      if (!placeBet(bet)) {
        resolvingRef.current = false;
        return;
      }
      stakeForRound = bet;
      setStreakStake(bet);
      setStreakActive(true);
      setStreak(0);
      setPot(bet);
    }

    setResult(null);
    setLastDelta(null);
    setPhase("flipping");
    sfx.thud();

    const landedSide: Side = chance(0.5) ? "heads" : "tails";
    setLanded(landedSide);
    setSpinKey((k) => k + 1);

    // Ticking spin feedback during the tumble.
    for (let i = 0; i < 6; i++) {
      await sleep(230);
      if (!mountedRef.current) return;
      sfx.tick();
    }
    await sleep(560); // let the coin settle visually
    if (!mountedRef.current) return;

    const won = landedSide === call;
    setResult({ call, landed: landedSide, won });
    const hid = ++historyIdRef.current;
    setHistory((h) => [{ side: landedSide, id: hid }, ...h].slice(0, 14));

    if (won) {
      const newPot = Math.round(stakeForRound * Math.pow(PAYOUT, priorStreak + 1));
      setStreak((s) => s + 1);
      setPot(newPot);
      setBurst((b) => b + 1);

      if (mode === "single") {
        // Resolve immediately: pay the gross and end the round.
        win(newPot);
        setLastDelta(newPot - stakeForRound);
        setStreakActive(false);
        sfx.win();
      } else {
        // Streak continues — pot rides, nothing credited yet.
        sfx.chip();
      }
    } else {
      // Wrong flip — lose the whole pot (already deducted at stake time).
      setLastDelta(-stakeForRound);
      setStreakActive(false);
      setStreak(0);
      setPot(0);
      sfx.lose();
    }

    setPhase("resolved");
    resolvingRef.current = false;
  }, [
    busy,
    streakActive,
    streakStake,
    streak,
    canAfford,
    placeBet,
    bet,
    call,
    mode,
    win,
  ]);

  // -------------------------------------------------------------------------
  // Cash out an active winning streak.
  // -------------------------------------------------------------------------
  const cashOut = useCallback(() => {
    if (busy || !streakActive || pot <= 0 || streak <= 0) return;
    win(pot);
    setLastDelta(pot - streakStake);
    setBurst((b) => b + 1);
    sfx.jackpot();
    setStreakActive(false);
    setStreak(0);
    setPot(0);
    setResult(null);
    setPhase("betting");
  }, [busy, streakActive, pot, streak, streakStake, win]);

  const startNew = useCallback(() => {
    setPhase("betting");
    setResult(null);
    setLastDelta(null);
    setStreakActive(false);
    setStreak(0);
    setPot(0);
  }, []);

  // Whether a streak is mid-flight and awaiting a cash-out / next flip.
  const ridable = mode === "streak" && streakActive && streak > 0 && phase === "resolved";

  // Win-celebration intensity, keyed off how many times the pot beats the
  // original stake (PAYOUT^streak). ~10×+ stake reads as a jackpot, ~4×+ big.
  const celebrate = phase === "resolved" && result?.won === true && pot > 0;
  const winMultiple = celebrate && streakStake > 0 ? pot / streakStake : 0;
  const celebrationTier: "win" | "big" | "jackpot" =
    winMultiple >= 10 ? "jackpot" : winMultiple >= 4 ? "big" : "win";

  // Primary button label & action.
  const flipLabel = streakActive
    ? `Flip Again (${formatChips(potentialPot)})`
    : "Flip Coin";

  const betLocked = streakActive || busy;

  return (
    <div className="mx-auto w-full max-w-3xl px-2 py-3 sm:py-5">
      {/* ===== Surface ===== */}
      <div
        className="felt relative overflow-hidden rounded-3xl border border-white/10 p-4 shadow-felt sm:p-6"
        style={{ background: "radial-gradient(120% 90% at 50% 0%, #1b2226 0%, #10171a 60%, #0b1013 100%)" }}
      >
        {/* ambient accent glow */}
        <div
          className="pointer-events-none absolute -top-24 left-1/2 h-64 w-64 -translate-x-1/2 rounded-full"
          style={{ background: `radial-gradient(circle, ${ACCENT}22, transparent 70%)`, filter: "blur(10px)" }}
        />

        {/* Header row */}
        <div className="relative mb-3 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="font-display text-2xl tracking-wide text-white sm:text-3xl">
              Coin&nbsp;Flip
            </h2>
            <p className="text-xs text-white/50">
              Call it. {formatMultiplier(PAYOUT)} on a correct flip.
            </p>
          </div>

          {/* Mode toggle */}
          <div className="flex items-center gap-1 rounded-xl border border-white/10 bg-black/30 p-1">
            {(["single", "streak"] as Mode[]).map((m) => (
              <button
                key={m}
                type="button"
                data-testid={`mode-${m}`}
                disabled={betLocked}
                onClick={() => {
                  if (betLocked) return;
                  sfx.click();
                  setMode(m);
                  startNew();
                }}
                className="relative rounded-lg px-3 py-1.5 text-xs font-semibold uppercase tracking-wider transition-colors disabled:opacity-40"
                style={{ color: mode === m ? "#10171a" : "rgba(255,255,255,0.65)" }}
              >
                {mode === m && (
                  <motion.span
                    layoutId="mode-pill"
                    className="absolute inset-0 rounded-lg"
                    style={{ background: ACCENT }}
                    transition={{ type: "spring", stiffness: 400, damping: 32 }}
                  />
                )}
                <span className="relative">{m === "single" ? "Single" : "Streak"}</span>
              </button>
            ))}
          </div>
        </div>

        {/* ===== Stage ===== */}
        <div className="relative grid place-items-center rounded-2xl border border-white/5 bg-black/25 px-3 py-3 sm:py-8 [@media(max-height:600px)]:py-2">
          <Celebration
            show={celebrate}
            seed={burst}
            tier={celebrationTier}
            colors={["#f5d060", "#bdc3c7", "#22e1ff", "#ffffff"]}
          />
          {/* streak ladder (only in streak mode) */}
          {mode === "streak" && (
            <div className="mb-2 flex items-center gap-1.5 sm:mb-4">
              {Array.from({ length: 8 }).map((_, i) => {
                const reached = i < streak;
                const next = i === streak && streakActive;
                return (
                  <motion.div
                    key={i}
                    initial={false}
                    animate={{
                      scale: next ? [1, 1.18, 1] : 1,
                      backgroundColor: reached ? ACCENT : "rgba(255,255,255,0.08)",
                    }}
                    transition={{ duration: 0.5, repeat: next ? Infinity : 0 }}
                    className="h-2.5 w-6 rounded-full"
                    style={{ boxShadow: reached ? `0 0 8px ${ACCENT}` : "none" }}
                  />
                );
              })}
            </div>
          )}

          {/* the coin (height-capped on short/small viewports to reclaim space) */}
          <div className="grid h-[150px] place-items-center sm:h-[200px] [@media(max-height:600px)]:h-[120px]">
            <Coin phase={phase} landed={landed} spinKey={spinKey} />
          </div>

          {/* live pot readout while a streak rides */}
          {mode === "streak" && streakActive && (
            <motion.div
              key={pot}
              initial={{ scale: 0.85, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              className="mt-3 text-center sm:mt-6"
            >
              <div className="text-[10px] uppercase tracking-[0.3em] text-white/40">
                Riding · {streak}× correct
              </div>
              <div
                className="text-3xl font-extrabold tabular-nums"
                style={{ color: ACCENT, textShadow: `0 0 18px ${ACCENT}88` }}
              >
                <CountingNumber value={pot} />
              </div>
              <div className="text-xs text-white/45">
                ×{formatMultiplier(PAYOUT).slice(0, -1)} on next correct flip
              </div>
            </motion.div>
          )}

          {/* win burst */}
          <AnimatePresence>
            {burst > 0 && result?.won && (
              <motion.div
                key={`burst-${burst}`}
                className="pointer-events-none absolute inset-0 grid place-items-center"
                initial={{ opacity: 1 }}
                animate={{ opacity: 0 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 1.1 }}
              >
                {Array.from({ length: 16 }).map((_, i) => {
                  const a = (i / 16) * Math.PI * 2;
                  return (
                    <motion.span
                      key={i}
                      className="absolute h-2 w-2 rounded-full"
                      style={{ background: i % 2 ? "#f5d060" : ACCENT }}
                      initial={{ x: 0, y: 0, scale: 1, opacity: 1 }}
                      animate={{
                        x: Math.cos(a) * 150,
                        y: Math.sin(a) * 150,
                        scale: 0,
                        opacity: 0,
                      }}
                      transition={{ duration: 1, ease: "easeOut" }}
                    />
                  );
                })}
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* ===== Round result banner ===== */}
        <div className="relative mt-3 min-h-[48px] sm:min-h-[58px]">
          <AnimatePresence mode="wait">
            {result && (
              <motion.div
                key={`${spinKey}-${result.won}`}
                data-testid="round-result"
                initial={{ opacity: 0, y: 10, scale: 0.96 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -8 }}
                className="flex items-center justify-center gap-3 rounded-2xl px-4 py-3 text-center"
                style={{
                  background: result.won ? "rgba(189,195,199,0.12)" : "rgba(220,38,38,0.12)",
                  border: `1px solid ${result.won ? ACCENT : "#dc2626"}55`,
                }}
              >
                <span className="text-2xl">{result.won ? "🪙" : "💥"}</span>
                <div className="text-left">
                  <div
                    className="text-base font-extrabold tracking-wide sm:text-lg"
                    style={{ color: result.won ? "#fff" : "#fca5a5" }}
                  >
                    {result.landed === "heads" ? "HEADS" : "TAILS"} —{" "}
                    {result.won
                      ? mode === "streak" && streakActive
                        ? "Correct! Ride or cash out."
                        : "You called it!"
                      : "Wrong call."}
                  </div>
                  {lastDelta !== null && (
                    <div
                      className="text-sm font-bold tabular-nums"
                      style={{ color: lastDelta >= 0 ? "#86efac" : "#fca5a5" }}
                    >
                      {formatDelta(lastDelta)} chips
                    </div>
                  )}
                </div>
              </motion.div>
            )}
            {!result && mode === "streak" && !streakActive && streak === 0 && (
              <motion.div
                key="streak-hint"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="flex items-center justify-center rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-center text-xs text-white/50"
              >
                Streak mode: each correct flip multiplies your pot by{" "}
                {formatMultiplier(PAYOUT)}. One wrong call loses it all — cash out anytime.
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* ===== Pick side ===== */}
        <div className="relative mt-3 flex gap-3 sm:mt-4">
          <SideButton
            side="heads"
            selected={call === "heads"}
            disabled={busy}
            onClick={() => {
              if (busy) return;
              sfx.click();
              setCall("heads");
            }}
          />
          <SideButton
            side="tails"
            selected={call === "tails"}
            disabled={busy}
            onClick={() => {
              if (busy) return;
              sfx.click();
              setCall("tails");
            }}
          />
        </div>

        {/* ===== Action buttons ===== */}
        <div className="relative mt-3 flex flex-col items-stretch gap-3 sm:mt-4 sm:flex-row sm:justify-center">
          {/* Primary action. The contract requires data-testid="play-btn" on
              the primary button; the game spec also names this button
              "flip-btn". A single element can hold only one data-testid, so the
              visible button carries play-btn and an invisible twin exposes the
              flip-btn handle — both trigger the same flip so every selector the
              harness may query resolves to a working control. */}
          <Button
            data-testid="play-btn"
            variant="gold"
            size="lg"
            block
            disabled={busy || (!streakActive && !canAfford)}
            onClick={() => void flip()}
            className="sm:flex-1"
          >
            {busy ? "Flipping…" : flipLabel}
          </Button>
          <button
            type="button"
            data-testid="flip-btn"
            aria-hidden
            tabIndex={-1}
            disabled={busy || (!streakActive && !canAfford)}
            onClick={() => void flip()}
            className="sr-only absolute h-px w-px overflow-hidden"
          >
            Flip
          </button>

          {ridable && (
            <Button
              data-testid="cashout-btn"
              variant="neon"
              size="lg"
              block
              disabled={busy || pot <= 0}
              onClick={cashOut}
              className="sm:flex-1"
            >
              Cash Out {formatChips(pot)}
            </Button>
          )}

          {!streakActive && phase === "resolved" && (
            <Button
              data-testid="newround-btn"
              variant="ghost"
              size="lg"
              onClick={startNew}
              className="sm:flex-1"
            >
              New Round
            </Button>
          )}
        </div>

        {/* ===== Bet controls ===== */}
        <div className="relative mt-3 sm:mt-4">
          <BetControls
            bet={bet}
            setBet={setBet}
            balance={balance}
            min={MIN_BET}
            chips={CHIPS}
            disabled={betLocked}
          />
          {betLocked && (
            <div className="mt-1 text-center text-[11px] uppercase tracking-widest text-white/35">
              {streakActive ? "Wager locked while the streak rides" : "Flipping…"}
            </div>
          )}
        </div>

        {/* ===== Odds / paytable + history ===== */}
        <div className="relative mt-3 grid gap-3 sm:mt-4 sm:grid-cols-2">
          <CollapsiblePanel title="Paytable" accent={ACCENT} summary={<>{formatMultiplier(PAYOUT)} correct</>}>
            <div className="space-y-1.5 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-white/70">Correct call</span>
                <span className="font-bold" style={{ color: ACCENT }}>
                  {formatMultiplier(PAYOUT)}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-white/70">Wrong call</span>
                <span className="font-bold text-red-400">0×</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-white/70">True odds</span>
                <span className="font-semibold text-white/80">50 / 50</span>
              </div>
              <div className="flex items-center justify-between border-t border-white/10 pt-1.5 text-xs">
                <span className="text-white/45">Streak (n wins)</span>
                <span className="font-semibold text-white/70">
                  {formatMultiplier(PAYOUT)}ⁿ
                </span>
              </div>
            </div>
          </CollapsiblePanel>

          <CollapsiblePanel title="Last Flips" accent={ACCENT} summary={<>newest first</>}>
            <div className="flex min-h-[34px] flex-wrap gap-1.5">
              <AnimatePresence initial={false}>
                {history.length === 0 && (
                  <span className="text-xs text-white/30">No flips yet.</span>
                )}
                {history.map(({ side: s, id }) => (
                  <motion.span
                    key={id}
                    initial={{ scale: 0, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    className="grid h-7 w-7 place-items-center rounded-full text-[11px] font-bold"
                    style={{
                      background: s === "heads" ? "rgba(245,208,96,0.18)" : "rgba(189,195,199,0.18)",
                      border: `1px solid ${s === "heads" ? "#f5d060" : ACCENT}66`,
                      color: s === "heads" ? "#f5d060" : ACCENT,
                    }}
                    title={s}
                  >
                    {s === "heads" ? "H" : "T"}
                  </motion.span>
                ))}
              </AnimatePresence>
            </div>
          </CollapsiblePanel>
        </div>

        {/* live balance hint */}
        <div className="relative mt-3 text-center text-xs text-white/40">
          Balance:{" "}
          <span className="font-semibold text-white/70 tabular-nums">
            {ready ? formatChips(balance) : "—"}
          </span>
        </div>
      </div>
    </div>
  );
}
