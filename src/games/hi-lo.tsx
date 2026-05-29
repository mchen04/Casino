"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AnimatePresence,
  motion,
  useMotionValue,
  useTransform,
  animate,
  type Variants,
} from "framer-motion";
import { useWallet } from "@/lib/wallet";
import { type Card, makeShoe, rankValue, RANKS } from "@/lib/cards";
import { formatChips, formatMultiplier, formatDelta } from "@/lib/format";
import { sfx } from "@/lib/sound";
import { Button } from "@/components/ui/Button";
import { PlayingCard } from "@/components/PlayingCard";
import { BetControls } from "@/components/BetControls";
import { CollapsiblePanel } from "@/components/CollapsiblePanel";
import { Celebration } from "@/components/Celebration";

// ─────────────────────────────────────────────────────────────────────────────
// Hi-Lo — accent #00cec9. Predict whether the NEXT card is HIGHER (≥) or LOWER (<)
// than the current one. Ace is high. Build a streak of correct guesses, each one
// multiplying your running payout by fair odds (with a 3% house edge). Cash out
// anytime; one wrong guess ends the streak and loses the whole bet.
// ─────────────────────────────────────────────────────────────────────────────

const ACCENT = "#00cec9";
const HOUSE_EDGE = 0.03;
const RANK_COUNT = RANKS.length; // 13

type Phase = "betting" | "playing" | "revealing" | "busted" | "cashed";
type Guess = "higher" | "lower";

interface StreakEntry {
  card: Card;
  guess: Guess;
  stepMult: number; // multiplier applied for this correct guess
  id: string;
}

/**
 * Probability that the next card is HIGHER-OR-SAME / LOWER, using a rank-only
 * with-replacement model over the 13 ranks (Ace high). Returns 0 for impossible
 * outcomes so the matching button can be disabled.
 *
 * value v ∈ [2,14]:  P(≥ v) = (15 - v)/13   ·   P(< v) = (v - 2)/13
 */
function odds(current: Card): { pHigher: number; pLower: number } {
  const v = rankValue(current.rank);
  const pHigher = (15 - v) / RANK_COUNT; // higher OR same (tie favours "higher")
  const pLower = (v - 2) / RANK_COUNT; // strictly lower
  return { pHigher, pLower };
}

/** Fair multiplier step for a probability, with house edge baked in. */
function stepMultiplier(p: number): number {
  if (p <= 0) return 0;
  return (1 / p) * (1 - HOUSE_EDGE);
}

function pct(p: number): string {
  return `${(p * 100).toFixed(1)}%`;
}

// Resolve a guess against the revealed card. Tie counts as HIGHER.
function isWin(current: Card, next: Card, guess: Guess): boolean {
  const c = rankValue(current.rank);
  const n = rankValue(next.rank);
  if (guess === "higher") return n >= c; // higher or same
  return n < c; // strictly lower
}

