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
import { chance } from "@/lib/rng";
import { formatChips, formatDelta, formatMultiplier } from "@/lib/format";
import { sfx } from "@/lib/sound";
import { Button } from "@/components/ui/Button";
import { BetControls } from "@/components/BetControls";
import { CountingNumber } from "@/components/CountingNumber";

// ---------------------------------------------------------------------------
// PLINKO — Neon Royale
//
// A triangular peg board. Drop a ball from the top center; at every peg it
// bounces left or right via a fair chance(0.5). After `rows` rows of pegs it
// lands in one of (rows + 1) buckets. The landing bucket index equals the
// number of RIGHT bounces (a binomial draw) — center buckets are the most
// likely, the edges the least.
//
// Bucket multipliers are symmetric (low in the middle, exploding at the
// edges) and depend on rows + risk. The payout routes through the wallet:
//   - bet(stake) is deducted when the ball is launched.
//   - win(stake * bucketMultiplier) credits the gross return; the multiplier
//     already includes the stake (e.g. 0.5× means you get half back; 9× means
//     nine times your stake back). A 1× bucket is a push.
//
// Multiple balls can ride at once — each is animated independently with real
// gravity, peg deflection and a final bucket bounce, then resolves on landing.
// ---------------------------------------------------------------------------

const ACCENT = "#22e1ff";
const MIN_BET = 5;
const CHIPS = [5, 25, 100, 500, 1000];

type Risk = "low" | "medium" | "high";
type RowCount = 8 | 12 | 16;

const ROW_OPTIONS: RowCount[] = [8, 12, 16];
const RISK_OPTIONS: Risk[] = ["low", "medium", "high"];

// ---------------------------------------------------------------------------
// Multiplier tables. Each is symmetric (len = rows + 1). Values mirror the
// familiar "Stake-style" Plinko payouts: the more rows / higher the risk, the
// flatter the middle and the wilder the edges (16-row high tops out at 1000×).
// ---------------------------------------------------------------------------
const PAYOUTS: Record<RowCount, Record<Risk, number[]>> = {
  8: {
    low: [5.6, 2.1, 1.1, 1, 0.5, 1, 1.1, 2.1, 5.6],
    medium: [13, 3, 1.3, 0.7, 0.4, 0.7, 1.3, 3, 13],
    high: [29, 4, 1.5, 0.3, 0.2, 0.3, 1.5, 4, 29],
  },
  12: {
    low: [10, 3, 1.6, 1.4, 1.1, 1, 0.5, 1, 1.1, 1.4, 1.6, 3, 10],
    medium: [22, 8, 3.5, 1.6, 1, 0.7, 0.6, 0.7, 1, 1.6, 3.5, 8, 22],
    high: [66, 15, 4, 2, 1.1, 0.5, 0.3, 0.5, 1.1, 2, 4, 15, 66],
  },
  16: {
    low: [
      18, 6, 3, 1.8, 1.4, 1.2, 1, 0.9, 0.7, 0.9, 1, 1.2, 1.4, 1.8, 3, 6, 18,
    ],
    medium: [
      110, 41, 10, 5, 3, 1.5, 1, 0.5, 0.3, 0.5, 1, 1.5, 3, 5, 10, 41, 110,
    ],
    high: [
      1000, 130, 26, 9, 4, 2, 0.2, 0.2, 0.2, 0.2, 0.2, 2, 4, 9, 26, 130, 1000,
    ],
  },
};

// Bucket gradient: hot (edges, high mult) → cool (center, low mult).
function bucketTint(mult: number): { from: string; to: string; text: string } {
  if (mult >= 50) return { from: "#ff3b6b", to: "#b30033", text: "#fff" };
  if (mult >= 10) return { from: "#ff6b35", to: "#c43a07", text: "#fff" };
  if (mult >= 3) return { from: "#ffb020", to: "#c47f00", text: "#1a1300" };
  if (mult >= 1.4) return { from: "#ffe066", to: "#caa022", text: "#1a1300" };
  if (mult >= 1) return { from: "#7be0a3", to: "#2f9e63", text: "#06210f" };
  return { from: "#2a4d5a", to: "#13313b", text: "#bfeefb" };
}

