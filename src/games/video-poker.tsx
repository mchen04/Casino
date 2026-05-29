"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  AnimatePresence,
  motion,
  useMotionValue,
  useSpring,
  useTransform,
} from "framer-motion";
import {
  type Card,
  HandCategory,
  evaluate5,
  makeShoe,
  rankValue,
} from "@/lib/cards";
import { useWallet } from "@/lib/wallet";
import { formatChips, formatDelta } from "@/lib/format";
import { sfx } from "@/lib/sound";
import { Button } from "@/components/ui/Button";
import { PlayingCard } from "@/components/PlayingCard";
import { CollapsiblePanel } from "@/components/CollapsiblePanel";

const ACCENT = "#22e1ff";

// ---------------------------------------------------------------------------
// Paytable
// ---------------------------------------------------------------------------
// Jacks-or-Better is a refinement of HandCategory.Pair (only J/Q/K/A pairs pay),
// so we model it as a synthetic key that the resolver maps to.
type PayKey =
  | "royal"
  | "straightFlush"
  | "fourKind"
  | "fullHouse"
  | "flush"
  | "straight"
  | "threeKind"
  | "twoPair"
  | "jacksOrBetter";

interface PayRow {
  key: PayKey;
  label: string;
  /** Pay per coin for coin counts 1..4. */
  perCoin: number;
  /** Pay per coin at the max 5-coin bet (Royal Flush jumps to 800). */
  perCoinMax: number;
}

// Standard 9/6 Jacks or Better paytable (per-coin multipliers of the total bet).
const PAYTABLE: PayRow[] = [
  { key: "royal", label: "Royal Flush", perCoin: 250, perCoinMax: 800 },
  { key: "straightFlush", label: "Straight Flush", perCoin: 50, perCoinMax: 50 },
  { key: "fourKind", label: "Four of a Kind", perCoin: 25, perCoinMax: 25 },
  { key: "fullHouse", label: "Full House", perCoin: 9, perCoinMax: 9 },
  { key: "flush", label: "Flush", perCoin: 6, perCoinMax: 6 },
  { key: "straight", label: "Straight", perCoin: 4, perCoinMax: 4 },
  { key: "threeKind", label: "Three of a Kind", perCoin: 3, perCoinMax: 3 },
  { key: "twoPair", label: "Two Pair", perCoin: 2, perCoinMax: 2 },
  { key: "jacksOrBetter", label: "Jacks or Better", perCoin: 1, perCoinMax: 1 },
];

const COIN_VALUES = [5, 25, 100] as const;
type CoinValue = (typeof COIN_VALUES)[number];

type Phase = "betting" | "dealing" | "holding" | "drawing" | "result";

interface Outcome {
  key: PayKey | null;
  label: string;
  perCoin: number;
  gross: number;
  net: number;
}

/**
 * Map a final 5-card hand to a paytable key (or null for a losing hand).
 * Jacks-or-Better: a Pair only pays when the pair rank is J(11) or higher.
 */
function payKeyFor(cards: Card[]): PayKey | null {
  const hand = evaluate5(cards);
  switch (hand.category) {
    case HandCategory.RoyalFlush:
      return "royal";
    case HandCategory.StraightFlush:
      return "straightFlush";
    case HandCategory.FourOfAKind:
      return "fourKind";
    case HandCategory.FullHouse:
      return "fullHouse";
    case HandCategory.Flush:
      return "flush";
    case HandCategory.Straight:
      return "straight";
    case HandCategory.ThreeOfAKind:
      return "threeKind";
    case HandCategory.TwoPair:
      return "twoPair";
    case HandCategory.Pair: {
      // tiebreak[0] is the paired rank value; pay only J/Q/K/A.
      const pairRank = hand.tiebreak[0] ?? 0;
      return pairRank >= 11 ? "jacksOrBetter" : null;
    }
    default:
      return null;
  }
}

/**
 * Determine which board indices form the scoring combination, so the winning
 * cards can be highlighted. Returns a Set of indices (0..4).
 */
