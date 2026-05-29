"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AnimatePresence,
  motion,
  useMotionValue,
  useTransform,
  animate,
} from "framer-motion";
import {
  type Card,
  HandCategory,
  evaluate5,
  makeShoe,
  type HandRank,
} from "@/lib/cards";
import { useWallet } from "@/lib/wallet";
import { formatChips, formatDelta } from "@/lib/format";
import { sfx } from "@/lib/sound";
import { Button } from "@/components/ui/Button";
import { Chip } from "@/components/ui/Chip";
import { PlayingCard } from "@/components/PlayingCard";
import { CollapsiblePanel } from "@/components/CollapsiblePanel";
import { Celebration } from "@/components/Celebration";

const ACCENT = "#e67e22";
const ACCENT_SOFT = "rgba(230,126,34,0.18)";
const MIN_BET = 5;
const MAX_BET = 1000;
const CHIPS = [5, 25, 100, 500, 1000];

/* ------------------------------------------------------------------ */
/* Paytable. multiplier is the PROFIT ratio (X:1). A winning bet of    */
/* `unit` returns win(unit * (multiplier + 1)).                        */
/* ------------------------------------------------------------------ */
interface PayRow {
  cat: HandCategory;
  label: string;
  mult: number;
}
const PAYTABLE: PayRow[] = [
  { cat: HandCategory.RoyalFlush, label: "Royal Flush", mult: 1000 },
  { cat: HandCategory.StraightFlush, label: "Straight Flush", mult: 200 },
  { cat: HandCategory.FourOfAKind, label: "Four of a Kind", mult: 50 },
  { cat: HandCategory.FullHouse, label: "Full House", mult: 11 },
  { cat: HandCategory.Flush, label: "Flush", mult: 8 },
  { cat: HandCategory.Straight, label: "Straight", mult: 5 },
  { cat: HandCategory.ThreeOfAKind, label: "Three of a Kind", mult: 3 },
  { cat: HandCategory.TwoPair, label: "Two Pair", mult: 2 },
  { cat: HandCategory.Pair, label: "Pair of 10s or better", mult: 1 },
];

/** Returns the profit multiplier for a final 5-card hand (0 = loss). */
function payoutMultiplier(rank: HandRank): number {
  if (rank.category === HandCategory.Pair) {
    // Qualifying pair must be tens or better. tiebreak[0] is the pair value.
    const pairVal = rank.tiebreak[0] ?? 0;
    return pairVal >= 10 ? 1 : 0;
  }
  if (rank.category === HandCategory.HighCard) return 0;
  const row = PAYTABLE.find((r) => r.cat === rank.category);
  return row ? row.mult : 0;
}

/* ------------------------------------------------------------------ */
/* Phases                                                              */
/* ------------------------------------------------------------------ */
type Phase =
  | "betting" // setting unit bet, nothing dealt
  | "dealing" // cards flying in
  | "decision1" // 3 player cards visible, decide bet 1
  | "reveal1" // flipping first community card
  | "decision2" // first community visible, decide bet 2
  | "reveal2" // flipping second community card
  | "resolved"; // show outcome

interface BetSlot {
  // true = still in play, false = pulled back
  active: boolean;
}

interface Resolution {
  rank: HandRank;
  mult: number;
  remainingBets: number; // 1..3
  pulledBack: number; // refunded chips
  stakeInPlay: number; // unit * remainingBets
  gross: number; // total credited (refunds + winnings/push)
  net: number; // gross - totalWagered
  win: boolean;
}

/* ------------------------------------------------------------------ */
/* Rolling chip counter                                                */
/* ------------------------------------------------------------------ */
function Counter({ value, className }: { value: number; className?: string }) {
  const mv = useMotionValue(0);
  const rounded = useTransform(mv, (v) => formatChips(Math.round(v)));
  useEffect(() => {
    const controls = animate(mv, value, { duration: 0.7, ease: "easeOut" });
    return controls.stop;
  }, [value, mv]);
  return <motion.span className={className}>{rounded}</motion.span>;
}