// ---------------------------------------------------------------------------
// Geometry. The board is laid out in a normalized 0..1 coordinate box; the
// SVG/HTML stretches it responsively. Peg row r (0-indexed) has (r + 3) pegs.
// Bucket b sits beneath the gap below the bottom peg row.
// ---------------------------------------------------------------------------
const TOP_PAD = 0.07; // fraction of height above the first peg row
const BOT_PAD = 0.16; // fraction reserved at the bottom for buckets

// Classic centered Galton geometry. The ball starts dead-center above row 0
// (one peg) and makes one left/right decision per row. We track the ball's
// horizontal position as a signed HALF-GAP offset from center:
//   row r has (r + 1) pegs at offsets {-r, -r+2, ..., r}.
//   reaching row r the ball sits on one of those pegs; L → offset-1, R → +1.
//   after `rows` rows the offset is (2*rights - rows) → bucket = rights.
interface BoardGeom {
  rows: number;
  pegRowY: number[]; // y per peg row
  rowY: (row: number) => number;
  // x (0..1) for a signed half-gap offset.
  xForOffset: (offset: number) => number;
  pegOffsets: (row: number) => number[]; // reachable offsets in a row
  bucketY: number;
  bucketX: (b: number) => number; // center x of bucket b
  halfGap: number;
}

function makeGeom(rows: number): BoardGeom {
  const playH = 1 - TOP_PAD - BOT_PAD;
  const pegRowY: number[] = [];
  for (let r = 0; r < rows; r++) {
    pegRowY.push(TOP_PAD + (playH * (r + 0.5)) / rows);
  }
  const bucketY = 1 - BOT_PAD * 0.5;

  // The widest spread is the bucket row at offsets ±rows. Keep it inside a
  // margin. fullGap spans two adjacent buckets; halfGap is one decision step.
  const margin = 0.07;
  const usableHalf = 0.5 - margin; // max |x - 0.5|
  const halfGap = usableHalf / rows; // offset of `rows` maps to the edge

  const xForOffset = (offset: number) => 0.5 + offset * halfGap;
  const rowY = (row: number) => pegRowY[row];

  const pegOffsets = (row: number) => {
    const out: number[] = [];
    for (let o = -row; o <= row; o += 2) out.push(o);
    return out;
  };

  // (rows + 1) buckets, bucket b centered at offset (2b - rows).
  const bucketX = (b: number) => xForOffset(2 * b - rows);

  return {
    rows,
    pegRowY,
    rowY,
    xForOffset,
    pegOffsets,
    bucketY,
    bucketX,
    halfGap,
  };
}

// ---------------------------------------------------------------------------
// A live ball. The full trajectory (peg-to-peg waypoints + bucket bounce) is
// precomputed; the render samples it by elapsed time for smooth physics-like
// motion. `dir` per row drives the peg-hit highlight.
// ---------------------------------------------------------------------------
interface Pt {
  x: number;
  y: number;
}

interface Ball {
  id: number;
  path: Pt[]; // normalized waypoints (incl. start, each peg, bucket bounce, rest)
  segDur: number[]; // duration (ms) per segment between path[i] -> path[i+1]
  totalDur: number;
  startedAt: number;
  bucket: number;
  mult: number;
  stake: number;
  resolved: boolean;
}

let BALL_SEQ = 0;

