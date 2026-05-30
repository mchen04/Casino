"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  motion,
  AnimatePresence,
  useMotionValue,
  useTransform,
  animate,
} from "framer-motion";
import { type Card, makeShoe, rankValue } from "@/lib/cards";
import { useWallet } from "@/lib/wallet";
import { formatChips, formatDelta } from "@/lib/format";
import { sfx } from "@/lib/sound";
import { Button } from "@/components/ui/Button";
import { Chip } from "@/components/ui/Chip";
import { PlayingCard } from "@/components/PlayingCard";
import { CollapsiblePanel } from "@/components/CollapsiblePanel";
import { Celebration } from "@/components/Celebration";

// ---------------------------------------------------------------------------
// Theme — festive lotus / pink-gold
// ---------------------------------------------------------------------------

const ACCENT = "#e84393";
const ACCENT_SOFT = "rgba(232,67,147,0.5)";
const GOLD = "#f5d060";
const WIN_COLOR = "#42e695";
const PUSH_COLOR = "#f5d060";
const LOSE_COLOR = "#ff5470";

// ---------------------------------------------------------------------------
// Teen Patti hand ranking (DIFFERENT from standard 3-card poker)
//   Trail/Trio (three of a kind)  ← HIGHEST
//   Pure Sequence (straight flush)
//   Sequence (straight)
//   Color (flush)
//   Pair
//   High Card                      ← LOWEST
// Ace is high. A-2-3 and A-K-Q are valid sequences; A-K-Q is the HIGHEST.
// ---------------------------------------------------------------------------

enum TPCategory {
  HighCard = 0,
  Pair = 1,
  Color = 2,
  Sequence = 3,
  PureSequence = 4,
  Trail = 5,
}

const TP_NAMES: Record<TPCategory, string> = {
  [TPCategory.HighCard]: "High Card",
  [TPCategory.Pair]: "Pair",
  [TPCategory.Color]: "Color",
  [TPCategory.Sequence]: "Sequence",
  [TPCategory.PureSequence]: "Pure Sequence",
  [TPCategory.Trail]: "Trail (Trio)",
};

interface TPRank {
  category: TPCategory;
  name: string;
  tiebreak: number[];
  score: number;
}

/**
 * Evaluate a Teen Patti hand of exactly 3 cards using the Teen Patti ranking
 * (Trail highest, then Pure Sequence, Sequence, Color, Pair, High Card).
 *
 * Sequences: Ace can be high (A-K-Q, the best run) or low (A-2-3, the worst
 * run). A-2-3 sorts BELOW 2-3-4 — it is the lowest possible sequence.
 */
function evaluateTeenPatti(cards: Card[]): TPRank {
  if (cards.length !== 3) throw new Error("evaluateTeenPatti expects 3 cards");
  const values = cards.map((c) => rankValue(c.rank)).sort((a, b) => b - a);
  const suits = cards.map((c) => c.suit);
  const isFlush = suits.every((s) => s === suits[0]);

  const distinct = [...new Set(values)].sort((a, b) => b - a);

  // Sequence detection. straightHigh is the comparable "rank" of the run.
  let straightHigh = 0;
  if (distinct.length === 3) {
    if (distinct[0] - distinct[2] === 2) {
      // Ordinary consecutive run (e.g. 5-6-7 → high 7, or 12-13-14 = A-K-Q → 14).
      straightHigh = distinct[0];
    } else if (distinct[0] === 14 && distinct[1] === 3 && distinct[2] === 2) {
      // A-2-3 — the LOWEST sequence. Rank it just below 2-3-4 (high 4) by
      // giving it a high value of 3 (2-3-4 is 4, so A-2-3 < 2-3-4).
      straightHigh = 3;
    }
  }
  const isSequence = straightHigh > 0;
  const isTrail = distinct.length === 1; // all three the same rank

  let category: TPCategory;
  let tiebreak: number[];

  if (isTrail) {
    category = TPCategory.Trail;
    tiebreak = [values[0]];
  } else if (isSequence && isFlush) {
    category = TPCategory.PureSequence;
    tiebreak = [straightHigh];
  } else if (isSequence) {
    category = TPCategory.Sequence;
    tiebreak = [straightHigh];
  } else if (isFlush) {
    category = TPCategory.Color;
    tiebreak = values; // high → low
  } else if (values[0] === values[1] || values[1] === values[2]) {
    category = TPCategory.Pair;
    const pairVal = values[0] === values[1] ? values[0] : values[1];
    const kicker = values[0] === values[1] ? values[2] : values[0];
    tiebreak = [pairVal, kicker];
  } else {
    category = TPCategory.HighCard;
    tiebreak = values;
  }

  // Pack into a single comparable score (category most significant).
  let score = category;
  for (let i = 0; i < 3; i++) score = score * 15 + (tiebreak[i] ?? 0);

  return { category, name: TP_NAMES[category], tiebreak, score };
}

