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
import { randInt } from "@/lib/rng";
import { sfx } from "@/lib/sound";
import { formatChips, formatDelta } from "@/lib/format";
import { Button } from "@/components/ui/Button";
import { Chip } from "@/components/ui/Chip";
import { CountingNumber } from "@/components/CountingNumber";
import { CollapsiblePanel } from "@/components/CollapsiblePanel";
import { Celebration } from "@/components/Celebration";

/* ----------------------------------------------------------------------------
 * ROULETTE — European (single 0) by default, American (0 + 00) toggle.
 *
 * Money model (per contract):
 *   bet(amount) deducts the FULL table stake on Spin (false => abort).
 *   win(gross) credits stake + profit. A winning bet returning Nx the stake
 *   calls win(stake * N) where N already includes the returned stake:
 *     straight        35:1  -> win(stake * 36)
 *     red/black/odd/even/high/low  1:1 -> win(stake * 2)
 *     dozen/column    2:1   -> win(stake * 3)
 *   Losing bets credit nothing.
 * ------------------------------------------------------------------------- */

const ACCENT = "#e3342f"; // game accent (red)
const GREEN = "#1b8a5a";
const RED = "#d23b3b";
const BLACK = "#1a1d24";
const FELT_LINE = "rgba(245,208,96,0.28)";

const RED_SET = new Set([
  1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36,
]);

type Pocket = number | "00";
type WheelKind = "european" | "american";

/** Wheel pocket order, clockwise, as on a real wheel. */
const EUROPEAN_ORDER: Pocket[] = [
  0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5, 24,
  16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26,
];
const AMERICAN_ORDER: Pocket[] = [
  0, 28, 9, 26, 30, 11, 7, 20, 32, 17, 5, 22, 34, 15, 3, 24, 36, 13, 1, "00",
  27, 10, 25, 29, 12, 8, 19, 31, 18, 6, 21, 33, 16, 4, 23, 35, 14, 2,
];

function pocketColor(p: Pocket): "green" | "red" | "black" {
  if (p === 0 || p === "00") return "green";
  return RED_SET.has(p) ? "red" : "black";
}
function colorHex(p: Pocket): string {
  const c = pocketColor(p);
  return c === "green" ? GREEN : c === "red" ? RED : BLACK;
}
function pocketKey(p: Pocket): string {
  return p === "00" ? "00" : String(p);
}

// --- Bet definitions -------------------------------------------------------

type BetKind =
  | "straight"
  | "red"
  | "black"
  | "odd"
  | "even"
  | "low"
  | "high"
  | "dozen"
  | "column";

interface Bet {
  /** Unique spot id, e.g. "straight:17", "red", "dozen:1", "column:2". */
  id: string;
  kind: BetKind;
  /** For straight: the pocket. For dozen/column: 1|2|3 group index. */
  ref: Pocket | number;
  label: string;
  /** Payout multiplier x where win = stake * x (x includes stake). */
  payX: number;
}

const PAYOUT: Record<BetKind, number> = {
  straight: 36, // 35:1
  red: 2,
  black: 2,
  odd: 2,
  even: 2,
  low: 2,
  high: 2,
  dozen: 3, // 2:1
  column: 3,
};

function spotLabel(kind: BetKind, ref: Pocket | number): string {
  switch (kind) {
    case "straight":
      return pocketKey(ref as Pocket);
    case "red":
      return "RED";
    case "black":
      return "BLACK";
    case "odd":
      return "ODD";
    case "even":
      return "EVEN";
    case "low":
      return "1-18";
    case "high":
      return "19-36";
    case "dozen":
      return ref === 1 ? "1st 12" : ref === 2 ? "2nd 12" : "3rd 12";
    case "column":
      return `Col ${ref}`;
  }
}

/** Does pocket p win the given bet? */
function betWins(kind: BetKind, ref: Pocket | number, p: Pocket): boolean {
  if (p === 0 || p === "00") {
    // Outside bets all lose on green; only a straight bet on that green wins.
    return kind === "straight" && ref === p;
  }
  const n = p as number;
  switch (kind) {
    case "straight":
      return ref === p;
    case "red":
      return RED_SET.has(n);
    case "black":
      return !RED_SET.has(n);
    case "odd":
      return n % 2 === 1;
    case "even":
      return n % 2 === 0;
    case "low":
      return n >= 1 && n <= 18;
    case "high":
      return n >= 19 && n <= 36;
    case "dozen":
      return ref === 1
        ? n >= 1 && n <= 12
        : ref === 2
          ? n >= 13 && n <= 24
          : n >= 25 && n <= 36;
    case "column":
      // column 1 -> n%3===1, column 2 -> n%3===2, column 3 -> n%3===0
      return n % 3 === (ref === 3 ? 0 : (ref as number));
  }
}

