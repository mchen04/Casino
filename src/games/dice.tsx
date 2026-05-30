"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useWallet } from "@/lib/wallet";
import { randFloat, clamp } from "@/lib/rng";
import { formatChips, formatDelta, formatMultiplier } from "@/lib/format";
import { sfx } from "@/lib/sound";
import { Button } from "@/components/ui/Button";
import { BetControls } from "@/components/BetControls";
import { CountingNumber } from "@/components/CountingNumber";
import { sleep } from "@/lib/async";
import { HOUSE_EDGE, payoutForChance } from "@/lib/cryptoGames";
import { CollapsiblePanel } from "@/components/CollapsiblePanel";
import { Celebration } from "@/components/Celebration";

// ---------------------------------------------------------------------------
// Dice — modern crypto-casino "over / under" game.
//
//   * A roll produces a number in [0.00, 99.99] via randFloat(0, 100).
//   * The player picks a TARGET (0.01 .. 99.99) with the big slider and chooses
//     ROLL OVER or ROLL UNDER.
//   * Win chance:
//       roll OVER  → (100 - target) / 100
//       roll UNDER → target / 100
//   * Payout multiplier = 99 / winChancePercent  (≈ 1% house edge, since a
//     fair multiplier would be 100 / winChancePercent).
//   * Win  → win(stake * multiplier)   (multiplier already includes the stake)
//     Loss → credit nothing.
//
// All money flows exclusively through useWallet(). The roll itself is a single
// uniform draw; the house edge lives entirely in the < fair payout.
// ---------------------------------------------------------------------------

const ACCENT = "#22e1ff";
const ACCENT_DEEP = "#0e7490";
const WIN_GREEN = "#86efac";
const LOSE_RED = "#fca5a5";

const MIN_BET = 5;
const CHIPS = [5, 25, 100, 500, 1000];

// Target bounds. Keep at least one valid outcome on each side so a win/loss is
// always physically possible and the payout never blows up to infinity.
const MIN_TARGET = 2;
const MAX_TARGET = 98;

type Mode = "over" | "under";
type Phase = "idle" | "rolling" | "resolved";

interface RollResult {
  roll: number; // 0.00 .. 99.99
  target: number;
  mode: Mode;
  won: boolean;
  multiplier: number;
  delta: number; // net chips (+profit / -stake)
}

/** Win probability (0..1) for a given target + mode. */
function winChance(target: number, mode: Mode): number {
  const t = clamp(target, 0, 100);
  return mode === "over" ? (100 - t) / 100 : t / 100;
}

/** Payout multiplier (includes stake) with the house edge baked in. */
function payoutFor(target: number, mode: Mode): number {
  return payoutForChance(winChance(target, mode));
}

// ---------------------------------------------------------------------------
// A single live-stat tile.
// ---------------------------------------------------------------------------
function StatTile({
  label,
  children,
  accent = false,
  testid,
}: {
  label: string;
  children: React.ReactNode;
  accent?: boolean;
  testid?: string;
}) {
  return (
    <div
      data-testid={testid}
      className="flex flex-col items-center justify-center rounded-2xl border bg-black/30 px-2 py-2.5 text-center"
      style={{ borderColor: accent ? `${ACCENT}55` : "rgba(255,255,255,0.08)" }}
    >
      <div className="text-[9px] uppercase tracking-[0.2em] text-white/40 sm:text-[10px]">
        {label}
      </div>
      <div
        className="mt-0.5 text-lg font-extrabold tabular-nums leading-none sm:text-xl"
        style={{ color: accent ? ACCENT : "#fff" }}
      >
        {children}
      </div>
    </div>
  );
}