// ---------------------------------------------------------------------------
// Bonus paytable for strong PLAYED hands (extra profit on top of the 1:1 win).
// These pay only when the player Plays (matches the boot) AND wins, on the
// player's own hand. Expressed as "X:1" profit on the TOTAL staked.
// ---------------------------------------------------------------------------

interface BonusRow {
  cat: TPCategory;
  label: string;
  bonus: number; // extra profit multiple on total stake
}

const BONUS_TABLE: BonusRow[] = [
  { cat: TPCategory.Trail, label: "Trail (Trio)", bonus: 5 },
  { cat: TPCategory.PureSequence, label: "Pure Sequence", bonus: 3 },
  { cat: TPCategory.Sequence, label: "Sequence", bonus: 1 },
];

function bonusFor(cat: TPCategory): number {
  return BONUS_TABLE.find((r) => r.cat === cat)?.bonus ?? 0;
}

// Full ranking chart (high → low) for the help panel.
const RANK_CHART: { cat: TPCategory; example: string }[] = [
  { cat: TPCategory.Trail, example: "A A A" },
  { cat: TPCategory.PureSequence, example: "A K Q ♠" },
  { cat: TPCategory.Sequence, example: "A K Q" },
  { cat: TPCategory.Color, example: "K 9 4 ♥" },
  { cat: TPCategory.Pair, example: "Q Q 7" },
  { cat: TPCategory.HighCard, example: "A J 6" },
];

// ---------------------------------------------------------------------------
// Game phases
// ---------------------------------------------------------------------------

type Phase = "betting" | "seen" | "revealing" | "result";

interface Resolution {
  outcome: "win" | "lose" | "push" | "fold";
  net: number; // net chip change for the round
  totalReturn: number; // gross credited back
  lines: { label: string; amount: number }[];
  banner: string;
}

const CHIP_DENOMS = [5, 25, 100, 500];
const DEFAULT_BOOT = 50;
const MIN_BOOT = 5;

// ---------------------------------------------------------------------------
// Rolling number counter
// ---------------------------------------------------------------------------

function Counter({ value, className }: { value: number; className?: string }) {
  const mv = useMotionValue(value);
  const rounded = useTransform(mv, (v) => formatChips(v));
  useEffect(() => {
    const controls = animate(mv, value, { duration: 0.55, ease: "easeOut" });
    return controls.stop;
  }, [value, mv]);
  return <motion.span className={className}>{rounded}</motion.span>;
}

// ---------------------------------------------------------------------------
// Win burst (radial petals + sparks)
// ---------------------------------------------------------------------------

function WinBurst({ show, big }: { show: boolean; big: boolean }) {
  const sparks = useMemo(() => {
    const n = big ? 26 : 14;
    return Array.from({ length: n }, (_, i) => {
      const angle = (i / n) * Math.PI * 2;
      const r = (big ? 240 : 160) * (0.7 + Math.random() * 0.5);
      return {
        id: i,
        x: Math.cos(angle) * r,
        y: Math.sin(angle) * r,
        c: i % 3 === 0 ? ACCENT : i % 3 === 1 ? GOLD : "#ff9ff3",
        petal: i % 2 === 0,
      };
    });
  }, [big]);
  return (
    <AnimatePresence>
      {show && (
        <div className="pointer-events-none absolute inset-0 z-30 grid place-items-center overflow-hidden">
          {/* expanding ring */}
          <motion.span
            className="absolute rounded-full"
            style={{ border: `2px solid ${GOLD}` }}
            initial={{ width: 20, height: 20, opacity: 0.9 }}
            animate={{ width: big ? 520 : 360, height: big ? 520 : 360, opacity: 0 }}
            transition={{ duration: big ? 1 : 0.8, ease: "easeOut" }}
          />
          {sparks.map((s) => (
            <motion.span
              key={s.id}
              className="absolute"
              style={{
                width: s.petal ? 14 : 9,
                height: s.petal ? 9 : 9,
                borderRadius: s.petal ? "50% 0 50% 0" : "50%",
                background: s.c,
                boxShadow: `0 0 14px ${s.c}`,
              }}
              initial={{ x: 0, y: 0, opacity: 1, scale: 1, rotate: 0 }}
              animate={{ x: s.x, y: s.y, opacity: 0, scale: 0.3, rotate: 220 }}
              exit={{ opacity: 0 }}
              transition={{ duration: big ? 1.2 : 0.9, ease: "easeOut" }}
            />
          ))}
        </div>
      )}
    </AnimatePresence>
  );
}