// Smooth a path point with a parabolic arc bias so the ball "falls" between
// pegs rather than sliding linearly. Vertical eased, horizontal eased.
function easeFall(t: number): number {
  // accelerate downward (gravity feel)
  return t * t * (1.15 - 0.15 * t);
}
function easeSide(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

function buildBall(geom: BoardGeom, risk: Risk, stake: number): Ball {
  const { rows } = geom;
  const path: Pt[] = [];
  const segDur: number[] = [];

  // Start dead-center, just above the top peg.
  path.push({ x: 0.5, y: TOP_PAD * 0.25 });

  // Fair 50/50 per peg. offset walks ±1 half-gap per row; the ball is drawn
  // sitting on the peg it strikes in each row.
  let offset = 0; // ball sits on the single peg at offset 0 in row 0
  let rights = 0;
  for (let r = 0; r < rows; r++) {
    // The peg struck in row r is at the ball's current offset.
    path.push({ x: geom.xForOffset(offset), y: geom.rowY(r) });
    segDur.push(118 + r * 5); // accelerating fall
    // Decide left/right off this peg.
    const right = chance(0.5);
    if (right) {
      rights += 1;
      offset += 1;
    } else {
      offset -= 1;
    }
  }

  const bucket = rights; // = number of right bounces
  const mult = PAYOUTS[rows as RowCount][risk][bucket] ?? 1;

  // Drop into the bucket, bounce once, settle.
  const bx = geom.bucketX(bucket);
  const landY = geom.bucketY - 0.015;
  path.push({ x: bx, y: landY }); // hit bucket floor
  segDur.push(150);
  path.push({ x: bx, y: landY - 0.035 }); // bounce up
  segDur.push(110);
  path.push({ x: bx, y: landY }); // settle
  segDur.push(110);

  const totalDur = segDur.reduce((s, d) => s + d, 0);

  return {
    id: ++BALL_SEQ,
    path,
    segDur,
    totalDur,
    startedAt: performance.now(),
    bucket,
    mult,
    stake,
    resolved: false,
  };
}

// Sample a ball's normalized position at elapsed time `el` (ms).
function sampleBall(ball: Ball, el: number): { p: Pt; lastPeg: number } {
  if (el <= 0) return { p: ball.path[0], lastPeg: -1 };
  let acc = 0;
  // The first `rows` segments are peg falls; index of segment == row reached.
  for (let i = 0; i < ball.segDur.length; i++) {
    const d = ball.segDur[i];
    if (el < acc + d) {
      const local = (el - acc) / d;
      const a = ball.path[i];
      const b = ball.path[i + 1];
      const isFall = i < ball.path.length - 4; // peg-fall segments
      const ty = isFall ? easeFall(local) : easeSide(local);
      const tx = easeSide(local);
      return {
        p: { x: a.x + (b.x - a.x) * tx, y: a.y + (b.y - a.y) * ty },
        lastPeg: i, // number of pegs passed
      };
    }
    acc += d;
  }
  return { p: ball.path[ball.path.length - 1], lastPeg: ball.path.length };
}

// ---------------------------------------------------------------------------
// Segmented control (rows / risk).
// ---------------------------------------------------------------------------
function Segmented<T extends string | number>({
  label,
  options,
  value,
  format,
  disabled,
  onChange,
  testidPrefix,
  layoutId,
}: {
  label: string;
  options: T[];
  value: T;
  format: (o: T) => string;
  disabled: boolean;
  onChange: (o: T) => void;
  testidPrefix: string;
  layoutId: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-[0.25em] text-white/40">
        {label}
      </span>
      <div className="flex items-center gap-1 rounded-xl border border-white/10 bg-black/30 p-1">
        {options.map((o) => {
          const active = o === value;
          return (
            <button
              key={String(o)}
              type="button"
              data-testid={`${testidPrefix}-${o}`}
              disabled={disabled}
              onClick={() => {
                if (disabled) return;
                sfx.click();
                onChange(o);
              }}
              className="relative flex-1 rounded-lg px-3 py-1.5 text-xs font-semibold uppercase tracking-wider transition-colors disabled:cursor-not-allowed disabled:opacity-40"
              style={{ color: active ? "#06181d" : "rgba(255,255,255,0.65)" }}
            >
              {active && (
                <motion.span
                  layoutId={layoutId}
                  className="absolute inset-0 rounded-lg"
                  style={{ background: ACCENT }}
                  transition={{ type: "spring", stiffness: 420, damping: 34 }}
                />
              )}
              <span className="relative">{format(o)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component.
// ---------------------------------------------------------------------------
interface ResultLog {
  id: number;
  bucket: number;
  mult: number;
  delta: number;
}

export default function Plinko() {
  const { balance, bet: placeBet, win, ready } = useWallet();

  const [bet, setBet] = useState(25);
  const [rows, setRows] = useState<RowCount>(12);
  const [risk, setRisk] = useState<Risk>("medium");

  const [balls, setBalls] = useState<Ball[]>([]);
  const [, forceTick] = useState(0); // RAF redraw pulse
  const ballsRef = useRef<Ball[]>([]);
  ballsRef.current = balls;

  // Per-bucket flash counter (bumps to retrigger the animation).
  const [bucketFlash, setBucketFlash] = useState<Record<number, number>>({});
  const [lastResult, setLastResult] = useState<ResultLog | null>(null);
  const [history, setHistory] = useState<ResultLog[]>([]);
  const [burstKey, setBurstKey] = useState(0);
  const [burstMult, setBurstMult] = useState(0);

  const geom = useMemo(() => makeGeom(rows), [rows]);
  const multipliers = PAYOUTS[rows][risk];

  const liveBalls = balls.length;
  const canAfford = bet >= MIN_BET && bet <= balance;

  // Keep bet affordable while idle.
  useEffect(() => {
    if (bet > balance) setBet(Math.max(0, balance));
  }, [balance, bet]);

  // -------------------------------------------------------------------------
  // Resolve a landed ball: pay out and flash its bucket.
  // -------------------------------------------------------------------------
  const resolveBall = useCallback(
    (b: Ball) => {
      const gross = Math.round(b.stake * b.mult);
      if (gross > 0) win(gross);
      const delta = gross - b.stake;
      const log: ResultLog = { id: b.id, bucket: b.bucket, mult: b.mult, delta };
      setLastResult(log);
      setHistory((h) => [log, ...h].slice(0, 18));
      setBucketFlash((f) => ({ ...f, [b.bucket]: (f[b.bucket] ?? 0) + 1 }));

      if (b.mult >= 10) {
        sfx.jackpot();
        sfx.thud();
        setBurstMult(b.mult);
        setBurstKey((k) => k + 1);
      } else if (b.mult >= 1) {
        sfx.win();
        if (b.mult > 1) {
          setBurstMult(b.mult);
          setBurstKey((k) => k + 1);
        } else {
          sfx.thud();
        }
      } else {
        sfx.lose();
        sfx.thud();
      }
    },
    [win],
  );

  // -------------------------------------------------------------------------
  // Animation loop: advance balls, resolve any that have landed, redraw.
  // -------------------------------------------------------------------------
  const rafRef = useRef<number | null>(null);
  const lastPegPassed = useRef<Map<number, number>>(new Map());
  const resolveRef = useRef(resolveBall);
  resolveRef.current = resolveBall;
  // Guard setTimeout callbacks against firing after the component unmounts.
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    let running = true;

    const frame = () => {
      if (!running) return;
      const now = performance.now();
      const current = ballsRef.current;
      if (current.length > 0) {
        const finished: Ball[] = [];
        for (const b of current) {
          const el = now - b.startedAt;
          // Peg tick sounds as the ball passes each peg row (segments 0..rows-1).
          // Use strict less-than so the bucket-arrival segment doesn't trigger an
          // extra tick; path.length - 4 equals the number of peg rows.
          const { lastPeg } = sampleBall(b, el);
          const prev = lastPegPassed.current.get(b.id) ?? -1;
          if (lastPeg > prev && lastPeg < b.path.length - 4) {
            lastPegPassed.current.set(b.id, lastPeg);
            sfx.tick();
          }
          if (!b.resolved && el >= b.totalDur) {
            b.resolved = true;
            finished.push(b);
          }
        }

        if (finished.length > 0) {
          for (const b of finished) resolveRef.current(b);
          // Remove resolved balls a touch after they settle.
          setTimeout(() => {
            if (!mountedRef.current) return;
            const ids = new Set(finished.map((f) => f.id));
            setBalls((bs) => bs.filter((x) => !ids.has(x.id)));
            for (const f of finished) lastPegPassed.current.delete(f.id);
          }, 260);
        }

        forceTick((t) => (t + 1) & 0xffff);
      }
      rafRef.current = requestAnimationFrame(frame);
    };

    rafRef.current = requestAnimationFrame(frame);
    return () => {
      running = false;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  // -------------------------------------------------------------------------
  // Drop a ball.
  // -------------------------------------------------------------------------
  const drop = useCallback(() => {
    if (!canAfford) return;
    if (!placeBet(bet)) return;
    sfx.chip();
    const ball = buildBall(geom, risk, bet);
    setBalls((bs) => [...bs, ball]);
  }, [canAfford, placeBet, bet, geom, risk]);

  // Lock row/risk edits only while balls are in flight (bet itself is locked
  // mid-flight too, so each ball uses a consistent stake/board).
  const optionsLocked = liveBalls > 0;
  const betLocked = liveBalls > 0;

  // House edge (RTP) readout per table.
  const houseInfo = useMemo(() => {
    // Probability of bucket k = C(n,k) / 2^n.
    const n = rows;
    const logC: number[] = [];
    let acc = 0;
    logC[0] = 0;
    for (let k = 1; k <= n; k++) {
      acc += Math.log((n - k + 1) / k);
      logC[k] = acc;
    }
    const denom = n * Math.log(2);
    let rtp = 0;
    for (let k = 0; k <= n; k++) {
      const p = Math.exp(logC[k] - denom);
      rtp += p * multipliers[k];
    }
    return { rtp };
  }, [rows, multipliers]);

  const maxMult = Math.max(...multipliers);

  return (
    <div className="mx-auto w-full max-w-3xl px-2 py-3 sm:py-5">
      <div
        className="felt relative overflow-hidden rounded-3xl border border-white/10 p-4 shadow-felt sm:p-6"
        style={{
          background:
            "radial-gradient(120% 90% at 50% 0%, #0c2730 0%, #08171c 60%, #050d10 100%)",
        }}
      >
        {/* ambient accent glow */}
        <div
          className="pointer-events-none absolute -top-24 left-1/2 h-64 w-64 -translate-x-1/2 rounded-full"
          style={{
            background: `radial-gradient(circle, ${ACCENT}22, transparent 70%)`,
            filter: "blur(10px)",
          }}
        />

        {/* Header */}
        <div className="relative mb-3 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="font-display text-2xl tracking-wide text-white sm:text-3xl">
              Plinko
            </h2>
            <p className="text-xs text-white/50">
              Drop the ball — ride the pegs to a multiplier. Up to{" "}
              <span style={{ color: ACCENT }}>{formatMultiplier(maxMult)}</span>.
            </p>
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <Segmented
              label="Rows"
              options={ROW_OPTIONS}
              value={rows}
              format={(o) => String(o)}
              disabled={optionsLocked}
              onChange={(o) => setRows(o)}
              testidPrefix="rows"
              layoutId="plinko-rows-pill"
            />
            <Segmented
              label="Risk"
              options={RISK_OPTIONS}
              value={risk}
              format={(o) => o[0].toUpperCase() + o.slice(1)}
              disabled={optionsLocked}
              onChange={(o) => setRisk(o)}
              testidPrefix="risk"
              layoutId="plinko-risk-pill"
            />
          </div>
        </div>

        {/* ===== Board ===== */}
        <div className="relative">
          <div
            className="relative w-full overflow-hidden rounded-2xl border border-white/5 bg-black/30"
            style={{ aspectRatio: "1 / 0.92" }}
          >
            {/* win burst overlay */}
            <AnimatePresence>
              {burstKey > 0 && (
                <motion.div
                  key={`burst-${burstKey}`}
                  className="pointer-events-none absolute inset-0 z-30 grid place-items-center"
                  initial={{ opacity: 1 }}
                  animate={{ opacity: 0 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 1.2 }}
                >
                  <motion.div
                    initial={{ scale: 0.5, opacity: 0, y: 0 }}
                    animate={{ scale: 1.15, opacity: [0, 1, 1, 0], y: -28 }}
                    transition={{ duration: 1.1, times: [0, 0.18, 0.7, 1] }}
                    className="text-4xl font-extrabold tabular-nums sm:text-5xl"
                    style={{
                      color: burstMult >= 50 ? "#ff3b6b" : ACCENT,
                      textShadow: `0 0 26px ${
                        burstMult >= 50 ? "#ff3b6b" : ACCENT
                      }cc`,
                    }}
                  >
                    {formatMultiplier(burstMult)}
                  </motion.div>
                  {Array.from({ length: 18 }).map((_, i) => {
                    const a = (i / 18) * Math.PI * 2;
                    return (
                      <motion.span
                        key={i}
                        className="absolute h-2 w-2 rounded-full"
                        style={{
                          background:
                            i % 3 === 0
                              ? "#f5d060"
                              : i % 3 === 1
                                ? ACCENT
                                : "#ff3b6b",
                        }}
                        initial={{ x: 0, y: 0, scale: 1, opacity: 1 }}
                        animate={{
                          x: Math.cos(a) * 170,
                          y: Math.sin(a) * 170,
                          scale: 0,
                          opacity: 0,
                        }}
                        transition={{ duration: 1.05, ease: "easeOut" }}
                      />
                    );
                  })}
                </motion.div>
              )}
            </AnimatePresence>

            {/* SVG pegs + balls */}
            <svg
              viewBox="0 0 100 92"
              preserveAspectRatio="none"
              className="absolute inset-0 h-full w-full"
            >
              <defs>
                <radialGradient id="pegGrad" cx="40%" cy="35%" r="70%">
                  <stop offset="0%" stopColor="#ffffff" />
                  <stop offset="55%" stopColor="#cfe9f2" />
                  <stop offset="100%" stopColor="#6f97a3" />
                </radialGradient>
                <radialGradient id="ballGrad" cx="38%" cy="32%" r="75%">
                  <stop offset="0%" stopColor="#ffffff" />
                  <stop offset="35%" stopColor={ACCENT} />
                  <stop offset="100%" stopColor="#0b6f86" />
                </radialGradient>
                <filter id="ballGlow" x="-60%" y="-60%" width="220%" height="220%">
                  <feGaussianBlur stdDeviation="0.9" result="b" />
                  <feMerge>
                    <feMergeNode in="b" />
                    <feMergeNode in="SourceGraphic" />
                  </feMerge>
                </filter>
              </defs>

              {/* pegs — centered Galton triangle, row r has (r + 1) pegs */}
              {geom.pegRowY.map((py, r) =>
                geom.pegOffsets(r).map((o) => {
                  const px = geom.xForOffset(o);
                  return (
                    <circle
                      key={`${r}-${o}`}
                      cx={px * 100}
                      cy={py * 92}
                      r={Math.max(0.42, 0.95 - rows * 0.018)}
                      fill="url(#pegGrad)"
                      stroke="rgba(0,0,0,0.25)"
                      strokeWidth={0.12}
                    />
                  );
                }),
              )}

              {/* balls */}
              {balls.map((b) => {
                const el = performance.now() - b.startedAt;
                const { p } = sampleBall(b, el);
                return (
                  <circle
                    key={b.id}
                    cx={p.x * 100}
                    cy={p.y * 92}
                    r={Math.max(0.9, 1.7 - rows * 0.03)}
                    fill="url(#ballGrad)"
                    filter="url(#ballGlow)"
                  />
                );
              })}
            </svg>

            {/* ===== Buckets — absolutely positioned to align exactly with the
                ball's landing x (bucketX). Each spans one full gap. ===== */}
            <div
              className="absolute inset-x-0 bottom-0"
              style={{ height: `${BOT_PAD * 100 * (1 / 0.92)}%` }}
            >
              {multipliers.map((m, b) => {
                const tint = bucketTint(m);
                const flash = bucketFlash[b] ?? 0;
                const cx = geom.bucketX(b) * 100; // percent center
                const w = geom.halfGap * 2 * 100; // percent width (one full gap)
                return (
                  <div
                    key={b}
                    data-testid={`bucket-${b}`}
                    className="absolute bottom-0 flex items-center justify-center overflow-visible rounded-md text-center font-bold tabular-nums"
                    style={{
                      left: `${cx}%`,
                      bottom: 0,
                      top: 0,
                      width: `calc(${w}% - 2px)`,
                      transform: "translateX(-50%)",
                      background: `linear-gradient(180deg, ${tint.from}, ${tint.to})`,
                      color: tint.text,
                      fontSize:
                        rows >= 16
                          ? "0.5rem"
                          : rows >= 12
                            ? "0.62rem"
                            : "0.78rem",
                      boxShadow: "inset 0 2px 0 rgba(255,255,255,0.25)",
                    }}
                  >
                    {/* flash ping: remounts on every hit so it replays even when
                        the same bucket is struck repeatedly. */}
                    <AnimatePresence>
                      {flash > 0 && (
                        <motion.span
                          key={flash}
                          className="pointer-events-none absolute inset-0 rounded-md"
                          initial={{ opacity: 0.9, scale: 1 }}
                          animate={{ opacity: 0, scale: 1.35, y: 6 }}
                          exit={{ opacity: 0 }}
                          transition={{ duration: 0.5, ease: "easeOut" }}
                          style={{
                            boxShadow: `0 0 20px 4px ${tint.from}`,
                            background: "rgba(255,255,255,0.35)",
                          }}
                        />
                      )}
                    </AnimatePresence>
                    <motion.span
                      key={`label-${flash}`}
                      className="relative px-0.5 leading-none"
                      initial={false}
                      animate={
                        flash > 0 ? { scale: [1, 1.28, 1], y: [0, 4, 0] } : {}
                      }
                      transition={{ duration: 0.42 }}
                    >
                      {m >= 100 ? `${m}×` : formatMultiplier(m)}
                    </motion.span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* ===== Round result ===== */}
        <div className="relative mt-3 min-h-[58px]">
          <AnimatePresence mode="wait">
            {lastResult ? (
              <motion.div
                key={lastResult.id}
                data-testid="round-result"
                initial={{ opacity: 0, y: 10, scale: 0.96 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -8 }}
                className="flex items-center justify-center gap-3 rounded-2xl px-4 py-3 text-center"
                style={{
                  background:
                    lastResult.mult >= 1
                      ? "rgba(34,225,255,0.10)"
                      : "rgba(220,38,38,0.12)",
                  border: `1px solid ${
                    lastResult.mult >= 1 ? ACCENT : "#dc2626"
                  }55`,
                }}
              >
                <span className="text-2xl">
                  {lastResult.mult >= 10
                    ? "💎"
                    : lastResult.mult >= 1
                      ? "🟢"
                      : "🔻"}
                </span>
                <div className="text-left">
                  <div
                    className="text-base font-extrabold tracking-wide sm:text-lg"
                    style={{
                      color: lastResult.mult >= 1 ? "#fff" : "#fca5a5",
                    }}
                  >
                    {formatMultiplier(lastResult.mult)} ·{" "}
                    {lastResult.mult > 1
                      ? "Win!"
                      : lastResult.mult === 1
                        ? "Push"
                        : "Below stake"}
                  </div>
                  <div
                    className="text-sm font-bold tabular-nums"
                    style={{
                      color: lastResult.delta >= 0 ? "#86efac" : "#fca5a5",
                    }}
                  >
                    {formatDelta(lastResult.delta)} chips
                  </div>
                </div>
              </motion.div>
            ) : (
              <motion.div
                key="hint"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="flex items-center justify-center rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-center text-xs text-white/50"
              >
                Set your bet, pick rows &amp; risk, then DROP. Center buckets are
                most likely; the edges pay big.
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* ===== Drop button ===== */}
        <div className="relative mt-4 flex flex-col items-stretch gap-2 sm:flex-row sm:justify-center">
          <Button
            data-testid="play-btn"
            variant="gold"
            size="lg"
            block
            disabled={!canAfford}
            onClick={drop}
            className="sm:flex-1"
          >
            {liveBalls > 0
              ? `Drop Ball (${liveBalls} in play)`
              : `Drop Ball · ${formatChips(bet)}`}
          </Button>
          {/* Secondary handle so a "drop-btn" selector also resolves. */}
          <button
            type="button"
            data-testid="drop-btn"
            aria-hidden
            tabIndex={-1}
            disabled={!canAfford}
            onClick={drop}
            className="sr-only absolute h-px w-px overflow-hidden"
          >
            Drop
          </button>
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
              Bet &amp; board locked while balls are in play
            </div>
          )}
        </div>

        {/* ===== Paytable + history ===== */}
        <div className="relative mt-4 grid gap-3 sm:grid-cols-2">
          <div className="glass rounded-2xl p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[10px] uppercase tracking-[0.25em] text-white/40">
                Paytable · {rows} rows · {risk}
              </span>
              <span className="text-[10px] text-white/30">
                RTP {(houseInfo.rtp * 100).toFixed(1)}%
              </span>
            </div>
            {/* unique multipliers (left half + center), buckets are symmetric */}
            <div className="flex flex-wrap gap-1.5">
              {multipliers
                .slice(0, Math.ceil(multipliers.length / 2))
                .map((m, i) => {
                  const tint = bucketTint(m);
                  return (
                    <div
                      key={i}
                      className="rounded-md px-2 py-1 text-[11px] font-bold tabular-nums"
                      style={{
                        background: `linear-gradient(180deg, ${tint.from}, ${tint.to})`,
                        color: tint.text,
                      }}
                    >
                      {m >= 100 ? `${m}×` : formatMultiplier(m)}
                    </div>
                  );
                })}
            </div>
            <div className="mt-2 text-[10px] text-white/35">
              Symmetric — edge buckets pay the most, the center the least. Each
              peg is a fair 50/50.
            </div>
          </div>

          <div className="glass rounded-2xl p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[10px] uppercase tracking-[0.25em] text-white/40">
                Last Drops
              </span>
              <span className="text-[10px] text-white/30">newest first</span>
            </div>
            <div className="flex min-h-[34px] flex-wrap gap-1.5">
              <AnimatePresence initial={false}>
                {history.length === 0 && (
                  <span className="text-xs text-white/30">No drops yet.</span>
                )}
                {history.map((h) => {
                  const tint = bucketTint(h.mult);
                  return (
                    <motion.span
                      key={h.id}
                      initial={{ scale: 0, opacity: 0 }}
                      animate={{ scale: 1, opacity: 1 }}
                      className="grid h-7 min-w-[2.4rem] place-items-center rounded-md px-1 text-[10px] font-bold tabular-nums"
                      style={{
                        background: `linear-gradient(180deg, ${tint.from}, ${tint.to})`,
                        color: tint.text,
                      }}
                      title={`Bucket ${h.bucket} · ${formatDelta(h.delta)}`}
                    >
                      {h.mult >= 100 ? `${h.mult}×` : formatMultiplier(h.mult)}
                    </motion.span>
                  );
                })}
              </AnimatePresence>
            </div>
          </div>
        </div>

        {/* live balance */}
        <div className="relative mt-3 text-center text-xs text-white/40">
          Balance:{" "}
          <span className="font-semibold text-white/70 tabular-nums">
            {ready ? <CountingNumber value={balance} /> : "—"}
          </span>
        </div>
      </div>
    </div>
  );
}
