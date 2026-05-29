"use client";

// Lucky Sevens — classic 3-reel, single center-payline slot machine.
// Retro red/gold cabinet. Reels scroll with motion blur and stop sequentially
// left→right with a thud. Pays only the center line; winning line highlighted
// with a coin burst. Money flows exclusively through useWallet().

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { motion, AnimatePresence, useMotionValue, animate } from "framer-motion";
import { useWallet } from "@/lib/wallet";
import { BetControls } from "@/components/BetControls";
import { Button } from "@/components/ui/Button";
import { formatChips, formatDelta, formatMultiplier } from "@/lib/format";
import { weightedPick, randInt } from "@/lib/rng";
import { sfx } from "@/lib/sound";

const ACCENT = "#e74c3c";

// ---------------------------------------------------------------------------
// Symbols
// ---------------------------------------------------------------------------
type SymKey = "7" | "BAR" | "BELL" | "CHERRY" | "LEMON" | "PLUM";

interface SymDef {
  key: SymKey;
  glyph: string; // emoji/text face
  label: string;
  /** rarity weight per reel — lower = rarer */
  weight: number;
  color: string; // accent for the face
}

const SYMBOLS: SymDef[] = [
  { key: "7", glyph: "7⃣", label: "Lucky 7", weight: 2, color: "#e74c3c" },
  { key: "BAR", glyph: "\u{1F4B0}", label: "Bar", weight: 4, color: "#f5d060" },
  { key: "BELL", glyph: "\u{1F514}", label: "Bell", weight: 6, color: "#ffd24a" },
  { key: "CHERRY", glyph: "\u{1F352}", label: "Cherry", weight: 8, color: "#ff5e7e" },
  { key: "LEMON", glyph: "\u{1F34B}", label: "Lemon", weight: 11, color: "#f2e34a" },
  { key: "PLUM", glyph: "\u{1F347}", label: "Plum", weight: 11, color: "#b06bd6" },
];

const SYM_BY_KEY: Record<SymKey, SymDef> = SYMBOLS.reduce(
  (acc, s) => {
    acc[s.key] = s;
    return acc;
  },
  {} as Record<SymKey, SymDef>,
);

const SYM_KEYS = SYMBOLS.map((s) => s.key);
const SYM_WEIGHTS = SYMBOLS.map((s) => s.weight);

function spinSymbol(): SymKey {
  return weightedPick(SYM_KEYS, SYM_WEIGHTS);
}

// ---------------------------------------------------------------------------
// Paytable / evaluation. A multiplier x means win(stake * x); x INCLUDES the
// stake (e.g. 100x returns 100× the stake). Loss returns 0.
// ---------------------------------------------------------------------------
interface Outcome {
  multiplier: number;
  label: string;
  tier: "jackpot" | "big" | "win" | "small" | "loss";
}

/** Evaluate the three symbols on the center payline (left→right). */
function evaluateLine(line: SymKey[]): Outcome {
  const [a, b, c] = line;
  const allSame = a === b && b === c;

  // 3 of a kind.
  if (allSame) {
    switch (a) {
      case "7":
        return { multiplier: 100, label: "JACKPOT — Triple Sevens!", tier: "jackpot" };
      case "BAR":
        return { multiplier: 40, label: "Triple Bars!", tier: "big" };
      case "BELL":
        return { multiplier: 20, label: "Triple Bells!", tier: "big" };
      case "CHERRY":
        return { multiplier: 12, label: "Triple Cherries!", tier: "win" };
      default:
        return { multiplier: 6, label: `Triple ${SYM_BY_KEY[a].label}s!`, tier: "win" };
    }
  }

  // Note on "mixed BARs": the classic Lucky Sevens set has a single BAR symbol,
  // so a BAR/BAR/BAR line is always a clean triple (40×, handled above). With no
  // double/triple-bar variants there is no distinct "mixed bar" combo to score.

  // Cherry consolations (cherries pay on count regardless of position).
  // Cherries are the most common symbol (weight 8), so these consolation pays
  // dominate the return. At 4x / 2x the single payline returned ~150% RTP (a
  // player-favorable money pump); 2x / 1x lands it at ~95.2% RTP (sim-verified).
  // A single cherry now returns the stake (money back), the classic 3-reel feel.
  const cherryCount = line.filter((s) => s === "CHERRY").length;
  if (cherryCount === 2) {
    return { multiplier: 2, label: "Two Cherries", tier: "small" };
  }
  if (cherryCount === 1) {
    return { multiplier: 1, label: "Cherry — money back", tier: "small" };
  }

  return { multiplier: 0, label: "No win — spin again", tier: "loss" };
}

