"use client";

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useWallet } from "@/lib/wallet";
import { randFloat, clamp } from "@/lib/rng";
import { formatChips, formatDelta, formatMultiplier } from "@/lib/format";
import { sfx } from "@/lib/sound";
import { Button } from "@/components/ui/Button";
import { BetControls } from "@/components/BetControls";

// ---------------------------------------------------------------------------
// Limbo — pick a TARGET multiplier, watch the LIMBO BAR fly.
//
// Each round draws a result multiplier from a crash-style distribution with a
// small house edge:
//
//   result = max(1.00, (1 - EDGE) / (1 - random))   ,  random ∈ [0, 1)
//
// If result >= target the player WINS and is paid win(stake * target) — the
// target multiplier already includes the returned stake (a 2.00× target
// returns double the wager). If result < target the wager is lost and nothing
// is credited.
//
// Fair win chance for a given target is  (1 - EDGE) / target  → shown live as a
// percentage. The house edge (~1%) lives entirely in the distribution; payouts
// are exactly the chosen target.
//
// All money flows through useWallet(): bet() deducts the stake up front, win()
// credits the gross on a win, nothing is credited on a loss.
// ---------------------------------------------------------------------------

const ACCENT = "#8aff80";
const ACCENT_DEEP = "#3fbf4f";
const LOSE = "#ff5d6c";
const EDGE = 0.01;
const MIN_TARGET = 1.01;
const MAX_TARGET = 1_000_000; // sane upper bound on the input
const MIN_BET = 5;
const CHIPS = [5, 25, 100, 500, 1000];

type Phase = "betting" | "rolling" | "resolved";

interface RoundResult {
  target: number;
  result: number;
  won: boolean;
  delta: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Draw a crash-style result multiplier with house edge folded in.
function rollResult(): number {
  // random ∈ [0, 1); guard the asymptote near 1 so the value stays finite.
  const r = clamp(randFloat(0, 1), 0, 0.999999);
  const raw = (1 - EDGE) / (1 - r);
  return Math.max(1, Math.floor(raw * 100) / 100);
}

// Win probability for a target, expressed as a fraction in [0, 1].
function winChance(target: number): number {
  if (target <= 0) return 0;
  return Math.min(1, (1 - EDGE) / target);
}

// ---------------------------------------------------------------------------
// Big multiplier readout. While rolling it ramps UP from 1.00 on an eased,
// accelerating curve and snaps to the final result. On resolve it locks to the
// result value, glowing green (win) or red (loss).
// ---------------------------------------------------------------------------
function MultiplierDisplay({
  value,
  phase,
  outcome,
  rollKey,
}: {
  value: number; // final result for this roll
  phase: Phase;
  outcome: "win" | "lose" | null;
  rollKey: number;
}) {
  // Initialise from phase so a remount (the key includes `outcome`) lands on
  // the correct value with no 1-frame flash back to 1.00×.
  const [display, setDisplay] = useState(() =>
    phase === "rolling" || phase === "betting" ? 1 : value,
  );
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (phase !== "rolling") return;
    const target = value;
    const start = performance.now();
    // Longer climbs for higher results so the count-up reads as "rapid but
    // dramatic" no matter the scale.
    const dur = clamp(650 + Math.log10(Math.max(1, target)) * 520, 650, 2400);
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / dur);
      // Ease-in (slow start, accelerating) so the number rips upward.
      const eased = Math.pow(t, 2.2);
      const v = 1 + (target - 1) * eased;
      setDisplay(v);
      if (t < 1) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        setDisplay(target);
      }
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
    // rollKey forces a fresh climb on each round even if value repeats.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rollKey, phase, value]);

  // When resolved, pin the exact result.
  useEffect(() => {
    if (phase === "resolved") setDisplay(value);
    if (phase === "betting") setDisplay(1);
  }, [phase, value]);

  const color =
    outcome === "win" ? ACCENT : outcome === "lose" ? LOSE : "#ffffff";
  const glow =
    outcome === "win"
      ? `0 0 38px ${ACCENT}cc, 0 0 14px ${ACCENT}`
      : outcome === "lose"
      ? `0 0 38px ${LOSE}aa, 0 0 14px ${LOSE}`
      : "0 0 22px rgba(255,255,255,0.25)";

  return (
    <motion.div
      key={`mult-${rollKey}-${outcome ?? "idle"}`}
      className="relative font-display tabular-nums"
      initial={false}
      animate={
        outcome
          ? { scale: [1, 1.16, 1] }
          : phase === "rolling"
          ? { scale: [1, 1.03, 1] }
          : { scale: 1 }
      }
      transition={
        outcome
          ? { duration: 0.5, ease: "easeOut" }
          : { duration: 0.4, repeat: phase === "rolling" ? Infinity : 0 }
      }
      style={{
        color,
        textShadow: glow,
        fontSize: "clamp(3rem, 14vw, 6.5rem)",
        lineHeight: 1,
        fontWeight: 800,
        letterSpacing: "-0.02em",
      }}
    >
      {formatMultiplier(display)}
    </motion.div>
  );
}