export default function Dice() {
  const { balance, bet: placeBet, win, ready } = useWallet();

  const [bet, setBet] = useState(50);
  const [target, setTarget] = useState(50);
  const [mode, setMode] = useState<Mode>("over");
  const [phase, setPhase] = useState<Phase>("idle");

  // The committed roll values (set when a roll resolves). `rollValue` is what the
  // marker on the track animates toward.
  const [rollValue, setRollValue] = useState<number | null>(null);
  const [result, setResult] = useState<RollResult | null>(null);
  const [rollKey, setRollKey] = useState(0);

  const [history, setHistory] = useState<RollResult[]>([]);
  const [burst, setBurst] = useState(0);

  // Track mount state so async roll() won't setState after unmount.
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  const busy = phase === "rolling";
  const betLocked = busy;

  // Keep bet affordable while idle.
  useEffect(() => {
    if (busy) return;
    if (bet > balance) setBet(Math.max(0, balance));
  }, [balance, bet, busy]);

  const chancePct = useMemo(() => winChance(target, mode) * 100, [target, mode]);
  const multiplier = useMemo(() => payoutFor(target, mode), [target, mode]);
  const profitOnWin = useMemo(
    () => Math.max(0, bet * multiplier - bet),
    [bet, multiplier],
  );

  const canAfford = ready && bet >= MIN_BET && bet <= balance && balance > 0;

  // -------------------------------------------------------------------------
  // Core roll.
  // -------------------------------------------------------------------------
  const roll = useCallback(async () => {
    if (busy) return;
    if (!canAfford) return;

    // Snapshot the wager terms before deducting.
    const stake = bet;
    const t = target;
    const m = mode;
    const mult = payoutFor(t, m);

    if (!placeBet(stake)) return; // unaffordable → abort

    setResult(null);
    setPhase("rolling");
    setRollKey((k) => k + 1);
    sfx.thud();

    // Anticipation: skitter the marker across the track with quick ticks while
    // the "physics" settle. We show transient random values then lock the real one.
    const ticks = 11;
    for (let i = 0; i < ticks; i++) {
      if (!isMountedRef.current) return;
      setRollValue(randFloat(0, 100));
      sfx.tick();
      // ease the tick cadence: fast → slow
      const delay = 55 + i * 16;
      await sleep(delay);
    }

    if (!isMountedRef.current) return;

    // The real, committed outcome.
    const final = randFloat(0, 100);
    setRollValue(final);
    await sleep(560); // let the marker glide & settle

    if (!isMountedRef.current) return;

    const won = m === "over" ? final > t : final < t;
    const gross = won ? stake * mult : 0;
    const delta = won ? gross - stake : -stake;

    const res: RollResult = {
      roll: final,
      target: t,
      mode: m,
      won,
      multiplier: mult,
      delta,
    };
    setResult(res);
    setHistory((h) => [res, ...h].slice(0, 16));

    if (won) {
      win(gross);
      setBurst((b) => b + 1);
      if (mult >= 8) sfx.jackpot();
      else sfx.win();
    } else {
      sfx.lose();
    }

    setPhase("resolved");
  }, [busy, canAfford, bet, target, mode, placeBet, win]);

  const newRound = useCallback(() => {
    setPhase("idle");
    setResult(null);
  }, []);

  // The marker position 0..100 mapped onto the track. While idle we sit at 50
  // (center) for a clean default; once rolling/resolved we track rollValue.
  const markerPos =
    rollValue !== null && phase !== "idle" ? clamp(rollValue, 0, 100) : null;

  // Slider visuals: the winning region is the side the player bet on.
  const targetPct = target; // target is already 0..100
  const winRegion =
    mode === "over"
      ? { left: targetPct, width: 100 - targetPct }
      : { left: 0, width: targetPct };

  // Live current displayed roll number above the track.
  const liveRoll = markerPos ?? (result ? result.roll : null);

  return (
    <div className="mx-auto w-full max-w-3xl px-2 py-2 sm:py-5">
      <div
        className="felt relative overflow-hidden rounded-3xl border border-white/10 p-3 shadow-felt sm:p-6"
        style={{
          background:
            "radial-gradient(120% 90% at 50% 0%, #102129 0%, #0a151a 60%, #07101400 100%), #07100f",
        }}
      >
        {/* ambient accent glow */}
        <div
          className="pointer-events-none absolute -top-24 left-1/2 h-64 w-72 -translate-x-1/2 rounded-full"
          style={{
            background: `radial-gradient(circle, ${ACCENT}22, transparent 70%)`,
            filter: "blur(10px)",
          }}
        />

        {/* win celebration overlay (confetti + coin fountain) */}
        <Celebration
          show={!busy && result !== null && result.won && result.delta > 0}
          seed={result ? result.delta : 0}
          tier={
            result && result.multiplier >= 10
              ? "jackpot"
              : result && result.multiplier >= 3
                ? "big"
                : "win"
          }
          colors={["#22e1ff", "#ffd24a", "#8aff80", "#ffffff"]}
        />

        {/* ===== Header ===== */}
        <div className="relative mb-3 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="font-display text-2xl tracking-wide text-white sm:text-3xl">
              Dice
            </h2>
            <p className="text-xs text-white/50">
              Set your target. Roll {mode === "over" ? "over" : "under"} to win.
            </p>
          </div>

          {/* Over / Under toggle */}
          <div className="flex items-center gap-1 rounded-xl border border-white/10 bg-black/30 p-1">
            {(["under", "over"] as Mode[]).map((m) => {
              const selected = mode === m;
              return (
                <button
                  key={m}
                  type="button"
                  data-testid={`mode-${m}`}
                  disabled={busy}
                  onClick={() => {
                    if (busy) return;
                    sfx.click();
                    setMode(m);
                  }}
                  className="relative rounded-lg px-3 py-1.5 text-xs font-bold uppercase tracking-wider transition-colors disabled:opacity-40"
                  style={{ color: selected ? "#06141a" : "rgba(255,255,255,0.65)" }}
                >
                  {selected && (
                    <motion.span
                      layoutId="mode-pill"
                      className="absolute inset-0 rounded-lg"
                      style={{ background: ACCENT }}
                      transition={{ type: "spring", stiffness: 400, damping: 32 }}
                    />
                  )}
                  <span className="relative">
                    {m === "over" ? "Roll Over ▲" : "Roll Under ▼"}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* ===== Stage: the big result number + 0-100 track ===== */}
        <div className="relative rounded-2xl border border-white/5 bg-black/25 px-4 py-4 sm:px-7 sm:py-9 [@media(max-height:600px)]:py-3">
          {/* Big live result number */}
          <div className="relative mb-4 grid place-items-center sm:mb-7 [@media(max-height:600px)]:mb-2">
            <AnimatePresence mode="wait">
              <motion.div
                key={
                  phase === "idle"
                    ? "idle"
                    : `${rollKey}-${result ? (result.won ? "w" : "l") : "live"}`
                }
                initial={{ scale: 0.8, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ type: "spring", stiffness: 260, damping: 20 }}
                className="text-center"
              >
                <div className="text-[10px] uppercase tracking-[0.35em] text-white/40">
                  {phase === "idle"
                    ? "Roll Result"
                    : busy
                      ? "Rolling…"
                      : result?.won
                        ? "Winner"
                        : "Result"}
                </div>
                <motion.div
                  key={result ? `r-${rollKey}` : "live"}
                  animate={
                    result?.won && !busy
                      ? { scale: [1, 1.12, 1] }
                      : { scale: 1 }
                  }
                  transition={{ duration: 0.5 }}
                  className="font-display text-5xl font-black tabular-nums sm:text-7xl [@media(max-height:600px)]:text-4xl"
                  style={{
                    color:
                      liveRoll === null
                        ? "#fff"
                        : busy
                          ? "#fff"
                          : result
                            ? result.won
                              ? WIN_GREEN
                              : LOSE_RED
                            : "#fff",
                    textShadow:
                      result && !busy
                        ? result.won
                          ? `0 0 28px ${ACCENT}99, 0 0 12px ${WIN_GREEN}77`
                          : "0 0 18px rgba(220,38,38,0.5)"
                        : `0 0 22px ${ACCENT}55`,
                  }}
                >
                  {liveRoll === null ? (
                    "00.00"
                  ) : busy ? (
                    // raw skittering value while rolling (no smoothing — it jitters)
                    liveRoll.toFixed(2)
                  ) : (
                    <CountingNumber
                      value={result ? result.roll : liveRoll}
                      decimals={2}
                      duration={900}
                    />
                  )}
                </motion.div>
              </motion.div>
            </AnimatePresence>

            {/* radial win burst */}
            <AnimatePresence>
              {burst > 0 && result?.won && !busy && (
                <motion.div
                  key={`burst-${burst}`}
                  className="pointer-events-none absolute inset-0 grid place-items-center"
                  initial={{ opacity: 1 }}
                  animate={{ opacity: 0 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 1.2 }}
                >
                  {Array.from({ length: 18 }).map((_, i) => {
                    const a = (i / 18) * Math.PI * 2;
                    const dist = 120 + (i % 3) * 30;
                    return (
                      <motion.span
                        key={i}
                        className="absolute h-2 w-2 rounded-full"
                        style={{ background: i % 2 ? ACCENT : "#f5d060" }}
                        initial={{ x: 0, y: 0, scale: 1, opacity: 1 }}
                        animate={{
                          x: Math.cos(a) * dist,
                          y: Math.sin(a) * dist,
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

          {/* ===== The 0-100 track ===== */}
          <div className="relative px-1 pt-6 pb-2 sm:px-2 [@media(max-height:600px)]:pt-4">
            {/* numeric scale */}
            <div className="mb-2 flex justify-between text-[10px] font-semibold text-white/30">
              {[0, 25, 50, 75, 100].map((n) => (
                <span key={n}>{n}</span>
              ))}
            </div>

            {/* track bar */}
            <div className="relative h-3.5 w-full rounded-full bg-white/8">
              {/* lose region tint (full bar base) */}
              <div className="absolute inset-0 rounded-full bg-gradient-to-r from-red-500/15 to-red-500/15" />
              {/* win region */}
              <motion.div
                className="absolute inset-y-0 rounded-full"
                style={{
                  background: `linear-gradient(90deg, ${ACCENT_DEEP}, ${ACCENT})`,
                  boxShadow: `0 0 14px ${ACCENT}66`,
                }}
                animate={{
                  left: `${winRegion.left}%`,
                  width: `${winRegion.width}%`,
                }}
                transition={{ type: "spring", stiffness: 320, damping: 34 }}
              />

              {/* target divider line */}
              <motion.div
                className="absolute top-1/2 z-20 -translate-y-1/2"
                animate={{ left: `${targetPct}%` }}
                transition={{ type: "spring", stiffness: 320, damping: 34 }}
                style={{ x: "-50%" }}
              >
                <div
                  className="h-7 w-1 rounded-full"
                  style={{ background: "#fff", boxShadow: `0 0 8px ${ACCENT}` }}
                />
                <div className="absolute -top-7 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-md bg-white px-1.5 py-0.5 text-[10px] font-bold tabular-nums text-ink">
                  {target.toFixed(0)}
                </div>
              </motion.div>

              {/* the rolling marker */}
              <AnimatePresence>
                {markerPos !== null && (
                  <motion.div
                    className="absolute top-1/2 z-30"
                    initial={{ scale: 0, opacity: 0 }}
                    animate={{
                      left: `${markerPos}%`,
                      scale: 1,
                      opacity: 1,
                    }}
                    exit={{ scale: 0, opacity: 0 }}
                    transition={
                      busy
                        ? { left: { duration: 0.06 }, scale: { duration: 0.2 } }
                        : {
                            left: { type: "spring", stiffness: 90, damping: 14 },
                            scale: { duration: 0.2 },
                          }
                    }
                    style={{ x: "-50%", y: "-50%" }}
                  >
                    <motion.div
                      className="grid h-9 w-9 place-items-center rounded-full text-base"
                      animate={busy ? { rotate: 360 } : { rotate: 0 }}
                      transition={
                        busy
                          ? { repeat: Infinity, duration: 0.4, ease: "linear" }
                          : { duration: 0.4 }
                      }
                      style={{
                        background:
                          result && !busy
                            ? result.won
                              ? `radial-gradient(circle at 40% 35%, #d2ffe2, ${WIN_GREEN})`
                              : "radial-gradient(circle at 40% 35%, #ffd2d2, #ef4444)"
                            : `radial-gradient(circle at 40% 35%, #d7fbff, ${ACCENT})`,
                        boxShadow:
                          result && !busy
                            ? result.won
                              ? `0 0 16px ${WIN_GREEN}, 0 4px 8px rgba(0,0,0,0.5)`
                              : "0 0 16px #ef4444, 0 4px 8px rgba(0,0,0,0.5)"
                            : `0 0 16px ${ACCENT}, 0 4px 8px rgba(0,0,0,0.5)`,
                      }}
                    >
                      🎲
                    </motion.div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            {/* ===== Target slider (the big control) ===== */}
            <div className="relative mt-4 sm:mt-5">
              <input
                type="range"
                data-testid="target-slider"
                min={MIN_TARGET}
                max={MAX_TARGET}
                step={1}
                value={target}
                disabled={busy}
                onChange={(e) => {
                  const v = clamp(Number(e.target.value), MIN_TARGET, MAX_TARGET);
                  setTarget(v);
                  sfx.tick();
                }}
                aria-label="Target"
                className="dice-slider w-full"
                style={{
                  accentColor: ACCENT,
                }}
              />
              <div className="mt-1 flex items-center justify-between text-[10px] uppercase tracking-widest text-white/35">
                <span>Lower target</span>
                <span className="text-white/55">
                  Target&nbsp;
                  <span className="font-bold tabular-nums" style={{ color: ACCENT }}>
                    {target.toFixed(0)}
                  </span>
                </span>
                <span>Higher target</span>
              </div>
            </div>
          </div>
        </div>

        {/* ===== Live stats row ===== */}
        <div className="relative mt-3 grid grid-cols-3 gap-2 sm:mt-4 sm:gap-3">
          <StatTile label="Multiplier" accent testid="stat-multiplier">
            {formatMultiplier(multiplier)}
          </StatTile>
          <StatTile label="Win Chance" testid="stat-chance">
            {chancePct.toFixed(2)}
            <span className="text-sm text-white/50">%</span>
          </StatTile>
          <StatTile label="Profit on Win" testid="stat-profit">
            <span style={{ color: WIN_GREEN }}>
              +<CountingNumber value={profitOnWin} />
            </span>
          </StatTile>
        </div>

        {/* ===== Round result banner ===== */}
        <div className="relative mt-3 min-h-[60px] sm:mt-4 [@media(max-height:600px)]:min-h-[48px]">
          <AnimatePresence mode="wait">
            {result && !busy ? (
              <motion.div
                key={`res-${rollKey}`}
                data-testid="round-result"
                initial={{ opacity: 0, y: 10, scale: 0.96 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -8 }}
                className="flex items-center justify-center gap-3 rounded-2xl px-4 py-3 text-center"
                style={{
                  background: result.won
                    ? `${ACCENT}1f`
                    : "rgba(220,38,38,0.12)",
                  border: `1px solid ${result.won ? ACCENT : "#dc2626"}55`,
                }}
              >
                <span className="text-2xl">{result.won ? "🎉" : "💥"}</span>
                <div className="text-left">
                  <div
                    className="text-base font-extrabold tracking-wide sm:text-lg"
                    style={{ color: result.won ? "#fff" : LOSE_RED }}
                  >
                    Rolled {result.roll.toFixed(2)} —{" "}
                    {result.won
                      ? `Win ${formatMultiplier(result.multiplier)}!`
                      : "No win."}
                  </div>
                  <div className="text-xs text-white/55">
                    Needed {result.mode === "over" ? "over" : "under"}{" "}
                    {result.target.toFixed(0)} ·{" "}
                    <span
                      className="font-bold tabular-nums"
                      style={{ color: result.delta >= 0 ? WIN_GREEN : LOSE_RED }}
                    >
                      {formatDelta(result.delta)} chips
                    </span>
                  </div>
                </div>
              </motion.div>
            ) : (
              <motion.div
                key="hint"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="flex items-center justify-center rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-center text-xs text-white/45"
              >
                {busy
                  ? "Rolling the dice…"
                  : `Win if the roll is ${mode === "over" ? "above" : "below"} ${target.toFixed(0)} — paying ${formatMultiplier(multiplier)}.`}
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* ===== Action buttons ===== */}
        <div className="relative mt-3 flex flex-col items-stretch gap-3 sm:mt-4 sm:flex-row sm:justify-center">
          <Button
            data-testid="play-btn"
            variant="neon"
            size="lg"
            block
            disabled={busy || !canAfford}
            onClick={() => void roll()}
            className="play-btn sm:flex-[2]"
          >
            {busy ? "Rolling…" : `Roll Dice · ${formatChips(bet)}`}
          </Button>

          {phase === "resolved" && (
            <Button
              data-testid="newround-btn"
              variant="ghost"
              size="lg"
              onClick={newRound}
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
              Wager locked while rolling…
            </div>
          )}
        </div>

        {/* ===== Odds / paytable + history ===== */}
        <div className="relative mt-3 grid gap-3 sm:mt-4 sm:grid-cols-2">
          {/* Odds panel — quick target presets with their multipliers */}
          <CollapsiblePanel
            title={`Odds · ${mode === "over" ? "Roll Over" : "Roll Under"}`}
            accent={ACCENT}
            summary={<>{formatMultiplier(multiplier)} now</>}
          >
            <div className="space-y-1.5 text-sm">
              {[10, 25, 50, 75, 90].map((preset) => {
                const c = winChance(preset, mode) * 100;
                const m = payoutFor(preset, mode);
                const active = target === preset;
                return (
                  <button
                    key={preset}
                    type="button"
                    data-testid={`preset-${preset}`}
                    disabled={busy}
                    onClick={() => {
                      if (busy) return;
                      sfx.click();
                      setTarget(preset);
                    }}
                    className="flex w-full items-center justify-between rounded-lg px-2 py-1 text-left transition-colors disabled:opacity-40"
                    style={{
                      background: active ? `${ACCENT}1f` : "transparent",
                    }}
                  >
                    <span className="text-white/70">
                      Target {preset}{" "}
                      <span className="text-white/35">({c.toFixed(1)}%)</span>
                    </span>
                    <span className="font-bold" style={{ color: ACCENT }}>
                      {formatMultiplier(m)}
                    </span>
                  </button>
                );
              })}
              <div className="flex items-center justify-between border-t border-white/10 pt-1.5 text-xs">
                <span className="text-white/45">House edge</span>
                <span className="font-semibold text-white/70">
                  {(HOUSE_EDGE * 100).toFixed(0)}%
                </span>
              </div>
            </div>
          </CollapsiblePanel>

          {/* History */}
          <CollapsiblePanel
            title="Recent Rolls"
            accent={ACCENT}
            summary={
              history.length === 0 ? "none yet" : `${history.length} roll${history.length === 1 ? "" : "s"}`
            }
          >
            <div className="flex min-h-[34px] flex-wrap gap-1.5">
              <AnimatePresence initial={false}>
                {history.length === 0 && (
                  <span className="text-xs text-white/30">No rolls yet.</span>
                )}
                {history.map((h, i) => (
                  <motion.span
                    key={`${rollKey}-${i}-${h.roll.toFixed(2)}`}
                    initial={{ scale: 0, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    exit={{ scale: 0, opacity: 0 }}
                    className="grid h-8 min-w-[44px] place-items-center rounded-lg px-1.5 text-[11px] font-bold tabular-nums"
                    style={{
                      background: h.won ? `${ACCENT}22` : "rgba(220,38,38,0.16)",
                      border: `1px solid ${h.won ? ACCENT : "#dc2626"}55`,
                      color: h.won ? ACCENT : LOSE_RED,
                    }}
                    title={`${h.roll.toFixed(2)} · ${h.mode} ${h.target.toFixed(0)} · ${
                      h.won ? "won" : "lost"
                    }`}
                  >
                    {h.roll.toFixed(2)}
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
            {ready ? <CountingNumber value={balance} /> : "—"}
          </span>
        </div>
      </div>

      {/* Slider chrome — plain <style> (no styled-jsx dep) for the range input. */}
      <style
        dangerouslySetInnerHTML={{
          __html: `
        .dice-slider {
          -webkit-appearance: none;
          appearance: none;
          height: 10px;
          border-radius: 9999px;
          background: linear-gradient(90deg, rgba(255,255,255,0.08), rgba(255,255,255,0.16));
          outline: none;
          cursor: pointer;
        }
        .dice-slider:disabled { opacity: 0.5; cursor: not-allowed; }
        .dice-slider::-webkit-slider-thumb {
          -webkit-appearance: none;
          appearance: none;
          width: 26px;
          height: 26px;
          border-radius: 50%;
          background: radial-gradient(circle at 38% 32%, #d7fbff, ${ACCENT});
          border: 2px solid #ffffff;
          box-shadow: 0 0 14px ${ACCENT}, 0 2px 6px rgba(0,0,0,0.6);
          cursor: pointer;
          transition: transform 0.1s ease;
          margin-top: -8px;
        }
        .dice-slider::-webkit-slider-thumb:hover { transform: scale(1.12); }
        .dice-slider::-webkit-slider-runnable-track {
          height: 10px;
          border-radius: 9999px;
          background: transparent;
        }
        .dice-slider::-moz-range-thumb {
          width: 26px;
          height: 26px;
          border-radius: 50%;
          background: radial-gradient(circle at 38% 32%, #d7fbff, ${ACCENT});
          border: 2px solid #ffffff;
          box-shadow: 0 0 14px ${ACCENT}, 0 2px 6px rgba(0,0,0,0.6);
          cursor: pointer;
        }
        .dice-slider::-moz-range-track {
          height: 10px;
          border-radius: 9999px;
          background: rgba(255,255,255,0.12);
        }
      `,
        }}
      />
    </div>
  );
}