/** Which reel indices form the winning combination (for highlighting). */
function winningReels(line: SymKey[], outcome: Outcome): boolean[] {
  if (outcome.multiplier === 0) return [false, false, false];
  const [a, b, c] = line;
  if (a === b && b === c) return [true, true, true];
  // cherry-based wins highlight the cherry positions
  return line.map((s) => s === "CHERRY");
}

// Display paytable rows.
const PAYTABLE: { faces: string; name: string; pay: string; accent?: boolean }[] = [
  { faces: "7⃣ 7⃣ 7⃣", name: "Triple Sevens", pay: "100×", accent: true },
  { faces: "\u{1F4B0} \u{1F4B0} \u{1F4B0}", name: "Triple Bars", pay: "40×" },
  { faces: "\u{1F514} \u{1F514} \u{1F514}", name: "Triple Bells", pay: "20×" },
  { faces: "\u{1F352} \u{1F352} \u{1F352}", name: "Triple Cherries", pay: "12×" },
  { faces: "\u{1F34B}/\u{1F347} ×3", name: "Any Other Triple", pay: "6×" },
  { faces: "\u{1F352} \u{1F352} —", name: "Two Cherries", pay: "2×" },
  { faces: "\u{1F352} — —", name: "One Cherry", pay: "1× (money back)" },
];

// ---------------------------------------------------------------------------
// Reel component — a vertical scrolling strip of symbols. The center cell is
// the payline. While spinning, the strip translates with motion blur; on stop
// it settles so that `final` sits on the center row.
// ---------------------------------------------------------------------------
const CELL = 88; // px height of a single symbol cell
const STRIP_LEN = 24; // number of symbols in the scrolling strip

type ReelPhase = "idle" | "spinning" | "stopped";

function buildStrip(top: SymKey, mid: SymKey, bot: SymKey, fillSpin: boolean): SymKey[] {
  // Strip is read top→bottom. The LAST three entries are the resting window
  // [top, mid, bot]; the rest are random filler that whizzes by.
  const filler: SymKey[] = [];
  for (let i = 0; i < STRIP_LEN - 3; i++) {
    filler.push(fillSpin ? spinSymbol() : "LEMON");
  }
  return [...filler, top, mid, bot];
}

interface ReelProps {
  phase: ReelPhase;
  window3: SymKey[]; // [top, mid, bot] resting window
  highlightMid: boolean;
  bursting: boolean;
}