function winningIndices(cards: Card[], key: PayKey | null): Set<number> {
  const set = new Set<number>();
  if (!key) return set;
  switch (key) {
    case "royal":
    case "straightFlush":
    case "flush":
    case "straight":
    case "fullHouse":
      // Whole hand participates.
      cards.forEach((_, i) => set.add(i));
      return set;
    case "fourKind":
    case "threeKind":
    case "jacksOrBetter": {
      // Highlight the n-of-a-kind group(s).
      const counts = new Map<number, number[]>();
      cards.forEach((c, i) => {
        const v = rankValue(c.rank);
        const arr = counts.get(v) ?? [];
        arr.push(i);
        counts.set(v, arr);
      });
      const target =
        key === "fourKind" ? 4 : key === "threeKind" ? 3 : 2;
      for (const idxs of counts.values()) {
        if (key === "jacksOrBetter") {
          if (idxs.length === 2) idxs.forEach((i) => set.add(i));
        } else if (idxs.length === target) {
          idxs.forEach((i) => set.add(i));
        }
      }
      return set;
    }
    case "twoPair": {
      const counts = new Map<number, number[]>();
      cards.forEach((c, i) => {
        const v = rankValue(c.rank);
        const arr = counts.get(v) ?? [];
        arr.push(i);
        counts.set(v, arr);
      });
      for (const idxs of counts.values()) {
        if (idxs.length === 2) idxs.forEach((i) => set.add(i));
      }
      return set;
    }
    default:
      return set;
  }
}

// ---------------------------------------------------------------------------
// Rolling credit counter
// ---------------------------------------------------------------------------
function RollingNumber({ value }: { value: number }) {
  const mv = useMotionValue(value);
  const spring = useSpring(mv, { stiffness: 90, damping: 18, mass: 0.6 });
  const text = useTransform(spring, (v) => formatChips(v));
  useEffect(() => {
    mv.set(value);
  }, [mv, value]);
  return <motion.span className="tabular-nums">{text}</motion.span>;
}