const CHIP_DENOMS = [5, 25, 100, 500, 1000];

interface HistoryEntry {
  id: string;
  pocket: Pocket;
  color: "green" | "red" | "black";
}

interface WinFlash {
  id: string;
  amount: number;
}

/* -------------------------------- Wheel ------------------------------------ */

function Wheel({
  order,
  rotation,
  ballRotation,
  ballRadius,
  spinning,
  resultColor,
}: {
  order: Pocket[];
  rotation: number;
  ballRotation: number;
  ballRadius: number;
  spinning: boolean;
  resultColor: string;
}) {
  const N = order.length;
  const step = 360 / N;
  const R = 130; // outer radius
  const cx = 150;
  const cy = 150;

  const segments = useMemo(() => {
    return order.map((p, i) => {
      const a0 = (i * step - 90 - step / 2) * (Math.PI / 180);
      const a1 = (i * step - 90 + step / 2) * (Math.PI / 180);
      const x0 = cx + R * Math.cos(a0);
      const y0 = cy + R * Math.sin(a0);
      const x1 = cx + R * Math.cos(a1);
      const y1 = cy + R * Math.sin(a1);
      const path = `M ${cx} ${cy} L ${x0.toFixed(2)} ${y0.toFixed(
        2,
      )} A ${R} ${R} 0 0 1 ${x1.toFixed(2)} ${y1.toFixed(2)} Z`;
      // label position
      const am = (i * step - 90) * (Math.PI / 180);
      const lr = R * 0.82;
      const lx = cx + lr * Math.cos(am);
      const ly = cy + lr * Math.sin(am);
      return {
        path,
        fill: colorHex(p),
        label: pocketKey(p),
        lx,
        ly,
        angle: i * step,
      };
    });
  }, [order, step]);

  return (
    <div className="relative mx-auto h-[300px] w-[300px] [@media(max-height:600px)]:h-[186px] [@media(max-height:600px)]:w-[186px]">
      <div
        className="absolute left-0 top-0 origin-top-left [@media(max-height:600px)]:scale-[0.62]"
        style={{ width: 300, height: 300 }}
      >
      {/* glow ring */}
      <div
        className="absolute inset-0 rounded-full"
        style={{
          boxShadow: spinning
            ? `0 0 50px ${ACCENT}66, inset 0 0 40px rgba(0,0,0,0.6)`
            : `0 0 28px rgba(245,208,96,0.35), inset 0 0 40px rgba(0,0,0,0.6)`,
          background:
            "radial-gradient(circle at 50% 50%, rgba(30,18,8,0.9), rgba(10,8,6,0.95))",
          transition: "box-shadow 0.5s ease",
        }}
      />

      {/* rotating disc */}
      <motion.div
        className="absolute inset-0"
        style={{ originX: 0.5, originY: 0.5 }}
        animate={{ rotate: rotation }}
        transition={{ duration: spinning ? 4.6 : 0, ease: [0.18, 0.7, 0.12, 1] }}
      >
        <svg viewBox="0 0 300 300" width="300" height="300">
          {/* outer gold rim */}
          <circle
            cx={cx}
            cy={cy}
            r={R + 12}
            fill="none"
            stroke="url(#rimGrad)"
            strokeWidth={9}
          />
          <defs>
            <radialGradient id="rimGrad" cx="50%" cy="35%" r="75%">
              <stop offset="0%" stopColor="#f7e7a3" />
              <stop offset="55%" stopColor="#caa022" />
              <stop offset="100%" stopColor="#6b4e10" />
            </radialGradient>
            <radialGradient id="hubGrad" cx="50%" cy="40%" r="70%">
              <stop offset="0%" stopColor="#f7e7a3" />
              <stop offset="70%" stopColor="#a87f1a" />
              <stop offset="100%" stopColor="#4a370b" />
            </radialGradient>
          </defs>

          {segments.map((s, i) => (
            <g key={i}>
              <path d={s.path} fill={s.fill} stroke="#0c0a08" strokeWidth={0.7} />
              <text
                x={s.lx}
                y={s.ly}
                fill="#fff"
                fontSize={9}
                fontWeight={700}
                textAnchor="middle"
                dominantBaseline="middle"
                transform={`rotate(${s.angle + 90} ${s.lx} ${s.ly})`}
                style={{ pointerEvents: "none", userSelect: "none" }}
              >
                {s.label}
              </text>
            </g>
          ))}

          {/* inner cone */}
          <circle cx={cx} cy={cy} r={R * 0.55} fill="#120c06" opacity={0.9} />
          <circle
            cx={cx}
            cy={cy}
            r={R * 0.55}
            fill="none"
            stroke="url(#rimGrad)"
            strokeWidth={2}
          />
          {/* spokes */}
          {Array.from({ length: 8 }).map((_, i) => {
            const a = (i * 45 - 90) * (Math.PI / 180);
            return (
              <line
                key={i}
                x1={cx}
                y1={cy}
                x2={cx + R * 0.55 * Math.cos(a)}
                y2={cy + R * 0.55 * Math.sin(a)}
                stroke="rgba(245,208,96,0.25)"
                strokeWidth={1.2}
              />
            );
          })}
          {/* hub */}
          <circle cx={cx} cy={cy} r={R * 0.2} fill="url(#hubGrad)" />
          <circle cx={cx} cy={cy} r={R * 0.07} fill="#2a1d06" />
        </svg>
      </motion.div>

      {/* ball — lives on its own rotating layer; counter-rotates relative to disc */}
      <motion.div
        className="absolute"
        style={{
          left: 150,
          top: 150,
          width: 0,
          height: 0,
          originX: 0,
          originY: 0,
        }}
        animate={{ rotate: ballRotation }}
        transition={{ duration: spinning ? 4.6 : 0, ease: [0.1, 0.55, 0.18, 1] }}
      >
        <motion.div
          className="absolute rounded-full"
          animate={{
            y: spinning ? [-(R + 4), -(R + 4), -ballRadius] : -ballRadius,
          }}
          transition={{
            duration: spinning ? 4.6 : 0.5,
            times: spinning ? [0, 0.6, 1] : undefined,
            ease: spinning ? "easeIn" : "easeOut",
          }}
          style={{
            width: 13,
            height: 13,
            marginLeft: -6.5,
            background:
              "radial-gradient(circle at 35% 30%, #ffffff, #d9d9d9 55%, #9aa0a8 100%)",
            boxShadow: `0 0 8px ${resultColor}, 0 2px 4px rgba(0,0,0,0.6)`,
          }}
        />
      </motion.div>

      {/* fixed pointer at top */}
      <div
        className="absolute left-1/2 -top-1 -translate-x-1/2"
        style={{
          width: 0,
          height: 0,
          borderLeft: "9px solid transparent",
          borderRight: "9px solid transparent",
          borderTop: "16px solid #f5d060",
          filter: "drop-shadow(0 2px 3px rgba(0,0,0,0.6))",
          zIndex: 5,
        }}
      />
      </div>
    </div>
  );
}