function Reel({ phase, window3, highlightMid, bursting }: ReelProps) {
  const y = useMotionValue(0);
  const [strip, setStrip] = useState<SymKey[]>(() =>
    buildStrip(window3[0], window3[1], window3[2], true),
  );
  const [blur, setBlur] = useState(0);

  // Resting offset so the LAST three entries occupy the visible 3-row window.
  const restY = -(STRIP_LEN - 3) * CELL;

  // Drive the reel based on phase. When phase flips to "stopped", animate to
  // rest with a springy overshoot; while "spinning", keep cycling.
  useEffect(() => {
    let cancelled = false;
    let controls: ReturnType<typeof animate> | null = null;

    if (phase === "spinning") {
      // Rebuild a fresh whizzing strip and loop a fast scroll.
      setStrip(buildStrip(window3[0], window3[1], window3[2], true));
      setBlur(7);
      y.set(0);
      const loop = () => {
        if (cancelled) return;
        y.set(0);
        controls = animate(y, -(STRIP_LEN - 3) * CELL, {
          duration: 0.32,
          ease: "linear",
          onComplete: () => {
            if (!cancelled) loop();
          },
        });
      };
      loop();
    } else if (phase === "stopped") {
      setBlur(0);
      // Make sure the rest window holds the final symbols.
      setStrip(buildStrip(window3[0], window3[1], window3[2], true));
      controls = animate(y, restY, {
        type: "spring",
        stiffness: 320,
        damping: 22,
        mass: 1.1,
      });
    } else {
      setBlur(0);
      y.set(restY);
    }

    return () => {
      cancelled = true;
      controls?.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  return (
    <div
      className="relative overflow-hidden rounded-xl"
      style={{
        height: CELL * 3,
        width: CELL,
        background:
          "linear-gradient(180deg, rgba(20,8,8,0.95), rgba(40,14,14,0.95))",
        boxShadow:
          "inset 0 0 24px rgba(0,0,0,0.8), inset 0 0 0 2px rgba(245,208,96,0.25)",
      }}
    >
      {/* scrolling strip */}
      <motion.div
        style={{ y, filter: blur ? `blur(${blur}px)` : "none" }}
        className="absolute inset-x-0 top-0"
      >
        {strip.map((s, i) => {
          const def = SYM_BY_KEY[s];
          return (
            <div
              key={i}
              className="grid place-items-center"
              style={{ height: CELL, width: CELL }}
            >
              <span
                style={{
                  fontSize: 46,
                  lineHeight: 1,
                  filter: `drop-shadow(0 0 8px ${def.color}55)`,
                }}
              >
                {def.glyph}
              </span>
            </div>
          );
        })}
      </motion.div>

      {/* center payline window highlight */}
      <div
        className="pointer-events-none absolute inset-x-0"
        style={{
          top: CELL,
          height: CELL,
          borderTop: "1px solid rgba(245,208,96,0.18)",
          borderBottom: "1px solid rgba(245,208,96,0.18)",
        }}
      />
      <AnimatePresence>
        {highlightMid && (
          <motion.div
            className="pointer-events-none absolute inset-x-0"
            style={{ top: CELL, height: CELL }}
            initial={{ opacity: 0 }}
            animate={{ opacity: [0.25, 0.7, 0.25] }}
            exit={{ opacity: 0 }}
            transition={{ duration: 1.1, repeat: Infinity }}
          >
            <div
              className="h-full w-full"
              style={{
                background:
                  "linear-gradient(90deg, rgba(231,76,60,0) 0%, rgba(231,76,60,0.35) 50%, rgba(231,76,60,0) 100%)",
                boxShadow: `inset 0 0 22px ${ACCENT}`,
              }}
            />
          </motion.div>
        )}
      </AnimatePresence>

      {/* coin burst on a winning reel */}
      <AnimatePresence>
        {bursting && (
          <CoinBurst key="burst" />
        )}
      </AnimatePresence>

      {/* glass glare overlays for cabinet feel (top + bottom fades) */}
      <div
        className="pointer-events-none absolute inset-x-0 top-0"
        style={{
          height: CELL * 0.9,
          background: "linear-gradient(180deg, rgba(0,0,0,0.65), transparent)",
        }}
      />
      <div
        className="pointer-events-none absolute inset-x-0 bottom-0"
        style={{
          height: CELL * 0.9,
          background: "linear-gradient(0deg, rgba(0,0,0,0.65), transparent)",
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Coin burst — emoji coins flying out of a winning reel cell.
// ---------------------------------------------------------------------------
function CoinBurst() {
  const coins = useMemo(
    () =>
      Array.from({ length: 10 }, (_, i) => ({
        id: i,
        dx: randInt(-70, 70),
        dy: randInt(-120, -40),
        rot: randInt(-220, 220),
        delay: i * 0.025,
      })),
    [],
  );
  return (
    <div
      className="pointer-events-none absolute left-1/2 -translate-x-1/2"
      style={{ top: CELL * 1.5 }}
    >
      {coins.map((c) => (
        <motion.span
          key={c.id}
          className="absolute"
          style={{ fontSize: 22 }}
          initial={{ x: 0, y: 0, opacity: 0, scale: 0.4, rotate: 0 }}
          animate={{
            x: c.dx,
            y: c.dy,
            opacity: [0, 1, 1, 0],
            scale: [0.4, 1, 1, 0.6],
            rotate: c.rot,
          }}
          transition={{ duration: 0.9, delay: c.delay, ease: "easeOut" }}
        >
          {"\u{1FA99}"}
        </motion.span>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Animated counter for the win payout readout.
// ---------------------------------------------------------------------------
function Counter({ value }: { value: number }) {
  const mv = useMotionValue(0);
  const [display, setDisplay] = useState(0);
  useEffect(() => {
    const controls = animate(mv, value, {
      duration: 0.7,
      ease: "easeOut",
      onUpdate: (v) => setDisplay(Math.round(v)),
    });
    return () => controls.stop();
  }, [value, mv]);
  return <>{formatChips(display)}</>;
}

// ---------------------------------------------------------------------------
// Main game
// ---------------------------------------------------------------------------
type GamePhase = "idle" | "spinning" | "resolved";

const MIN_BET = 5;

// Buy-a-bonus: pay BUY_COST_MULT× the bet for BUY_SPINS auto-spins whose wins
// are all multiplied by BUY_MULT. Base RTP is ~95.2%, so 10 spins × ×10 returns
// ~95.2× the bet — fair against the 100× cost.
const BUY_COST_MULT = 100;
const BUY_SPINS = 10;
const BUY_MULT = 10;

export default function LuckySevens() {
  const wallet = useWallet();
  const [bet, setBet] = useState(50);
  const [phase, setPhase] = useState<GamePhase>("idle");

  // The resting 3-row window for each reel: [top, mid, bot].
  const [windows, setWindows] = useState<SymKey[][]>([
    ["BAR", "7", "CHERRY"],
    ["BELL", "BAR", "PLUM"],
    ["CHERRY", "BELL", "LEMON"],
  ]);
  // Per-reel phase so they stop sequentially.
  const [reelPhase, setReelPhase] = useState<ReelPhase[]>([
    "idle",
    "idle",
    "idle",
  ]);

  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [payout, setPayout] = useState(0);
  const [lastDelta, setLastDelta] = useState(0);
  const [winReels, setWinReels] = useState<boolean[]>([false, false, false]);
  const [autoSpin, setAutoSpin] = useState(false);

  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  // Interval for reel tick sounds — stored separately so clearTimers can stop it.
  const tickIvRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const autoRef = useRef(false);
  autoRef.current = autoSpin;

  // Buy-bonus: remaining bonus spins + the active win multiplier (refs so the
  // async spin loop always sees the latest value).
  const bonusLeftRef = useRef(0);
  const buyMultRef = useRef(1);
  const [bonusActive, setBonusActive] = useState(false);

  const clearTimers = useCallback(() => {
    timers.current.forEach((t) => clearTimeout(t));
    timers.current = [];
    if (tickIvRef.current !== null) {
      clearInterval(tickIvRef.current);
      tickIvRef.current = null;
    }
  }, []);

  useEffect(() => () => clearTimers(), [clearTimers]);

  const balance = wallet.balance;
  const canBet = wallet.ready && bet >= MIN_BET && bet <= balance;
  const spinning = phase === "spinning";

  // A ref that always points to the latest doSpin — used inside async callbacks
  // to avoid stale-closure bugs where the captured doSpin sees stale phase/bet.
  const doSpinRef = useRef<() => void>(() => undefined);

  const doSpin = useCallback(() => {
    if (phase === "spinning") return;
    if (!wallet.ready) return;
    // Bonus spins are pre-paid by the buy — they don't draw from the wallet and
    // they consume one of the remaining bought spins.
    const isBonus = bonusLeftRef.current > 0;
    if (isBonus) {
      bonusLeftRef.current -= 1;
    } else {
      if (bet < MIN_BET || bet > wallet.balance) {
        setAutoSpin(false);
        return;
      }
      // Take the stake first. Abort if unaffordable.
      if (!wallet.bet(bet)) {
        setAutoSpin(false);
        return;
      }
    }

    clearTimers();
    setOutcome(null);
    setPayout(0);
    setLastDelta(0);
    setWinReels([false, false, false]);
    setPhase("spinning");

    // Decide the final results up-front using weightedPick per reel.
    const line: SymKey[] = [spinSymbol(), spinSymbol(), spinSymbol()];
    const next: SymKey[][] = line.map((mid) => [
      spinSymbol(),
      mid,
      spinSymbol(),
    ]);
    setWindows(next);
    setReelPhase(["spinning", "spinning", "spinning"]);
    sfx.tick();

    // Reel tick sounds while spinning — stored in ref so clearTimers can stop it.
    tickIvRef.current = setInterval(() => sfx.tick(), 90);

    // Stop reels sequentially left→right with a thud.
    const stopTimes = [820, 1240, 1700];
    stopTimes.forEach((ms, idx) => {
      const t = setTimeout(() => {
        sfx.thud();
        setReelPhase((p) => {
          const c = [...p];
          c[idx] = "stopped";
          return c;
        });
      }, ms);
      timers.current.push(t);
    });

    // Resolve shortly after the last reel settles.
    const resolveT = setTimeout(() => {
      // Stop tick interval.
      if (tickIvRef.current !== null) {
        clearInterval(tickIvRef.current);
        tickIvRef.current = null;
      }
      const result = evaluateLine(line);
      // Bonus spins multiply the win; normal spins use ×1.
      const gross =
        bet * result.multiplier * (isBonus ? buyMultRef.current : 1); // x includes stake
      setOutcome(result);
      setWinReels(winningReels(line, result));
      setPhase("resolved");

      if (gross > 0) {
        wallet.win(gross);
        setPayout(gross);
        setLastDelta(gross - bet);
        if (result.tier === "jackpot" || result.tier === "big") {
          sfx.jackpot();
        } else {
          sfx.win();
        }
      } else {
        setPayout(0);
        setLastDelta(-bet);
        sfx.lose();
      }

      // Continuation — keep going while auto-spin is on OR bonus spins remain.
      // Uses the ref to always call the latest doSpin (avoids the stale-closure
      // bug where the captured closure sees phase === "spinning" and bails).
      if (autoRef.current || bonusLeftRef.current > 0) {
        const again = setTimeout(() => {
          if (autoRef.current || bonusLeftRef.current > 0) doSpinRef.current();
        }, 1400);
        timers.current.push(again);
      } else if (isBonus) {
        // The bought bonus round just finished — clear the multiplier.
        buyMultRef.current = 1;
        setBonusActive(false);
      }
    }, stopTimes[2] + 520);
    timers.current.push(resolveT);
  }, [bet, phase, wallet, clearTimers]);

  // Keep the ref in sync with the latest doSpin every render.
  doSpinRef.current = doSpin;

  const buyCost = bet * BUY_COST_MULT;
  const handleBuy = useCallback(() => {
    if (phase === "spinning" || !wallet.ready) return;
    if (bonusLeftRef.current > 0) return;
    if (buyCost > wallet.balance) return;
    if (!wallet.bet(buyCost)) return;
    setAutoSpin(false);
    autoRef.current = false;
    bonusLeftRef.current = BUY_SPINS;
    buyMultRef.current = BUY_MULT;
    setBonusActive(true);
    sfx.jackpot();
    doSpinRef.current();
  }, [phase, wallet, buyCost]);

  const toggleAuto = useCallback(() => {
    setAutoSpin((a) => {
      const nextVal = !a;
      autoRef.current = nextVal;
      if (nextVal && phase !== "spinning") {
        // Kick off immediately via ref to avoid stale closure.
        setTimeout(() => doSpinRef.current(), 0);
      }
      return nextVal;
    });
  }, [phase]);

  const primaryDisabled = !canBet || spinning;

  return (
    <div className="mx-auto w-full max-w-4xl">
      {/* ----- Cabinet ----- */}
      <div
        className="felt relative overflow-hidden rounded-3xl p-4 sm:p-6"
        style={{
          background:
            "radial-gradient(120% 120% at 50% 0%, #3a0f0f 0%, #220909 55%, #160505 100%)",
          boxShadow: `0 0 0 2px rgba(245,208,96,0.35), 0 0 40px ${ACCENT}33, inset 0 0 60px rgba(0,0,0,0.6)`,
        }}
      >
        {/* marquee header */}
        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <motion.h2
              className="font-display text-2xl font-bold tracking-wider sm:text-3xl"
              style={{
                color: "#ffd24a",
                textShadow: `0 0 14px ${ACCENT}, 0 0 4px #fff8`,
              }}
              animate={{ textShadow: [
                `0 0 10px ${ACCENT}`,
                `0 0 22px ${ACCENT}, 0 0 6px #fff8`,
                `0 0 10px ${ACCENT}`,
              ] }}
              transition={{ duration: 2.2, repeat: Infinity }}
            >
              LUCKY SEVENS
            </motion.h2>
            <div className="text-[11px] uppercase tracking-[0.25em] text-amber-200/60">
              3 Reels &middot; Center Payline
            </div>
          </div>

          {/* marquee bulbs */}
          <div className="hidden gap-1.5 sm:flex">
            {Array.from({ length: 7 }).map((_, i) => (
              <motion.span
                key={i}
                className="h-2.5 w-2.5 rounded-full"
                style={{ background: i % 2 ? "#ffd24a" : ACCENT }}
                animate={{ opacity: [0.3, 1, 0.3] }}
                transition={{
                  duration: 1.1,
                  repeat: Infinity,
                  delay: i * 0.12,
                }}
              />
            ))}
          </div>
        </div>

        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_220px]">
          {/* ----- Reels + readout ----- */}
          <div>
            <div
              className="relative mx-auto flex items-center justify-center gap-3 rounded-2xl p-4"
              style={{
                background:
                  "linear-gradient(180deg, #1a0606, #2a0a0a)",
                boxShadow:
                  "inset 0 0 0 4px rgba(245,208,96,0.4), inset 0 6px 26px rgba(0,0,0,0.7)",
                width: "fit-content",
                maxWidth: "100%",
              }}
            >
              {/* payline arrows */}
              <span
                className="pointer-events-none absolute left-1 top-1/2 -translate-y-1/2 text-lg"
                style={{ color: ACCENT, filter: "drop-shadow(0 0 6px #e74c3c)" }}
              >
                {"▶"}
              </span>
              <span
                className="pointer-events-none absolute right-1 top-1/2 -translate-y-1/2 text-lg"
                style={{ color: ACCENT, filter: "drop-shadow(0 0 6px #e74c3c)" }}
              >
                {"◀"}
              </span>

              {[0, 1, 2].map((i) => (
                <Reel
                  key={i}
                  phase={reelPhase[i]}
                  window3={windows[i]}
                  highlightMid={phase === "resolved" && winReels[i]}
                  bursting={phase === "resolved" && winReels[i] && payout > 0}
                />
              ))}
            </div>

            {/* result readout */}
            <div className="mt-4 min-h-[84px]">
              <AnimatePresence mode="wait">
                {phase === "resolved" && outcome ? (
                  <motion.div
                    key={outcome.label + payout}
                    data-testid="round-result"
                    initial={{ opacity: 0, y: 10, scale: 0.96 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: -8 }}
                    className="rounded-2xl border px-4 py-3 text-center"
                    style={{
                      borderColor:
                        payout > 0 ? "rgba(245,208,96,0.5)" : "rgba(255,255,255,0.1)",
                      background:
                        payout > 0
                          ? "linear-gradient(180deg, rgba(245,208,96,0.14), rgba(231,76,60,0.1))"
                          : "rgba(0,0,0,0.3)",
                    }}
                  >
                    <div
                      className="font-display text-lg font-bold"
                      style={{ color: payout > 0 ? "#ffd24a" : "#ff8b8b" }}
                    >
                      {outcome.label}
                    </div>
                    {payout > 0 ? (
                      <div className="mt-1 flex items-center justify-center gap-3 text-sm">
                        <span className="text-amber-200/70">
                          {formatMultiplier(outcome.multiplier)}
                        </span>
                        <span className="font-bold text-emerald-300 tabular-nums">
                          Won <Counter value={payout} />
                        </span>
                        <span className="text-emerald-400/80 tabular-nums">
                          {formatDelta(lastDelta)}
                        </span>
                      </div>
                    ) : (
                      <div className="mt-1 text-sm text-white/50 tabular-nums">
                        {formatDelta(lastDelta)}
                      </div>
                    )}
                  </motion.div>
                ) : (
                  <motion.div
                    key="idle-readout"
                    data-testid="round-result"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="grid h-full place-items-center rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-center text-sm text-white/45"
                  >
                    {spinning ? "Spinning… good luck!" : "Set your bet and pull the lever."}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </div>

          {/* ----- Paytable ----- */}
          <div className="rounded-2xl border border-amber-300/20 bg-black/30 p-3">
            <div className="mb-2 text-center text-[11px] font-bold uppercase tracking-widest text-amber-200/70">
              Paytable
            </div>
            <ul className="space-y-1.5">
              {PAYTABLE.map((row) => (
                <li
                  key={row.name}
                  className="flex items-center justify-between gap-2 rounded-lg px-2 py-1"
                  style={{
                    background: row.accent
                      ? "linear-gradient(90deg, rgba(231,76,60,0.18), transparent)"
                      : "transparent",
                  }}
                >
                  <span className="text-base" aria-hidden>
                    {row.faces}
                  </span>
                  <span className="flex-1 truncate text-[10px] text-white/55">
                    {row.name}
                  </span>
                  <span
                    className="font-bold tabular-nums"
                    style={{ color: row.accent ? "#ffd24a" : "#ffe8a3" }}
                  >
                    {row.pay}
                  </span>
                </li>
              ))}
            </ul>
            <div className="mt-2 border-t border-white/10 pt-2 text-[9px] leading-relaxed text-white/35">
              Pays on the center line only. Cherries pay anywhere on the line.
            </div>
          </div>
        </div>

        {/* ----- Bet controls ----- */}
        <div className="mt-5">
          <BetControls
            bet={bet}
            setBet={setBet}
            balance={balance}
            min={MIN_BET}
            chips={[5, 25, 50, 100, 500]}
            disabled={spinning}
          />
        </div>

        {/* ----- Action row ----- */}
        <div className="mt-4 flex flex-wrap items-center justify-center gap-3">
          <Button
            data-testid="play-btn"
            size="lg"
            variant="danger"
            disabled={primaryDisabled || bonusActive}
            onClick={doSpin}
            className="min-w-[160px]"
          >
            <motion.span
              animate={spinning ? { rotate: 360 } : { rotate: 0 }}
              transition={
                spinning
                  ? { duration: 0.8, repeat: Infinity, ease: "linear" }
                  : { duration: 0.2 }
              }
              style={{ display: "inline-block" }}
            >
              {"\u{1F3B0}"}
            </motion.span>
            {spinning ? "Spinning…" : "SPIN"}
          </Button>

          <Button
            data-testid="autospin-btn"
            size="lg"
            variant={autoSpin ? "gold" : "ghost"}
            disabled={!wallet.ready || bonusActive || (!autoSpin && !canBet)}
            onClick={toggleAuto}
          >
            {autoSpin ? "Auto: ON" : "Auto Spin"}
          </Button>

          <Button
            data-testid="buy-bonus-btn"
            size="lg"
            variant="ghost"
            disabled={!wallet.ready || spinning || bonusActive || buyCost > balance}
            onClick={handleBuy}
            className="border border-amber-300/50 text-amber-200"
            title={`Buy ${BUY_SPINS} spins at ${BUY_MULT}× for ${BUY_COST_MULT}× your bet`}
          >
            {bonusActive
              ? `BONUS · ${bonusLeftRef.current}`
              : `🪙 Buy Bonus · ${formatChips(buyCost)}`}
          </Button>
        </div>

        {/* balance / cost footer */}
        <div className="mt-3 flex items-center justify-center gap-4 text-[11px] text-white/45">
          <span>
            Balance:{" "}
            <span className="font-semibold text-amber-200/80 tabular-nums">
              {wallet.ready ? formatChips(balance) : "—"}
            </span>
          </span>
          <span className="text-white/20">|</span>
          <span>
            Bet this spin:{" "}
            <span className="font-semibold text-amber-200/80 tabular-nums">
              {formatChips(bet)}
            </span>
          </span>
          {bet > balance && wallet.ready && (
            <span className="font-semibold text-red-400">Insufficient balance</span>
          )}
        </div>
      </div>
    </div>
  );
}
