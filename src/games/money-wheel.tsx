"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useWallet } from "@/lib/wallet";
import { sfx } from "@/lib/sound";
import { formatDelta } from "@/lib/format";
import { weightedPick, randFloat } from "@/lib/rng";
import { Button } from "@/components/ui/Button";
import { BetControls } from "@/components/BetControls";
import { CountingNumber } from "@/components/CountingNumber";

/* ----------------------------------------------------------------------------
 * Big Six Money Wheel (Wheel of Fortune).
 *
 * 54 segments labeled with multipliers:
 *   1  -> 24 segments   pays 1:1   -> win(stake * 2)
 *   2  -> 15 segments   pays 2:1   -> win(stake * 3)
 *   5  ->  7 segments   pays 5:1   -> win(stake * 6)
 *   10 ->  4 segments   pays 10:1  -> win(stake * 11)
 *   20 ->  2 segments   pays 20:1  -> win(stake * 21)
 *   JOKER  -> 1 segment  pays 40:1 -> win(stake * 41)
 *   CASINO -> 1 segment  pays 40:1 -> win(stake * 41)
 *
 * Player picks a single segment value. Spin the wheel; it decelerates to the
 * fixed pointer at 12 o'clock. If the landed segment matches the bet, pay
 * value:1 (the 40:1 logos pay 40:1). All money flows through useWallet().
 * ------------------------------------------------------------------------- */

const ACCENT = "#f5d060";
const MIN_BET = 5;

type SpotKind = "value" | "logo";

interface Spot {
  /** Stable key used for bet selection. */
  key: string;
  /** Display label on the wheel + buttons. */
  label: string;
  /** Multiplier paid as x:1 (gross payout multiplier is mult + 1). */
  mult: number;
  /** Number of segments carrying this label. */
  count: number;
  /** Segment fill color. */
  color: string;
  /** Bright glow color. */
  glow: string;
  kind: SpotKind;
}

/** The six bettable spots. Order roughly by frequency (best odds first). */
const SPOTS: Spot[] = [
  { key: "1", label: "1", mult: 1, count: 24, color: "#1f9d5a", glow: "#3ee08a", kind: "value" },
  { key: "2", label: "2", mult: 2, count: 15, color: "#2563c9", glow: "#5aa0ff", kind: "value" },
  { key: "5", label: "5", mult: 5, count: 7, color: "#d9534f", glow: "#ff7b76", kind: "value" },
  { key: "10", label: "10", mult: 10, count: 4, color: "#7c3aed", glow: "#b388ff", kind: "value" },
  { key: "20", label: "20", mult: 20, count: 2, color: "#0e7490", glow: "#22e1ff", kind: "value" },
  { key: "joker", label: "JOKER", mult: 40, count: 1, color: "#caa022", glow: "#f5d060", kind: "logo" },
  { key: "casino", label: "CASINO", mult: 40, count: 1, color: "#caa022", glow: "#f5d060", kind: "logo" },
];

const TOTAL_SEGMENTS = SPOTS.reduce((s, sp) => s + sp.count, 0); // 54
const SEG_ANGLE = 360 / TOTAL_SEGMENTS; // ~6.667°
const TWO_PI = Math.PI * 2;

interface Segment {
  spot: Spot;
  /** Index 0..53 around the ring (0 at top, growing clockwise). */
  index: number;
}

/**
 * Build the physical 54-segment ring. We interleave the labels so high payouts
 * are spread out (like a real Big Six wheel) rather than clustered. Greedy
 * "most remaining" placement keeps the distribution visually even.
 */
function buildRing(): Segment[] {
  const remaining = SPOTS.map((s) => ({ spot: s, left: s.count }));
  const order: Spot[] = [];
  // Place logos at fixed, opposite-ish anchors so they're never adjacent.
  const anchors: Record<number, string> = { 0: "joker", 27: "casino" };
  const slots: (Spot | null)[] = new Array(TOTAL_SEGMENTS).fill(null);

  for (const [pos, key] of Object.entries(anchors)) {
    const idx = Number(pos);
    const spot = SPOTS.find((s) => s.key === key);
    if (spot) {
      slots[idx] = spot;
      const r = remaining.find((x) => x.spot.key === key);
      if (r) r.left -= 1;
    }
  }

  // Fill the rest greedily, always taking the value-spot with the most left,
  // avoiding placing the same label in two adjacent slots when possible.
  for (let i = 0; i < TOTAL_SEGMENTS; i++) {
    if (slots[i]) continue;
    const prev = slots[(i - 1 + TOTAL_SEGMENTS) % TOTAL_SEGMENTS];
    const candidates = remaining
      .filter((r) => r.left > 0 && r.spot.kind === "value")
      .sort((a, b) => b.left - a.left);
    let chosen = candidates.find((c) => c.spot.key !== prev?.key) ?? candidates[0];
    if (chosen) {
      slots[i] = chosen.spot;
      chosen.left -= 1;
    }
  }

  for (let i = 0; i < TOTAL_SEGMENTS; i++) {
    const spot = slots[i] ?? SPOTS[0];
    order.push(spot);
  }
  return order.map((spot, index) => ({ spot, index }));
}