// ---------------------------------------------------------------------------
// Flying boot chip (decorative chip flight into the pot)
// ---------------------------------------------------------------------------

function ChipFlight({ trigger }: { trigger: number }) {
  return (
    <AnimatePresence>
      {trigger > 0 && (
        <motion.div
          key={trigger}
          className="pointer-events-none absolute left-1/2 top-1/2 z-20 h-11 w-11 -translate-x-1/2 -translate-y-1/2 rounded-full"
          style={{
            background: `radial-gradient(circle at 50% 35%, ${ACCENT}, rgba(0,0,0,0.6))`,
            border: "2px dashed rgba(255,255,255,0.7)",
            boxShadow: `0 0 18px ${ACCENT_SOFT}`,
          }}
          initial={{ x: -180, y: 160, scale: 0.4, opacity: 0, rotate: -60 }}
          animate={{ x: 0, y: 0, scale: 1, opacity: [0, 1, 1, 0], rotate: 360 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.65, ease: "easeOut" }}
        />
      )}
    </AnimatePresence>
  );
}

// ---------------------------------------------------------------------------
// Decorative lotus (SVG) — sits behind the table as a festive motif
// ---------------------------------------------------------------------------

function Lotus({ className }: { className?: string }) {
  const petals = Array.from({ length: 8 }, (_, i) => (i * 360) / 8);
  return (
    <svg viewBox="-60 -60 120 120" className={className} aria-hidden>
      {petals.map((deg) => (
        <ellipse
          key={deg}
          cx={0}
          cy={-26}
          rx={11}
          ry={28}
          transform={`rotate(${deg})`}
          fill="none"
          stroke={ACCENT}
          strokeWidth={1.4}
          opacity={0.5}
        />
      ))}
      <circle cx={0} cy={0} r={9} fill={GOLD} opacity={0.55} />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Ranking chart panel
// ---------------------------------------------------------------------------

function RankingChart({ highlight }: { highlight: TPCategory | null }) {
  return (
    <CollapsiblePanel
      title="Teen Patti Ranking"
      accent={ACCENT}
      summary={<>High → Low</>}
    >
      <p className="mb-2 text-[10px] text-white/45">High → Low (Trail beats all)</p>
      <ul className="space-y-0.5 text-[11px] sm:text-xs">
        {RANK_CHART.map((r) => {
          const lit = highlight === r.cat;
          const bonus = bonusFor(r.cat);
          return (
            <motion.li
              key={r.cat}
              animate={
                lit
                  ? {
                      backgroundColor: "rgba(232,67,147,0.30)",
                      scale: [1, 1.05, 1],
                    }
                  : { backgroundColor: "rgba(0,0,0,0)" }
              }
              transition={{ duration: 0.4 }}
              className="flex items-center justify-between gap-2 rounded-md px-2 py-1"
            >
              <span className={lit ? "font-bold text-white" : "text-white/75"}>
                {TP_NAMES[r.cat]}
              </span>
              <span className="flex items-center gap-2">
                {bonus > 0 && (
                  <span
                    className="rounded px-1.5 py-0.5 text-[9px] font-semibold"
                    style={{ background: "rgba(245,208,96,0.16)", color: GOLD }}
                  >
                    +{bonus}:1
                  </span>
                )}
                <span className="font-mono text-[10px] tabular-nums text-white/40">
                  {r.example}
                </span>
              </span>
            </motion.li>
          );
        })}
      </ul>
    </CollapsiblePanel>
  );
}

// ---------------------------------------------------------------------------
// Bet spot badge
// ---------------------------------------------------------------------------

function BetSpot({
  label,
  value,
  active,
  dim,
}: {
  label: string;
  value: number;
  active: boolean;
  dim?: boolean;
}) {
  return (
    <motion.div
      className="relative grid min-w-[96px] place-items-center rounded-2xl border px-4 py-3"
      animate={{ opacity: dim && !active ? 0.45 : 1 }}
      style={{
        borderColor: active ? ACCENT : "rgba(255,255,255,0.12)",
        background: active
          ? "linear-gradient(180deg, rgba(232,67,147,0.22), rgba(232,67,147,0.05))"
          : "rgba(255,255,255,0.03)",
        boxShadow: active ? `0 0 22px ${ACCENT_SOFT}` : "none",
      }}
    >
      <span className="text-[10px] uppercase tracking-widest text-white/55">
        {label}
      </span>
      <span className="gold-text mt-0.5 text-lg font-bold tabular-nums">
        {value > 0 ? formatChips(value) : "—"}
      </span>
    </motion.div>
  );
}

// ---------------------------------------------------------------------------
// Main game
// ---------------------------------------------------------------------------

export default function TeenPatti() {
  const wallet = useWallet();

  const [boot, setBoot] = useState(DEFAULT_BOOT);

  const [phase, setPhase] = useState<Phase>("betting");
  const [player, setPlayer] = useState<(Card | null)[]>([null, null, null]);
  const [dealer, setDealer] = useState<(Card | null)[]>([null, null, null]);
  // player cards revealed (seen) one-by-one; dealer cards face down until reveal
  const [playerShown, setPlayerShown] = useState<boolean[]>([false, false, false]);
  const [dealerFaceDown, setDealerFaceDown] = useState<boolean[]>([true, true, true]);

  const [playStake, setPlayStake] = useState(0); // boot matched on Play
  const [resolution, setResolution] = useState<Resolution | null>(null);
  const [burst, setBurst] = useState<{ show: boolean; big: boolean }>({
    show: false,
    big: false,
  });
  const [chipFlight, setChipFlight] = useState(0);

  // Timer bookkeeping so we can cancel on unmount.
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

  const playerCards = player.filter((c): c is Card => c !== null);
  const dealerCards = dealer.filter((c): c is Card => c !== null);

  const playerRank =
    playerCards.length === 3 ? evaluateTeenPatti(playerCards) : null;
  const dealerRank =
    dealerCards.length === 3 && (phase === "result" || phase === "revealing")
      ? evaluateTeenPatti(dealerCards)
      : null;

  const playerSeen = playerShown.every(Boolean);
  const totalStake = boot + playStake; // for the active round

  // Clamp boot to balance / minimum.
  const maxBoot = wallet.ready ? wallet.balance : 0;
  const canDeal =
    phase === "betting" && boot >= MIN_BOOT && boot <= wallet.balance;
  // To Play you must match the boot, so you need 2× boot total.
  const canAffordPlay = wallet.balance >= boot; // boot already deducted; need another boot

  // -------------------------------------------------------------------------
  // Bet editing (betting phase only)
  // -------------------------------------------------------------------------

  const addBoot = (v: number) => {
    if (phase !== "betting") return;
    sfx.chip();
    setBoot((b) => Math.min(b + v, wallet.balance));
  };
  const clearBoot = () => {
    if (phase !== "betting") return;
    sfx.click();
    setBoot(0);
  };
  const halveBoot = () => {
    if (phase !== "betting") return;
    sfx.click();
    setBoot((b) => Math.max(0, Math.floor(b / 2)));
  };
  const maxOut = () => {
    if (phase !== "betting") return;
    sfx.click();
    setBoot(Math.floor(maxBoot));
  };

  // -------------------------------------------------------------------------
  // Deal — take the BOOT (ante), deal 3 to player (seen) + 3 to dealer (down)
  // -------------------------------------------------------------------------

  const deal = () => {
    if (phase !== "betting" || boot < MIN_BOOT) return;
    if (!wallet.bet(boot)) return; // deducts the boot up-front

    const shoe = makeShoe(1);
    // Alternate-style deal: p0,d0,p1,d1,p2,d2
    const p: Card[] = [shoe[0], shoe[2], shoe[4]];
    const d: Card[] = [shoe[1], shoe[3], shoe[5]];

    setResolution(null);
    setBurst({ show: false, big: false });
    setPlayStake(0);
    setPlayer(p);
    setDealer(d);
    setPlayerShown([false, false, false]);
    setDealerFaceDown([true, true, true]);
    setPhase("seen");
    setChipFlight((n) => n + 1);

    // Reveal the player's three cards one-by-one (they "see" their hand).
    [0, 1, 2].forEach((i) => {
      after(360 + i * 260, () => {
        sfx.card();
        setPlayerShown((r) => {
          const next = [...r];
          next[i] = true;
          return next;
        });
      });
    });
  };

  // -------------------------------------------------------------------------
  // Resolve after Play / Fold
  // -------------------------------------------------------------------------

  const resolveRound = useCallback(
    (folded: boolean, playBet: number) => {
      const pCards = player.filter((c): c is Card => c !== null);
      const dCards = dealer.filter((c): c is Card => c !== null);
      if (pCards.length !== 3 || dCards.length !== 3) return;

      const pRank = evaluateTeenPatti(pCards);
      const dRank = evaluateTeenPatti(dCards);

      const lines: { label: string; amount: number }[] = [];
      const stakedThisRound = boot + (folded ? 0 : playBet);

      let totalReturn = 0;
      let banner: string;
      let outcome: Resolution["outcome"];

      if (folded) {
        outcome = "fold";
        banner = "You folded — Boot forfeited";
        lines.push({ label: "Folded · Boot lost", amount: 0 });
      } else {
        const totalBet = boot + playBet; // full stake at risk
        const cmp = pRank.score - dRank.score;

        if (cmp > 0) {
          // Player vs dealer here is a symmetric mirror match (push on tie), so
          // the base showdown is ~0% edge — paying 1:1 + an uncapped bonus made
          // the whole game ~105% RTP (player-favorable). A house commission on
          // the winnings restores a normal edge (~3.3%, sim-verified) without
          // touching the fair comparison itself.
          const COMMISSION = 0.15; // house cut on winnings above the stake

          // Gross profit = 1:1 on the stake, plus the bonus for strong hands.
          const bonus = bonusFor(pRank.category);
          const grossProfit = totalBet + totalBet * bonus;
          const commission = grossProfit * COMMISSION; // exact 15% — wallet rounds to the cent
          const netProfit = grossProfit - commission;
          const baseWin = totalBet + netProfit; // stake returned + net profit
          totalReturn += baseWin;

          lines.push({ label: "Show won (1:1)", amount: totalBet * 2 });
          if (bonus > 0) {
            lines.push({
              label: `${pRank.name} bonus (${bonus}:1)`,
              amount: totalBet * bonus,
            });
          }
          lines.push({
            label: `House commission (${Math.round(COMMISSION * 100)}%)`,
            amount: -commission,
          });
          outcome = "win";
          banner =
            bonus > 0 ? `${pRank.name} — you win big!` : "You win the show!";
        } else if (cmp === 0) {
          // Tie → PUSH (refund the total stake).
          totalReturn += totalBet;
          lines.push({ label: "Tie · Boot & Play push", amount: totalBet });
          outcome = "push";
          banner = "Tie — bets returned";
        } else {
          lines.push({ label: "Dealer wins · stake lost", amount: 0 });
          outcome = "lose";
          banner = "Dealer takes the pot";
        }
      }

      const net = totalReturn - stakedThisRound;

      setResolution({ outcome, net, totalReturn, lines, banner });

      // Dramatic dealer reveal — flip the three cards one by one.
      [0, 1, 2].forEach((i) => {
        after(i * 360, () => {
          sfx.card();
          setDealerFaceDown((f) => {
            const next = [...f];
            next[i] = false;
            return next;
          });
        });
      });

      // After the reveal lands, credit winnings and fire the result feedback.
      after(3 * 360 + 320, () => {
        // Credit the gross return at the same moment the result becomes visible,
        // so the balance counter does not jump during the dealer-flip animation.
        if (totalReturn > 0) wallet.win(totalReturn);
        setPhase("result");
        if (outcome === "win") {
          const big = net >= boot * 6;
          if (big) sfx.jackpot();
          else sfx.win();
          setBurst({ show: true, big });
          after(big ? 1300 : 950, () => setBurst({ show: false, big }));
        } else if (outcome === "push") {
          sfx.thud();
        } else {
          sfx.lose();
        }
      });
    },
    [player, dealer, boot, wallet, after],
  );

  const onPlay = () => {
    if (phase !== "seen" || !playerSeen) return;
    // Match the boot to stay in.
    if (!wallet.bet(boot)) return; // can't afford → caller disables this
    sfx.chip();
    setPlayStake(boot);
    setChipFlight((n) => n + 1);
    setPhase("revealing");
    resolveRound(false, boot);
  };

  const onFold = () => {
    if (phase !== "seen" || !playerSeen) return;
    sfx.click();
    setPhase("revealing");
    resolveRound(true, 0);
  };

  const nextRound = () => {
    if (phase !== "result") return;
    sfx.click();
    setPhase("betting");
    setPlayer([null, null, null]);
    setDealer([null, null, null]);
    setPlayerShown([false, false, false]);
    setDealerFaceDown([true, true, true]);
    setPlayStake(0);
    setResolution(null);
    setBurst({ show: false, big: false });
  };

  // Highlight categories on the chart.
  const chartHighlight =
    (phase === "result" || phase === "revealing") && playerRank
      ? playerRank.category
      : phase === "seen" && playerSeen && playerRank
        ? playerRank.category
        : null;

  const resultColor =
    resolution?.outcome === "win"
      ? WIN_COLOR
      : resolution?.outcome === "push"
        ? PUSH_COLOR
        : LOSE_COLOR;

  const playerWon = resolution?.outcome === "win";
  const dealerWon = resolution?.outcome === "lose" || resolution?.outcome === "fold";

  // Celebration overlay — fire only on a notable win (total return >= ~2x the
  // total wagered this round, which only bonus hands reach; plain ~1.85x wins
  // and 1:1 pushes are skipped). Tier follows the hand strength.
  const celebrateWin =
    phase === "result" &&
    playerWon &&
    !!resolution &&
    resolution.totalReturn >= totalStake * 2;
  const celebrationTier: "win" | "big" | "jackpot" =
    playerRank?.category === TPCategory.Trail ||
    playerRank?.category === TPCategory.PureSequence ||
    (celebrateWin && resolution.totalReturn >= totalStake * 10)
      ? "jackpot"
      : playerRank?.category === TPCategory.Sequence ||
          playerRank?.category === TPCategory.Color ||
          (celebrateWin && resolution.totalReturn >= totalStake * 4)
        ? "big"
        : "win";

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <div className="mx-auto w-full max-w-6xl">
      <div className="grid gap-2 sm:gap-4 lg:grid-cols-[1fr_290px]">
        {/* ===================== TABLE ===================== */}
        <div className="relative">
          <div
            className="felt relative overflow-hidden rounded-3xl p-3 sm:p-6 [@media(max-height:600px)]:p-2.5"
            style={{
              boxShadow: `0 0 0 1px ${ACCENT_SOFT}, 0 24px 60px rgba(0,0,0,0.55)`,
              backgroundImage:
                "radial-gradient(120% 90% at 50% 0%, rgba(232,67,147,0.14), transparent 60%)",
            }}
          >
            {/* ambient accent glow */}
            <div
              className="pointer-events-none absolute -top-24 left-1/2 h-56 w-[140%] -translate-x-1/2 rounded-full opacity-30 blur-3xl"
              style={{ background: ACCENT }}
            />
            {/* decorative lotus motifs */}
            <Lotus className="pointer-events-none absolute -left-10 top-8 h-32 w-32 opacity-30" />
            <Lotus className="pointer-events-none absolute -right-10 bottom-8 h-32 w-32 opacity-30" />

            <ChipFlight trigger={chipFlight} />
            <WinBurst show={burst.show} big={burst.big} />
            <Celebration
              show={celebrateWin}
              seed={resolution?.totalReturn ?? 0}
              tier={celebrationTier}
              colors={["#e84393", "#ffd24a", "#22e1ff", "#ffffff"]}
            />

            {/* Title flourish */}
            <div className="relative z-10 mb-2 text-center sm:mb-3 [@media(max-height:600px)]:mb-1">
              <span
                className="font-display text-xs font-bold uppercase tracking-[0.35em]"
                style={{ color: GOLD, textShadow: `0 0 12px ${ACCENT_SOFT}` }}
              >
                ✦ Teen Patti ✦
              </span>
            </div>

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
                      className="rounded-full bg-black/40 px-3 py-1 text-xs font-semibold"
                      style={{ color: dealerWon ? WIN_COLOR : "rgba(255,255,255,0.7)" }}
                    >
                      {dealerRank.name}
                    </motion.span>
                  )}
                </AnimatePresence>
              </div>
              <div className="flex justify-center gap-2 sm:gap-3">
                {dealer.map((c, i) => (
                  <motion.div
                    key={`d-${i}`}
                    initial={{ y: -46, opacity: 0, rotate: -10 }}
                    animate={
                      c ? { y: 0, opacity: 1, rotate: 0 } : { y: -46, opacity: 0 }
                    }
                    transition={{
                      delay: c ? 0.06 * i : 0,
                      type: "spring",
                      stiffness: 220,
                      damping: 20,
                    }}
                  >
                    <PlayingCard
                      card={c}
                      faceDown={dealerFaceDown[i]}
                      size="lg"
                      highlight={
                        phase === "result" && dealerWon && !dealerFaceDown[i]
                      }
                    />
                  </motion.div>
                ))}
              </div>
            </div>

            {/* Center banner / pot */}
            <div className="my-2 grid min-h-[56px] place-items-center sm:my-4 sm:min-h-[72px] [@media(max-height:600px)]:my-1.5 [@media(max-height:600px)]:min-h-[44px]">
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
                      background: "rgba(0,0,0,0.5)",
                      boxShadow: `0 0 28px ${resultColor}66`,
                    }}
                  >
                    <div
                      className="font-display text-lg font-bold sm:text-xl"
                      style={{
                        color: resultColor,
                        textShadow: `0 0 14px ${resultColor}88`,
                      }}
                    >
                      {resolution.banner}
                    </div>
                    <div className="mt-0.5 text-sm font-semibold tabular-nums text-white/85">
                      {resolution.totalReturn > 0 ? (
                        <>
                          Returned{" "}
                          <Counter
                            value={resolution.totalReturn}
                            className="tabular-nums"
                          />
                        </>
                      ) : (
                        "No return"
                      )}
                      <span
                        style={{
                          color: resolution.net >= 0 ? WIN_COLOR : LOSE_COLOR,
                        }}
                        className="ml-2"
                      >
                        ({formatDelta(resolution.net)})
                      </span>
                    </div>
                  </motion.div>
                ) : phase === "seen" ? (
                  <motion.div
                    key="decide"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="text-center text-sm text-white/65"
                  >
                    {playerSeen ? (
                      <>
                        Your hand:{" "}
                        <span className="font-bold" style={{ color: ACCENT }}>
                          {playerRank?.name}
                        </span>{" "}
                        — Play (match {formatChips(boot)}) or Fold?
                      </>
                    ) : (
                      <span className="animate-pulse">Dealing your cards…</span>
                    )}
                  </motion.div>
                ) : phase === "revealing" ? (
                  <motion.div
                    key="reveal"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="text-center text-sm font-semibold"
                    style={{ color: GOLD }}
                  >
                    <span className="animate-pulse">Showdown…</span>
                  </motion.div>
                ) : (
                  <motion.div
                    key="idle"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="text-center text-sm text-white/45"
                  >
                    Set your Boot, then deal.
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            {/* Player row */}
            <div className="relative z-10">
              <div className="mb-2 flex items-center justify-between">
                <span className="font-display text-sm font-bold uppercase tracking-[0.2em] text-emerald-200">
                  You
                </span>
                <AnimatePresence>
                  {playerRank && playerSeen && (
                    <motion.span
                      initial={{ opacity: 0, x: 10 }}
                      animate={{ opacity: 1, x: 0 }}
                      className="rounded-full bg-black/40 px-3 py-1 text-xs font-semibold"
                      style={{
                        color: playerWon ? WIN_COLOR : "rgba(255,255,255,0.85)",
                      }}
                    >
                      {playerRank.name}
                    </motion.span>
                  )}
                </AnimatePresence>
              </div>
              <div className="flex justify-center gap-2 sm:gap-3">
                {player.map((c, i) => (
                  <motion.div
                    key={`p-${i}`}
                    initial={{ y: 52, opacity: 0, rotate: 10 }}
                    animate={
                      c ? { y: 0, opacity: 1, rotate: 0 } : { y: 52, opacity: 0 }
                    }
                    transition={{
                      delay: c ? 0.06 * i : 0,
                      type: "spring",
                      stiffness: 220,
                      damping: 20,
                    }}
                  >
                    <PlayingCard
                      card={c}
                      faceDown={!playerShown[i]}
                      size="lg"
                      highlight={phase === "result" && playerWon && playerShown[i]}
                    />
                  </motion.div>
                ))}
              </div>
            </div>

            {/* Bet spots */}
            <div className="relative z-10 mt-3 flex flex-wrap items-center justify-center gap-2 sm:mt-5 sm:gap-3 [@media(max-height:600px)]:mt-2">
              <BetSpot
                label="Boot"
                value={boot}
                active={boot > 0}
                dim={phase !== "betting"}
              />
              <BetSpot
                label="Play"
                value={playStake}
                active={playStake > 0}
                dim
              />
              <div className="grid min-w-[96px] place-items-center rounded-2xl border border-gold/30 bg-black/40 px-4 py-3">
                <span className="text-[10px] uppercase tracking-widest text-white/55">
                  Pot
                </span>
                <span className="gold-text mt-0.5 text-lg font-bold tabular-nums">
                  {phase === "betting"
                    ? formatChips(boot)
                    : formatChips(totalStake)}
                </span>
              </div>
            </div>
          </div>

          {/* ===================== CONTROLS ===================== */}
          <div className="mt-2 sm:mt-4">
            {phase === "betting" && (
              <div className="glass rounded-2xl p-3 sm:p-4">
                <div className="mb-2 text-center text-[11px] uppercase tracking-widest text-white/55">
                  Tap a chip to raise the Boot (ante)
                </div>
                <div className="flex flex-wrap items-center justify-center gap-2 sm:gap-3">
                  {CHIP_DENOMS.map((v) => (
                    <Chip
                      key={v}
                      value={v}
                      size={52}
                      onClick={
                        boot + v > wallet.balance ? undefined : () => addBoot(v)
                      }
                    />
                  ))}
                </div>

                <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={clearBoot}
                    data-testid="clear-boot-btn"
                  >
                    Clear
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={halveBoot}
                    data-testid="halve-boot-btn"
                  >
                    ½
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={maxOut}
                    data-testid="max-boot-btn"
                  >
                    Max
                  </Button>

                  <div className="rounded-xl border border-gold/30 bg-black/40 px-4 py-2 text-center">
                    <div className="text-[9px] uppercase tracking-widest text-white/40">
                      Boot
                    </div>
                    <div className="gold-text text-lg font-bold tabular-nums">
                      {formatChips(boot)}
                    </div>
                  </div>

                  <Button
                    size="lg"
                    variant="gold"
                    onClick={deal}
                    disabled={!canDeal}
                    data-testid="play-btn"
                  >
                    Deal
                  </Button>
                </div>

                {boot < MIN_BOOT && (
                  <p className="mt-2 text-center text-xs text-white/40">
                    Set a Boot of at least {MIN_BOOT} to deal.
                  </p>
                )}
                {boot >= MIN_BOOT && boot > wallet.balance && (
                  <p className="mt-2 text-center text-xs text-ruby/80">
                    Not enough chips for that Boot.
                  </p>
                )}
                {boot >= MIN_BOOT &&
                  boot <= wallet.balance &&
                  boot * 2 > wallet.balance && (
                    <p className="mt-2 text-center text-xs text-amber-300/80">
                      Heads up: you won&apos;t have enough to Play (match the
                      Boot) after dealing — you&apos;d have to Fold.
                    </p>
                  )}
              </div>
            )}

            {(phase === "seen" || phase === "revealing") && (
              <div className="glass rounded-2xl p-4">
                <div className="flex flex-wrap items-center justify-center gap-3">
                  <Button
                    size="lg"
                    variant="gold"
                    onClick={onPlay}
                    disabled={phase !== "seen" || !playerSeen || !canAffordPlay}
                    data-testid="play-action-btn"
                  >
                    Play · match {formatChips(boot)}
                  </Button>
                  <Button
                    size="lg"
                    variant="danger"
                    onClick={onFold}
                    disabled={phase !== "seen" || !playerSeen}
                    data-testid="fold-btn"
                  >
                    Fold
                  </Button>
                </div>
                {phase === "seen" && playerSeen && !canAffordPlay && (
                  <p className="mt-2 text-center text-xs text-ruby/80">
                    Can&apos;t match the Boot — you must Fold.
                  </p>
                )}
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
          <RankingChart highlight={chartHighlight} />

          {/* Round breakdown / rules */}
          <CollapsiblePanel title="Round" accent={ACCENT} summary={<>rules</>}>
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
                      style={{
                        color: resolution.net >= 0 ? WIN_COLOR : LOSE_COLOR,
                      }}
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
                    Post the <span className="text-white/80">Boot</span> (ante),
                    see your 3 cards, then{" "}
                    <span className="text-white/80">Play</span> (match the Boot)
                    or <span className="text-white/80">Fold</span>.
                  </p>
                  <p>Higher hand wins the showdown. Win pays 1:1 on total stake.</p>
                  <p>Tie pushes (bets returned).</p>
                  <p className="text-white/40">
                    Trail beats Pure Sequence beats Sequence beats Color in Teen
                    Patti. Sequence+ played hands earn a bonus.
                  </p>
                </motion.div>
              )}
            </AnimatePresence>
          </CollapsiblePanel>

          {/* Stats */}
          <div className="glass flex items-center justify-between rounded-2xl px-4 py-3">
            <div>
              <div className="text-[9px] uppercase tracking-widest text-white/40">
                Balance
              </div>
              <div className="gold-text text-base font-bold tabular-nums">
                {wallet.ready ? <Counter value={wallet.balance} /> : "—"}
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