/* ------------------------------------------------------------------ */
/* Win burst (radiating accent shards)                                 */
/* ------------------------------------------------------------------ */
function WinBurst({ big }: { big: boolean }) {
  const shards = useMemo(
    () =>
      Array.from({ length: big ? 26 : 16 }, (_, i) => ({
        id: i,
        angle: (360 / (big ? 26 : 16)) * i + (i % 2 ? 7 : -7),
        dist: 120 + (i % 5) * 26,
        size: 6 + (i % 4) * 3,
        delay: (i % 6) * 0.018,
        hue: i % 3 === 0 ? "#f5d060" : i % 3 === 1 ? ACCENT : "#fff",
      })),
    [big],
  );
  return (
    <div className="pointer-events-none absolute inset-0 z-30 grid place-items-center overflow-visible">
      {shards.map((s) => (
        <motion.span
          key={s.id}
          className="absolute rounded-full"
          style={{ width: s.size, height: s.size, background: s.hue }}
          initial={{ x: 0, y: 0, opacity: 1, scale: 1 }}
          animate={{
            x: Math.cos((s.angle * Math.PI) / 180) * s.dist,
            y: Math.sin((s.angle * Math.PI) / 180) * s.dist,
            opacity: 0,
            scale: 0.2,
          }}
          transition={{ duration: big ? 1.1 : 0.85, ease: "easeOut", delay: s.delay }}
        />
      ))}
      <motion.span
        className="absolute rounded-full"
        style={{ boxShadow: `0 0 60px 30px ${ACCENT}` }}
        initial={{ width: 10, height: 10, opacity: 0.6 }}
        animate={{ width: 260, height: 260, opacity: 0 }}
        transition={{ duration: 0.9, ease: "easeOut" }}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Bet circle (a betting spot on the felt)                             */
/* ------------------------------------------------------------------ */
function BetSpot({
  label,
  unit,
  active,
  glowing,
  result,
}: {
  label: string;
  unit: number;
  active: boolean;
  glowing: boolean;
  result: "win" | "lose" | "push" | "pulled" | null;
}) {
  const ring =
    result === "win"
      ? "#f5d060"
      : result === "lose"
        ? "#b0282d"
        : result === "pulled"
          ? "rgba(255,255,255,0.35)"
          : glowing
            ? ACCENT
            : "rgba(255,255,255,0.18)";
  return (
    <motion.div
      className="relative flex flex-col items-center gap-1"
      animate={glowing ? { scale: [1, 1.04, 1] } : { scale: 1 }}
      transition={glowing ? { duration: 1.4, repeat: Infinity } : { duration: 0.2 }}
    >
      <div
        className="grid h-16 w-16 place-items-center rounded-full text-center transition-colors sm:h-20 sm:w-20 [@media(max-height:600px)]:h-12 [@media(max-height:600px)]:w-12"
        style={{
          border: `2px solid ${ring}`,
          boxShadow: glowing
            ? `0 0 18px ${ACCENT}, inset 0 0 14px ${ACCENT_SOFT}`
            : result === "win"
              ? "0 0 18px rgba(245,208,96,0.7)"
              : "inset 0 0 12px rgba(0,0,0,0.4)",
          background:
            result === "pulled"
              ? "repeating-linear-gradient(45deg,rgba(255,255,255,0.04) 0 6px,transparent 6px 12px)"
              : "radial-gradient(circle at 50% 35%, rgba(255,255,255,0.05), rgba(0,0,0,0.3))",
          opacity: result === "pulled" || result === "lose" ? 0.55 : 1,
        }}
      >
        <span className="text-[10px] font-bold uppercase tracking-widest text-white/70">
          {label}
        </span>
      </div>
      <AnimatePresence>
        {active && (
          <motion.div
            key="chip"
            initial={{ y: -30, opacity: 0, scale: 0.6 }}
            animate={{ y: 0, opacity: 1, scale: 1 }}
            exit={{ y: -16, opacity: 0, scale: 0.4 }}
            transition={{ type: "spring", stiffness: 320, damping: 22 }}
          >
            <Chip value={unit} size={34} />
          </motion.div>
        )}
        {!active && result === "pulled" && (
          <motion.span
            key="pulled"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="text-[9px] font-semibold uppercase tracking-wider text-white/45"
          >
            Pulled
          </motion.span>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

/* ================================================================== */
/* MAIN COMPONENT                                                      */
/* ================================================================== */
export default function LetItRide() {
  const wallet = useWallet();
  const { balance, ready } = wallet;

  const [unit, setUnit] = useState(25);
  const [phase, setPhase] = useState<Phase>("betting");

  // The dealt cards. player[0..2] = the 3 player cards. community[0..1].
  const [player, setPlayer] = useState<(Card | null)[]>([null, null, null]);
  const [community, setCommunity] = useState<(Card | null)[]>([null, null]);
  const [commRevealed, setCommRevealed] = useState<[boolean, boolean]>([false, false]);
  const [dealt, setDealt] = useState<number>(0); // how many player cards have landed

  const [bets, setBets] = useState<[BetSlot, BetSlot, BetSlot]>([
    { active: true },
    { active: true },
    { active: true },
  ]);

  const [resolution, setResolution] = useState<Resolution | null>(null);
  const [lastDelta, setLastDelta] = useState<number | null>(null);

  // hold final 5 cards for the resolved state
  const finalRef = useRef<{ player: Card[]; community: Card[] } | null>(null);
  // mirror bet1's active flag so resolve() can read it without touching state
  // inside a state updater (keeps the wallet credit a pure side effect).
  const bet1ActiveRef = useRef(true);
  // guard against a double credit (e.g. React StrictMode double-invoke).
  const resolvedRef = useRef(false);

  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const after = useCallback((ms: number, fn: () => void) => {
    const t = setTimeout(fn, ms);
    timers.current.push(t);
    return t;
  }, []);
  useEffect(
    () => () => {
      timers.current.forEach(clearTimeout);
    },
    [],
  );

  const totalWager = unit * 3;
  const inRound = phase !== "betting" && phase !== "resolved";
  const canAfford = balance >= totalWager;

  /* ------------------------------ deal ------------------------------ */
  const startRound = useCallback(() => {
    if (inRound) return;
    if (unit < MIN_BET) return;
    if (!wallet.bet(totalWager)) return; // deduct all 3 bets up front

    // reset
    timers.current.forEach(clearTimeout);
    timers.current = [];
    bet1ActiveRef.current = true;
    resolvedRef.current = false;
    setResolution(null);
    setLastDelta(null);
    setBets([{ active: true }, { active: true }, { active: true }]);
    setCommRevealed([false, false]);
    setDealt(0);

    const shoe = makeShoe(1);
    const p = [shoe[0], shoe[1], shoe[2]];
    const c = [shoe[3], shoe[4]];
    finalRef.current = { player: p, community: c };

    setPlayer(p);
    setCommunity(c); // present but face-down until revealed
    setPhase("dealing");

    // Fly player cards in one by one.
    [0, 1, 2].forEach((i) => {
      after(220 + i * 230, () => {
        sfx.card();
        setDealt(i + 1);
      });
    });
    after(220 + 3 * 230 + 200, () => setPhase("decision1"));
  }, [inRound, unit, totalWager, wallet, after]);

  /* ---------------------------- resolve ----------------------------- */
  const resolve = useCallback(
    (bet2Active: boolean) => {
      const data = finalRef.current;
      if (!data) return;
      if (resolvedRef.current) return; // never credit twice
      resolvedRef.current = true;

      const bet1Active = bet1ActiveRef.current;
      const remaining = (bet1Active ? 1 : 0) + (bet2Active ? 1 : 0) + 1; // bet3 always rides

      const five = [...data.player, ...data.community];
      const rank = evaluate5(five);
      const mult = payoutMultiplier(rank);

      const pulledCount = 3 - remaining;
      const pulledBack = pulledCount * unit; // refunded chips (already deducted up front)
      const stakeInPlay = remaining * unit;

      let gross = pulledBack; // refunds always come back
      let isWin = false;
      if (mult > 0) {
        // each remaining bet returns unit * (mult + 1)  (stake + profit)
        gross += stakeInPlay * (mult + 1);
        isWin = true;
      }
      // loss on remaining bets: those chips are gone (credit nothing for them)

      if (gross > 0) wallet.win(gross);

      const net = gross - totalWager;
      setResolution({
        rank,
        mult,
        remainingBets: remaining,
        pulledBack,
        stakeInPlay,
        gross,
        net,
        win: isWin,
      });
      setLastDelta(net);

      if (isWin) {
        if (mult >= 50) sfx.jackpot();
        else sfx.win();
      } else {
        sfx.lose();
      }
      setPhase("resolved");
    },
    [unit, totalWager, wallet],
  );

  /* --------------------------- decisions ---------------------------- */
  // bet 1 decision (after seeing 3 player cards)
  const decideBet1 = useCallback(
    (letRide: boolean) => {
      if (phase !== "decision1") return;
      sfx.chip();
      if (!letRide) {
        bet1ActiveRef.current = false;
        setBets((b) => [{ active: false }, b[1], b[2]]);
        sfx.thud();
      }
      setPhase("reveal1");
      after(80, () => {
        sfx.card();
        setCommRevealed([true, false]);
      });
      after(620, () => setPhase("decision2"));
    },
    [phase, after],
  );

  // bet 2 decision (after first community card)
  const decideBet2 = useCallback(
    (letRide: boolean) => {
      if (phase !== "decision2") return;
      sfx.chip();
      if (!letRide) sfx.thud();
      setBets((b): [BetSlot, BetSlot, BetSlot] => [
        b[0],
        letRide ? b[1] : { active: false },
        b[2],
      ]);
      setPhase("reveal2");
      after(80, () => {
        sfx.card();
        setCommRevealed([true, true]);
      });
      after(720, () => resolve(letRide));
    },
    [phase, after, resolve],
  );

  /* --------------------------- next round --------------------------- */
  const newRound = useCallback(() => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
    bet1ActiveRef.current = true;
    resolvedRef.current = false;
    setPhase("betting");
    setPlayer([null, null, null]);
    setCommunity([null, null]);
    setCommRevealed([false, false]);
    setDealt(0);
    setResolution(null);
    finalRef.current = null;
    setBets([{ active: true }, { active: true }, { active: true }]);
  }, []);

  /* ---------------------- live "best so far" hint ------------------- */
  const liveHand = useMemo<HandRank | null>(() => {
    if (phase === "betting") return null;
    const data = finalRef.current;
    if (!data) return null;
    const revealed: Card[] = [...data.player];
    if (commRevealed[0]) revealed.push(data.community[0]);
    if (commRevealed[1]) revealed.push(data.community[1]);
    if (revealed.length === 5) return evaluate5(revealed);
    return null; // only show a named hand once all 5 are out (true Let It Ride feel)
  }, [phase, commRevealed]);

  // which paytable row matches the resolved hand (for highlight)
  const winningRow = resolution
    ? PAYTABLE.find((r) =>
        r.cat === HandCategory.Pair
          ? resolution.rank.category === HandCategory.Pair && (resolution.rank.tiebreak[0] ?? 0) >= 10
          : r.cat === resolution.rank.category,
      )
    : null;

  // Win celebration: fire only on a notable resolved win (>= ~2x total wagered).
  const celebrate =
    phase === "resolved" && !!resolution?.win && resolution.gross >= totalWager * 2;
  const celebrationTier: "win" | "big" | "jackpot" = resolution
    ? resolution.rank.category === HandCategory.RoyalFlush ||
      resolution.rank.category === HandCategory.StraightFlush ||
      resolution.gross >= totalWager * 25
      ? "jackpot"
      : resolution.rank.category === HandCategory.FourOfAKind ||
          resolution.rank.category === HandCategory.FullHouse ||
          resolution.rank.category === HandCategory.Flush ||
          resolution.gross >= totalWager * 6
        ? "big"
        : "win"
    : "win";

  const cardSizeClass =
    "scale-[0.82] sm:scale-100 [@media(max-height:600px)]:scale-[0.7]";

  /* ============================ RENDER ============================= */
  return (
    <div className="mx-auto w-full max-w-5xl px-2 sm:px-4">
      {/* Title row */}
      <div className="mb-2 flex items-end justify-between gap-3 sm:mb-3 [@media(max-height:600px)]:mb-1">
        <div>
          <h2
            className="font-display text-2xl font-bold tracking-wide sm:text-3xl"
            style={{ color: ACCENT, textShadow: `0 0 18px ${ACCENT_SOFT}` }}
          >
            Let It Ride
          </h2>
          <p className="text-xs text-white/45">
            Three bets ride or retreat — chase a pair of tens or better.
          </p>
        </div>
        <div className="text-right">
          <div className="text-[10px] uppercase tracking-widest text-white/40">Balance</div>
          <div className="gold-text text-lg font-bold tabular-nums sm:text-xl">
            {ready ? formatChips(balance) : "—"}
          </div>
        </div>
      </div>

      <div className="grid gap-3 lg:grid-cols-[1fr_260px]">
        {/* ---------------------- FELT SURFACE ---------------------- */}
        <div className="felt relative overflow-hidden rounded-3xl border border-white/10 p-4 shadow-felt sm:p-6 [@media(max-height:600px)]:p-3">
          <Celebration
            show={celebrate}
            seed={resolution?.gross ?? 0}
            tier={celebrationTier}
            colors={["#e67e22", "#ffd24a", "#22e1ff", "#ffffff"]}
          />
          {/* accent corner glows */}
          <div
            className="pointer-events-none absolute -left-16 -top-16 h-56 w-56 rounded-full opacity-30 blur-3xl"
            style={{ background: ACCENT }}
          />
          <div
            className="pointer-events-none absolute -bottom-20 -right-12 h-56 w-56 rounded-full opacity-20 blur-3xl"
            style={{ background: ACCENT }}
          />

          {/* COMMUNITY CARDS */}
          <div className="relative z-10 mb-2 flex flex-col items-center sm:mb-4 [@media(max-height:600px)]:mb-1">
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.3em] text-white/45">
              Community
            </div>
            <div className={`flex gap-3 ${cardSizeClass}`}>
              {[0, 1].map((i) => {
                const shown = inRound || phase === "resolved";
                return (
                  <motion.div
                    key={`comm-${i}`}
                    initial={false}
                    animate={
                      commRevealed[i]
                        ? { y: [0, -10, 0], rotate: [0, i ? 2 : -2, 0] }
                        : { y: 0, rotate: 0 }
                    }
                    transition={{ duration: 0.5 }}
                  >
                    <PlayingCard
                      card={shown ? community[i] : null}
                      faceDown={!commRevealed[i]}
                      size="md"
                      highlight={
                        phase === "resolved" &&
                        !!resolution?.win &&
                        resolution.rank.category !== HandCategory.HighCard
                      }
                    />
                  </motion.div>
                );
              })}
            </div>
          </div>

          {/* PLAYER CARDS */}
          <div className="relative z-10 mb-2 flex flex-col items-center sm:mb-4 [@media(max-height:600px)]:mb-1">
            <div className={`flex gap-3 ${cardSizeClass}`}>
              {[0, 1, 2].map((i) => {
                const landed = dealt > i || phase === "resolved";
                return (
                  <motion.div
                    key={`p-${i}`}
                    initial={{ x: -180, y: -120, rotate: -25, opacity: 0 }}
                    animate={
                      landed
                        ? { x: 0, y: 0, rotate: 0, opacity: 1 }
                        : { x: -180, y: -120, rotate: -25, opacity: 0 }
                    }
                    transition={{ type: "spring", stiffness: 260, damping: 24 }}
                  >
                    <PlayingCard
                      card={landed ? player[i] : null}
                      faceDown={!landed}
                      size="md"
                      highlight={
                        phase === "resolved" &&
                        !!resolution?.win &&
                        resolution.rank.category !== HandCategory.HighCard
                      }
                    />
                  </motion.div>
                );
              })}
            </div>
            <div className="mt-1 text-[10px] font-semibold uppercase tracking-[0.3em] text-white/45">
              Your Hand
            </div>
          </div>

          {/* BET SPOTS */}
          <div className="relative z-10 mb-2 flex items-start justify-center gap-6 sm:gap-10">
            <BetSpot
              label="$"
              unit={unit}
              active={bets[2].active}
              glowing={false}
              result={
                phase === "resolved"
                  ? resolution?.win
                    ? "win"
                    : "lose"
                  : null
              }
            />
            <BetSpot
              label="2"
              unit={unit}
              active={bets[1].active}
              glowing={phase === "decision2"}
              result={
                phase === "resolved"
                  ? !bets[1].active
                    ? "pulled"
                    : resolution?.win
                      ? "win"
                      : "lose"
                  : null
              }
            />
            <BetSpot
              label="1"
              unit={unit}
              active={bets[0].active}
              glowing={phase === "decision1"}
              result={
                phase === "resolved"
                  ? !bets[0].active
                    ? "pulled"
                    : resolution?.win
                      ? "win"
                      : "lose"
                  : null
              }
            />
          </div>
          <div className="relative z-10 mb-3 text-center text-[10px] uppercase tracking-widest text-white/35">
            $ rides always · bet 2 · bet 1
          </div>

          {/* DECISION / RESULT BAR */}
          <div className="relative z-20 min-h-[88px] sm:min-h-[112px] [@media(max-height:600px)]:min-h-[72px]">
            <AnimatePresence mode="wait">
              {/* Decision 1 */}
              {phase === "decision1" && (
                <motion.div
                  key="d1"
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -8 }}
                  className="flex flex-col items-center gap-2"
                >
                  <div className="text-sm font-semibold text-white/80">
                    Decision 1 — pull back bet&nbsp;1 or let it ride?
                  </div>
                  <div className="flex gap-3">
                    <Button
                      variant="danger"
                      size="md"
                      data-testid="pullback-1"
                      onClick={() => decideBet1(false)}
                    >
                      ↩ Pull Back
                    </Button>
                    <Button
                      variant="gold"
                      size="md"
                      data-testid="play-btn"
                      onClick={() => decideBet1(true)}
                    >
                      ▶ Let It Ride
                    </Button>
                  </div>
                </motion.div>
              )}

              {/* Decision 2 */}
              {phase === "decision2" && (
                <motion.div
                  key="d2"
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -8 }}
                  className="flex flex-col items-center gap-2"
                >
                  <div className="text-sm font-semibold text-white/80">
                    Decision 2 — pull back bet&nbsp;2 or let it ride?
                  </div>
                  <div className="flex gap-3">
                    <Button
                      variant="danger"
                      size="md"
                      data-testid="pullback-2"
                      onClick={() => decideBet2(false)}
                    >
                      ↩ Pull Back
                    </Button>
                    <Button
                      variant="gold"
                      size="md"
                      data-testid="play-btn"
                      onClick={() => decideBet2(true)}
                    >
                      ▶ Let It Ride
                    </Button>
                  </div>
                </motion.div>
              )}

              {/* Dealing / revealing */}
              {(phase === "dealing" || phase === "reveal1" || phase === "reveal2") && (
                <motion.div
                  key="busy"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="grid place-items-center pt-4 text-sm font-semibold uppercase tracking-widest text-white/50"
                >
                  {phase === "dealing" ? "Dealing…" : "Revealing…"}
                </motion.div>
              )}

              {/* Resolved */}
              {phase === "resolved" && resolution && (
                <motion.div
                  key="res"
                  initial={{ opacity: 0, y: 14, scale: 0.96 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0 }}
                  className="relative flex flex-col items-center gap-1"
                  data-testid="round-result"
                >
                  {resolution.win && <WinBurst big={resolution.mult >= 50} />}
                  <div
                    className="font-display text-2xl font-bold tracking-wide sm:text-3xl"
                    style={{
                      color: resolution.win ? "#f5d060" : "#e88",
                      textShadow: resolution.win ? "0 0 22px rgba(245,208,96,0.6)" : "none",
                    }}
                  >
                    {resolution.win
                      ? `${resolution.rank.name}!`
                      : `${resolution.rank.name} — No Pay`}
                  </div>
                  <div className="flex items-center gap-3 text-sm">
                    <span className="text-white/60">
                      {resolution.remainingBets} bet
                      {resolution.remainingBets > 1 ? "s" : ""} in play
                      {winningRow ? ` @ ${winningRow.mult}:1` : ""}
                    </span>
                  </div>
                  <div
                    className="text-xl font-bold tabular-nums"
                    style={{
                      color:
                        resolution.net > 0
                          ? "#7CFFB2"
                          : resolution.net < 0
                            ? "#ff8585"
                            : "#fff",
                    }}
                  >
                    {formatDelta(resolution.net)} chips
                  </div>
                  <Button
                    variant="gold"
                    size="md"
                    className="mt-1"
                    data-testid="play-btn"
                    onClick={newRound}
                  >
                    Deal Again
                  </Button>
                </motion.div>
              )}

              {/* Betting prompt on the felt */}
              {phase === "betting" && (
                <motion.div
                  key="prompt"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="grid place-items-center pt-3 text-center text-sm text-white/55"
                >
                  Set your unit bet, then deal. Three equal bets ride —
                  <br className="hidden sm:block" /> pull back up to two as cards reveal.
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>

        {/* ----------------------- SIDE PANEL ----------------------- */}
        <div className="flex flex-col gap-3">
          {/* Paytable */}
          <CollapsiblePanel
            title="Paytable"
            accent={ACCENT}
            summary={<>per remaining bet</>}
          >
            <div className="mb-2 text-right text-[10px] text-white/40">per remaining bet</div>
            <ul className="space-y-0.5 text-[13px]">
              {PAYTABLE.map((r) => {
                const lit = winningRow?.cat === r.cat;
                return (
                  <motion.li
                    key={r.label}
                    animate={
                      lit
                        ? { backgroundColor: "rgba(245,208,96,0.18)" }
                        : { backgroundColor: "rgba(0,0,0,0)" }
                    }
                    className="flex items-center justify-between rounded-md px-2 py-1"
                  >
                    <span className={lit ? "font-semibold text-gold" : "text-white/75"}>
                      {r.label}
                    </span>
                    <span
                      className="font-bold tabular-nums"
                      style={{ color: lit ? "#f5d060" : ACCENT }}
                    >
                      {r.mult}:1
                    </span>
                  </motion.li>
                );
              })}
              <li className="flex items-center justify-between rounded-md px-2 py-1 text-white/35">
                <span>Less than a pair of 10s</span>
                <span className="font-bold">loss</span>
              </li>
            </ul>
          </CollapsiblePanel>

          {/* Round stats */}
          <CollapsiblePanel title="This Round" accent={ACCENT}>
            <div className="text-sm">
            <Row label="Unit bet" value={formatChips(unit)} />
            <Row label="Total wagered" value={formatChips(totalWager)} accent />
            {resolution && (
              <>
                <Row label="Refunded" value={formatChips(resolution.pulledBack)} />
                <Row
                  label="Returned"
                  value={formatChips(resolution.gross)}
                  good={resolution.gross > 0}
                />
              </>
            )}
            {lastDelta !== null && (
              <div className="mt-2 border-t border-white/10 pt-2">
                <div className="flex items-center justify-between">
                  <span className="text-white/50">Net</span>
                  <span
                    className="font-bold tabular-nums"
                    style={{ color: lastDelta >= 0 ? "#7CFFB2" : "#ff8585" }}
                  >
                    <Counter value={Math.abs(lastDelta)} />
                    <span className="ml-1">{lastDelta >= 0 ? "▲" : "▼"}</span>
                  </span>
                </div>
              </div>
            )}
            </div>
          </CollapsiblePanel>

          {/* Live hand readout */}
          <div className="glass rounded-2xl p-3 text-center">
            <div className="text-[10px] uppercase tracking-widest text-white/40">
              {phase === "resolved" ? "Final Hand" : "Hand"}
            </div>
            <div className="text-base font-semibold" style={{ color: ACCENT }}>
              {liveHand ? liveHand.name : inRound ? "…" : "—"}
            </div>
          </div>
        </div>
      </div>

      {/* ----------------------- BET CONTROLS ----------------------- */}
      <div className="mt-2 sm:mt-4">
        {phase === "betting" || phase === "resolved" ? (
          <div className="glass rounded-2xl p-3 sm:p-4">
            <div className="mb-3 flex flex-wrap items-center justify-center gap-2 sm:gap-3">
              {CHIPS.map((v) => {
                const wouldExceed = (unit + v) * 3 > balance;
                return (
                  <Chip
                    key={v}
                    value={v}
                    size={52}
                    selected={unit === v}
                    onClick={
                      inRound || wouldExceed
                        ? undefined
                        : () => {
                            sfx.chip();
                            setUnit((u) => Math.min(MAX_BET, u + v));
                          }
                    }
                  />
                );
              })}
            </div>
            <div className="flex flex-wrap items-center justify-center gap-2">
              <Button
                size="sm"
                variant="ghost"
                data-testid="bet-clear"
                disabled={inRound}
                onClick={() => {
                  sfx.click();
                  setUnit(MIN_BET);
                }}
              >
                Min
              </Button>
              <Button
                size="sm"
                variant="ghost"
                data-testid="bet-half"
                disabled={inRound}
                onClick={() => {
                  sfx.click();
                  setUnit((u) => Math.max(MIN_BET, Math.floor(u / 2)));
                }}
              >
                ½
              </Button>
              <Button
                size="sm"
                variant="ghost"
                data-testid="bet-double"
                disabled={inRound}
                onClick={() => {
                  sfx.click();
                  setUnit((u) => {
                    const doubled = u * 2;
                    return doubled * 3 <= balance ? Math.min(MAX_BET, doubled) : u;
                  });
                }}
              >
                2×
              </Button>
              <Button
                size="sm"
                variant="ghost"
                data-testid="bet-max"
                disabled={inRound}
                onClick={() => {
                  sfx.click();
                  setUnit(Math.max(MIN_BET, Math.min(MAX_BET, Math.floor(balance / 3))));
                }}
              >
                Max
              </Button>

              <div className="ml-1 min-w-[150px] rounded-xl border px-4 py-2 text-center"
                style={{ borderColor: ACCENT_SOFT, background: "rgba(0,0,0,0.4)" }}
              >
                <div className="text-[9px] uppercase tracking-widest text-white/40">
                  Unit × 3
                </div>
                <div className="text-lg font-bold tabular-nums" style={{ color: ACCENT }}>
                  {formatChips(unit)} × 3 = {formatChips(totalWager)}
                </div>
              </div>

              <Button
                size="lg"
                variant="gold"
                data-testid={phase === "betting" ? "play-btn" : "deal-btn"}
                disabled={inRound || unit < MIN_BET || !canAfford}
                onClick={startRound}
              >
                {canAfford ? "Deal" : "Insufficient Balance"}
              </Button>
            </div>
          </div>
        ) : (
          <div className="glass flex items-center justify-center rounded-2xl p-4 text-center text-sm text-white/50">
            Round in progress — betting locked. Make your Let It Ride / Pull Back calls above.
          </div>
        )}
      </div>
    </div>
  );
}

/* small helper row for the stats panel */
function Row({
  label,
  value,
  accent,
  good,
}: {
  label: string;
  value: string;
  accent?: boolean;
  good?: boolean;
}) {
  return (
    <div className="flex items-center justify-between py-0.5">
      <span className="text-white/50">{label}</span>
      <span
        className="font-semibold tabular-nums"
        style={{ color: good ? "#7CFFB2" : accent ? ACCENT : "rgba(255,255,255,0.85)" }}
      >
        {value}
      </span>
    </div>
  );
}
