"use client";

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useWallet } from "@/lib/wallet";
import { BetControls } from "@/components/BetControls";
import { Button } from "@/components/ui/Button";
import { formatChips, formatMultiplier, formatDelta } from "@/lib/format";
import { sfx } from "@/lib/sound";
import { clamp } from "@/lib/rng";

const ACCENT = "#ff2bd1";
const HOUSE_EDGE = 0.01;
// Multiplier grows exponentially: m = GROWTH_RATE ^ elapsedSeconds.
// ~0.0625x/s base growth that compounds — a tense, accelerating climb.
const GROWTH_RATE = 1.07;

type Phase = "idle" | "running" | "crashed" | "cashed";

interface HistoryItem {
  id: number;
  point: number;
  /** Did the player cash out this round (win) or bust (loss/no-bet)? */
  cashed: boolean;
}

/** Pre-roll a crash point from a house-edge distribution. */
function rollCrashPoint(): number {
  // Use (0,1) — guard against the rare 0/1 endpoints from Math.random().
  let r = Math.random();
  if (r >= 1) r = 0.999999;
  // crashPoint = max(1.00, floor(100*(1-edge)/(1-r))/100)
  const raw = Math.floor((100 * (1 - HOUSE_EDGE)) / (1 - r)) / 100;
  return Math.max(1, raw);
}

// Geometry for the rocket trajectory (an exponential-feeling curve in an SVG box).
const VIEW_W = 1000;
const VIEW_H = 560;
const PAD_X = 70;
const PAD_Y = 60;
// Multiplier at which the curve reaches the top-right of the viewport.
const CURVE_MAX_X = 12;

/** Map a multiplier to a point along the flight curve. */
function curvePoint(m: number): { x: number; y: number; progress: number } {
  // progress: 0 at 1.00x, 1 at CURVE_MAX_X, log-scaled so early rise is visible.
  const progress = clamp(
    Math.log(Math.max(1, m)) / Math.log(CURVE_MAX_X),
    0,
    1,
  );
  const x = PAD_X + progress * (VIEW_W - PAD_X * 2);
  // The curve sweeps up: y eases toward the top as progress grows (power curve).
  const yNorm = Math.pow(progress, 1.6);
  const y = VIEW_H - PAD_Y - yNorm * (VIEW_H - PAD_Y * 2);
  return { x, y, progress };
}

/** Build the SVG path string for the flown portion of the curve. */
function buildPath(m: number): string {
  const steps = 48;
  const target = clamp(
    Math.log(Math.max(1, m)) / Math.log(CURVE_MAX_X),
    0,
    1,
  );
  let d = "";
  for (let i = 0; i <= steps; i++) {
    const p = (i / steps) * target;
    // invert progress->multiplier to reuse curvePoint mapping precisely
    const mm = Math.pow(CURVE_MAX_X, p);
    const { x, y } = curvePoint(mm);
    d += `${i === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)} `;
  }
  return d.trim();
}

const STAR_FIELD = Array.from({ length: 36 }, (_, i) => ({
  id: i,
  x: (i * 73.3) % 100,
  y: (i * 41.7) % 100,
  size: 1 + ((i * 7) % 3),
  delay: (i % 8) * 0.25,
}));

const PARTICLE_DIRS = Array.from({ length: 18 }, (_, i) => {
  const a = (i / 18) * Math.PI * 2;
  return { id: i, dx: Math.cos(a), dy: Math.sin(a) };
});

