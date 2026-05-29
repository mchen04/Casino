"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  motion,
  AnimatePresence,
  useMotionValue,
  useTransform,
  animate,
} from "framer-motion";
import {
  type Card,
  makeShoe,
  evaluate3,
  ThreeCardCategory,
  rankValue,
} from "@/lib/cards";
import { useWallet } from "@/lib/wallet";
import { formatChips, formatDelta } from "@/lib/format";
import { sfx } from "@/lib/sound";
import { Button } from "@/components/ui/Button";
import { Chip } from "@/components/ui/Chip";
import { PlayingCard } from "@/components/PlayingCard";
import { CollapsiblePanel } from "@/components/CollapsiblePanel";

const ACCENT = "#9b59b6";
const ACCENT_SOFT = "rgba(155,89,182,0.5)";

// ---------------------------------------------------------------------------
// Paytables (gross multipliers shown as "X:1" odds; payout = stake * (X + 1))
// ---------------------------------------------------------------------------

interface PayRow {
  cat: ThreeCardCategory;
  label: string;
  odds: number; // profit multiple, "X:1"
}

// Pair Plus paytable (resolved on the player's dealt 3 cards).
const PAIR_PLUS_TABLE: PayRow[] = [
  { cat: ThreeCardCategory.StraightFlush, label: "Straight Flush", odds: 40 },
  { cat: ThreeCardCategory.ThreeOfAKind, label: "Three of a Kind", odds: 30 },
  { cat: ThreeCardCategory.Straight, label: "Straight", odds: 6 },
  { cat: ThreeCardCategory.Flush, label: "Flush", odds: 3 },
  { cat: ThreeCardCategory.Pair, label: "Pair", odds: 1 },
];

// Ante Bonus paytable (paid on player's hand regardless of the dealer).
const ANTE_BONUS_TABLE: PayRow[] = [
  { cat: ThreeCardCategory.StraightFlush, label: "Straight Flush", odds: 5 },
  { cat: ThreeCardCategory.ThreeOfAKind, label: "Three of a Kind", odds: 4 },
  { cat: ThreeCardCategory.Straight, label: "Straight", odds: 1 },
];

const DEALER_QUALIFY_VALUE = 12; // Queen-high or better.

function pairPlusOdds(cat: ThreeCardCategory): number {
  return PAIR_PLUS_TABLE.find((r) => r.cat === cat)?.odds ?? 0;
}
function anteBonusOdds(cat: ThreeCardCategory): number {
  return ANTE_BONUS_TABLE.find((r) => r.cat === cat)?.odds ?? 0;
}

/** Highest single card value in a hand (for "Queen-high" qualification). */
function highValue(cards: Card[]): number {
  return cards.reduce((m, c) => Math.max(m, rankValue(c.rank)), 0);
}

type Phase = "betting" | "decision" | "revealing" | "result";

interface Resolution {
  outcome: "win" | "lose" | "push" | "fold";
  net: number; // net change for the round (excl. earlier stake already taken)
  totalReturn: number; // gross credited back this round
  lines: { label: string; amount: number }[];
  dealerQualified: boolean;
  banner: string;
}

// ---------------------------------------------------------------------------
// Rolling number counter
// ---------------------------------------------------------------------------

function Counter({ value, className }: { value: number; className?: string }) {
  const mv = useMotionValue(value);
  const rounded = useTransform(mv, (v) => formatChips(v));
  useEffect(() => {
    const controls = animate(mv, value, { duration: 0.5, ease: "easeOut" });
    return controls.stop;
  }, [value, mv]);
  return <motion.span className={className}>{rounded}</motion.span>;
}

// ---------------------------------------------------------------------------
// Spark burst for wins
// ---------------------------------------------------------------------------