/* ------------------------------ Bet spot UI -------------------------------- */

function Stack({ amount }: { amount: number }) {
  if (amount <= 0) return null;
  // Decompose into chip layers for a stacked look (cap visual height).
  const layers = Math.min(5, Math.max(1, Math.ceil(amount / 50)));
  return (
    <motion.div
      initial={{ scale: 0, y: -10 }}
      animate={{ scale: 1, y: 0 }}
      transition={{ type: "spring", stiffness: 480, damping: 22 }}
      className="pointer-events-none absolute -top-1 left-1/2 z-10 -translate-x-1/2"
    >
      <div className="relative grid place-items-center" style={{ width: 28, height: 28 }}>
        {Array.from({ length: layers }).map((_, i) => (
          <span
            key={i}
            className="absolute rounded-full border border-white/40"
            style={{
              width: 24,
              height: 24,
              bottom: i * 2.5,
              background:
                "radial-gradient(circle at 50% 35%, #f5d060, #caa022 60%, #6b4e10)",
              boxShadow: "0 1px 2px rgba(0,0,0,0.5)",
            }}
          />
        ))}
        <span
          className="absolute z-10 font-bold tabular-nums text-ink"
          style={{ fontSize: 9, bottom: layers * 2.5 + 6 }}
        >
          {amount >= 1000 ? `${(amount / 1000).toFixed(0)}k` : amount}
        </span>
      </div>
    </motion.div>
  );
}