export default function Crash() {
  const wallet = useWallet();

  const [bet, setBet] = useState(50);
  const [phase, setPhase] = useState<Phase>("idle");
  const [multiplier, setMultiplier] = useState(1);
  const [autoEnabled, setAutoEnabled] = useState(false);
  const [autoTarget, setAutoTarget] = useState(2);

  const [crashPoint, setCrashPoint] = useState(0);
  const [cashedAt, setCashedAt] = useState<number | null>(null);
  const [lastProfit, setLastProfit] = useState(0);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [shake, setShake] = useState(false);

  // Refs for the rAF loop (avoid stale closures).
  const rafRef = useRef<number | null>(null);
  const startRef = useRef(0);
  const crashRef = useRef(0);
  const stakeRef = useRef(0);
  const cashedRef = useRef(false);
  const autoRef = useRef<{ on: boolean; target: number }>({ on: false, target: 2 });
  const lastTickRef = useRef(1);
  const histIdRef = useRef(0);
  // Mirror of `multiplier` state kept in a ref so the rAF loop and manual
  // cash-out handler always read the latest value without stale-closure risk.
  const multiplierRef = useRef(1);

  const ready = wallet.ready;
  const canAfford = bet > 0 && bet <= wallet.balance;
  const inRound = phase === "running";
  // Reactive flag so the cashout button is visually disabled immediately after
  // cash-out is triggered (cashedRef alone is a ref and doesn't re-render).
  const [cashoutFired, setCashoutFired] = useState(false);

  const stopLoop = useCallback(() => {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  useEffect(() => () => stopLoop(), [stopLoop]);

  /** Resolve the round when the rocket explodes (no cash-out). */
  const bust = useCallback((point: number) => {
    stopLoop();
    cashedRef.current = true; // lock further cash-outs
    setMultiplier(point);
    setPhase("crashed");
    setLastProfit(-stakeRef.current);
    setShake(true);
    sfx.lose();
    sfx.thud();
    window.setTimeout(() => setShake(false), 520);
    setHistory((h) =>
      [{ id: ++histIdRef.current, point, cashed: false }, ...h].slice(0, 18),
    );
  }, [stopLoop]);

  /** Cash out at the current (or supplied) multiplier — a win. */
  const cashOut = useCallback(
    (atMultiplier: number) => {
      if (cashedRef.current) return;
      cashedRef.current = true;
      setCashoutFired(true);
      stopLoop();
      const m = atMultiplier;
      const gross = stakeRef.current * m; // multiplier already includes stake
      wallet.win(gross);
      const profit = gross - stakeRef.current;
      setCashedAt(m);
      multiplierRef.current = m;
      setMultiplier(m);
      setLastProfit(profit);
      setPhase("cashed");
      if (m >= 10) sfx.jackpot();
      else sfx.win();
      setHistory((h) =>
        [{ id: ++histIdRef.current, point: m, cashed: true }, ...h].slice(0, 18),
      );
    },
    [stopLoop, wallet],
  );

  // Keep auto config in a ref so the loop reads live values.
  useEffect(() => {
    autoRef.current = { on: autoEnabled, target: autoTarget };
  }, [autoEnabled, autoTarget]);

  const launch = useCallback(() => {
    // Only allow launch from idle state — not from running, cashed, or crashed.
    if (phase !== "idle") return;
    if (!ready) return;
    const stake = Math.floor(bet);
    if (stake <= 0 || stake > wallet.balance) return;
    // Deduct the stake; abort if unaffordable.
    if (!wallet.bet(stake)) return;

    const point = rollCrashPoint();
    stakeRef.current = stake;
    crashRef.current = point;
    cashedRef.current = false;
    lastTickRef.current = 1;
    multiplierRef.current = 1;
    setCashoutFired(false);
    setCrashPoint(point);
    setCashedAt(null);
    setLastProfit(0);
    setMultiplier(1);
    setPhase("running");
    sfx.thud();

    startRef.current = performance.now();

    const tick = (now: number) => {
      const elapsed = (now - startRef.current) / 1000;
      const m = Math.pow(GROWTH_RATE, elapsed);
      const cp = crashRef.current;

      // Reel-tick sound on each whole/quarter step up.
      if (Math.floor(m * 4) > Math.floor(lastTickRef.current * 4)) {
        sfx.tick();
      }
      lastTickRef.current = m;

      // Auto cash-out: trigger when multiplier reaches or exceeds target and
      // the target is reachable (≤ crash point) so the player actually wins.
      const auto = autoRef.current;
      if (
        !cashedRef.current &&
        auto.on &&
        auto.target > 1 &&
        m >= auto.target &&
        auto.target <= cp
      ) {
        cashOut(auto.target);
        return;
      }

      // Crash reached → bust at exactly the crash point.
      if (m >= cp) {
        bust(cp);
        return;
      }

      multiplierRef.current = m;
      setMultiplier(m);
      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
  }, [bet, phase, ready, wallet, bust, cashOut]);

  const onManualCashOut = useCallback(() => {
    if (phase !== "running" || cashedRef.current) return;
    // Use the ref value so we cash out at the live multiplier, not the
    // 1-frame-stale state value that React may have rendered last tick.
    cashOut(multiplierRef.current);
  }, [phase, cashOut]);

  const resetToIdle = useCallback(() => {
    stopLoop();
    cashedRef.current = false;
    multiplierRef.current = 1;
    setCashoutFired(false);
    setPhase("idle");
    setMultiplier(1);
    setCashedAt(null);
    setCrashPoint(0);
    setLastProfit(0);
    sfx.click();
  }, [stopLoop]);

  // Derived display values.
  const rocket = useMemo(() => curvePoint(multiplier), [multiplier]);
  const pathD = useMemo(() => buildPath(multiplier), [multiplier]);
  const exploded = phase === "crashed";
  const won = phase === "cashed";
  const potentialPayout = stakeRef.current * multiplier;

  // Rocket nose angle along the curve (tangent estimate).
  const angle = useMemo(() => {
    const a = curvePoint(multiplier);
    const b = curvePoint(multiplier * 1.04 + 0.001);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    if (dx === 0 && dy === 0) return -45;
    return (Math.atan2(dy, dx) * 180) / Math.PI;
  }, [multiplier]);

  const resultText =
    phase === "cashed"
      ? `Cashed out at ${formatMultiplier(cashedAt ?? multiplier)} · ${formatDelta(lastProfit)}`
      : phase === "crashed"
        ? `Crashed at ${formatMultiplier(crashPoint)} · ${formatDelta(lastProfit)}`
        : phase === "running"
          ? "In flight…"
          : "Set your bet and launch";

  const multiplierColor = exploded ? "#ff5a5a" : won ? "#7CFFB2" : ACCENT;

  // Where the auto target line sits on the readout (for an indicator).
  const autoMarkerActive = autoEnabled && autoTarget > 1 && phase === "running";

  return (
    <div className="mx-auto w-full max-w-5xl px-3 pb-10 sm:px-4">
      {/* History strip */}
      <div className="no-scrollbar mb-3 flex items-center gap-2 overflow-x-auto pb-1">
        <span className="shrink-0 text-[10px] uppercase tracking-widest text-white/40">
          History
        </span>
        <AnimatePresence initial={false}>
          {history.length === 0 && (
            <span className="text-xs text-white/30">No rounds yet</span>
          )}
          {history.map((h) => (
            <motion.span
              key={h.id}
              layout
              initial={{ scale: 0.5, opacity: 0, y: -6 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ type: "spring", stiffness: 380, damping: 26 }}
              className="shrink-0 rounded-full px-2.5 py-1 text-xs font-bold tabular-nums"
              style={{
                background: h.cashed
                  ? "rgba(34,197,94,0.16)"
                  : "rgba(244,63,94,0.16)",
                color: h.cashed ? "#7CFFB2" : "#ff8a8a",
                border: `1px solid ${h.cashed ? "rgba(34,197,94,0.4)" : "rgba(244,63,94,0.4)"}`,
              }}
            >
              {formatMultiplier(h.point)}
            </motion.span>
          ))}
        </AnimatePresence>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_280px]">
        {/* === FLIGHT STAGE === */}
        <motion.div
          className="felt relative overflow-hidden rounded-3xl p-3 sm:p-4"
          animate={
            shake
              ? { x: [0, -12, 11, -8, 7, -4, 0], y: [0, 7, -6, 5, -3, 2, 0] }
              : { x: 0, y: 0 }
          }
          transition={shake ? { duration: 0.5 } : { duration: 0.2 }}
          style={{
            boxShadow: exploded
              ? "inset 0 0 120px rgba(244,63,94,0.35)"
              : won
                ? "inset 0 0 120px rgba(34,197,94,0.28)"
                : `inset 0 0 90px ${ACCENT}22`,
          }}
        >
          {/* Multiplier readout */}
          <div className="pointer-events-none absolute inset-x-0 top-5 z-20 flex flex-col items-center">
            <motion.div
              data-testid="multiplier"
              key={`${phase}-readout`}
              className="font-display font-black tabular-nums"
              style={{
                color: multiplierColor,
                fontSize: "clamp(2.6rem, 9vw, 5.5rem)",
                lineHeight: 1,
                textShadow: `0 0 28px ${multiplierColor}aa, 0 0 60px ${multiplierColor}55`,
              }}
              animate={
                exploded
                  ? { scale: [1, 1.18, 1], opacity: [1, 1, 0.95] }
                  : { scale: 1 }
              }
              transition={{ duration: 0.4 }}
            >
              {formatMultiplier(multiplier)}
            </motion.div>
            <AnimatePresence mode="wait">
              {phase === "running" && (
                <motion.div
                  key="potential"
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  className="mt-1 text-sm font-semibold tabular-nums text-white/80"
                >
                  Payout {formatChips(potentialPayout)}
                </motion.div>
              )}
              {exploded && (
                <motion.div
                  key="boom"
                  initial={{ opacity: 0, scale: 0.6 }}
                  animate={{ opacity: 1, scale: 1 }}
                  className="mt-1 text-lg font-black uppercase tracking-widest"
                  style={{ color: "#ff5a5a" }}
                >
                  Busted!
                </motion.div>
              )}
              {won && (
                <motion.div
                  key="won"
                  initial={{ opacity: 0, scale: 0.6 }}
                  animate={{ opacity: 1, scale: 1 }}
                  className="mt-1 text-lg font-black uppercase tracking-widest"
                  style={{ color: "#7CFFB2" }}
                >
                  Cashed out!
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {/* Star field background */}
          <div className="absolute inset-0">
            {STAR_FIELD.map((s) => (
              <motion.span
                key={s.id}
                className="absolute rounded-full bg-white"
                style={{
                  left: `${s.x}%`,
                  top: `${s.y}%`,
                  width: s.size,
                  height: s.size,
                }}
                animate={{ opacity: [0.15, 0.7, 0.15] }}
                transition={{
                  duration: 2.4,
                  delay: s.delay,
                  repeat: Infinity,
                  ease: "easeInOut",
                }}
              />
            ))}
          </div>

          {/* SVG flight curve */}
          <svg
            viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
            className="relative z-10 block aspect-[1000/560] w-full"
            preserveAspectRatio="xMidYMid meet"
          >
            <defs>
              <linearGradient id="crash-grad" x1="0" y1="1" x2="1" y2="0">
                <stop offset="0%" stopColor={ACCENT} stopOpacity="0.1" />
                <stop offset="100%" stopColor={ACCENT} stopOpacity="1" />
              </linearGradient>
              <linearGradient id="crash-fill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={ACCENT} stopOpacity="0.35" />
                <stop offset="100%" stopColor={ACCENT} stopOpacity="0" />
              </linearGradient>
              <filter id="crash-glow" x="-30%" y="-30%" width="160%" height="160%">
                <feGaussianBlur stdDeviation="6" result="b" />
                <feMerge>
                  <feMergeNode in="b" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>
            </defs>

            {/* Baseline + grid */}
            <line
              x1={PAD_X}
              y1={VIEW_H - PAD_Y}
              x2={VIEW_W - PAD_X}
              y2={VIEW_H - PAD_Y}
              stroke="rgba(255,255,255,0.15)"
              strokeWidth={2}
            />
            <line
              x1={PAD_X}
              y1={PAD_Y}
              x2={PAD_X}
              y2={VIEW_H - PAD_Y}
              stroke="rgba(255,255,255,0.12)"
              strokeWidth={2}
            />
            {[2, 4, 8].map((g) => {
              const yp = curvePoint(g).y;
              return (
                <g key={g}>
                  <line
                    x1={PAD_X}
                    y1={yp}
                    x2={VIEW_W - PAD_X}
                    y2={yp}
                    stroke="rgba(255,255,255,0.06)"
                    strokeDasharray="4 8"
                    strokeWidth={1}
                  />
                  <text
                    x={PAD_X - 10}
                    y={yp + 4}
                    fontSize={16}
                    textAnchor="end"
                    fill="rgba(255,255,255,0.35)"
                  >
                    {g}×
                  </text>
                </g>
              );
            })}

            {/* Auto cash-out marker line */}
            {autoMarkerActive && autoTarget <= CURVE_MAX_X && (
              <g>
                <line
                  x1={PAD_X}
                  y1={curvePoint(autoTarget).y}
                  x2={VIEW_W - PAD_X}
                  y2={curvePoint(autoTarget).y}
                  stroke="#7CFFB2"
                  strokeDasharray="6 6"
                  strokeWidth={1.5}
                  opacity={0.7}
                />
                <text
                  x={VIEW_W - PAD_X}
                  y={curvePoint(autoTarget).y - 8}
                  fontSize={15}
                  textAnchor="end"
                  fill="#7CFFB2"
                >
                  auto {formatMultiplier(autoTarget)}
                </text>
              </g>
            )}

            {/* Area fill under the curve */}
            {phase !== "idle" && multiplier > 1 && (
              <path
                d={`${pathD} L${rocket.x.toFixed(2)},${(VIEW_H - PAD_Y).toFixed(2)} L${PAD_X},${(VIEW_H - PAD_Y).toFixed(2)} Z`}
                fill="url(#crash-fill)"
                opacity={exploded ? 0.4 : 1}
              />
            )}

            {/* The flight path */}
            {phase !== "idle" && multiplier > 1 && (
              <path
                d={pathD}
                fill="none"
                stroke={exploded ? "#ff5a5a" : "url(#crash-grad)"}
                strokeWidth={5}
                strokeLinecap="round"
                filter="url(#crash-glow)"
              />
            )}

            {/* Explosion burst */}
            {exploded && (
              <g>
                {PARTICLE_DIRS.map((p) => (
                  <motion.circle
                    key={p.id}
                    cx={rocket.x}
                    cy={rocket.y}
                    r={6}
                    fill={p.id % 3 === 0 ? "#ffd166" : "#ff5a5a"}
                    initial={{ opacity: 1 }}
                    animate={{
                      cx: rocket.x + p.dx * 120,
                      cy: rocket.y + p.dy * 120,
                      opacity: 0,
                      r: 1,
                    }}
                    transition={{ duration: 0.6, ease: "easeOut" }}
                  />
                ))}
                <motion.circle
                  cx={rocket.x}
                  cy={rocket.y}
                  fill="#ffae42"
                  initial={{ r: 8, opacity: 0.9 }}
                  animate={{ r: 90, opacity: 0 }}
                  transition={{ duration: 0.5, ease: "easeOut" }}
                />
              </g>
            )}

            {/* The rocket */}
            {phase !== "idle" && (
              <g
                transform={`translate(${rocket.x} ${rocket.y}) rotate(${angle})`}
                style={{ opacity: exploded ? 0 : 1 }}
              >
                {/* exhaust trail */}
                <motion.ellipse
                  cx={-26}
                  cy={0}
                  rx={20}
                  ry={6}
                  fill="#ffce54"
                  opacity={0.85}
                  animate={
                    phase === "running"
                      ? { rx: [16, 26, 16], opacity: [0.5, 0.9, 0.5] }
                      : { rx: 16, opacity: 0.6 }
                  }
                  transition={{ duration: 0.18, repeat: Infinity }}
                />
                {/* body */}
                <path
                  d="M-16,-9 L10,-9 Q22,0 10,9 L-16,9 Q-22,0 -16,-9 Z"
                  fill="#f4f4f7"
                  stroke={ACCENT}
                  strokeWidth={2}
                />
                {/* nose cone */}
                <path d="M10,-9 Q22,0 10,9 Z" fill={ACCENT} />
                {/* window */}
                <circle cx={-2} cy={0} r={4} fill="#22e1ff" />
                {/* fins */}
                <path d="M-16,-9 L-24,-16 L-12,-9 Z" fill={ACCENT} />
                <path d="M-16,9 L-24,16 L-12,9 Z" fill={ACCENT} />
              </g>
            )}

            {/* Idle launchpad rocket */}
            {phase === "idle" && (
              <g transform={`translate(${PAD_X} ${VIEW_H - PAD_Y}) rotate(-45)`}>
                <motion.g
                  animate={{ y: [0, -5, 0] }}
                  transition={{ duration: 1.6, repeat: Infinity, ease: "easeInOut" }}
                >
                  <path
                    d="M-16,-9 L10,-9 Q22,0 10,9 L-16,9 Q-22,0 -16,-9 Z"
                    fill="#f4f4f7"
                    stroke={ACCENT}
                    strokeWidth={2}
                  />
                  <path d="M10,-9 Q22,0 10,9 Z" fill={ACCENT} />
                  <circle cx={-2} cy={0} r={4} fill="#22e1ff" />
                  <path d="M-16,-9 L-24,-16 L-12,-9 Z" fill={ACCENT} />
                  <path d="M-16,9 L-24,16 L-12,9 Z" fill={ACCENT} />
                </motion.g>
              </g>
            )}
          </svg>

          {/* Round result text */}
          <div className="relative z-20 mt-1 flex items-center justify-center">
            <motion.div
              data-testid="round-result"
              key={resultText}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              className="rounded-full border border-white/10 bg-black/40 px-4 py-1.5 text-center text-sm font-semibold"
              style={{
                color: exploded ? "#ff8a8a" : won ? "#7CFFB2" : "rgba(255,255,255,0.8)",
              }}
            >
              {resultText}
            </motion.div>
          </div>
        </motion.div>

        {/* === SIDE PANEL === */}
        <div className="flex flex-col gap-4">
          {/* Auto cash-out config */}
          <div className="glass rounded-2xl p-4">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-widest text-white/60">
                Auto Cash-Out
              </span>
              <button
                type="button"
                data-testid="auto-toggle"
                disabled={inRound}
                onClick={() => {
                  setAutoEnabled((v) => !v);
                  sfx.click();
                }}
                className="relative h-6 w-11 rounded-full transition-colors disabled:opacity-40"
                style={{
                  background: autoEnabled ? ACCENT : "rgba(255,255,255,0.15)",
                }}
                aria-pressed={autoEnabled}
                aria-label="Toggle auto cash-out"
              >
                <motion.span
                  className="absolute top-0.5 h-5 w-5 rounded-full bg-white shadow"
                  animate={{ left: autoEnabled ? 22 : 2 }}
                  transition={{ type: "spring", stiffness: 500, damping: 30 }}
                />
              </button>
            </div>
            <div
              className="flex items-center gap-2 rounded-xl border border-white/10 bg-black/40 px-3 py-2"
              style={{ opacity: autoEnabled ? 1 : 0.45 }}
            >
              <Button
                size="sm"
                variant="ghost"
                disabled={!autoEnabled || inRound}
                data-testid="auto-minus"
                onClick={() => setAutoTarget((t) => clamp(+(t - 0.25).toFixed(2), 1.01, 1000))}
              >
                −
              </Button>
              <div className="flex-1 text-center">
                <div className="text-[9px] uppercase tracking-widest text-white/40">
                  Target
                </div>
                <div
                  className="text-lg font-bold tabular-nums"
                  style={{ color: autoEnabled ? "#7CFFB2" : "white" }}
                >
                  {formatMultiplier(autoTarget)}
                </div>
              </div>
              <Button
                size="sm"
                variant="ghost"
                disabled={!autoEnabled || inRound}
                data-testid="auto-plus"
                onClick={() => setAutoTarget((t) => clamp(+(t + 0.25).toFixed(2), 1.01, 1000))}
              >
                +
              </Button>
            </div>
            <p className="mt-2 text-[11px] leading-snug text-white/40">
              {autoEnabled
                ? `Auto-cashes the moment the rocket hits ${formatMultiplier(autoTarget)}.`
                : "Off — cash out manually before the crash."}
            </p>
          </div>

          {/* Paytable / odds */}
          <div className="glass rounded-2xl p-4">
            <div className="mb-2 text-xs font-semibold uppercase tracking-widest text-white/60">
              Payouts
            </div>
            <table className="w-full text-sm">
              <tbody className="tabular-nums">
                {[
                  { m: 1.5, label: "Cash at 1.50×" },
                  { m: 2, label: "Cash at 2.00×" },
                  { m: 5, label: "Cash at 5.00×" },
                  { m: 10, label: "Cash at 10.00×" },
                ].map((row) => (
                  <tr key={row.m} className="border-b border-white/5 last:border-0">
                    <td className="py-1.5 text-white/70">{row.label}</td>
                    <td className="py-1.5 text-right font-semibold text-white/90">
                      {formatChips(bet * row.m)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-2 text-[11px] leading-snug text-white/40">
              Win = bet × cash-out multiplier. House edge {Math.round(HOUSE_EDGE * 100)}% —
              ~1% of rounds bust instantly at 1.00×.
            </p>
          </div>

          {/* Last result chip */}
          <AnimatePresence>
            {(won || exploded) && (
              <motion.div
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0 }}
                className="rounded-2xl border px-4 py-3 text-center"
                style={{
                  borderColor: won ? "rgba(34,197,94,0.45)" : "rgba(244,63,94,0.45)",
                  background: won ? "rgba(34,197,94,0.1)" : "rgba(244,63,94,0.1)",
                }}
              >
                <div className="text-[10px] uppercase tracking-widest text-white/50">
                  {won ? "You won" : "You lost"}
                </div>
                <div
                  className="text-2xl font-black tabular-nums"
                  style={{ color: won ? "#7CFFB2" : "#ff8a8a" }}
                >
                  {formatDelta(lastProfit)}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      {/* === CONTROLS === */}
      <div className="mt-4">
        {phase === "running" ? (
          <div className="glass flex flex-col items-center gap-3 rounded-2xl p-4">
            <Button
              data-testid="cashout-btn"
              variant="neon"
              size="lg"
              block
              onClick={onManualCashOut}
              disabled={cashoutFired}
            >
              <motion.span
                className="inline-flex items-center gap-2"
                animate={{ scale: [1, 1.05, 1] }}
                transition={{ duration: 0.8, repeat: Infinity }}
              >
                Cash Out {formatChips(potentialPayout)} ({formatMultiplier(multiplier)})
              </motion.span>
            </Button>
            <p className="text-[11px] text-white/40">
              Bet {formatChips(stakeRef.current)} in flight — cash out before the crash!
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <BetControls
              bet={bet}
              setBet={setBet}
              balance={wallet.balance}
              min={1}
              disabled={!ready}
            />
            <div className="flex items-center justify-center gap-3">
              {(won || exploded) && (
                <Button
                  variant="ghost"
                  size="lg"
                  data-testid="new-round-btn"
                  onClick={resetToIdle}
                >
                  Clear
                </Button>
              )}
              <Button
                data-testid="play-btn"
                variant="gold"
                size="lg"
                onClick={launch}
                disabled={!ready || !canAfford || phase !== "idle"}
              >
                🚀 Launch ({formatChips(bet)})
              </Button>
            </div>
            {!canAfford && bet > 0 && (
              <p className="text-center text-[11px] text-ruby">
                Not enough chips for that bet.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