// ---------------------------------------------------------------------------
// Coin-count selector pip
// ---------------------------------------------------------------------------
function CoinPip({
  index,
  active,
  disabled,
  onClick,
}: {
  index: number;
  active: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <motion.button
      type="button"
      data-testid={`coin-${index}`}
      disabled={disabled}
      onClick={onClick}
      whileHover={disabled ? undefined : { y: -3, scale: 1.08 }}
      whileTap={disabled ? undefined : { scale: 0.9 }}
      animate={
        active
          ? { boxShadow: `0 0 14px ${ACCENT}, 0 0 4px ${ACCENT}` }
          : { boxShadow: "0 2px 6px rgba(0,0,0,0.5)" }
      }
      className="grid h-9 w-9 place-items-center rounded-full font-bold disabled:cursor-not-allowed sm:h-10 sm:w-10"
      style={{
        background: active
          ? `radial-gradient(circle at 50% 35%, ${ACCENT} 0%, #0e7490 70%, #063b48 100%)`
          : "radial-gradient(circle at 50% 35%, #1a222e 0%, #0b0f16 100%)",
        color: active ? "#04141a" : "rgba(255,255,255,0.55)",
        border: active
          ? `2px solid #bff7ff`
          : "2px dashed rgba(255,255,255,0.15)",
      }}
      aria-label={`Bet ${index} coin${index > 1 ? "s" : ""}`}
    >
      {index}
    </motion.button>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------
export default function VideoPoker() {
  const wallet = useWallet();

  const [coins, setCoins] = useState<number>(5);
  const [coinValue, setCoinValue] = useState<CoinValue>(25);

  const [hand, setHand] = useState<(Card | null)[]>([
    null,
    null,
    null,
    null,
    null,
  ]);
  const [faceDown, setFaceDown] = useState<boolean[]>([
    true,
    true,
    true,
    true,
    true,
  ]);
  const [held, setHeld] = useState<boolean[]>([
    false,
    false,
    false,
    false,
    false,
  ]);
  const [phase, setPhase] = useState<Phase>("betting");
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [winSet, setWinSet] = useState<Set<number>>(new Set());
  const [dealtCount, setDealtCount] = useState(0);
  const [burstKey, setBurstKey] = useState(0);

  // The shoe + the next index to draw from (cards 5..) for the current hand.
  const deckRef = useRef<Card[]>([]);
  const drawPtr = useRef(5);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  const totalBet = coins * coinValue;
  const balance = wallet.ready ? wallet.balance : 0;
  const canAfford = totalBet <= balance && totalBet > 0;

  const clearTimers = useCallback(() => {
    timers.current.forEach((t) => clearTimeout(t));
    timers.current = [];
  }, []);

  useEffect(() => clearTimers, [clearTimers]);

  const schedule = useCallback((fn: () => void, ms: number) => {
    const t = setTimeout(fn, ms);
    timers.current.push(t);
  }, []);

  // Keep coin count affordable when value/balance changes pre-round.
  useEffect(() => {
    if (phase !== "betting" && phase !== "result") return;
    const maxAffordable = Math.floor(balance / coinValue);
    if (maxAffordable < coins && maxAffordable >= 1) {
      setCoins(Math.max(1, Math.min(coins, maxAffordable)));
    }
  }, [balance, coinValue, coins, phase]);

  const locked = phase === "dealing" || phase === "drawing";

  // -------------------------------------------------------------------------
  // Deal
  // -------------------------------------------------------------------------
  const deal = useCallback(() => {
    if (locked) return;
    if (!canAfford) return;
    if (!wallet.bet(totalBet)) return;

    clearTimers();
    const shoe = makeShoe(1);
    deckRef.current = shoe;
    drawPtr.current = 5;

    const next = shoe.slice(0, 5);
    setHand(next);
    setHeld([false, false, false, false, false]);
    setFaceDown([true, true, true, true, true]);
    setWinSet(new Set());
    setOutcome(null);
    setDealtCount(0);
    setPhase("dealing");
    sfx.chip();

    // Cascade-flip the 5 cards face up.
    for (let i = 0; i < 5; i++) {
      schedule(() => {
        setFaceDown((fd) => {
          const copy = fd.slice();
          copy[i] = false;
          return copy;
        });
        setDealtCount(i + 1);
        sfx.card();
      }, 160 + i * 130);
    }
    schedule(() => setPhase("holding"), 160 + 5 * 130 + 250);
  }, [locked, canAfford, wallet, totalBet, clearTimers, schedule]);

  // -------------------------------------------------------------------------
  // Toggle hold
  // -------------------------------------------------------------------------
  const toggleHold = useCallback(
    (i: number) => {
      if (phase !== "holding") return;
      setHeld((h) => {
        const copy = h.slice();
        copy[i] = !copy[i];
        return copy;
      });
      sfx.tick();
    },
    [phase],
  );

  // -------------------------------------------------------------------------
  // Resolve final hand & pay
  // -------------------------------------------------------------------------
  const resolve = useCallback(
    (finalCards: Card[]) => {
      const key = payKeyFor(finalCards);
      const row = key ? PAYTABLE.find((r) => r.key === key) ?? null : null;
      const perCoin = row ? (coins === 5 ? row.perCoinMax : row.perCoin) : 0;
      const gross = perCoin * coins * coinValue;
      const net = gross - totalBet;

      setWinSet(winningIndices(finalCards, key));
      setOutcome({
        key,
        label: row ? row.label : "No Win",
        perCoin,
        gross,
        net,
      });
      setPhase("result");

      if (gross > 0) {
        wallet.win(gross);
        setBurstKey((k) => k + 1);
        if (key === "royal" || key === "straightFlush" || key === "fourKind") {
          sfx.jackpot();
        } else {
          sfx.win();
        }
      } else {
        sfx.lose();
      }
    },
    [coins, coinValue, totalBet, wallet],
  );

  // -------------------------------------------------------------------------
  // Draw — replace non-held cards from the same deck
  // -------------------------------------------------------------------------
  const draw = useCallback(() => {
    if (phase !== "holding") return;
    setPhase("drawing");
    clearTimers();

    // All 5 slots are real Cards by the time we reach "holding" phase.
    // Filter out any unexpected nulls (guards evaluate5 from bad input).
    const current: Card[] = hand.filter((c): c is Card => c !== null);
    if (current.length !== 5) return; // should never happen
    const final = current.slice();
    const replaceIdx: number[] = [];
    for (let i = 0; i < 5; i++) {
      if (!held[i]) replaceIdx.push(i);
    }

    if (replaceIdx.length === 0) {
      // Stand pat — straight to resolve with a brief beat.
      schedule(() => resolve(final), 220);
      return;
    }

    // Flip replaced cards down, swap their value, flip back up — one by one.
    replaceIdx.forEach((idx, n) => {
      schedule(() => {
        setFaceDown((fd) => {
          const copy = fd.slice();
          copy[idx] = true;
          return copy;
        });
        sfx.card();
      }, n * 200);

      schedule(() => {
        const replacement = deckRef.current[drawPtr.current++];
        if (!replacement) return; // deck exhausted (should never happen with a 52-card shoe)
        final[idx] = replacement;
        setHand((h) => {
          const copy = h.slice();
          copy[idx] = replacement;
          return copy;
        });
        setFaceDown((fd) => {
          const copy = fd.slice();
          copy[idx] = false;
          return copy;
        });
        sfx.card();
      }, n * 200 + 240);
    });

    const done = replaceIdx.length * 200 + 240 + 360;
    schedule(() => resolve(final), done);
  }, [phase, hand, held, clearTimers, schedule, resolve]);

  // -------------------------------------------------------------------------
  // New hand (reset to betting)
  // -------------------------------------------------------------------------
  const newHand = useCallback(() => {
    clearTimers();
    setPhase("betting");
    setHand([null, null, null, null, null]);
    setFaceDown([true, true, true, true, true]);
    setHeld([false, false, false, false, false]);
    setWinSet(new Set());
    setOutcome(null);
    setDealtCount(0);
    sfx.click();
  }, [clearTimers]);

  const setCoinsSafe = useCallback(
    (n: number) => {
      if (phase !== "betting" && phase !== "result") return;
      const maxAffordable = Math.max(1, Math.floor(balance / coinValue));
      const clamped = Math.max(1, Math.min(5, Math.min(n, maxAffordable)));
      setCoins(clamped);
      sfx.chip();
      if (phase === "result") newHand();
    },
    [phase, balance, coinValue, newHand],
  );

  const setCoinValueSafe = useCallback(
    (v: CoinValue) => {
      if (phase !== "betting" && phase !== "result") return;
      setCoinValue(v);
      sfx.chip();
      if (phase === "result") newHand();
    },
    [phase, newHand],
  );

  const highlightKey = outcome?.key ?? null;

  // Which paytable per-coin column to emphasise (always show the active bet).
  const usingMax = coins === 5;

  const dealDisabled =
    locked || (phase !== "betting" && phase !== "result") || !canAfford;

  return (
    <div className="mx-auto w-full max-w-5xl">
      <div
        className="felt relative overflow-hidden rounded-3xl p-4 sm:p-6"
        style={{ boxShadow: `inset 0 0 0 1px rgba(34,225,255,0.12)` }}
      >
        {/* ambient grid + accent glows */}
        <div className="pointer-events-none absolute inset-0 bg-grid opacity-40" />
        <div
          className="pointer-events-none absolute -left-24 -top-24 h-64 w-64 rounded-full opacity-30 blur-3xl"
          style={{ background: ACCENT }}
        />
        <div
          className="pointer-events-none absolute -bottom-24 -right-24 h-64 w-64 rounded-full opacity-20 blur-3xl"
          style={{ background: "#ff2bd1" }}
        />

        {/* Header */}
        <div className="relative z-10 mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2
              className="font-display text-2xl font-bold tracking-wide sm:text-3xl neon-cyan"
              style={{ color: ACCENT }}
            >
              Video Poker
            </h2>
            <p className="text-xs uppercase tracking-[0.3em] text-white/40">
              Jacks or Better · 9/6
            </p>
          </div>
          <div className="flex items-center gap-3">
            <div className="rounded-xl border border-white/10 bg-black/40 px-4 py-2 text-right">
              <div className="text-[9px] uppercase tracking-widest text-white/40">
                Balance
              </div>
              <div className="gold-text text-lg font-bold tabular-nums">
                {wallet.ready ? formatChips(wallet.balance) : "—"}
              </div>
            </div>
            <div
              className="rounded-xl border px-4 py-2 text-right"
              style={{ borderColor: `${ACCENT}55`, background: "rgba(34,225,255,0.06)" }}
            >
              <div className="text-[9px] uppercase tracking-widest text-white/40">
                Total Bet
              </div>
              <div
                className="text-lg font-bold tabular-nums"
                style={{ color: ACCENT }}
              >
                {formatChips(totalBet)}
              </div>
            </div>
          </div>
        </div>

        <div className="relative z-10 grid gap-2 sm:gap-4 md:grid-cols-[1.65fr_1fr]">
          {/* ---------------- Table / cards ---------------- */}
          <div className="flex flex-col">
            <div className="glass relative flex flex-1 flex-col items-center justify-center gap-2 rounded-2xl p-4 sm:gap-4 sm:p-6 [@media(max-height:600px)]:p-3">
              {/* Win burst */}
              <AnimatePresence>
                {outcome && outcome.gross > 0 && (
                  <WinBurst
                    key={burstKey}
                    big={
                      outcome.key === "royal" ||
                      outcome.key === "straightFlush" ||
                      outcome.key === "fourKind"
                    }
                  />
                )}
              </AnimatePresence>

              {/* Cards row */}
              <div className="flex origin-center items-end justify-center gap-1.5 sm:gap-3 [@media(max-height:600px)]:scale-[0.62] [@media(max-width:380px)]:scale-90">
                {hand.map((card, i) => {
                  const isHeld = held[i];
                  const isWin =
                    phase === "result" && winSet.has(i) && (outcome?.gross ?? 0) > 0;
                  const clickable = phase === "holding";
                  const appeared = i < dealtCount || phase !== "dealing";
                  return (
                    <div
                      key={i}
                      className="relative flex flex-col items-center"
                    >
                      {/* HELD badge */}
                      <AnimatePresence>
                        {isHeld && phase !== "betting" && (
                          <motion.div
                            initial={{ opacity: 0, y: 8, scale: 0.7 }}
                            animate={{ opacity: 1, y: 0, scale: 1 }}
                            exit={{ opacity: 0, y: 8, scale: 0.7 }}
                            className="absolute -top-6 z-20 rounded-md px-2 py-0.5 text-[10px] font-extrabold tracking-widest"
                            style={{
                              background: ACCENT,
                              color: "#04141a",
                              boxShadow: `0 0 12px ${ACCENT}`,
                            }}
                          >
                            HELD
                          </motion.div>
                        )}
                      </AnimatePresence>

                      <motion.button
                        type="button"
                        data-testid={`card-${i}`}
                        disabled={!clickable}
                        onClick={() => toggleHold(i)}
                        initial={{ y: -120, opacity: 0, rotate: -8 }}
                        animate={{
                          y: appeared ? (isHeld ? -10 : 0) : -120,
                          opacity: appeared ? 1 : 0,
                          rotate: 0,
                          scale: isWin ? 1.06 : 1,
                        }}
                        transition={{
                          type: "spring",
                          stiffness: 320,
                          damping: 24,
                        }}
                        whileHover={clickable ? { y: isHeld ? -16 : -6 } : undefined}
                        whileTap={clickable ? { scale: 0.95 } : undefined}
                        className={`relative rounded-xl ${
                          clickable ? "cursor-pointer" : "cursor-default"
                        }`}
                        style={{
                          outline: isHeld
                            ? `2px solid ${ACCENT}`
                            : "2px solid transparent",
                          borderRadius: 12,
                          boxShadow: isHeld
                            ? `0 0 16px ${ACCENT}`
                            : "none",
                        }}
                        aria-label={
                          card
                            ? `${card.rank} of ${card.suit}${isHeld ? ", held" : ""}`
                            : "card"
                        }
                      >
                        <PlayingCard
                          card={card}
                          faceDown={faceDown[i]}
                          size="lg"
                          highlight={isWin}
                        />
                      </motion.button>

                      {/* HOLD hint label under card during holding phase */}
                      {phase === "holding" && (
                        <motion.div
                          initial={{ opacity: 0 }}
                          animate={{ opacity: isHeld ? 0 : 0.55 }}
                          className="mt-2 text-[9px] uppercase tracking-widest text-white/50"
                        >
                          tap to hold
                        </motion.div>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Result banner */}
              <div className="mt-2 min-h-[44px] w-full text-center sm:min-h-[56px] [@media(max-height:600px)]:mt-0 [@media(max-height:600px)]:min-h-[32px]">
                <AnimatePresence mode="wait">
                  {phase === "result" && outcome ? (
                    <motion.div
                      key="result"
                      data-testid="round-result"
                      initial={{ opacity: 0, y: 10, scale: 0.95 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      exit={{ opacity: 0, y: -10 }}
                      transition={{ type: "spring", stiffness: 280, damping: 20 }}
                    >
                      <div
                        className="font-display text-xl font-bold sm:text-2xl"
                        style={{
                          color: outcome.gross > 0 ? ACCENT : "#ff6b6b",
                          textShadow:
                            outcome.gross > 0
                              ? `0 0 12px ${ACCENT}`
                              : "none",
                        }}
                      >
                        {outcome.gross > 0
                          ? outcome.label.toUpperCase()
                          : `${outcome.label} — try again`}
                      </div>
                      <div
                        className="mt-0.5 text-sm font-bold tabular-nums"
                        style={{
                          color: outcome.net >= 0 ? "#8aff80" : "#ff8a8a",
                        }}
                      >
                        {outcome.gross > 0 ? (
                          <>
                            Won <RollingNumber value={outcome.gross} /> ·{" "}
                            {formatDelta(outcome.net)}
                          </>
                        ) : (
                          formatDelta(outcome.net)
                        )}
                      </div>
                    </motion.div>
                  ) : phase === "holding" ? (
                    <motion.div
                      key="holding"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      className="font-display text-base font-semibold text-white/70 sm:text-lg"
                    >
                      Hold the cards you want, then Draw
                    </motion.div>
                  ) : phase === "dealing" || phase === "drawing" ? (
                    <motion.div
                      key="busy"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      className="font-display text-base font-semibold text-white/50"
                    >
                      {phase === "dealing" ? "Dealing…" : "Drawing…"}
                    </motion.div>
                  ) : (
                    <motion.div
                      key="idle"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      className="font-display text-base font-semibold text-white/40"
                    >
                      Set your bet and Deal
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </div>

            {/* ---------------- Controls ---------------- */}
            <div className="glass mt-2 rounded-2xl p-3 sm:mt-4 sm:p-4">
              {/* Coin value selector */}
              <div className="mb-2 flex flex-wrap items-center justify-between gap-3 sm:mb-3">
                <div className="flex items-center gap-2">
                  <span className="text-[10px] uppercase tracking-widest text-white/40">
                    Coin
                  </span>
                  <div className="flex gap-1.5">
                    {COIN_VALUES.map((v) => {
                      const active = v === coinValue;
                      const disabled = locked || v > balance;
                      return (
                        <motion.button
                          key={v}
                          type="button"
                          data-testid={`coinvalue-${v}`}
                          disabled={disabled}
                          whileHover={disabled ? undefined : { y: -2 }}
                          whileTap={disabled ? undefined : { scale: 0.94 }}
                          onClick={() => setCoinValueSafe(v)}
                          className="rounded-lg px-3 py-1.5 text-xs font-bold tabular-nums transition-colors disabled:opacity-30"
                          style={{
                            background: active
                              ? `linear-gradient(180deg, ${ACCENT}, #0e7490)`
                              : "rgba(255,255,255,0.05)",
                            color: active ? "#04141a" : "rgba(255,255,255,0.7)",
                            border: active
                              ? "1px solid #bff7ff"
                              : "1px solid rgba(255,255,255,0.1)",
                            boxShadow: active ? `0 0 12px ${ACCENT}66` : "none",
                          }}
                        >
                          {v}
                        </motion.button>
                      );
                    })}
                  </div>
                </div>

                {/* Coin count selector */}
                <div className="flex items-center gap-2">
                  <span className="text-[10px] uppercase tracking-widest text-white/40">
                    Coins
                  </span>
                  <div className="flex gap-1.5">
                    {[1, 2, 3, 4, 5].map((n) => (
                      <CoinPip
                        key={n}
                        index={n}
                        active={n === coins}
                        disabled={locked || n * coinValue > balance}
                        onClick={() => setCoinsSafe(n)}
                      />
                    ))}
                    <motion.button
                      type="button"
                      data-testid="bet-max"
                      disabled={locked || coinValue > balance}
                      whileHover={{ y: -2 }}
                      whileTap={{ scale: 0.94 }}
                      onClick={() => setCoinsSafe(5)}
                      className="rounded-lg px-2.5 py-1.5 text-[10px] font-extrabold uppercase tracking-widest disabled:opacity-30"
                      style={{
                        background: "rgba(255,43,209,0.12)",
                        color: "#ff2bd1",
                        border: "1px solid rgba(255,43,209,0.4)",
                      }}
                    >
                      Max
                    </motion.button>
                  </div>
                </div>
              </div>

              {/* Primary actions */}
              <div className="flex flex-wrap items-center justify-center gap-3">
                {phase === "holding" ? (
                  <Button
                    data-testid="play-btn"
                    variant="neon"
                    size="lg"
                    disabled={locked}
                    onClick={draw}
                  >
                    Draw
                  </Button>
                ) : phase === "result" ? (
                  <>
                    <Button
                      data-testid="play-btn"
                      variant="neon"
                      size="lg"
                      disabled={!canAfford}
                      onClick={deal}
                    >
                      Deal Again
                    </Button>
                    <Button
                      data-testid="new-hand-btn"
                      variant="ghost"
                      size="lg"
                      onClick={newHand}
                    >
                      Change Bet
                    </Button>
                  </>
                ) : (
                  <Button
                    data-testid="play-btn"
                    variant="neon"
                    size="lg"
                    disabled={dealDisabled}
                    onClick={deal}
                  >
                    Deal
                  </Button>
                )}
              </div>

              {!canAfford && (phase === "betting" || phase === "result") && (
                <motion.p
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="mt-2 text-center text-xs font-semibold text-ruby"
                >
                  Not enough chips for this bet — lower the coins or coin value.
                </motion.p>
              )}
            </div>
          </div>

          {/* ---------------- Paytable ---------------- */}
          <CollapsiblePanel
            title="Paytable"
            accent={ACCENT}
            summary={<>9/6 · Royal 800×</>}
          >
            <div className="mb-2 flex items-baseline justify-end">
              <span className="text-[10px] uppercase tracking-widest text-white/40">
                × {coins} coin{coins > 1 ? "s" : ""}
              </span>
            </div>
            <div className="overflow-hidden rounded-xl border border-white/10">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-black/40 text-white/40">
                    <th className="px-2 py-1.5 text-left font-semibold uppercase tracking-wider">
                      Hand
                    </th>
                    <th className="px-2 py-1.5 text-right font-semibold uppercase tracking-wider">
                      Per Coin
                    </th>
                    <th className="px-2 py-1.5 text-right font-semibold uppercase tracking-wider">
                      Pays
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {PAYTABLE.map((row) => {
                    const isHit = highlightKey === row.key;
                    const per = usingMax ? row.perCoinMax : row.perCoin;
                    const pays = per * coins * coinValue;
                    const royalBoost = row.key === "royal" && usingMax;
                    return (
                      <motion.tr
                        key={row.key}
                        animate={
                          isHit
                            ? {
                                backgroundColor: "rgba(34,225,255,0.22)",
                              }
                            : { backgroundColor: "rgba(0,0,0,0)" }
                        }
                        transition={{ duration: 0.25 }}
                        className="border-t border-white/5"
                      >
                        <td
                          className="px-2 py-1.5 font-semibold"
                          style={{
                            color: isHit ? "#fff" : "rgba(255,255,255,0.8)",
                          }}
                        >
                          <span className="flex items-center gap-1.5">
                            {isHit && (
                              <motion.span
                                initial={{ scale: 0 }}
                                animate={{ scale: 1 }}
                                style={{ color: ACCENT }}
                              >
                                ◆
                              </motion.span>
                            )}
                            {row.label}
                          </span>
                        </td>
                        <td
                          className="px-2 py-1.5 text-right font-bold tabular-nums"
                          style={{
                            color: royalBoost
                              ? "#ff2bd1"
                              : isHit
                              ? ACCENT
                              : "rgba(255,255,255,0.65)",
                          }}
                        >
                          {per}
                        </td>
                        <td
                          className="px-2 py-1.5 text-right font-bold tabular-nums"
                          style={{
                            color: isHit ? ACCENT : "rgba(255,255,255,0.55)",
                          }}
                        >
                          {formatChips(pays)}
                        </td>
                      </motion.tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="mt-2 text-[10px] leading-relaxed text-white/35">
              Royal Flush pays{" "}
              <span style={{ color: "#ff2bd1" }} className="font-bold">
                800×
              </span>{" "}
              per coin only at the 5-coin max bet. Jacks or Better = a pair of
              Jacks, Queens, Kings or Aces.
            </p>

            {/* Session stats */}
            <div className="mt-3 grid grid-cols-2 gap-2 text-center">
              <div className="rounded-lg border border-white/10 bg-black/30 px-2 py-1.5">
                <div className="text-[8px] uppercase tracking-widest text-white/40">
                  Hands
                </div>
                <div className="text-sm font-bold tabular-nums text-white/80">
                  {wallet.ready ? formatChips(wallet.rounds) : "—"}
                </div>
              </div>
              <div className="rounded-lg border border-white/10 bg-black/30 px-2 py-1.5">
                <div className="text-[8px] uppercase tracking-widest text-white/40">
                  Biggest Win
                </div>
                <div className="text-sm font-bold tabular-nums" style={{ color: ACCENT }}>
                  {wallet.ready ? formatChips(wallet.biggestWin) : "—"}
                </div>
              </div>
            </div>
          </CollapsiblePanel>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Win burst — radial spray of accent shards
// ---------------------------------------------------------------------------
function WinBurst({ big }: { big: boolean }) {
  const count = big ? 22 : 12;
  const shards = useMemo(
    () =>
      Array.from({ length: count }, (_, i) => {
        const angle = (i / count) * Math.PI * 2;
        const dist = 120 + Math.random() * (big ? 180 : 90);
        return {
          x: Math.cos(angle) * dist,
          y: Math.sin(angle) * dist,
          rot: Math.random() * 360,
          color: i % 3 === 0 ? "#ff2bd1" : i % 3 === 1 ? "#f5d060" : ACCENT,
          delay: Math.random() * 0.08,
        };
      }),
    [count, big],
  );

  return (
    <motion.div
      className="pointer-events-none absolute inset-0 z-30 grid place-items-center"
      initial={{ opacity: 1 }}
      animate={{ opacity: 0 }}
      transition={{ duration: big ? 1.6 : 1.1, delay: big ? 0.6 : 0.4 }}
    >
      {/* expanding ring */}
      <motion.div
        className="absolute rounded-full"
        initial={{ width: 40, height: 40, opacity: 0.8 }}
        animate={{
          width: big ? 480 : 320,
          height: big ? 480 : 320,
          opacity: 0,
        }}
        transition={{ duration: big ? 1.1 : 0.8, ease: "easeOut" }}
        style={{ border: `3px solid ${ACCENT}` }}
      />
      {shards.map((s, i) => (
        <motion.div
          key={i}
          className="absolute rounded-sm"
          initial={{ x: 0, y: 0, opacity: 1, scale: 1, rotate: 0 }}
          animate={{
            x: s.x,
            y: s.y,
            opacity: 0,
            scale: 0.4,
            rotate: s.rot,
          }}
          transition={{
            duration: big ? 1.3 : 0.9,
            delay: s.delay,
            ease: "easeOut",
          }}
          style={{
            width: big ? 12 : 9,
            height: big ? 12 : 9,
            background: s.color,
            boxShadow: `0 0 8px ${s.color}`,
          }}
        />
      ))}
    </motion.div>
  );
}