type Phase = "betting" | "spinning" | "resolved";

interface RoundResult {
  segment: Segment;
  win: boolean;
  payout: number; // gross returned
  profit: number; // net (payout - stake)
  stake: number;
}

export default function MoneyWheel() {
  const wallet = useWallet();

  const ring = useMemo(() => buildRing(), []);

  const [bet, setBet] = useState(50);
  const [pick, setPick] = useState<string>("5");
  const [phase, setPhase] = useState<Phase>("betting");

  // Cumulative wheel rotation in degrees (always increasing for forward spin).
  const [rotation, setRotation] = useState(0);
  const [result, setResult] = useState<RoundResult | null>(null);
  const [resultText, setResultText] = useState("");
  const [lastLanded, setLastLanded] = useState<string[]>([]);
  const [burst, setBurst] = useState(0);

  const tickTimers = useRef<number[]>([]);
  const resolveTimer = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      tickTimers.current.forEach((t) => clearTimeout(t));
      if (resolveTimer.current) clearTimeout(resolveTimer.current);
    };
  }, []);

  const selectedSpot = useMemo(
    () => SPOTS.find((s) => s.key === pick) ?? SPOTS[0],
    [pick],
  );

  const canSpin =
    phase === "betting" && wallet.ready && bet >= MIN_BET && bet <= wallet.balance;

  // The pointer sits at the top (12 o'clock). The wheel is drawn so segment 0's
  // CENTER is at the top when rotation === 0. To land segment `i`, we must
  // rotate the wheel by -i*SEG_ANGLE (mod 360), plus extra full turns.
  const landSegmentUnderPointer = useCallback(
    (segIndex: number, current: number) => {
      const turns = 6; // full revolutions for drama
      // jitter within the segment so the pointer never sits dead-center
      const jitter = randFloat(-SEG_ANGLE * 0.32, SEG_ANGLE * 0.32);
      // Desired final orientation (mod 360) that puts segIndex at the top.
      const targetMod = (360 - ((segIndex * SEG_ANGLE) % 360) + 360) % 360;
      const currentMod = ((current % 360) + 360) % 360;
      let advance = (targetMod - currentMod + 360) % 360;
      const final = current + turns * 360 + advance + jitter;
      return final;
    },
    [],
  );

  const spin = useCallback(() => {
    if (phase !== "betting") return;
    const stake = Math.floor(bet);
    if (stake < MIN_BET) return;
    if (!wallet.bet(stake)) return; // unaffordable -> abort

    sfx.chip();

    // Choose the winning segment weighted purely by physical segment count
    // (each of the 54 segments equally likely). Pick a segment index uniformly.
    const winningIndex = weightedPick(
      ring.map((s) => s.index),
      ring.map(() => 1),
    );
    const landed = ring[winningIndex];

    setPhase("spinning");
    setResult(null);
    setResultText("");
    setBurst(0);

    const finalRotation = landSegmentUnderPointer(winningIndex, rotation);
    const spinDuration = 4.6; // seconds, must match transition below
    setRotation(finalRotation);

    // Schedule clack ticks that thin out as the wheel decelerates.
    tickTimers.current.forEach((t) => clearTimeout(t));
    tickTimers.current = [];
    const totalTicks = 46;
    for (let i = 0; i < totalTicks; i++) {
      const p = i / totalTicks;
      // ease-out cubic timing -> ticks bunch early, spread late
      const at = (1 - Math.pow(1 - p, 3)) * spinDuration * 1000;
      const id = window.setTimeout(() => sfx.tick(), at);
      tickTimers.current.push(id);
    }

    // Resolve after the spin completes.
    resolveTimer.current = window.setTimeout(() => {
      sfx.thud();
      const matched = landed.spot.key === selectedSpot.key;
      const gross = matched ? stake * (landed.spot.mult + 1) : 0;
      if (matched) wallet.win(gross);

      const res: RoundResult = {
        segment: landed,
        win: matched,
        payout: gross,
        profit: gross - stake,
        stake,
      };
      setResult(res);
      setLastLanded((prev) => [landed.spot.label, ...prev].slice(0, 12));

      if (matched) {
        setBurst((b) => b + 1);
        if (landed.spot.mult >= 20) {
          sfx.jackpot();
          setResultText(
            `${landed.spot.label} — ${landed.spot.mult}:1! ${formatDelta(gross - stake)}`,
          );
        } else {
          sfx.win();
          setResultText(
            `Landed ${landed.spot.label} — pays ${landed.spot.mult}:1 ${formatDelta(
              gross - stake,
            )}`,
          );
        }
      } else {
        sfx.lose();
        setResultText(
          `Landed ${landed.spot.label} — your ${selectedSpot.label} missed ${formatDelta(
            -stake,
          )}`,
        );
      }
      setPhase("resolved");
    }, spinDuration * 1000 + 120);
  }, [phase, bet, wallet, ring, rotation, selectedSpot, landSegmentUnderPointer]);

  const newRound = useCallback(() => {
    if (phase !== "resolved") return;
    sfx.click();
    setPhase("betting");
    setResult(null);
    setResultText("");
    setBurst(0);
  }, [phase]);

  // -------------------------------------------------------------------------
  // Wheel geometry (SVG). Drawn with segment 0 centered at the top.
  // -------------------------------------------------------------------------
  const R = 160; // outer radius
  const RIM = 14; // rim thickness
  const HUB = 34; // hub radius
  const VIEW = (R + RIM + 6) * 2;
  const C = VIEW / 2;

  const segPaths = useMemo(() => {
    return ring.map((seg) => {
      // Center the segment at angle = index*SEG_ANGLE, measured clockwise from
      // the top (12 o'clock). Convert to standard math angle for SVG.
      const centerDeg = seg.index * SEG_ANGLE;
      const startDeg = centerDeg - SEG_ANGLE / 2;
      const endDeg = centerDeg + SEG_ANGLE / 2;
      const toXY = (deg: number, radius: number) => {
        // 0deg => top, clockwise positive.
        const rad = ((deg - 90) * Math.PI) / 180;
        return [C + radius * Math.cos(rad), C + radius * Math.sin(rad)] as const;
      };
      const [sx, sy] = toXY(startDeg, R);
      const [ex, ey] = toXY(endDeg, R);
      const [isx, isy] = toXY(startDeg, HUB);
      const [iex, iey] = toXY(endDeg, HUB);
      const largeArc = SEG_ANGLE > 180 ? 1 : 0;
      const d = [
        `M ${isx.toFixed(2)} ${isy.toFixed(2)}`,
        `L ${sx.toFixed(2)} ${sy.toFixed(2)}`,
        `A ${R} ${R} 0 ${largeArc} 1 ${ex.toFixed(2)} ${ey.toFixed(2)}`,
        `L ${iex.toFixed(2)} ${iey.toFixed(2)}`,
        `A ${HUB} ${HUB} 0 ${largeArc} 0 ${isx.toFixed(2)} ${isy.toFixed(2)}`,
        "Z",
      ].join(" ");
      // Label position
      const [lx, ly] = toXY(centerDeg, (R + HUB) / 2);
      return { seg, d, lx, ly, centerDeg };
    });
  }, [ring, C, R, HUB]);

  return (
    <div className="mx-auto w-full max-w-5xl px-3 pb-10">
      <div className="felt relative overflow-hidden rounded-3xl border border-white/10 p-4 shadow-felt sm:p-6">
        {/* ambient glow */}
        <div
          className="pointer-events-none absolute -inset-24 opacity-30 blur-3xl"
          style={{
            background: `radial-gradient(circle at 50% 0%, ${ACCENT}33, transparent 60%)`,
          }}
        />

        <div className="relative grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
          {/* LEFT: the wheel showpiece */}
          <div className="flex flex-col items-center">
            <WheelStage
              VIEW={VIEW}
              C={C}
              R={R}
              RIM={RIM}
              HUB={HUB}
              rotation={rotation}
              segPaths={segPaths}
              spinning={phase === "spinning"}
              selectedKey={selectedSpot.key}
              burst={burst}
              result={result}
            />

            {/* Result banner */}
            <div className="mt-4 min-h-[58px] w-full max-w-md">
              <AnimatePresence mode="wait">
                {resultText ? (
                  <motion.div
                    key={resultText}
                    data-testid="round-result"
                    initial={{ opacity: 0, y: 12, scale: 0.94 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: -8 }}
                    transition={{ type: "spring", stiffness: 320, damping: 22 }}
                    className="rounded-2xl border px-4 py-3 text-center font-display text-base font-bold sm:text-lg"
                    style={{
                      borderColor: result?.win ? `${ACCENT}aa` : "#ffffff22",
                      background: result?.win
                        ? `linear-gradient(180deg, ${ACCENT}22, transparent)`
                        : "rgba(0,0,0,0.35)",
                      color: result?.win ? ACCENT : "rgba(255,255,255,0.7)",
                      textShadow: result?.win ? `0 0 16px ${ACCENT}66` : "none",
                    }}
                  >
                    {resultText}
                  </motion.div>
                ) : (
                  <motion.div
                    key="placeholder"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="rounded-2xl border border-white/10 bg-black/30 px-4 py-3 text-center text-sm text-white/45"
                  >
                    {phase === "spinning"
                      ? "Spinning…"
                      : `Bet on ${selectedSpot.label} · pays ${selectedSpot.mult}:1`}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            {/* Recent landings ticker */}
            {lastLanded.length > 0 && (
              <div className="mt-3 flex w-full max-w-md flex-wrap items-center justify-center gap-1.5">
                <span className="text-[10px] uppercase tracking-widest text-white/35">
                  Recent
                </span>
                {lastLanded.map((l, i) => {
                  const sp = SPOTS.find((s) => s.label === l) ?? SPOTS[0];
                  return (
                    <span
                      key={`${l}-${i}`}
                      className="grid h-6 min-w-[24px] place-items-center rounded-md px-1.5 text-[11px] font-bold"
                      style={{
                        background: `${sp.color}33`,
                        color: sp.glow,
                        border: `1px solid ${sp.glow}55`,
                        opacity: 1 - i * 0.06,
                      }}
                    >
                      {sp.kind === "logo" ? (l === "JOKER" ? "🃏" : "♛") : l}
                    </span>
                  );
                })}
              </div>
            )}
          </div>

          {/* RIGHT: controls + paytable */}
          <div className="flex flex-col gap-4">
            {/* Stake readouts */}
            <div className="grid grid-cols-2 gap-2">
              <Readout label="Balance" value={wallet.balance} accent={ACCENT} />
              <Readout
                label={result?.win ? "Last Payout" : "Stake"}
                value={result ? (result.win ? result.payout : result.stake) : bet}
                accent={result?.win ? "#3ee08a" : ACCENT}
              />
            </div>

            {/* Pick a segment */}
            <div className="glass rounded-2xl p-3">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-[10px] uppercase tracking-widest text-white/40">
                  Pick a segment
                </span>
                <span className="text-[10px] text-white/40">
                  {TOTAL_SEGMENTS} segments
                </span>
              </div>
              <div className="grid grid-cols-3 gap-2">
                {SPOTS.map((sp) => {
                  const active = sp.key === pick;
                  const odds = ((sp.count / TOTAL_SEGMENTS) * 100).toFixed(1);
                  return (
                    <motion.button
                      key={sp.key}
                      type="button"
                      data-testid={`bet-${sp.key}`}
                      disabled={phase === "spinning"}
                      onClick={() => {
                        if (phase === "spinning") return;
                        sfx.click();
                        setPick(sp.key);
                      }}
                      whileHover={phase !== "spinning" ? { y: -2 } : undefined}
                      whileTap={phase !== "spinning" ? { scale: 0.95 } : undefined}
                      className="relative flex flex-col items-center gap-0.5 rounded-xl border px-2 py-2 transition disabled:opacity-50"
                      style={{
                        borderColor: active ? sp.glow : "rgba(255,255,255,0.1)",
                        background: active
                          ? `linear-gradient(180deg, ${sp.color}66, ${sp.color}22)`
                          : "rgba(0,0,0,0.3)",
                        boxShadow: active ? `0 0 16px ${sp.glow}66` : "none",
                      }}
                    >
                      <span
                        className="font-display text-lg font-extrabold leading-none"
                        style={{ color: active ? "#fff" : sp.glow }}
                      >
                        {sp.kind === "logo"
                          ? sp.label === "JOKER"
                            ? "🃏"
                            : "♛"
                          : sp.label}
                      </span>
                      <span className="text-[10px] font-semibold text-white/70">
                        {sp.mult}:1
                      </span>
                      <span className="text-[9px] text-white/35">{odds}%</span>
                    </motion.button>
                  );
                })}
              </div>
            </div>

            {/* Bet controls */}
            <BetControls
              bet={bet}
              setBet={setBet}
              balance={wallet.balance}
              min={MIN_BET}
              chips={[5, 25, 100, 500]}
              disabled={phase === "spinning"}
            />

            {/* Primary action */}
            {phase === "resolved" ? (
              <Button
                data-testid="play-btn"
                variant="gold"
                size="lg"
                block
                onClick={newRound}
              >
                Spin Again
              </Button>
            ) : (
              <Button
                data-testid="play-btn"
                variant="gold"
                size="lg"
                block
                disabled={!canSpin}
                onClick={spin}
              >
                {phase === "spinning" ? (
                  <span className="inline-flex items-center gap-2">
                    <motion.span
                      animate={{ rotate: 360 }}
                      transition={{ repeat: Infinity, ease: "linear", duration: 0.9 }}
                      className="inline-block"
                    >
                      ◉
                    </motion.span>
                    Spinning…
                  </span>
                ) : bet > wallet.balance ? (
                  "Insufficient Chips"
                ) : (
                  <span>
                    Spin · <CountingNumber value={bet} duration={560} className="tabular-nums" /> on {selectedSpot.label}
                  </span>
                )}
              </Button>
            )}

            {/* Paytable / odds */}
            <div className="glass rounded-2xl p-3">
              <div className="mb-2 text-[10px] uppercase tracking-widest text-white/40">
                Paytable & Odds
              </div>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-[10px] uppercase tracking-wider text-white/35">
                    <th className="pb-1 text-left">Spot</th>
                    <th className="pb-1 text-center">Segs</th>
                    <th className="pb-1 text-center">Pays</th>
                    <th className="pb-1 text-right">Odds</th>
                  </tr>
                </thead>
                <tbody>
                  {SPOTS.map((sp) => {
                    const active = sp.key === pick;
                    return (
                      <tr
                        key={sp.key}
                        className="border-t border-white/5"
                        style={{
                          background: active ? `${sp.color}1f` : "transparent",
                        }}
                      >
                        <td className="py-1">
                          <span
                            className="inline-flex items-center gap-1.5 font-semibold"
                            style={{ color: sp.glow }}
                          >
                            <span
                              className="inline-block h-2.5 w-2.5 rounded-sm"
                              style={{ background: sp.color }}
                            />
                            {sp.kind === "logo"
                              ? sp.label === "JOKER"
                                ? "🃏 Joker"
                                : "♛ Casino"
                              : sp.label}
                          </span>
                        </td>
                        <td className="py-1 text-center tabular-nums text-white/70">
                          {sp.count}
                        </td>
                        <td className="py-1 text-center font-semibold tabular-nums text-white">
                          {sp.mult}:1
                        </td>
                        <td className="py-1 text-right tabular-nums text-white/50">
                          {((sp.count / TOTAL_SEGMENTS) * 100).toFixed(1)}%
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <p className="mt-2 text-[10px] leading-relaxed text-white/35">
                Win pays the segment value to 1 (stake returned plus profit). The
                two logo segments each pay 40:1.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Wheel stage: the rotating SVG wheel, pointer, hub, and win burst.           */
/* -------------------------------------------------------------------------- */

interface SegPath {
  seg: Segment;
  d: string;
  lx: number;
  ly: number;
  centerDeg: number;
}

function WheelStage({
  VIEW,
  C,
  R,
  RIM,
  HUB,
  rotation,
  segPaths,
  spinning,
  selectedKey,
  burst,
  result,
}: {
  VIEW: number;
  C: number;
  R: number;
  RIM: number;
  HUB: number;
  rotation: number;
  segPaths: SegPath[];
  spinning: boolean;
  selectedKey: string;
  burst: number;
  result: RoundResult | null;
}) {
  return (
    <div
      className="relative"
      style={{ width: "min(100%, 380px)", aspectRatio: "1 / 1" }}
    >
      {/* Outer ambient ring glow */}
      <div
        className="pointer-events-none absolute inset-0 rounded-full"
        style={{
          boxShadow: spinning
            ? `0 0 60px ${ACCENT}55, inset 0 0 40px rgba(0,0,0,0.6)`
            : `0 0 30px rgba(0,0,0,0.6), inset 0 0 40px rgba(0,0,0,0.6)`,
        }}
      />

      {/* Win burst overlay */}
      <AnimatePresence>
        {result?.win && burst > 0 && (
          <WinBurst key={burst} color={result.segment.spot.glow} />
        )}
      </AnimatePresence>

      {/* Rotation is applied to THIS wrapping HTML element, not the inner SVG
          group. framer-motion's `rotate` on an SVG <g> was a silent no-op here
          (transform never written) so the wheel never actually spun — rotating
          an HTML wrapper, like the roulette wheel does, is reliable. */}
      <motion.div
        className="absolute inset-0"
        style={{ transformOrigin: "50% 50%" }}
        animate={{ rotate: rotation }}
        transition={{
          duration: spinning ? 4.6 : 0,
          ease: spinning ? [0.18, 0.62, 0.12, 1] : "linear",
        }}
      >
      <svg
        viewBox={`0 0 ${VIEW} ${VIEW}`}
        className="h-full w-full overflow-visible"
        role="img"
        aria-label="Money wheel"
      >
        <defs>
          <radialGradient id="mw-hub" cx="50%" cy="38%" r="65%">
            <stop offset="0%" stopColor="#fff7da" />
            <stop offset="45%" stopColor={ACCENT} />
            <stop offset="100%" stopColor="#8a6a14" />
          </radialGradient>
          <radialGradient id="mw-rim" cx="50%" cy="35%" r="70%">
            <stop offset="0%" stopColor="#3a3320" />
            <stop offset="60%" stopColor="#1a160c" />
            <stop offset="100%" stopColor="#070503" />
          </radialGradient>
          <filter id="mw-soft" x="-30%" y="-30%" width="160%" height="160%">
            <feGaussianBlur stdDeviation="1.4" />
          </filter>
        </defs>

        {/* Static rim */}
        <circle cx={C} cy={C} r={R + RIM} fill="url(#mw-rim)" />
        <circle
          cx={C}
          cy={C}
          r={R + RIM}
          fill="none"
          stroke={ACCENT}
          strokeWidth={2}
          opacity={0.6}
        />

        {/* Segments + labels + pegs + hub — rotated by the <motion.div> above. */}
        <g>
          {segPaths.map(({ seg, d, lx, ly, centerDeg }) => {
            const sp = seg.spot;
            const isPicked = sp.key === selectedKey;
            const isWinner =
              result != null && result.segment.index === seg.index;
            return (
              <g key={seg.index}>
                <path
                  d={d}
                  fill={sp.color}
                  stroke="rgba(0,0,0,0.45)"
                  strokeWidth={1}
                  style={{
                    filter: isWinner
                      ? `drop-shadow(0 0 8px ${sp.glow})`
                      : undefined,
                  }}
                />
                {/* picked-spot subtle inner highlight */}
                {isPicked && (
                  <path d={d} fill={`${sp.glow}33`} stroke={sp.glow} strokeWidth={1.2} />
                )}
                <g transform={`rotate(${centerDeg} ${lx} ${ly})`}>
                  <text
                    x={lx}
                    y={ly}
                    textAnchor="middle"
                    dominantBaseline="central"
                    fontSize={sp.kind === "logo" ? 13 : 15}
                    fontWeight={800}
                    fill="#fff"
                    style={{
                      paintOrder: "stroke",
                      stroke: "rgba(0,0,0,0.55)",
                      strokeWidth: 0.8,
                    }}
                  >
                    {sp.kind === "logo"
                      ? sp.label === "JOKER"
                        ? "★"
                        : "♛"
                      : sp.label}
                  </text>
                </g>
              </g>
            );
          })}

          {/* pegs between segments */}
          {segPaths.map(({ seg, centerDeg }) => {
            const pegDeg = centerDeg - SEG_ANGLE / 2;
            const rad = ((pegDeg - 90) * Math.PI) / 180;
            const px = C + (R + 2) * Math.cos(rad);
            const py = C + (R + 2) * Math.sin(rad);
            return (
              <circle
                key={`peg-${seg.index}`}
                cx={px}
                cy={py}
                r={2.4}
                fill="#fff"
                opacity={0.85}
              />
            );
          })}

          {/* hub */}
          <circle cx={C} cy={C} r={HUB} fill="url(#mw-hub)" stroke="#5a4410" strokeWidth={2} />
          <circle cx={C} cy={C} r={HUB * 0.55} fill="none" stroke="#5a4410" strokeWidth={1.5} opacity={0.6} />
          <text
            x={C}
            y={C}
            textAnchor="middle"
            dominantBaseline="central"
            fontSize={11}
            fontWeight={900}
            fill="#3a2c08"
            letterSpacing={1}
          >
            ROYALE
          </text>
        </g>

        {/* center cap */}
        <circle cx={C} cy={C} r={6} fill="#fff7da" stroke="#8a6a14" strokeWidth={1.5} />
      </svg>
      </motion.div>

      {/* Pointer (static, at top, pointing down into the wheel) */}
      <motion.div
        className="pointer-events-none absolute left-1/2 top-0 z-10 -translate-x-1/2"
        style={{ transformOrigin: "50% 0%" }}
        animate={
          spinning
            ? { rotate: [0, -10, 0, -8, 0, -6, 0] }
            : result?.win
              ? { rotate: [0, -14, 0] }
              : { rotate: 0 }
        }
        transition={
          spinning
            ? { repeat: Infinity, duration: 0.42, ease: "easeInOut" }
            : { duration: 0.4 }
        }
      >
        <svg width={42} height={48} viewBox="0 0 42 48" className="overflow-visible">
          <polygon
            points="21,46 6,8 36,8"
            fill={ACCENT}
            stroke="#3a2c08"
            strokeWidth={1.5}
            style={{ filter: `drop-shadow(0 3px 6px rgba(0,0,0,0.6))` }}
          />
          <circle cx={21} cy={10} r={8} fill="#fff7da" stroke="#8a6a14" strokeWidth={2} />
        </svg>
      </motion.div>
    </div>
  );
}

/* Radial confetti / spark burst on a win. */
function WinBurst({ color }: { color: string }) {
  const sparks = useMemo(
    () =>
      Array.from({ length: 16 }, (_, i) => {
        const angle = (i / 16) * TWO_PI + randFloat(-0.2, 0.2);
        const dist = randFloat(120, 200);
        return {
          id: i,
          x: Math.cos(angle) * dist,
          y: Math.sin(angle) * dist,
          rot: randFloat(-180, 180),
          delay: randFloat(0, 0.12),
          hue: i % 3,
        };
      }),
    [],
  );
  const palette = [color, "#ffffff", ACCENT];
  return (
    <div className="pointer-events-none absolute inset-0 z-20 grid place-items-center">
      <motion.div
        initial={{ scale: 0, opacity: 0.8 }}
        animate={{ scale: 2.6, opacity: 0 }}
        transition={{ duration: 0.7, ease: "easeOut" }}
        className="absolute h-24 w-24 rounded-full"
        style={{ background: `radial-gradient(circle, ${color}88, transparent 70%)` }}
      />
      {sparks.map((s) => (
        <motion.span
          key={s.id}
          initial={{ x: 0, y: 0, scale: 0, opacity: 1, rotate: 0 }}
          animate={{
            x: s.x,
            y: s.y,
            scale: [0, 1.1, 0.4],
            opacity: [1, 1, 0],
            rotate: s.rot,
          }}
          transition={{ duration: 1, delay: s.delay, ease: "easeOut" }}
          className="absolute block h-2.5 w-2.5 rounded-[2px]"
          style={{ background: palette[s.hue] }}
        />
      ))}
    </div>
  );
}

/* Small labeled stat readout. */
function Readout({
  label,
  value,
  accent,
}: {
  label: string;
  value: number;
  accent: string;
}) {
  return (
    <div className="glass rounded-2xl px-3 py-2.5">
      <div className="text-[10px] uppercase tracking-widest text-white/40">{label}</div>
      <div
        className="font-display text-xl font-bold tabular-nums"
        style={{ color: accent }}
      >
        <CountingNumber value={value} duration={560} className="tabular-nums" />
      </div>
    </div>
  );
}