// ─────────────────────────────────────────────────────────────────────────────
// Animated multiplier counter
// ─────────────────────────────────────────────────────────────────────────────
function MultiplierCounter({ value, big }: { value: number; big: boolean }) {
  const mv = useMotionValue(value);
  const text = useTransform(mv, (v) => formatMultiplier(v));
  useEffect(() => {
    const controls = animate(mv, value, { duration: 0.55, ease: "easeOut" });
    return () => controls.stop();
  }, [value, mv]);
  return (
    <motion.span
      className="tabular-nums font-display font-bold"
      style={{
        fontSize: big ? "clamp(2.4rem,9vw,4rem)" : "clamp(1.6rem,6vw,2.4rem)",
        color: ACCENT,
        textShadow: `0 0 14px ${ACCENT}aa, 0 0 38px ${ACCENT}55`,
      }}
    >
      {text}
    </motion.span>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Win burst — radial neon shards
// ─────────────────────────────────────────────────────────────────────────────
function WinBurst({ show, color }: { show: boolean; color: string }) {
  const shards = useMemo(
    () =>
      Array.from({ length: 14 }, (_, i) => ({
        a: (i / 14) * Math.PI * 2,
        d: 70 + (i % 3) * 26,
        delay: (i % 5) * 0.015,
      })),
    [],
  );
  return (
    <AnimatePresence>
      {show && (
        <div className="pointer-events-none absolute inset-0 z-30 grid place-items-center">
          {shards.map((s, i) => (
            <motion.span
              key={i}
              className="absolute rounded-full"
              style={{ width: 8, height: 8, background: color, boxShadow: `0 0 12px ${color}` }}
              initial={{ x: 0, y: 0, scale: 1, opacity: 1 }}
              animate={{
                x: Math.cos(s.a) * s.d,
                y: Math.sin(s.a) * s.d,
                scale: 0,
                opacity: 0,
              }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.7, delay: s.delay, ease: "easeOut" }}
            />
          ))}
          <motion.span
            className="absolute rounded-full"
            style={{ width: 40, height: 40, border: `3px solid ${color}` }}
            initial={{ scale: 0, opacity: 0.9 }}
            animate={{ scale: 5, opacity: 0 }}
            transition={{ duration: 0.6, ease: "easeOut" }}
          />
        </div>
      )}
    </AnimatePresence>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Floating chip-flight to the multiplier on a correct guess
// ─────────────────────────────────────────────────────────────────────────────
const cardSlide: Variants = {
  enter: { x: 120, y: -30, opacity: 0, rotateZ: 14, rotateY: 40, scale: 0.85 },
  center: {
    x: 0,
    y: 0,
    opacity: 1,
    rotateZ: 0,
    rotateY: 0,
    scale: 1,
    transition: { type: "spring", stiffness: 220, damping: 22 },
  },
  exit: {
    x: -150,
    y: 24,
    opacity: 0,
    rotateZ: -10,
    scale: 0.8,
    transition: { duration: 0.3, ease: "easeIn" },
  },
};

export default function HiLo() {
  const wallet = useWallet();
  const { balance, ready, bet: walletBet, win: walletWin } = wallet;

  const [bet, setBet] = useState(50);
  const [phase, setPhase] = useState<Phase>("betting");

  // Shoe + cards
  const shoeRef = useRef<Card[]>([]);
  const shoeIdxRef = useRef(0);
  const [current, setCurrent] = useState<Card | null>(null);
  const [nextCard, setNextCard] = useState<Card | null>(null);
  const [nextFaceDown, setNextFaceDown] = useState(true);

  // Streak / payout
  const [mult, setMult] = useState(1);
  const [streak, setStreak] = useState<StreakEntry[]>([]);
  const [lastGuess, setLastGuess] = useState<Guess | null>(null);
  const [lastWon, setLastWon] = useState<boolean | null>(null);

  // Result UI
  const [resultText, setResultText] = useState("");
  const [resultKind, setResultKind] = useState<"" | "win" | "lose" | "info">("");
  const [delta, setDelta] = useState<number | null>(null);
  const [burst, setBurst] = useState(false);
  // Banked cash-out result, used to drive the full-surface celebration overlay.
  const [cashOutResult, setCashOutResult] = useState<{ gross: number; mult: number } | null>(null);

  const stakeRef = useRef(0); // active bet locked for this round
  const timerRefs = useRef<number[]>([]); // cleanup on unmount
  const busy = phase === "revealing";

  // Clear all pending timers on unmount to prevent state updates after unmount.
  useEffect(() => {
    return () => {
      // eslint-disable-next-line react-hooks/exhaustive-deps
      timerRefs.current.forEach(clearTimeout);
    };
  }, []);

  // Draw a fresh card from the shoe, reshuffling when exhausted.
  const drawCard = useCallback((): Card => {
    if (shoeIdxRef.current >= shoeRef.current.length) {
      shoeRef.current = makeShoe(1);
      shoeIdxRef.current = 0;
    }
    const c = shoeRef.current[shoeIdxRef.current] as Card;
    shoeIdxRef.current += 1;
    return c;
  }, []);

  // Initialise a shoe + a base card on mount so the table never looks empty.
  useEffect(() => {
    shoeRef.current = makeShoe(1);
    shoeIdxRef.current = 0;
    setCurrent(shoeRef.current[shoeIdxRef.current++]);
  }, []);

  const liveOdds = useMemo(() => (current ? odds(current) : { pHigher: 0, pLower: 0 }), [current]);
  const higherStep = stepMultiplier(liveOdds.pHigher);
  const lowerStep = stepMultiplier(liveOdds.pLower);

  const potentialWin = stakeRef.current > 0 ? Math.floor(stakeRef.current * mult) : 0;
  const canAfford = bet > 0 && bet <= balance;

  // ── Start a round ─────────────────────────────────────────────────────────
  const startRound = useCallback(() => {
    if (phase !== "betting" && phase !== "busted" && phase !== "cashed") return;
    if (bet <= 0 || bet > balance) return;
    if (!walletBet(bet)) return; // unaffordable → abort

    sfx.chip();
    stakeRef.current = bet;
    setMult(1);
    setStreak([]);
    setLastGuess(null);
    setLastWon(null);
    setResultText("");
    setResultKind("");
    setDelta(null);
    setBurst(false);
    setCashOutResult(null);
    setNextCard(null);
    setNextFaceDown(true);

    // Fresh base card for the streak.
    const base = drawCard();
    setCurrent(base);
    sfx.card();
    setPhase("playing");
  }, [phase, bet, balance, walletBet, drawCard]);

  // ── Make a guess ─────────────────────────────────────────────────────────
  const guess = useCallback(
    (g: Guess) => {
      if (phase !== "playing" || !current) return;
      const p = g === "higher" ? liveOdds.pHigher : liveOdds.pLower;
      if (p <= 0) return; // impossible outcome — guard

      const drawn = drawCard();
      const won = isWin(current, drawn, g);
      const step = g === "higher" ? higherStep : lowerStep;

      setLastGuess(g);
      setLastWon(null);
      setNextCard(drawn);
      setNextFaceDown(true);
      setPhase("revealing");
      sfx.card();

      // Reveal after the card slides in.
      const t1 = window.setTimeout(() => {
        setNextFaceDown(false);
        sfx.tick();

        const t2 = window.setTimeout(() => {
          setLastWon(won);
          if (won) {
            const newMult = mult * step;
            setMult(newMult);
            setStreak((s) => [
              ...s,
              { card: current, guess: g, stepMult: step, id: `${current.id}-${s.length}` },
            ]);
            setBurst(true);
            const t3 = window.setTimeout(() => setBurst(false), 720);
            timerRefs.current.push(t3);
            sfx.win();
            // The drawn card becomes the new base card.
            setCurrent(drawn);
            setNextCard(null);
            setNextFaceDown(true);
            setPhase("playing");
          } else {
            // Loss — whole bet gone, streak over.
            sfx.lose();
            setResultText(
              streak.length > 0
                ? `Busted on a ${streak.length}-card streak`
                : "Busted! Better luck next deal",
            );
            setResultKind("lose");
            setDelta(-stakeRef.current);
            setCurrent(drawn);
            setPhase("busted");
            stakeRef.current = 0;
          }
        }, 430);
        timerRefs.current.push(t2);
      }, 360);
      timerRefs.current.push(t1);
    },
    [phase, current, liveOdds, higherStep, lowerStep, drawCard, mult, streak.length],
  );

  // ── Cash out ───────────────────────────────────────────────────────────────
  const cashOut = useCallback(() => {
    if (phase !== "playing" || streak.length === 0) return;
    const stake = stakeRef.current;
    const gross = Math.floor(stake * mult);
    walletWin(gross);
    const profit = gross - stake;
    sfx.jackpot();
    setBurst(true);
    const t = window.setTimeout(() => setBurst(false), 720);
    timerRefs.current.push(t);
    setResultText(`Cashed out ${formatMultiplier(mult)} → ${formatChips(gross)}`);
    setResultKind("win");
    setDelta(profit);
    if (profit > 0) setCashOutResult({ gross, mult });
    stakeRef.current = 0;
    setPhase("cashed");
  }, [phase, streak.length, mult, walletWin]);

  // ── New deal (reset to betting) ──────────────────────────────────────────
  const newDeal = useCallback(() => {
    sfx.click();
    setPhase("betting");
    setMult(1);
    setStreak([]);
    setLastGuess(null);
    setLastWon(null);
    setResultText("");
    setResultKind("");
    setDelta(null);
    setCashOutResult(null);
    setNextCard(null);
    setNextFaceDown(true);
    // Show a fresh teaser card.
    setCurrent(drawCard());
  }, [drawCard]);

  const playing = phase === "playing";
  const resolved = phase === "busted" || phase === "cashed";

  // Auto-cap the bet to the balance so a stale value never exceeds funds.
  useEffect(() => {
    if (phase === "betting" && bet > balance) setBet(Math.max(0, balance));
  }, [phase, balance, bet]);

  const higherDisabled = !playing || busy || liveOdds.pHigher <= 0;
  const lowerDisabled = !playing || busy || liveOdds.pLower <= 0;

  return (
    <div className="mx-auto w-full max-w-3xl">
      {/* ── Table surface ─────────────────────────────────────────────────── */}
      <div
        className="felt relative overflow-hidden rounded-3xl p-5 sm:p-8 [@media(max-height:600px)]:p-3"
        style={{ boxShadow: `0 0 0 1px ${ACCENT}33, 0 24px 70px rgba(0,0,0,0.6)` }}
      >
        {/* accent ambient glow */}
        <div
          className="pointer-events-none absolute -top-24 left-1/2 h-64 w-64 -translate-x-1/2 rounded-full blur-3xl"
          style={{ background: `${ACCENT}22` }}
        />

        {/* Cash-out win celebration — confetti + coin fountain over the table. */}
        <Celebration
          show={phase === "cashed" && cashOutResult !== null}
          seed={cashOutResult?.gross ?? 0}
          tier={
            (cashOutResult?.mult ?? 0) >= 10
              ? "jackpot"
              : (cashOutResult?.mult ?? 0) >= 3
                ? "big"
                : "win"
          }
          colors={["#00cec9", "#ffd24a", "#22e1ff", "#ffffff"]}
        />

        {/* Header: title + live multiplier */}
        <div className="relative z-10 flex items-start justify-between gap-3">
          <div>
            <h2 className="font-display text-2xl font-bold tracking-wide text-white sm:text-3xl">
              Hi<span style={{ color: ACCENT }}>-</span>Lo
            </h2>
            <p className="mt-0.5 text-xs text-white/45">
              Predict the next card · Ace high · ties pay <span style={{ color: ACCENT }}>Higher</span>
            </p>
          </div>
          <div className="text-right">
            <div className="text-[10px] uppercase tracking-[0.25em] text-white/40">
              {resolved ? "Multiplier" : "Streak Multiplier"}
            </div>
            <MultiplierCounter value={mult} big={playing && streak.length > 0} />
            {stakeRef.current > 0 && (
              <div className="mt-0.5 text-xs text-white/55">
                Cash value{" "}
                <span className="font-semibold" style={{ color: ACCENT }}>
                  {formatChips(potentialWin)}
                </span>
              </div>
            )}
          </div>
        </div>

        {/* Streak rail */}
        <div className="relative z-10 mt-4 [@media(max-height:600px)]:mt-2 flex min-h-[16px] flex-wrap items-center gap-1.5">
          <AnimatePresence initial={false}>
            {streak.map((e) => (
              <motion.span
                key={e.id}
                initial={{ scale: 0, opacity: 0, y: 6 }}
                animate={{ scale: 1, opacity: 1, y: 0 }}
                exit={{ scale: 0, opacity: 0 }}
                className="grid h-6 w-6 place-items-center rounded-md text-[10px] font-bold"
                style={{
                  background: `${ACCENT}22`,
                  border: `1px solid ${ACCENT}55`,
                  color: ACCENT,
                }}
                title={`${e.guess} → ${formatMultiplier(e.stepMult)}`}
              >
                {e.guess === "higher" ? "▲" : "▼"}
              </motion.span>
            ))}
          </AnimatePresence>
          {streak.length > 0 && (
            <span className="ml-1 text-[10px] uppercase tracking-widest text-white/35">
              {streak.length} correct
            </span>
          )}
        </div>

        {/* ── Card arena ──────────────────────────────────────────────────── */}
        <div className="relative z-10 mt-3 grid place-items-center rounded-2xl bg-black/25 px-4 py-7 [@media(max-height:600px)]:py-2 [@media(max-height:600px)]:max-h-[140px]">
          <WinBurst show={burst} color={resultKind === "lose" ? "#ff5b6e" : ACCENT} />

          <div className="flex items-center justify-center gap-6 sm:gap-10">
            {/* Current / base card */}
            <div className="flex flex-col items-center gap-2">
              <span className="text-[10px] uppercase tracking-[0.25em] text-white/40">
                {playing || resolved ? "Current" : "Up Next"}
              </span>
              <motion.div
                key={current?.id ?? "empty"}
                initial={{ scale: 0.92, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={{ type: "spring", stiffness: 260, damping: 20 }}
              >
                <PlayingCard card={current} size="lg" highlight={playing} />
              </motion.div>
              {current && (
                <span className="text-xs font-semibold text-white/60">
                  rank {rankValue(current.rank)}
                </span>
              )}
            </div>

            {/* vs divider */}
            <motion.div
              className="font-display text-2xl font-bold text-white/30"
              animate={{ opacity: [0.3, 0.7, 0.3] }}
              transition={{ duration: 2.2, repeat: Infinity }}
            >
              vs
            </motion.div>

            {/* Next card slot */}
            <div className="flex flex-col items-center gap-2">
              <span className="text-[10px] uppercase tracking-[0.25em] text-white/40">Next</span>
              <div className="relative grid h-[123px] w-[88px] place-items-center">
                <AnimatePresence mode="wait">
                  {nextCard ? (
                    <motion.div
                      key={nextCard.id}
                      variants={cardSlide}
                      initial="enter"
                      animate="center"
                      exit="exit"
                      style={{ perspective: 800 }}
                    >
                      <PlayingCard
                        card={nextCard}
                        faceDown={nextFaceDown}
                        size="lg"
                        highlight={lastWon === true}
                      />
                    </motion.div>
                  ) : (
                    <motion.div
                      key="placeholder"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      className="grid h-[123px] w-[88px] place-items-center rounded-[11px] border border-dashed text-3xl"
                      style={{ borderColor: `${ACCENT}44`, color: `${ACCENT}66` }}
                    >
                      ?
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
              {lastGuess && (
                <span className="text-xs font-semibold text-white/60">
                  guessed {lastGuess === "higher" ? "Higher ▲" : "Lower ▼"}
                </span>
              )}
            </div>
          </div>
        </div>

        {/* ── Result banner ───────────────────────────────────────────────── */}
        <div className="relative z-10 mt-3 min-h-[34px]">
          <AnimatePresence mode="wait">
            {resultText && (
              <motion.div
                key={resultText}
                data-testid="round-result"
                initial={{ y: 10, opacity: 0, scale: 0.96 }}
                animate={{ y: 0, opacity: 1, scale: 1 }}
                exit={{ y: -10, opacity: 0 }}
                className="flex items-center justify-center gap-3 rounded-xl px-4 py-2 text-center"
                style={{
                  background:
                    resultKind === "win"
                      ? `${ACCENT}1f`
                      : resultKind === "lose"
                        ? "rgba(255,91,110,0.14)"
                        : "rgba(255,255,255,0.06)",
                  border:
                    resultKind === "win"
                      ? `1px solid ${ACCENT}66`
                      : resultKind === "lose"
                        ? "1px solid rgba(255,91,110,0.5)"
                        : "1px solid rgba(255,255,255,0.12)",
                }}
              >
                <span
                  className="font-display text-base font-bold sm:text-lg"
                  style={{ color: resultKind === "lose" ? "#ff8a97" : ACCENT }}
                >
                  {resultText}
                </span>
                {delta !== null && (
                  <span
                    className="text-sm font-bold tabular-nums"
                    style={{ color: delta >= 0 ? ACCENT : "#ff8a97" }}
                  >
                    {formatDelta(delta)}
                  </span>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* ── Action area ─────────────────────────────────────────────────── */}
        <div className="relative z-10 mt-4">
          {playing ? (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <GuessButton
                testId="higher-btn"
                label="Higher"
                arrow="▲"
                pctText={pct(liveOdds.pHigher)}
                multText={formatMultiplier(higherStep)}
                onClick={() => guess("higher")}
                disabled={higherDisabled}
                tie
              />
              <GuessButton
                testId="lower-btn"
                label="Lower"
                arrow="▼"
                pctText={pct(liveOdds.pLower)}
                multText={liveOdds.pLower > 0 ? formatMultiplier(lowerStep) : "—"}
                onClick={() => guess("lower")}
                disabled={lowerDisabled}
              />
              <div className="col-span-2 sm:col-span-1">
                <motion.button
                  type="button"
                  data-testid="cashout-btn"
                  onClick={cashOut}
                  disabled={busy || streak.length === 0}
                  whileHover={streak.length > 0 && !busy ? { y: -2 } : undefined}
                  whileTap={streak.length > 0 && !busy ? { scale: 0.96 } : undefined}
                  className="relative grid h-full w-full place-items-center rounded-xl px-4 py-3 font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  style={{
                    background: "linear-gradient(180deg,#f5d060,#9a7d1e)",
                    color: "#1a1300",
                    boxShadow:
                      streak.length > 0 && !busy
                        ? "0 0 0 1px rgba(245,208,96,0.5), 0 10px 26px rgba(245,208,96,0.25)"
                        : "none",
                  }}
                >
                  <span className="text-sm uppercase tracking-widest">Cash Out</span>
                  <span className="mt-0.5 text-lg font-bold tabular-nums">
                    {formatChips(potentialWin)}
                  </span>
                </motion.button>
              </div>
            </div>
          ) : resolved ? (
            <div className="flex flex-col items-center gap-3">
              <Button
                data-testid="new-deal-btn"
                variant="neon"
                size="lg"
                block
                onClick={newDeal}
              >
                New Deal
              </Button>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <BetControls
                bet={bet}
                setBet={setBet}
                balance={balance}
                min={1}
                chips={[5, 25, 100, 500, 1000]}
                disabled={!ready}
              />
              <Button
                data-testid="play-btn"
                variant="neon"
                size="lg"
                block
                disabled={!ready || !canAfford}
                onClick={startRound}
              >
                {canAfford ? `Deal · ${formatChips(bet)}` : "Insufficient chips"}
              </Button>
            </div>
          )}
        </div>

        {/* ── Odds / paytable panel ───────────────────────────────────────── */}
        <div className="relative z-10 mt-5 [@media(max-height:600px)]:mt-2">
          <CollapsiblePanel
            title="Odds & Rules"
            accent={ACCENT}
            summary={<>house edge {(HOUSE_EDGE * 100).toFixed(0)}%</>}
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-[10px] uppercase tracking-[0.25em] text-white/45">
                    Live Odds
                  </span>
                  <span className="text-[10px] text-white/30">house edge {(HOUSE_EDGE * 100).toFixed(0)}%</span>
                </div>
                {current ? (
                  <div className="grid grid-cols-2 gap-2 text-center text-xs">
                    <OddsTile
                      label="Higher ≥"
                      pctText={pct(liveOdds.pHigher)}
                      multText={liveOdds.pHigher > 0 ? formatMultiplier(higherStep) : "—"}
                    />
                    <OddsTile
                      label="Lower <"
                      pctText={pct(liveOdds.pLower)}
                      multText={liveOdds.pLower > 0 ? formatMultiplier(lowerStep) : "—"}
                    />
                  </div>
                ) : (
                  <div className="text-xs text-white/40">Deal to see odds…</div>
                )}
              </div>

              <div className="text-xs leading-relaxed text-white/55">
                <span className="text-[10px] uppercase tracking-[0.25em] text-white/45">
                  How it pays
                </span>
                <ul className="mt-2 space-y-1">
                  <li>
                    <span style={{ color: ACCENT }}>Higher</span> wins on a higher{" "}
                    <em>or equal</em> rank. <span style={{ color: ACCENT }}>Lower</span> needs strictly
                    lower.
                  </li>
                  <li>Each correct guess multiplies your stake by its fair-odds step.</li>
                  <li>
                    <span style={{ color: ACCENT }}>Cash out</span> anytime to bank the running
                    multiplier. One miss loses the bet.
                  </li>
                </ul>
              </div>
            </div>
          </CollapsiblePanel>
        </div>

        {/* Footer status */}
        <div className="relative z-10 mt-4 [@media(max-height:600px)]:mt-2 flex items-center justify-between text-xs text-white/45">
          <span>
            Balance{" "}
            <span className="font-semibold text-white/80">{ready ? formatChips(balance) : "…"}</span>
          </span>
          <span>
            {playing
              ? `Stake ${formatChips(stakeRef.current)} · streak ${streak.length}`
              : "Set your bet and deal"}
          </span>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────────────
function GuessButton({
  testId,
  label,
  arrow,
  pctText,
  multText,
  onClick,
  disabled,
  tie,
}: {
  testId: string;
  label: string;
  arrow: string;
  pctText: string;
  multText: string;
  onClick: () => void;
  disabled: boolean;
  tie?: boolean;
}) {
  return (
    <motion.button
      type="button"
      data-testid={testId}
      onClick={onClick}
      disabled={disabled}
      whileHover={disabled ? undefined : { y: -2, scale: 1.02 }}
      whileTap={disabled ? undefined : { scale: 0.96 }}
      className="relative flex flex-col items-center justify-center gap-0.5 overflow-hidden rounded-xl px-4 py-3 font-semibold disabled:opacity-35 disabled:cursor-not-allowed"
      style={{
        background: `linear-gradient(180deg, ${ACCENT}26, ${ACCENT}10)`,
        border: `1px solid ${ACCENT}66`,
        color: "#eafffd",
        boxShadow: disabled ? "none" : `0 0 0 1px ${ACCENT}22, 0 8px 22px ${ACCENT}1f`,
      }}
    >
      <span className="flex items-center gap-1.5 text-base">
        <span style={{ color: ACCENT }}>{arrow}</span>
        {label}
      </span>
      <span className="flex items-center gap-2 text-[11px] text-white/60">
        <span>{pctText}</span>
        <span className="opacity-40">·</span>
        <span className="font-bold" style={{ color: ACCENT }}>
          {multText}
        </span>
      </span>
      {tie && <span className="text-[9px] uppercase tracking-widest text-white/35">ties win</span>}
    </motion.button>
  );
}

function OddsTile({
  label,
  pctText,
  multText,
}: {
  label: string;
  pctText: string;
  multText: string;
}) {
  return (
    <div className="rounded-lg bg-black/25 px-2 py-2">
      <div className="text-[10px] uppercase tracking-widest text-white/45">{label}</div>
      <div className="mt-0.5 text-sm font-bold text-white/85 tabular-nums">{pctText}</div>
      <div className="text-[11px] font-semibold tabular-nums" style={{ color: ACCENT }}>
        {multText}
      </div>
    </div>
  );
}