// ---------------------------------------------------------------------------
// Animated chip counter for balance-style numbers.
// ---------------------------------------------------------------------------
function ChipCounter({ value }: { value: number }) {
  const [display, setDisplay] = useState(value);
  const fromRef = useRef(value);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    const from = fromRef.current;
    const to = value;
    if (from === to) return;
    const start = performance.now();
    const dur = 550;
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / dur);
      const eased = 1 - Math.pow(1 - t, 3);
      setDisplay(Math.round(from + (to - from) * eased));
      if (t < 1) rafRef.current = requestAnimationFrame(step);
      else fromRef.current = to;
    };
    rafRef.current = requestAnimationFrame(step);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      fromRef.current = to;
    };
  }, [value]);

  return <span className="tabular-nums">{formatChips(display)}</span>;
}

export default function Limbo() {
  const { balance, bet: placeBet, win, ready } = useWallet();

  const [bet, setBet] = useState(25);
  const [target, setTarget] = useState(2);
  const [targetText, setTargetText] = useState("2.00");
  const [focused, setFocused] = useState(false);
  const [phase, setPhase] = useState<Phase>("betting");

  const [resultValue, setResultValue] = useState(1);
  const [rollKey, setRollKey] = useState(0);
  const [round, setRound] = useState<RoundResult | null>(null);
  const [burst, setBurst] = useState(0);
  const [history, setHistory] = useState<RoundResult[]>([]);

  const busy = phase === "rolling";
  const betLocked = busy;

  // Keep bet affordable while idle.
  useEffect(() => {
    if (phase !== "betting") return;
    if (bet > balance) setBet(Math.max(0, balance));
  }, [balance, bet, phase]);

  const canAfford = bet >= MIN_BET && bet <= balance;

  // Derived odds for the current target.
  const chanceFrac = useMemo(() => winChance(target), [target]);
  const chancePct = chanceFrac * 100;
  const potentialReturn = Math.floor(bet * target);
  const potentialProfit = potentialReturn - bet;

  const outcome: "win" | "lose" | null =
    phase === "resolved" && round ? (round.won ? "win" : "lose") : null;

  // -------------------------------------------------------------------------
  // Target editing helpers. Target is committed live; clamp on commit.
  // -------------------------------------------------------------------------
  const commitTarget = useCallback((raw: number) => {
    const clamped = clamp(
      Math.round(raw * 100) / 100,
      MIN_TARGET,
      MAX_TARGET,
    );
    setTarget(clamped);
    setTargetText(clamped.toFixed(2));
  }, []);

  const adjustTarget = useCallback(
    (delta: number) => {
      if (busy) return;
      sfx.click();
      commitTarget(target + delta);
    },
    [busy, target, commitTarget],
  );

  const onTargetInput = useCallback(
    (text: string) => {
      if (busy) return;
      // Allow free typing; only digits & one dot.
      const cleaned = text.replace(/[^0-9.]/g, "");
      setTargetText(cleaned);
      const parsed = parseFloat(cleaned);
      if (Number.isFinite(parsed) && parsed > 0) {
        setTarget(clamp(parsed, MIN_TARGET, MAX_TARGET));
      }
    },
    [busy],
  );

  const onTargetBlur = useCallback(() => {
    setFocused(false);
    const parsed = parseFloat(targetText);
    commitTarget(Number.isFinite(parsed) && parsed > 0 ? parsed : MIN_TARGET);
  }, [targetText, commitTarget]);

  // -------------------------------------------------------------------------
  // Core round.
  // -------------------------------------------------------------------------
  const play = useCallback(async () => {
    if (busy) return;
    if (!canAfford) return;
    // Normalise target before charging.
    const tgt = clamp(
      Math.round(target * 100) / 100,
      MIN_TARGET,
      MAX_TARGET,
    );
    if (tgt !== target) {
      setTarget(tgt);
      setTargetText(tgt.toFixed(2));
    }
    if (!placeBet(bet)) return;

    const stake = bet;
    const res = rollResult();
    setResultValue(res);
    setRound(null);
    setRollKey((k) => k + 1);
    setPhase("rolling");
    sfx.thud();

    // Ticking climb feedback. Duration roughly mirrors the count-up curve.
    const climbDur = clamp(
      650 + Math.log10(Math.max(1, res)) * 520,
      650,
      2400,
    );
    const ticks = Math.round(climbDur / 130);
    for (let i = 0; i < ticks; i++) {
      await sleep(climbDur / ticks);
      sfx.tick();
    }
    await sleep(180); // let the number lock visually

    const won = res >= tgt;
    const gross = won ? Math.floor(stake * tgt) : 0;
    const delta = won ? gross - stake : -stake;

    if (won) {
      win(gross);
      setBurst((b) => b + 1);
      if (tgt >= 10) sfx.jackpot();
      else sfx.win();
    } else {
      sfx.lose();
    }

    const finished: RoundResult = { target: tgt, result: res, won, delta };
    setRound(finished);
    setHistory((h) => [finished, ...h].slice(0, 12));
    setPhase("resolved");
  }, [busy, canAfford, target, placeBet, bet, win]);

  const newRound = useCallback(() => {
    sfx.click();
    setPhase("betting");
    setRound(null);
  }, []);

  // Quick target presets.
  const PRESETS = [1.5, 2, 3, 5, 10, 50];

  return (
    <div className="mx-auto w-full max-w-3xl px-2 py-3 sm:py-5">
      {/* ===== Surface ===== */}
      <div
        className="felt relative overflow-hidden rounded-3xl border border-white/10 p-4 shadow-felt sm:p-6"
        style={{
          background:
            "radial-gradient(120% 90% at 50% 0%, #0f2417 0%, #0a1611 55%, #06100b 100%)",
        }}
      >
        {/* ambient accent glow */}
        <div
          className="pointer-events-none absolute -top-24 left-1/2 h-64 w-72 -translate-x-1/2 rounded-full"
          style={{
            background: `radial-gradient(circle, ${ACCENT}26, transparent 70%)`,
            filter: "blur(12px)",
          }}
        />
        {/* faint grid */}
        <div className="bg-grid pointer-events-none absolute inset-0 opacity-[0.06]" />

        {/* Header */}
        <div className="relative mb-3 flex flex-wrap items-end justify-between gap-2">
          <div>
            <h2 className="font-display text-2xl tracking-wide text-white sm:text-3xl">
              Limbo
            </h2>
            <p className="text-xs text-white/50">
              Set a target. Beat it and bank{" "}
              <span style={{ color: ACCENT }}>{formatMultiplier(target)}</span>.
            </p>
          </div>
          <div className="rounded-xl border border-white/10 bg-black/30 px-3 py-1.5 text-right">
            <div className="text-[9px] uppercase tracking-[0.25em] text-white/40">
              Balance
            </div>
            <div className="gold-text text-lg font-bold tabular-nums">
              {ready ? <ChipCounter value={balance} /> : "—"}
            </div>
          </div>
        </div>

        {/* ===== Stage ===== */}
        <div
          className="relative grid place-items-center overflow-hidden rounded-2xl border px-3 py-8 sm:py-12"
          style={{
            borderColor:
              outcome === "win"
                ? `${ACCENT}55`
                : outcome === "lose"
                ? `${LOSE}55`
                : "rgba(255,255,255,0.06)",
            background: "rgba(0,0,0,0.28)",
            transition: "border-color 0.3s",
          }}
        >
          {/* sweeping scan line while rolling */}
          <AnimatePresence>
            {busy && (
              <motion.div
                key="scan"
                className="pointer-events-none absolute inset-x-0 h-24"
                initial={{ top: "100%", opacity: 0 }}
                animate={{ top: "-30%", opacity: [0, 0.5, 0] }}
                exit={{ opacity: 0 }}
                transition={{
                  duration: 0.9,
                  repeat: Infinity,
                  ease: "easeInOut",
                }}
                style={{
                  background: `linear-gradient(to top, ${ACCENT}33, transparent)`,
                }}
              />
            )}
          </AnimatePresence>

          {/* result glow wash */}
          <AnimatePresence>
            {outcome && (
              <motion.div
                key={`wash-${rollKey}`}
                className="pointer-events-none absolute inset-0"
                initial={{ opacity: 0.8 }}
                animate={{ opacity: 0 }}
                transition={{ duration: 1 }}
                style={{
                  background: `radial-gradient(circle at 50% 50%, ${
                    outcome === "win" ? ACCENT : LOSE
                  }33, transparent 65%)`,
                }}
              />
            )}
          </AnimatePresence>

          {/* The headline multiplier */}
          <MultiplierDisplay
            value={resultValue}
            phase={phase}
            outcome={outcome}
            rollKey={rollKey}
          />

          {/* target vs result strip */}
          <div className="relative mt-5 flex items-stretch gap-3">
            <div className="rounded-xl border border-white/10 bg-black/40 px-4 py-2 text-center">
              <div className="text-[9px] uppercase tracking-[0.25em] text-white/40">
                Target
              </div>
              <div
                className="text-xl font-bold tabular-nums"
                style={{ color: ACCENT }}
              >
                {formatMultiplier(target)}
              </div>
            </div>
            <div className="grid place-items-center text-white/30">
              {outcome === "win" ? "≥" : outcome === "lose" ? "<" : "vs"}
            </div>
            <motion.div
              key={`res-${rollKey}-${phase}`}
              animate={
                outcome
                  ? { scale: [1, 1.12, 1] }
                  : { scale: 1 }
              }
              transition={{ duration: 0.45 }}
              className="rounded-xl border bg-black/40 px-4 py-2 text-center"
              style={{
                borderColor:
                  outcome === "win"
                    ? `${ACCENT}66`
                    : outcome === "lose"
                    ? `${LOSE}66`
                    : "rgba(255,255,255,0.1)",
              }}
            >
              <div className="text-[9px] uppercase tracking-[0.25em] text-white/40">
                Result
              </div>
              <div
                className="text-xl font-bold tabular-nums"
                style={{
                  color:
                    outcome === "win"
                      ? ACCENT
                      : outcome === "lose"
                      ? LOSE
                      : "rgba(255,255,255,0.85)",
                }}
              >
                {phase === "betting" ? "—" : formatMultiplier(resultValue)}
              </div>
            </motion.div>
          </div>

          {/* win burst */}
          <AnimatePresence>
            {burst > 0 && outcome === "win" && (
              <motion.div
                key={`burst-${burst}`}
                className="pointer-events-none absolute inset-0 grid place-items-center"
                initial={{ opacity: 1 }}
                animate={{ opacity: 0 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 1.2 }}
              >
                {Array.from({ length: 20 }).map((_, i) => {
                  const a = (i / 20) * Math.PI * 2;
                  const dist = 150 + (i % 3) * 28;
                  return (
                    <motion.span
                      key={i}
                      className="absolute h-2 w-2 rounded-full"
                      style={{
                        background: i % 2 ? ACCENT : "#f5d060",
                        boxShadow: `0 0 8px ${i % 2 ? ACCENT : "#f5d060"}`,
                      }}
                      initial={{ x: 0, y: 0, scale: 1, opacity: 1 }}
                      animate={{
                        x: Math.cos(a) * dist,
                        y: Math.sin(a) * dist,
                        scale: 0,
                        opacity: 0,
                      }}
                      transition={{ duration: 1.1, ease: "easeOut" }}
                    />
                  );
                })}
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* ===== Round result banner ===== */}
        <div className="relative mt-3 min-h-[58px]">
          <AnimatePresence mode="wait">
            {round && phase === "resolved" ? (
              <motion.div
                key={`${rollKey}-${round.won}`}
                data-testid="round-result"
                initial={{ opacity: 0, y: 10, scale: 0.96 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -8 }}
                className="flex items-center justify-center gap-3 rounded-2xl px-4 py-3 text-center"
                style={{
                  background: round.won
                    ? `${ACCENT}1f`
                    : "rgba(220,38,38,0.12)",
                  border: `1px solid ${round.won ? ACCENT : LOSE}55`,
                }}
              >
                <span className="text-2xl">{round.won ? "🚀" : "💥"}</span>
                <div className="text-left">
                  <div
                    className="text-base font-extrabold tracking-wide sm:text-lg"
                    style={{ color: round.won ? "#fff" : "#fca5a5" }}
                  >
                    {round.won
                      ? `Cleared ${formatMultiplier(round.target)}!`
                      : `Fell short of ${formatMultiplier(round.target)}.`}{" "}
                    <span className="text-white/60">
                      Landed {formatMultiplier(round.result)}
                    </span>
                  </div>
                  <div
                    className="text-sm font-bold tabular-nums"
                    style={{ color: round.delta >= 0 ? ACCENT : "#fca5a5" }}
                  >
                    {formatDelta(round.delta)} chips
                  </div>
                </div>
              </motion.div>
            ) : (
              <motion.div
                key="idle-hint"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="flex items-center justify-center rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-center text-xs text-white/50"
              >
                {busy
                  ? "Rolling…"
                  : `Win chance ${chancePct.toFixed(2)}% · pays ${formatMultiplier(
                      target,
                    )} if the result reaches your target.`}
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* ===== Target selector ===== */}
        <div className="relative mt-4 glass rounded-2xl p-3 sm:p-4">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[10px] uppercase tracking-[0.25em] text-white/40">
              Target Multiplier
            </span>
            <span className="text-[10px] text-white/30">min {MIN_TARGET}×</span>
          </div>

          <div className="flex items-center gap-2">
            <Button
              data-testid="target-minus"
              variant="ghost"
              size="md"
              disabled={busy || target <= MIN_TARGET}
              onClick={() => adjustTarget(target >= 10 ? -1 : -0.1)}
              aria-label="Decrease target"
            >
              −
            </Button>

            <div className="relative flex-1">
              <input
                data-testid="target-input"
                type="text"
                inputMode="decimal"
                value={targetText}
                disabled={busy}
                onChange={(e) => onTargetInput(e.target.value)}
                onBlur={onTargetBlur}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.currentTarget.blur();
                    if (!busy && canAfford) void play();
                  }
                }}
                className="w-full rounded-xl border bg-black/50 px-4 py-2.5 text-center text-2xl font-bold tabular-nums text-white outline-none transition-colors disabled:opacity-50"
                style={{
                  borderColor: focused ? ACCENT : "rgba(255,255,255,0.15)",
                  boxShadow: focused ? `0 0 0 1px ${ACCENT}` : "none",
                }}
                onFocus={() => setFocused(true)}
              />
              <span
                className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-2xl font-bold"
                style={{ color: ACCENT }}
              >
                ×
              </span>
            </div>

            <Button
              data-testid="target-plus"
              variant="ghost"
              size="md"
              disabled={busy || target >= MAX_TARGET}
              onClick={() => adjustTarget(target >= 10 ? 1 : 0.1)}
              aria-label="Increase target"
            >
              +
            </Button>
          </div>

          {/* presets */}
          <div className="mt-3 flex flex-wrap items-center justify-center gap-1.5">
            {PRESETS.map((p) => {
              const active = Math.abs(target - p) < 0.001;
              return (
                <button
                  key={p}
                  type="button"
                  data-testid={`preset-${p}`}
                  disabled={busy}
                  onClick={() => {
                    if (busy) return;
                    sfx.click();
                    commitTarget(p);
                  }}
                  className="rounded-lg px-3 py-1.5 text-xs font-semibold tabular-nums transition-colors disabled:opacity-40"
                  style={{
                    color: active ? "#06100b" : "rgba(255,255,255,0.7)",
                    background: active ? ACCENT : "rgba(255,255,255,0.05)",
                    border: `1px solid ${
                      active ? ACCENT : "rgba(255,255,255,0.1)"
                    }`,
                    boxShadow: active ? `0 0 14px ${ACCENT}66` : "none",
                  }}
                >
                  {formatMultiplier(p)}
                </button>
              );
            })}
          </div>
        </div>

        {/* ===== Action buttons ===== */}
        <div className="relative mt-4 flex flex-col items-stretch gap-3 sm:flex-row sm:justify-center">
          <Button
            data-testid="play-btn"
            variant="gold"
            size="lg"
            block
            disabled={busy || !canAfford}
            onClick={() => void play()}
            className="sm:flex-1"
          >
            {busy
              ? "Rolling…"
              : phase === "resolved"
              ? `Roll Again · ${formatMultiplier(target)}`
              : `Roll · ${formatMultiplier(target)}`}
          </Button>

          {phase === "resolved" && (
            <Button
              data-testid="newround-btn"
              variant="ghost"
              size="lg"
              onClick={newRound}
              className="sm:flex-1"
            >
              Reset
            </Button>
          )}
        </div>

        {/* ===== Bet controls ===== */}
        <div className="relative mt-4">
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
              Wager locked while rolling
            </div>
          )}
        </div>

        {/* ===== Odds + history ===== */}
        <div className="relative mt-4 grid gap-3 sm:grid-cols-2">
          <div className="glass rounded-2xl p-3">
            <div className="mb-2 text-[10px] uppercase tracking-[0.25em] text-white/40">
              Your Bet
            </div>
            <div className="space-y-1.5 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-white/70">Target</span>
                <span className="font-bold" style={{ color: ACCENT }}>
                  {formatMultiplier(target)}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-white/70">Win chance</span>
                <span className="font-bold text-white/90 tabular-nums">
                  {chancePct.toFixed(2)}%
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-white/70">Pays</span>
                <span className="font-semibold text-white/90 tabular-nums">
                  {formatChips(potentialReturn)}
                </span>
              </div>
              <div className="flex items-center justify-between border-t border-white/10 pt-1.5 text-xs">
                <span className="text-white/45">Profit on win</span>
                <span
                  className="font-semibold tabular-nums"
                  style={{ color: ACCENT }}
                >
                  {formatDelta(potentialProfit)}
                </span>
              </div>
              <div className="flex items-center justify-between text-xs">
                <span className="text-white/45">House edge</span>
                <span className="font-semibold text-white/70 tabular-nums">
                  {(EDGE * 100).toFixed(0)}%
                </span>
              </div>
            </div>
          </div>

          <div className="glass rounded-2xl p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[10px] uppercase tracking-[0.25em] text-white/40">
                Recent Rolls
              </span>
              <span className="text-[10px] text-white/30">newest first</span>
            </div>
            <div className="flex min-h-[34px] flex-wrap gap-1.5">
              <AnimatePresence initial={false}>
                {history.length === 0 && (
                  <span className="text-xs text-white/30">No rolls yet.</span>
                )}
                {history.map((h, i) => (
                  <motion.span
                    key={`${rollKey - i}-${h.result}-${h.target}`}
                    initial={{ scale: 0, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    className="grid place-items-center rounded-md px-2 py-1 text-[11px] font-bold tabular-nums"
                    style={{
                      background: h.won
                        ? `${ACCENT}26`
                        : "rgba(255,93,108,0.16)",
                      border: `1px solid ${h.won ? ACCENT : LOSE}55`,
                      color: h.won ? ACCENT : "#fca5a5",
                    }}
                    title={`Target ${formatMultiplier(
                      h.target,
                    )} · Result ${formatMultiplier(h.result)}`}
                  >
                    {formatMultiplier(h.result)}
                  </motion.span>
                ))}
              </AnimatePresence>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