function WinBurst({ show, big }: { show: boolean; big: boolean }) {
  const sparks = useMemo(
    () =>
      Array.from({ length: big ? 22 : 12 }, (_, i) => {
        const angle = (i / (big ? 22 : 12)) * Math.PI * 2;
        return {
          id: i,
          x: Math.cos(angle) * (big ? 220 : 150),
          y: Math.sin(angle) * (big ? 220 : 150),
          c: i % 3 === 0 ? ACCENT : i % 3 === 1 ? "#f5d060" : "#22e1ff",
        };
      }),
    [big],
  );
  return (
    <AnimatePresence>
      {show && (
        <div className="pointer-events-none absolute inset-0 z-30 grid place-items-center overflow-hidden">
          {sparks.map((s) => (
            <motion.span
              key={s.id}
              className="absolute h-2.5 w-2.5 rounded-full"
              style={{ background: s.c, boxShadow: `0 0 12px ${s.c}` }}
              initial={{ x: 0, y: 0, opacity: 1, scale: 1 }}
              animate={{ x: s.x, y: s.y, opacity: 0, scale: 0.2 }}
              exit={{ opacity: 0 }}
              transition={{ duration: big ? 1.1 : 0.85, ease: "easeOut" }}
            />
          ))}
        </div>
      )}
    </AnimatePresence>
  );
}

// ---------------------------------------------------------------------------
// Flying chip (decorative chip flight from bet area)
// ---------------------------------------------------------------------------

function ChipFlight({ trigger, color }: { trigger: number; color: string }) {
  return (
    <AnimatePresence>
      {trigger > 0 && (
        <motion.div
          key={trigger}
          className="pointer-events-none absolute left-1/2 top-1/2 z-20 h-10 w-10 -translate-x-1/2 -translate-y-1/2 rounded-full"
          style={{
            background: `radial-gradient(circle at 50% 35%, ${color}, rgba(0,0,0,0.6))`,
            border: "2px dashed rgba(255,255,255,0.6)",
          }}
          initial={{ x: -160, y: 140, scale: 0.4, opacity: 0, rotate: -40 }}
          animate={{ x: 0, y: 0, scale: 1, opacity: [0, 1, 1, 0], rotate: 360 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.6, ease: "easeOut" }}
        />
      )}
    </AnimatePresence>
  );
}

// ---------------------------------------------------------------------------
// Paytable panel
// ---------------------------------------------------------------------------

function PaytablePanel({
  title,
  rows,
  highlightCat,
  badge,
}: {
  title: string;
  rows: PayRow[];
  highlightCat: ThreeCardCategory | null;
  badge?: string;
}) {
  return (
    <CollapsiblePanel
      title={title}
      accent={ACCENT}
      summary={badge ? <>{badge}</> : undefined}
    >
      <ul className="space-y-0.5 pt-1 text-[11px] sm:text-xs">
        {rows.map((r) => {
          const lit = highlightCat === r.cat;
          return (
            <motion.li
              key={r.label}
              animate={
                lit
                  ? {
                      backgroundColor: "rgba(155,89,182,0.28)",
                      scale: [1, 1.04, 1],
                    }
                  : { backgroundColor: "rgba(0,0,0,0)" }
              }
              transition={{ duration: 0.4 }}
              className="flex items-center justify-between rounded-md px-2 py-1"
            >
              <span className={lit ? "font-bold text-white" : "text-white/70"}>
                {r.label}
              </span>
              <span
                className={`tabular-nums font-semibold ${
                  lit ? "text-gold" : "text-white/55"
                }`}
              >
                {r.odds}:1
              </span>
            </motion.li>
          );
        })}
      </ul>
    </CollapsiblePanel>
  );
}

// ---------------------------------------------------------------------------
// Bet spot
// ---------------------------------------------------------------------------

function BetSpot({
  label,
  value,
  active,
  optional,
  onClick,
  disabled,
}: {
  label: string;
  value: number;
  active: boolean;
  optional?: boolean;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <motion.button
      type="button"
      onClick={onClick}
      disabled={disabled}
      whileHover={!disabled && onClick ? { y: -2 } : undefined}
      whileTap={!disabled && onClick ? { scale: 0.96 } : undefined}
      className="relative grid min-w-[92px] place-items-center rounded-2xl border px-4 py-3 transition disabled:cursor-default"
      style={{
        borderColor: active ? ACCENT : "rgba(255,255,255,0.12)",
        background: active
          ? "linear-gradient(180deg, rgba(155,89,182,0.22), rgba(155,89,182,0.06))"
          : "rgba(255,255,255,0.03)",
        boxShadow: active ? `0 0 22px ${ACCENT_SOFT}` : "none",
        opacity: disabled && !active ? 0.5 : 1,
      }}
    >
      <span className="text-[10px] uppercase tracking-widest text-white/55">
        {label}
        {optional && <span className="ml-1 text-white/30">(opt)</span>}
      </span>
      <span className="gold-text mt-0.5 text-lg font-bold tabular-nums">
        {value > 0 ? formatChips(value) : "—"}
      </span>
    </motion.button>
  );
}