export default function Roulette() {
  const wallet = useWallet();

  const [wheelKind, setWheelKind] = useState<WheelKind>("european");
  const order = wheelKind === "european" ? EUROPEAN_ORDER : AMERICAN_ORDER;

  const [chip, setChip] = useState(25);
  const [bets, setBets] = useState<Record<string, Bet & { amount: number }>>({});
  const [phase, setPhase] = useState<"betting" | "spinning" | "resolved">(
    "betting",
  );

  const [rotation, setRotation] = useState(0);
  const [ballRotation, setBallRotation] = useState(0);
  const [ballRadius, setBallRadius] = useState(118);
  const [result, setResult] = useState<Pocket | null>(null);
  const [resultColor, setResultColor] = useState(GREEN);
  const [resultText, setResultText] = useState("");
  const [lastNet, setLastNet] = useState(0);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [winningSpots, setWinningSpots] = useState<Set<string>>(new Set());
  const [winFlashes, setWinFlashes] = useState<WinFlash[]>([]);
  const [celebration, setCelebration] = useState<{
    seed: number;
    tier: "win" | "big" | "jackpot";
  } | null>(null);

  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(
    () => () => {
      timers.current.forEach(clearTimeout);
    },
    [],
  );
  const after = (ms: number, fn: () => void) => {
    timers.current.push(setTimeout(fn, ms));
  };

  const totalStake = useMemo(
    () => Object.values(bets).reduce((s, b) => s + b.amount, 0),
    [bets],
  );

  const canAfford = chip <= wallet.balance && totalStake + chip <= wallet.balance;
  const isBetting = phase !== "spinning";

  const placeBet = useCallback(
    (kind: BetKind, ref: Pocket | number) => {
      if (phase === "spinning") return;
      const id =
        kind === "straight"
          ? `straight:${pocketKey(ref as Pocket)}`
          : kind === "dozen" || kind === "column"
            ? `${kind}:${ref}`
            : kind;
      setBets((prev) => {
        const existing = prev[id];
        const current = existing?.amount ?? 0;
        // Don't allow committing more than the balance across all spots.
        const others = Object.entries(prev)
          .filter(([k]) => k !== id)
          .reduce((s, [, b]) => s + b.amount, 0);
        if (others + current + chip > wallet.balance) {
          sfx.lose();
          return prev;
        }
        sfx.chip();
        return {
          ...prev,
          [id]: {
            id,
            kind,
            ref,
            label: spotLabel(kind, ref),
            payX: PAYOUT[kind],
            amount: current + chip,
          },
        };
      });
      // Re-enter betting if we were showing a prior result.
      if (phase === "resolved") {
        setPhase("betting");
        setWinningSpots(new Set());
        setResultText("");
      }
    },
    [chip, phase, wallet.balance],
  );

  const clearBets = useCallback(() => {
    if (phase === "spinning") return;
    sfx.click();
    setBets({});
    setWinningSpots(new Set());
  }, [phase]);

  const spin = useCallback(() => {
    if (phase === "spinning") return;
    const stake = totalStake;
    if (stake <= 0) {
      sfx.lose();
      return;
    }
    if (!wallet.bet(stake)) {
      sfx.lose();
      return;
    }

    setPhase("spinning");
    setWinningSpots(new Set());
    setResultText("");
    setCelebration(null);
    setLastNet(0);
    setBallRadius(118); // launch on the outer track
    // Clear any lingering timer IDs from prior spins to prevent array growth.
    timers.current = [];
    sfx.thud();

    // Determine result.
    const N = order.length;
    const idx = randInt(0, N - 1);
    // Guard: idx is always in [0, N-1] so this assertion is safe; the fallback
    // is belt-and-suspenders in case N is somehow 0.
    const landed: Pocket = order[idx] ?? 0;
    const landedColor = pocketColor(landed);

    // Compute final rotations so the ball settles on `idx` under the top pointer.
    const step = 360 / N;
    // The disc spins clockwise; we want pocket idx at the top (angle 0 / -90 visually).
    const baseDiscTurns = 5;
    const finalDiscRotation =
      rotation -
      (rotation % 360) +
      baseDiscTurns * 360 +
      ((360 - idx * step) % 360);
    // Ball spins the opposite way and lands aligned with the pocket center.
    // The ball layer's 0deg points UP; rotate it to the pocket's screen angle
    // after the disc settles: pocket sits at top => ball rotate offset 0.
    const baseBallTurns = 8;
    const finalBallRotation =
      ballRotation - (ballRotation % 360) - baseBallTurns * 360;

    setRotation(finalDiscRotation);
    setBallRotation(finalBallRotation);
    // IMPORTANT: do NOT reveal the outcome here. `result` drives the "Last"
    // badge and `resultColor` drives the ball glow — setting them now would
    // spoil the number ~4.7s before the wheel stops. They are committed in the
    // resolve callback below. Use a neutral gold glow on the ball while it's in
    // flight so nothing hints at the landing pocket.
    setResultColor("#f5d060");

    // Ticking SFX during the spin.
    for (let i = 0; i < 14; i++) {
      after(150 + i * 280 * (1 - i / 22), () => sfx.tick());
    }

    // Resolve after the animation completes.
    after(4700, () => {
      sfx.thud();
      // Settle ball into pocket radius.
      setBallRadius(86);

      // NOW reveal the outcome — the wheel has stopped. This updates the "Last"
      // badge and the ball glow to the true landing color.
      setResult(landed);
      setResultColor(
        landedColor === "green" ? GREEN : landedColor === "red" ? RED : BLACK,
      );

      // Pay out winners.
      let gross = 0;
      let straightHit = false;
      const winners = new Set<string>();
      Object.values(bets).forEach((b) => {
        if (betWins(b.kind, b.ref, landed)) {
          gross += b.amount * b.payX;
          winners.add(b.id);
          if (b.kind === "straight") straightHit = true;
        }
      });

      const net = gross - stake;
      if (gross > 0) wallet.win(gross);

      setWinningSpots(winners);
      setLastNet(net);
      if (net > 0) {
        const tier: "win" | "big" | "jackpot" =
          straightHit || gross >= stake * 20
            ? "jackpot"
            : gross >= stake * 5
              ? "big"
              : "win";
        setCelebration({ seed: gross, tier });
      }
      setHistory((h) => [{ id: `${Date.now()}-${pocketKey(landed)}`, pocket: landed, color: landedColor }, ...h].slice(0, 18));

      const label = pocketKey(landed);
      const colorWord =
        landedColor === "green"
          ? "Green"
          : landedColor === "red"
            ? "Red"
            : "Black";

      if (net > 0) {
        setResultText(`${label} ${colorWord} — won ${formatChips(net)}`);
        const flashId = `${Date.now()}`;
        setWinFlashes([{ id: flashId, amount: net }]);
        after(1500, () => setWinFlashes([]));
        if (net >= stake * 8) sfx.jackpot();
        else sfx.win();
      } else if (winners.size > 0) {
        // Won something back but net negative/zero — overall a loss.
        setResultText(`${label} ${colorWord} — returned ${formatChips(gross)}`);
        sfx.lose();
      } else {
        setResultText(`${label} ${colorWord} — no win`);
        sfx.lose();
      }

      setPhase("resolved");
      // Ball stays nestled in the pocket (radius 86) until the next spin.
    });
  }, [phase, totalStake, wallet, order, rotation, ballRotation, bets]);

  // Helper to read a spot's current stake.
  const stakeOf = (id: string): number => bets[id]?.amount ?? 0;

  // Number grid layout: 3 rows x 12 columns (standard table orientation).
  // Row top = {3,6,...,36}, mid = {2,5,...,35}, bottom = {1,4,...,34}.
  const gridRows: number[][] = [
    [3, 6, 9, 12, 15, 18, 21, 24, 27, 30, 33, 36],
    [2, 5, 8, 11, 14, 17, 20, 23, 26, 29, 32, 35],
    [1, 4, 7, 10, 13, 16, 19, 22, 25, 28, 31, 34],
  ];

  const numberCell = (n: number) => {
    const id = `straight:${n}`;
    const col = pocketColor(n);
    const win = winningSpots.has(id);
    return (
      <button
        key={n}
        type="button"
        data-testid={`spot-num-${n}`}
        onClick={() => placeBet("straight", n)}
        disabled={!isBetting}
        className="relative grid aspect-square place-items-center rounded-[3px] text-[11px] font-bold text-white transition-transform hover:scale-[1.06] disabled:cursor-not-allowed sm:text-xs"
        style={{
          background:
            col === "red"
              ? "linear-gradient(160deg,#e0473f,#b7251d)"
              : "linear-gradient(160deg,#2a2e37,#13151b)",
          boxShadow: win
            ? "0 0 0 2px #f5d060, 0 0 14px rgba(245,208,96,0.9)"
            : "inset 0 0 0 1px rgba(245,208,96,0.18)",
        }}
      >
        {n}
        <Stack amount={stakeOf(id)} />
      </button>
    );
  };

  const outsideBtn = (
    kind: BetKind,
    ref: Pocket | number,
    label: string,
    extra?: string,
    bg?: string,
  ) => {
    const id =
      kind === "dozen" || kind === "column" ? `${kind}:${ref}` : kind;
    const win = winningSpots.has(id);
    return (
      <button
        type="button"
        data-testid={`spot-${id}`}
        onClick={() => placeBet(kind, ref)}
        disabled={!isBetting}
        className={`relative grid place-items-center rounded-[4px] px-1 py-2 text-[10px] font-bold uppercase tracking-wide text-white transition-transform hover:scale-[1.03] disabled:cursor-not-allowed sm:text-[11px] ${extra ?? ""}`}
        style={{
          background:
            bg ??
            "linear-gradient(160deg,rgba(20,90,60,0.85),rgba(8,40,28,0.9))",
          boxShadow: win
            ? "0 0 0 2px #f5d060, 0 0 14px rgba(245,208,96,0.9)"
            : `inset 0 0 0 1px ${FELT_LINE}`,
        }}
      >
        {label}
        <Stack amount={stakeOf(id)} />
      </button>
    );
  };

  const zeroCell = (p: Pocket) => {
    const id = `straight:${pocketKey(p)}`;
    const win = winningSpots.has(id);
    return (
      <button
        type="button"
        data-testid={`spot-num-${pocketKey(p)}`}
        onClick={() => placeBet("straight", p)}
        disabled={!isBetting}
        className="relative grid place-items-center rounded-[3px] px-1 text-[11px] font-bold text-white transition-transform hover:scale-[1.05] disabled:cursor-not-allowed"
        style={{
          background: "linear-gradient(160deg,#1f9d62,#0e5e3a)",
          minWidth: 26,
          boxShadow: win
            ? "0 0 0 2px #f5d060, 0 0 14px rgba(245,208,96,0.9)"
            : "inset 0 0 0 1px rgba(245,208,96,0.18)",
        }}
      >
        {pocketKey(p)}
        <Stack amount={stakeOf(id)} />
      </button>
    );
  };

  return (
    <div className="mx-auto w-full max-w-5xl">
      <div className="felt relative overflow-hidden rounded-3xl p-4 shadow-felt sm:p-6 [@media(max-height:600px)]:p-3">
        {/* ambient grid */}
        <div className="bg-grid pointer-events-none absolute inset-0 opacity-[0.12]" />

        {/* Header row */}
        <div className="relative mb-2 flex flex-wrap items-center justify-between gap-3 sm:mb-4">
          <div>
            <h2
              className="font-display text-2xl font-bold tracking-wide sm:text-3xl"
              style={{ color: ACCENT, textShadow: `0 0 16px ${ACCENT}66` }}
            >
              Roulette
            </h2>
            <p className="text-[11px] uppercase tracking-[0.3em] text-white/40">
              {wheelKind === "european" ? "European · Single 0" : "American · 0 & 00"}
            </p>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-[10px] uppercase tracking-widest text-white/40">
              Wheel
            </span>
            <div className="flex overflow-hidden rounded-full border border-gold/30 bg-black/40">
              {(["european", "american"] as WheelKind[]).map((k) => (
                <button
                  key={k}
                  type="button"
                  data-testid={`wheel-${k}`}
                  disabled={!isBetting}
                  onClick={() => {
                    if (!isBetting) return;
                    sfx.click();
                    setWheelKind(k);
                  }}
                  className={`px-3 py-1.5 text-[11px] font-semibold capitalize transition-colors disabled:cursor-not-allowed ${
                    wheelKind === k
                      ? "bg-gold text-ink"
                      : "text-white/60 hover:text-white"
                  }`}
                >
                  {k === "european" ? "Euro" : "USA"}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Top zone: wheel + result/history + paytable */}
        <div className="relative grid gap-2 sm:gap-4 lg:grid-cols-[320px_1fr]">
          {/* Wheel + result */}
          <div className="glass relative flex flex-col items-center gap-2 rounded-2xl p-4 sm:gap-3 [@media(max-height:600px)]:p-2">
            <Wheel
              order={order}
              rotation={rotation}
              ballRotation={ballRotation}
              ballRadius={ballRadius}
              spinning={phase === "spinning"}
              resultColor={resultColor}
            />

            {/* Result badge */}
            <div className="flex items-center gap-3">
              <div className="text-center">
                <div className="text-[9px] uppercase tracking-widest text-white/40">
                  Last
                </div>
                <AnimatePresence mode="popLayout">
                  <motion.div
                    key={result === null ? "none" : pocketKey(result)}
                    initial={{ scale: 0.5, opacity: 0, rotateX: -90 }}
                    animate={{ scale: 1, opacity: 1, rotateX: 0 }}
                    exit={{ scale: 0.5, opacity: 0 }}
                    transition={{ type: "spring", stiffness: 320, damping: 20 }}
                    className="mt-1 grid h-12 w-12 place-items-center rounded-xl text-xl font-bold text-white"
                    style={{
                      background:
                        result === null
                          ? "rgba(255,255,255,0.06)"
                          : `linear-gradient(160deg, ${resultColor}, rgba(0,0,0,0.4))`,
                      boxShadow:
                        result === null
                          ? "inset 0 0 0 1px rgba(255,255,255,0.1)"
                          : `0 0 18px ${resultColor}99`,
                    }}
                  >
                    {result === null ? "—" : pocketKey(result)}
                  </motion.div>
                </AnimatePresence>
              </div>
            </div>

            {/* win burst overlay */}
            <AnimatePresence>
              {winFlashes.map((f) => (
                <motion.div
                  key={f.id}
                  initial={{ scale: 0.4, opacity: 0, y: 10 }}
                  animate={{ scale: 1, opacity: 1, y: -8 }}
                  exit={{ scale: 1.3, opacity: 0, y: -40 }}
                  transition={{ duration: 0.5 }}
                  className="pointer-events-none absolute inset-x-0 top-1/2 z-20 grid place-items-center"
                >
                  <div
                    className="rounded-full px-4 py-1.5 font-display text-xl font-bold"
                    style={{
                      color: "#1a1300",
                      background:
                        "radial-gradient(circle at 50% 30%, #f7e7a3, #caa022)",
                      boxShadow: "0 0 28px rgba(245,208,96,0.9)",
                    }}
                  >
                    {formatDelta(f.amount)}
                  </div>
                </motion.div>
              ))}
            </AnimatePresence>
          </div>

          {/* Right column: result text + history + paytable */}
          <div className="flex flex-col gap-2 sm:gap-3">
            {/* Result line */}
            <div className="glass flex min-h-[58px] items-center justify-between gap-3 rounded-2xl px-4 py-3">
              <div
                data-testid="round-result"
                className="font-display text-base font-semibold sm:text-lg"
                style={{
                  color:
                    lastNet > 0
                      ? "#f5d060"
                      : phase === "resolved"
                        ? "#ff8e8e"
                        : "rgba(255,255,255,0.6)",
                }}
              >
                {phase === "spinning"
                  ? "No more bets — spinning…"
                  : resultText ||
                    (totalStake > 0
                      ? "Place your bets and spin"
                      : "Select a chip, click the table to bet")}
              </div>
              {phase === "resolved" && lastNet !== 0 && (
                <motion.span
                  initial={{ scale: 0.6, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  className="shrink-0 rounded-lg px-2 py-1 text-sm font-bold tabular-nums"
                  style={{
                    color: lastNet > 0 ? "#1a1300" : "#fff",
                    background:
                      lastNet > 0
                        ? "radial-gradient(circle at 50% 30%,#f7e7a3,#caa022)"
                        : "rgba(220,38,38,0.4)",
                  }}
                >
                  {formatDelta(lastNet)}
                </motion.span>
              )}
            </div>

            {/* History strip */}
            <CollapsiblePanel title="History" accent={ACCENT}>
              <div className="no-scrollbar flex gap-1 overflow-x-auto">
                {history.length === 0 && (
                  <span className="py-1 text-xs text-white/30">
                    No spins yet
                  </span>
                )}
                <AnimatePresence initial={false}>
                  {history.map((h) => (
                    <motion.span
                      key={h.id}
                      initial={{ scale: 0, x: -8 }}
                      animate={{ scale: 1, x: 0 }}
                      className="grid h-7 min-w-[28px] shrink-0 place-items-center rounded-md px-1 text-[11px] font-bold text-white"
                      style={{
                        background:
                          h.color === "green"
                            ? GREEN
                            : h.color === "red"
                              ? RED
                              : BLACK,
                        boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.12)",
                      }}
                    >
                      {pocketKey(h.pocket)}
                    </motion.span>
                  ))}
                </AnimatePresence>
              </div>
            </CollapsiblePanel>

            {/* Paytable */}
            <CollapsiblePanel
              title="Payouts"
              accent={ACCENT}
              summary={<>up to 35 : 1</>}
            >
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 pt-2 text-xs sm:grid-cols-3">
                {[
                  ["Straight (number)", "35 : 1"],
                  ["Red / Black", "1 : 1"],
                  ["Odd / Even", "1 : 1"],
                  ["1-18 / 19-36", "1 : 1"],
                  ["Dozen", "2 : 1"],
                  ["Column", "2 : 1"],
                ].map(([label, pay]) => (
                  <div
                    key={label}
                    className="flex items-center justify-between gap-2 border-b border-white/5 py-0.5"
                  >
                    <span className="text-white/70">{label}</span>
                    <span className="font-semibold text-gold">{pay}</span>
                  </div>
                ))}
              </div>
            </CollapsiblePanel>
          </div>
        </div>

        {/* Betting layout */}
        <div className="relative mt-2 overflow-x-auto sm:mt-4">
          <div className="min-w-[640px] rounded-2xl bg-emerald-950/40 p-3 ring-1 ring-gold/15">
            <div className="flex gap-2">
              {/* Zero(s) column */}
              <div className="flex flex-col gap-1" style={{ width: 30 }}>
                {wheelKind === "american" ? (
                  <>
                    <div className="flex-1">{zeroCell(0)}</div>
                    <div className="flex-1">{zeroCell("00")}</div>
                  </>
                ) : (
                  <div className="flex h-full items-stretch">{zeroCell(0)}</div>
                )}
              </div>

              {/* Numbers + columns */}
              <div className="flex-1">
                <div className="flex gap-1">
                  <div className="grid flex-1 grid-rows-3 gap-1">
                    {gridRows.map((row, ri) => (
                      <div key={ri} className="grid grid-cols-12 gap-1">
                        {row.map((n) => numberCell(n))}
                      </div>
                    ))}
                  </div>
                  {/* Column bets (2:1) on the right edge */}
                  <div className="grid w-12 grid-rows-3 gap-1">
                    {outsideBtn("column", 3, "2:1", "h-full")}
                    {outsideBtn("column", 2, "2:1", "h-full")}
                    {outsideBtn("column", 1, "2:1", "h-full")}
                  </div>
                </div>

                {/* Dozens */}
                <div className="mt-1 grid grid-cols-3 gap-1">
                  {outsideBtn("dozen", 1, "1st 12")}
                  {outsideBtn("dozen", 2, "2nd 12")}
                  {outsideBtn("dozen", 3, "3rd 12")}
                </div>

                {/* Even-money row */}
                <div className="mt-1 grid grid-cols-6 gap-1">
                  {outsideBtn("low", 0, "1-18")}
                  {outsideBtn("even", 0, "Even")}
                  {outsideBtn(
                    "red",
                    0,
                    "Red",
                    "",
                    "linear-gradient(160deg,#e0473f,#b7251d)",
                  )}
                  {outsideBtn(
                    "black",
                    0,
                    "Black",
                    "",
                    "linear-gradient(160deg,#2a2e37,#13151b)",
                  )}
                  {outsideBtn("odd", 0, "Odd")}
                  {outsideBtn("high", 0, "19-36")}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Controls */}
        <div className="relative mt-2 flex flex-col gap-2 sm:mt-4 sm:gap-3 lg:flex-row lg:items-center lg:justify-between">
          {/* Chip selector */}
          <div className="glass flex flex-wrap items-center gap-2 rounded-2xl p-3">
            <span className="mr-1 text-[10px] uppercase tracking-widest text-white/40">
              Chip
            </span>
            {CHIP_DENOMS.map((v) => (
              <div key={v} className="relative">
                <Chip
                  value={v}
                  size={44}
                  selected={chip === v}
                  onClick={
                    isBetting && v <= wallet.balance
                      ? () => {
                          sfx.click();
                          setChip(v);
                        }
                      : undefined
                  }
                />
              </div>
            ))}
          </div>

          {/* Stake + actions */}
          <div className="glass flex flex-wrap items-center justify-center gap-3 rounded-2xl p-3">
            <div className="rounded-xl border border-gold/30 bg-black/40 px-4 py-2 text-center">
              <div className="text-[9px] uppercase tracking-widest text-white/40">
                Table stake
              </div>
              <div className="gold-text text-lg font-bold tabular-nums">
                <CountingNumber value={totalStake} className="tabular-nums" />
              </div>
            </div>

            <Button
              variant="ghost"
              size="md"
              data-testid="clear-btn"
              disabled={!isBetting || totalStake === 0}
              onClick={clearBets}
            >
              Clear Bets
            </Button>

            <Button
              variant="gold"
              size="lg"
              className="spin-btn"
              data-testid="play-btn"
              disabled={phase === "spinning" || totalStake === 0}
              onClick={spin}
            >
              {phase === "spinning" ? "Spinning…" : "SPIN"}
            </Button>
          </div>
        </div>

        {/* Footer hint / balance guard */}
        <div className="relative mt-2 text-center text-[11px] text-white/40">
          Balance {formatChips(wallet.balance)} chips · stake deducts on spin ·
          winners auto-paid
          {totalStake > wallet.balance && (
            <span className="ml-2 font-semibold text-ruby">
              Lower your bets — over balance
            </span>
          )}
          {!canAfford && totalStake === 0 && (
            <span className="ml-2 text-white/30">
              (smallest chip exceeds balance — top up from the header)
            </span>
          )}
        </div>

        <Celebration
          show={celebration !== null}
          seed={celebration?.seed ?? 0}
          tier={celebration?.tier ?? "win"}
          colors={["#e3342f", "#ffd24a", "#22e1ff", "#ffffff"]}
        />
      </div>
    </div>
  );
}