// ---------------------------------------------------------------------------
// Main game
// ---------------------------------------------------------------------------

const CHIP_DENOMS = [5, 25, 100, 500];

export default function ThreeCardPoker() {
  const wallet = useWallet();

  const [ante, setAnte] = useState(25);
  const [pairPlus, setPairPlus] = useState(0);

  const [phase, setPhase] = useState<Phase>("betting");
  const [player, setPlayer] = useState<(Card | null)[]>([null, null, null]);
  const [dealer, setDealer] = useState<(Card | null)[]>([null, null, null]);
  const [dealerFaceDown, setDealerFaceDown] = useState<boolean[]>([true, true, true]);
  const [revealedPlayer, setRevealedPlayer] = useState<boolean[]>([false, false, false]);

  const [resolution, setResolution] = useState<Resolution | null>(null);
  const [playBetPlaced, setPlayBetPlaced] = useState(0);
  const [burst, setBurst] = useState<{ show: boolean; big: boolean }>({
    show: false,
    big: false,
  });
  const [chipFlight, setChipFlight] = useState(0);

  // Track timers so we can clear them on unmount.
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const after = useCallback((ms: number, fn: () => void) => {
    const t = setTimeout(fn, ms);
    timers.current.push(t);
    return t;
  }, []);
  useEffect(() => {
    return () => {
      timers.current.forEach(clearTimeout);
    };
  }, []);

  // Prevent rapid-click double-fire during deal / decision transitions.
  const resolving = useRef(false);

  const playerCards = player.filter((c): c is Card => c !== null);
  const dealerCards = dealer.filter((c): c is Card => c !== null);
  const playerRank =
    playerCards.length === 3 ? evaluate3(playerCards) : null;
  const dealerRank =
    dealerCards.length === 3 && phase === "result"
      ? evaluate3(dealerCards)
      : null;

  const totalStaked = ante + pairPlus;
  // Full round cost = Ante + PairPlus + Play (= Ante again). We pre-deduct the
  // Play bet at deal time so wallet.bet() is called only once per round.
  const fullRoundCost = ante * 2 + pairPlus;
  const canAffordAnte = ante > 0 && fullRoundCost <= wallet.balance;

  // -------------------------------------------------------------------------
  // Bet editing (betting phase only)
  // -------------------------------------------------------------------------

  const addAnte = (v: number) => {
    if (phase !== "betting") return;
    sfx.chip();
    // Cap so fullRoundCost (ante*2 + pairPlus) stays within balance.
    setAnte((a) => Math.min(a + v, Math.floor((wallet.balance - pairPlus) / 2)));
  };
  const addPairPlus = (v: number) => {
    if (phase !== "betting") return;
    sfx.chip();
    // Cap so fullRoundCost (ante*2 + pairPlus) stays within balance.
    setPairPlus((p) => Math.min(p + v, Math.max(0, wallet.balance - ante * 2)));
  };
  const clearBets = () => {
    if (phase !== "betting") return;
    sfx.click();
    setAnte(0);
    setPairPlus(0);
  };

  // -------------------------------------------------------------------------
  // Deal
  // -------------------------------------------------------------------------

  const deal = () => {
    if (phase !== "betting") return;
    if (resolving.current) return;
    if (ante <= 0) return;
    // Pre-deduct the full round cost (Ante + PairPlus + Play) in a single
    // wallet.bet() call so rounds is incremented exactly once per hand.
    // On fold the reserved Play stake is refunded via wallet.win().
    if (!wallet.bet(fullRoundCost)) return;
    resolving.current = true;

    const shoe = makeShoe(1);
    const p: Card[] = [shoe[0], shoe[1], shoe[2]];
    const d: Card[] = [shoe[3], shoe[4], shoe[5]];

    setResolution(null);
    setBurst({ show: false, big: false });
    setPlayBetPlaced(0);
    setPlayer(p);
    setDealer(d);
    setDealerFaceDown([true, true, true]);
    setRevealedPlayer([false, false, false]);
    setPhase("decision");
    setChipFlight((n) => n + 1);

    // Animate dealing the player's three cards face-up.
    // Release the resolving guard once all cards are revealed so Play/Fold can fire.
    [0, 1, 2].forEach((i) => {
      after(220 + i * 230, () => {
        sfx.card();
        setRevealedPlayer((r) => {
          const next = [...r];
          next[i] = true;
          return next;
        });
        if (i === 2) resolving.current = false;
      });
    });
  };

  // -------------------------------------------------------------------------
  // Resolve (after Play or Fold decision)
  // -------------------------------------------------------------------------

  const resolveRound = useCallback(
    (folded: boolean) => {
      const pCards = player.filter((c): c is Card => c !== null);
      const dCards = dealer.filter((c): c is Card => c !== null);
      if (pCards.length !== 3 || dCards.length !== 3) return;

      const pRank = evaluate3(pCards);
      const dRank = evaluate3(dCards);
      const dealerQualified =
        dRank.category > ThreeCardCategory.HighCard ||
        highValue(dCards) >= DEALER_QUALIFY_VALUE;

      const lines: { label: string; amount: number }[] = [];

      // --- Pair Plus resolves on the dealt hand regardless of fold/play. ---
      let ppReturn = 0;
      if (pairPlus > 0) {
        const ppOdds = pairPlusOdds(pRank.category);
        if (ppOdds > 0) {
          ppReturn = pairPlus * (ppOdds + 1); // gross incl. stake
          lines.push({ label: `Pair Plus (${ppOdds}:1)`, amount: ppReturn });
        } else {
          lines.push({ label: "Pair Plus", amount: 0 });
        }
      }

      let totalReturn = ppReturn;
      let banner: string;
      let outcome: Resolution["outcome"];

      if (folded) {
        // Ante is forfeited. The Play stake was pre-reserved in deal(); refund it now.
        // Pair Plus already settled above.
        totalReturn += ante; // refund the pre-reserved Play stake
        lines.push({ label: "Ante (forfeited)", amount: 0 });
        lines.push({ label: "Play (refunded)", amount: ante });
        outcome = "fold";
        banner = "You folded — Ante forfeited";
      } else {
        // --- Ante Bonus: paid on player's hand regardless of dealer. ---
        const abOdds = anteBonusOdds(pRank.category);
        if (abOdds > 0) {
          const abReturn = ante * abOdds; // bonus is pure profit (1:1, 4:1, 5:1)
          totalReturn += abReturn;
          lines.push({ label: `Ante Bonus (${abOdds}:1)`, amount: abReturn });
        }

        const playBet = ante; // Play wager equals the Ante.

        if (!dealerQualified) {
          // Ante pays 1:1, Play pushes (returned).
          const anteWin = ante * 2; // stake + 1:1
          const playPush = playBet; // returned
          totalReturn += anteWin + playPush;
          lines.push({ label: "Dealer doesn't qualify", amount: 0 });
          lines.push({ label: "Ante (1:1)", amount: anteWin });
          lines.push({ label: "Play (push)", amount: playPush });
          outcome = "win";
          banner = "Dealer didn't qualify — Ante pays, Play pushes";
        } else {
          const cmp = pRank.score - dRank.score;
          if (cmp > 0) {
            const anteWin = ante * 2;
            const playWin = playBet * 2;
            totalReturn += anteWin + playWin;
            lines.push({ label: "Ante (1:1)", amount: anteWin });
            lines.push({ label: "Play (1:1)", amount: playWin });
            outcome = "win";
            banner = "You beat the dealer!";
          } else if (cmp === 0) {
            totalReturn += ante + playBet; // push both
            lines.push({ label: "Ante (push)", amount: ante });
            lines.push({ label: "Play (push)", amount: playBet });
            outcome = "push";
            banner = "Tie — Ante & Play push";
          } else {
            lines.push({ label: "Ante & Play lost", amount: 0 });
            outcome = "lose";
            banner = "Dealer wins";
          }
        }
      }

      // Credit the gross return.
      if (totalReturn > 0) wallet.win(totalReturn);

      // Net change for the round = what came back minus the full amount pre-deducted.
      // Full pre-deduction was: ante + pairPlus + ante (play reserved at deal time).
      const staked = ante * 2 + pairPlus;
      const net = totalReturn - staked;

      // If Pair Plus won but main bet lost/folded, treat as a positive moment.
      const overallWin = net > 0;

      setResolution({
        outcome,
        net,
        totalReturn,
        lines,
        dealerQualified,
        banner,
      });

      // Reveal dealer cards one by one with a flip animation.
      [0, 1, 2].forEach((i) => {
        after(i * 320, () => {
          sfx.card();
          setDealerFaceDown((f) => {
            const next = [...f];
            next[i] = false;
            return next;
          });
        });
      });

      // After the reveal completes, fire result feedback.
      after(3 * 320 + 250, () => {
        setPhase("result");
        if (overallWin) {
          const big = net >= ante * 8 || ppReturn >= pairPlus * 30;
          if (big) sfx.jackpot();
          else sfx.win();
          setBurst({ show: true, big });
          after(big ? 1200 : 900, () => setBurst({ show: false, big }));
        } else if (outcome === "push") {
          sfx.thud();
        } else {
          sfx.lose();
        }
      });
    },
    [player, dealer, ante, pairPlus, wallet, after],
  );

  const onPlay = () => {
    if (phase !== "decision") return;
    if (resolving.current) return;
    resolving.current = true;
    // Play stake was already deducted at deal time — no extra wallet.bet() needed.
    sfx.chip();
    setPlayBetPlaced(ante);
    setChipFlight((n) => n + 1);
    setPhase("revealing");
    resolveRound(false);
  };

  const onFold = () => {
    if (phase !== "decision") return;
    if (resolving.current) return;
    resolving.current = true;
    sfx.click();
    setPhase("revealing");
    resolveRound(true);
  };

  const nextRound = () => {
    if (phase !== "result") return;
    resolving.current = false;
    sfx.click();
    setPhase("betting");
    setPlayer([null, null, null]);
    setDealer([null, null, null]);
    setDealerFaceDown([true, true, true]);
    setRevealedPlayer([false, false, false]);
    setResolution(null);
    setBurst({ show: false, big: false });
    setPlayBetPlaced(0);
  };

  const decisionDisabled = phase !== "decision" || !revealedPlayer.every(Boolean) || resolving.current;

  // Highlight categories on the paytables.
  const ppHighlight =
    phase === "result" && playerRank ? playerRank.category : null;
  const abHighlight =
    phase === "result" && playerRank && anteBonusOdds(playerRank.category) > 0
      ? playerRank.category
      : null;

  const resultColor =
    resolution?.outcome === "win"
      ? "#22e1ff"
      : resolution?.outcome === "push"
        ? "#f5d060"
        : resolution?.net && resolution.net > 0
          ? "#22e1ff"
          : "#ff5470";

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <div className="mx-auto w-full max-w-6xl">
      <div className="grid gap-2 sm:gap-4 lg:grid-cols-[1fr_280px]">
        {/* ===================== TABLE ===================== */}
        <div className="relative">
          <div
            className="felt relative overflow-hidden rounded-3xl p-3 sm:p-6 [@media(max-height:600px)]:p-3"
            style={{ boxShadow: `0 0 0 1px ${ACCENT_SOFT}, 0 24px 60px rgba(0,0,0,0.55)` }}
          >
            {/* ambient accent glow */}
            <div
              className="pointer-events-none absolute -top-24 left-1/2 h-56 w-[140%] -translate-x-1/2 rounded-full opacity-40 blur-3xl"
              style={{ background: ACCENT }}
            />

            <ChipFlight trigger={chipFlight} color={ACCENT} />
            <WinBurst show={burst.show} big={burst.big} />

            {/* Dealer row */}
            <div className="relative z-10">
              <div className="mb-2 flex items-center justify-between">
                <span
                  className="font-display text-sm font-bold uppercase tracking-[0.2em]"
                  style={{ color: ACCENT }}
                >
                  Dealer
                </span>
                <AnimatePresence>
                  {phase === "result" && dealerRank && (
                    <motion.span
                      initial={{ opacity: 0, x: 10 }}
                      animate={{ opacity: 1, x: 0 }}
                      className="rounded-full bg-black/40 px-3 py-1 text-xs"
                      style={{
                        color: resolution?.dealerQualified ? "#22e1ff" : "#ff9f43",
                      }}
                    >
                      {dealerRank.name}
                      {resolution
                        ? resolution.dealerQualified
                          ? " · qualifies"
                          : " · no qualify"
                        : ""}
                    </motion.span>
                  )}
                </AnimatePresence>
              </div>
              <div className="flex origin-top justify-center gap-2 sm:gap-3 [@media(max-height:600px)]:-mb-6 [@media(max-height:600px)]:scale-[0.78]">
                {dealer.map((c, i) => (
                  <motion.div
                    key={`d-${i}`}
                    initial={{ y: -40, opacity: 0, rotate: -8 }}
                    animate={
                      c
                        ? { y: 0, opacity: 1, rotate: 0 }
                        : { y: -40, opacity: 0 }
                    }
                    transition={{ delay: c ? 0.05 * i : 0, type: "spring", stiffness: 220, damping: 20 }}
                  >
                    <PlayingCard
                      card={c}
                      faceDown={dealerFaceDown[i]}
                      size="lg"
                      highlight={
                        phase === "result" &&
                        resolution?.outcome === "lose" &&
                        !dealerFaceDown[i]
                      }
                    />
                  </motion.div>
                ))}
              </div>
            </div>

            {/* Center result banner */}
            <div className="my-2 grid min-h-[44px] place-items-center sm:my-4 sm:min-h-[64px] [@media(max-height:600px)]:my-1 [@media(max-height:600px)]:min-h-[36px]">
              <AnimatePresence mode="wait">
                {phase === "result" && resolution ? (
                  <motion.div
                    key="banner"
                    data-testid="round-result"
                    initial={{ scale: 0.7, opacity: 0, y: 8 }}
                    animate={{ scale: 1, opacity: 1, y: 0 }}
                    exit={{ scale: 0.7, opacity: 0 }}
                    transition={{ type: "spring", stiffness: 260, damping: 18 }}
                    className="rounded-2xl border px-5 py-2 text-center backdrop-blur"
                    style={{
                      borderColor: resultColor,
                      background: "rgba(0,0,0,0.45)",
                      boxShadow: `0 0 26px ${resultColor}66`,
                    }}
                  >
                    <div
                      className="font-display text-lg font-bold sm:text-xl"
                      style={{ color: resultColor, textShadow: `0 0 14px ${resultColor}88` }}
                    >
                      {resolution.banner}
                    </div>
                    <div className="mt-0.5 text-sm font-semibold tabular-nums text-white/85">
                      {resolution.net >= 0 ? "Returned " : "Net "}
                      <Counter
                        value={resolution.net >= 0 ? resolution.totalReturn : resolution.net}
                        className="tabular-nums"
                      />
                      {resolution.net !== 0 && (
                        <span style={{ color: resultColor }} className="ml-2">
                          ({formatDelta(resolution.net)})
                        </span>
                      )}
                    </div>
                  </motion.div>
                ) : phase === "decision" ? (
                  <motion.div
                    key="decide"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="text-center text-sm text-white/60"
                  >
                    {revealedPlayer.every(Boolean) ? (
                      <>
                        Your hand:{" "}
                        <span className="font-bold" style={{ color: ACCENT }}>
                          {playerRank?.name}
                        </span>{" "}
                        — Play (match Ante) or Fold?
                      </>
                    ) : (
                      <span className="animate-pulse">Dealing…</span>
                    )}
                  </motion.div>
                ) : (
                  <motion.div
                    key="idle"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="text-center text-sm text-white/45"
                  >
                    Place your Ante (and optional Pair Plus), then deal.
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            {/* Player row */}
            <div className="relative z-10">
              <div className="mb-2 flex items-center justify-between">
                <span
                  className="font-display text-sm font-bold uppercase tracking-[0.2em] text-emerald-200"
                >
                  Player
                </span>
                <AnimatePresence>
                  {playerRank && revealedPlayer.every(Boolean) && (
                    <motion.span
                      initial={{ opacity: 0, x: 10 }}
                      animate={{ opacity: 1, x: 0 }}
                      className="rounded-full bg-black/40 px-3 py-1 text-xs font-semibold text-white/85"
                    >
                      {playerRank.name}
                    </motion.span>
                  )}
                </AnimatePresence>
              </div>
              <div className="flex origin-top justify-center gap-2 sm:gap-3 [@media(max-height:600px)]:-mb-6 [@media(max-height:600px)]:scale-[0.78]">
                {player.map((c, i) => (
                  <motion.div
                    key={`p-${i}`}
                    initial={{ y: 50, opacity: 0, rotate: 8 }}
                    animate={
                      c
                        ? { y: 0, opacity: 1, rotate: 0 }
                        : { y: 50, opacity: 0 }
                    }
                    transition={{ type: "spring", stiffness: 220, damping: 20 }}
                  >
                    <PlayingCard
                      card={c}
                      faceDown={!revealedPlayer[i]}
                      size="lg"
                      highlight={
                        phase === "result" &&
                        (resolution?.outcome === "win" ||
                          (resolution?.net ?? 0) > 0) &&
                        revealedPlayer[i]
                      }
                    />
                  </motion.div>
                ))}
              </div>
            </div>

            {/* Bet spots */}
            <div className="relative z-10 mt-3 flex flex-wrap items-center justify-center gap-2 sm:mt-5 sm:gap-3">
              <BetSpot
                label="Ante"
                value={ante}
                active={ante > 0}
                disabled={phase !== "betting"}
              />
              <BetSpot
                label="Play"
                value={playBetPlaced}
                active={playBetPlaced > 0}
                disabled={phase === "betting" || phase === "result"}
              />
              <BetSpot
                label="Pair +"
                value={pairPlus}
                active={pairPlus > 0}
                optional
                disabled={phase !== "betting"}
              />
            </div>
          </div>

          {/* ===================== CONTROLS ===================== */}
          <div className="mt-2 sm:mt-4">
            {phase === "betting" && (
              <div className="glass rounded-2xl p-3 sm:p-4">
                <div className="mb-3 flex flex-wrap items-center justify-center gap-3">
                  <span className="text-[11px] uppercase tracking-widest text-white/50">
                    Tap a chip → Ante. Hold-mode below for Pair +
                  </span>
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  {/* Ante chips */}
                  <div className="rounded-xl border border-white/10 bg-black/20 p-3">
                    <div className="mb-2 text-center text-[11px] uppercase tracking-widest text-white/55">
                      Add to Ante
                    </div>
                    <div className="flex flex-wrap items-center justify-center gap-2">
                      {CHIP_DENOMS.map((v) => (
                        <Chip
                          key={`a-${v}`}
                          value={v}
                          size={48}
                          onClick={
                            ante * 2 + v * 2 + pairPlus > wallet.balance
                              ? undefined
                              : () => addAnte(v)
                          }
                        />
                      ))}
                    </div>
                  </div>

                  {/* Pair Plus chips */}
                  <div className="rounded-xl border border-white/10 bg-black/20 p-3">
                    <div className="mb-2 text-center text-[11px] uppercase tracking-widest text-white/55">
                      Add to Pair + <span className="text-white/30">(optional)</span>
                    </div>
                    <div className="flex flex-wrap items-center justify-center gap-2">
                      {CHIP_DENOMS.map((v) => (
                        <Chip
                          key={`pp-${v}`}
                          value={v}
                          size={48}
                          onClick={
                            ante * 2 + pairPlus + v > wallet.balance
                              ? undefined
                              : () => addPairPlus(v)
                          }
                        />
                      ))}
                    </div>
                  </div>
                </div>

                <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={clearBets}
                    data-testid="clear-bets"
                  >
                    Clear
                  </Button>
                  <div className="rounded-xl border border-gold/30 bg-black/40 px-4 py-2 text-center">
                    <div className="text-[9px] uppercase tracking-widest text-white/40">
                      Total Stake
                    </div>
                    <div className="gold-text text-lg font-bold tabular-nums">
                      {formatChips(totalStaked)}
                    </div>
                  </div>
                  <Button
                    size="lg"
                    variant="gold"
                    onClick={deal}
                    disabled={!canAffordAnte}
                    data-testid="play-btn"
                  >
                    Deal
                  </Button>
                </div>
                {!canAffordAnte && ante > 0 && (
                  <p className="mt-2 text-center text-xs text-ruby/80">
                    Not enough chips for that stake.
                  </p>
                )}
                {ante <= 0 && (
                  <p className="mt-2 text-center text-xs text-white/40">
                    Set an Ante to deal.
                  </p>
                )}
              </div>
            )}

            {(phase === "decision" || phase === "revealing") && (
              <div className="glass rounded-2xl p-4">
                <div className="flex flex-wrap items-center justify-center gap-3">
                  <Button
                    size="lg"
                    variant="neon"
                    onClick={onPlay}
                    disabled={decisionDisabled}
                    data-testid="play-action-btn"
                  >
                    Play · match {formatChips(ante)}
                  </Button>
                  <Button
                    size="lg"
                    variant="danger"
                    onClick={onFold}
                    disabled={decisionDisabled}
                    data-testid="fold-btn"
                  >
                    Fold
                  </Button>
                </div>
              </div>
            )}

            {phase === "result" && (
              <div className="glass rounded-2xl p-4">
                <div className="flex justify-center">
                  <Button
                    size="lg"
                    variant="gold"
                    onClick={nextRound}
                    data-testid="next-round-btn"
                  >
                    Next Hand
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* ===================== SIDEBAR ===================== */}
        <div className="space-y-2 sm:space-y-4">
          <PaytablePanel
            title="Pair Plus"
            rows={PAIR_PLUS_TABLE}
            highlightCat={ppHighlight}
            badge="on your hand"
          />
          <PaytablePanel
            title="Ante Bonus"
            rows={ANTE_BONUS_TABLE}
            highlightCat={abHighlight}
            badge="any dealer"
          />

          {/* Resolution breakdown */}
          <CollapsiblePanel title="Round" accent={ACCENT}>
            <div className="pt-1">
            <AnimatePresence mode="wait">
              {resolution && phase === "result" ? (
                <motion.ul
                  key="breakdown"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="space-y-1 text-[11px]"
                >
                  {resolution.lines.map((l, i) => (
                    <li
                      key={i}
                      className="flex items-center justify-between gap-2"
                    >
                      <span className="text-white/60">{l.label}</span>
                      <span
                        className={`tabular-nums font-semibold ${
                          l.amount > 0 ? "text-gold" : "text-white/35"
                        }`}
                      >
                        {l.amount > 0 ? `+${formatChips(l.amount)}` : "—"}
                      </span>
                    </li>
                  ))}
                  <li className="mt-1 flex items-center justify-between gap-2 border-t border-white/10 pt-1">
                    <span className="text-white/80">Net</span>
                    <span
                      className="tabular-nums font-bold"
                      style={{ color: resolution.net >= 0 ? "#22e1ff" : "#ff5470" }}
                    >
                      {formatDelta(resolution.net)}
                    </span>
                  </li>
                </motion.ul>
              ) : (
                <motion.div
                  key="rules"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="space-y-1.5 text-[11px] text-white/55"
                >
                  <p>
                    Dealer qualifies with{" "}
                    <span className="text-white/80">Queen-high or better</span>.
                  </p>
                  <p>No qualify: Ante pays 1:1, Play pushes.</p>
                  <p>Qualify: beat dealer → Ante & Play 1:1.</p>
                  <p className="text-white/40">
                    Note: a Straight beats a Flush in three-card poker.
                  </p>
                </motion.div>
              )}
            </AnimatePresence>
            </div>
          </CollapsiblePanel>

          {/* Stats */}
          <div className="glass flex items-center justify-between rounded-2xl px-4 py-3">
            <div>
              <div className="text-[9px] uppercase tracking-widest text-white/40">
                Balance
              </div>
              <div className="gold-text text-base font-bold tabular-nums">
                <Counter value={wallet.balance} />
              </div>
            </div>
            <div className="text-right">
              <div className="text-[9px] uppercase tracking-widest text-white/40">
                Biggest Win
              </div>
              <div className="text-base font-bold tabular-nums text-white/80">
                {formatChips(wallet.biggestWin)}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
