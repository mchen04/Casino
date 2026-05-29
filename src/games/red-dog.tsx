"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useWallet } from "@/lib/wallet";
import { makeShoe, rankValue, type Card } from "@/lib/cards";
import { formatChips, formatDelta } from "@/lib/format";
import { sfx } from "@/lib/sound";
import { Button } from "@/components/ui/Button";
import { Chip } from "@/components/ui/Chip";
import { PlayingCard } from "@/components/PlayingCard";
import { CollapsiblePanel } from "@/components/CollapsiblePanel";
import { Celebration } from "@/components/Celebration";

const ACCENT = "#d35400";
const ACCENT_LIGHT = "#ff8c42";
const ACCENT_DARK = "#9c3a00";

// ---------------------------------------------------------------------------
// Game model
// ---------------------------------------------------------------------------

type Phase =
  | "betting" // place ante, deal disabled until valid
  | "dealing" // first two cards sliding in
  | "decision" // spread shown, player may raise or call
  | "thirdDeal" // third card sliding in between
  | "resolved"; // outcome shown

type Outcome =
  | "push" // consecutive, or pair-no-trips
  | "win" // third card fell between
  | "trips" // pair -> three of a kind 11:1
  | "lose"; // third card outside

interface SpreadTier {
  spread: number; // exact spread; 4 means "4 or more"
  ratio: number; // payout-to-1 (profit per unit on total wager)
  label: string;
}

// spread -> payout-to-1 on the TOTAL wager (ante + raise).
const SPREAD_TIERS: SpreadTier[] = [
  { spread: 1, ratio: 5, label: "1" },
  { spread: 2, ratio: 4, label: "2" },
  { spread: 3, ratio: 2, label: "3" },
  { spread: 4, ratio: 1, label: "4+" },
];

function ratioForSpread(spread: number): number {
  if (spread <= 0) return 0;
  if (spread === 1) return 5;
  if (spread === 2) return 4;
  if (spread === 3) return 2;
  return 1; // 4 or more
}

const DEFAULT_CHIPS = [5, 25, 100, 500];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function RedDog() {
  const wallet = useWallet();

  const [ante, setAnte] = useState(25);
  const [phase, setPhase] = useState<Phase>("betting");

  // Dealt cards. low/high are the two flanking cards (sorted by rank),
  // third is the middle card.
  const [left, setLeft] = useState<Card | null>(null);
  const [right, setRight] = useState<Card | null>(null);
  const [middle, setMiddle] = useState<Card | null>(null);

  const [leftDown, setLeftDown] = useState(true);
  const [rightDown, setRightDown] = useState(true);
  const [middleDown, setMiddleDown] = useState(true);
  const [showMiddle, setShowMiddle] = useState(false);

  const [spread, setSpread] = useState(0); // 0 = pair or consecutive
  const [raised, setRaised] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [payout, setPayout] = useState(0); // gross returned this round
  const [delta, setDelta] = useState(0); // net result vs total staked
  const [resultText, setResultText] = useState("");
  const [winningTier, setWinningTier] = useState<number | null>(null);

  const shoeRef = useRef<Card[]>([]);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  // Guard against rapid double-clicks before the phase state update commits.
  const dealing = useRef(false);

  const after = useCallback((ms: number, fn: () => void) => {
    const t = setTimeout(fn, ms);
    timers.current.push(t);
  }, []);

  useEffect(() => {
    return () => {
      timers.current.forEach(clearTimeout);
    };
  }, []);

  const inRound = phase !== "betting" && phase !== "resolved";
  const totalWager = ante + (raised ? ante : 0);
  const sorted = useMemo(() => {
    if (!left || !right) return null;
    const a = rankValue(left.rank);
    const b = rankValue(right.rank);
    return { low: Math.min(a, b), high: Math.max(a, b) };
  }, [left, right]);

  const drawCard = useCallback((): Card => {
    if (shoeRef.current.length < 5) shoeRef.current = makeShoe(1);
    const c = shoeRef.current.pop();
    // makeShoe(1) always yields 52 cards; fallback keeps types honest.
    if (!c) {
      shoeRef.current = makeShoe(1);
      return shoeRef.current.pop() as Card;
    }
    return c;
  }, []);

  // -------------------------------------------------------------------------
  // Round flow
  // -------------------------------------------------------------------------

  const resolveBetween = useCallback(
    (third: Card, sp: number, total: number) => {
      const lo = sorted ? sorted.low : 0;
      const hi = sorted ? sorted.high : 0;
      const mid = rankValue(third.rank);
      const between = mid > lo && mid < hi;
      if (between) {
        const ratio = ratioForSpread(sp);
        const gross = total * (ratio + 1); // includes the stake
        wallet.win(gross);
        setPayout(gross);
        setDelta(gross - total);
        setOutcome("win");
        setResultText(`Between! ${ratio}:1 — Win ${formatChips(gross - total)}`);
        const tierIdx = SPREAD_TIERS.findIndex((t) =>
          t.spread === 4 ? sp >= 4 : t.spread === sp,
        );
        setWinningTier(tierIdx);
        if (gross - total >= total * 4) sfx.jackpot();
        else sfx.win();
      } else {
        setPayout(0);
        setDelta(-total);
        setOutcome("lose");
        setResultText(`Missed — ${third.rank} not between. Lost ${formatChips(total)}`);
        sfx.lose();
      }
      dealing.current = false;
      setPhase("resolved");
    },
    [sorted, wallet],
  );

  // Deal the third card for the between-case (after raise decision).
  const dealThird = useCallback(
    (total: number) => {
      setPhase("thirdDeal");
      const third = drawCard();
      setMiddle(third);
      setMiddleDown(true);
      setShowMiddle(true);
      sfx.card();
      after(520, () => {
        setMiddleDown(false);
        sfx.card();
      });
      after(1180, () => {
        resolveBetween(third, spread, total);
      });
    },
    [after, drawCard, resolveBetween, spread],
  );

  const handleRaise = useCallback(() => {
    if (phase !== "decision") return;
    if (dealing.current) return; // guard rapid double-clicks
    // Player doubles the ante: place an equal additional wager.
    if (!wallet.bet(ante)) return; // can't afford raise -> ignore
    dealing.current = true;
    sfx.chip();
    setRaised(true);
    dealThird(ante * 2);
  }, [ante, dealThird, phase, wallet]);

  const handleCall = useCallback(() => {
    if (phase !== "decision") return;
    if (dealing.current) return; // guard rapid double-clicks
    dealing.current = true;
    sfx.click();
    dealThird(ante);
  }, [ante, dealThird, phase]);

  // Pair branch: deal third immediately, check for trips (11:1) else push.
  // leftCard is passed explicitly to avoid reading stale `left` state from the closure.
  const resolvePair = useCallback((leftCard: Card) => {
    setPhase("thirdDeal");
    const third = drawCard();
    setMiddle(third);
    setMiddleDown(true);
    setShowMiddle(true);
    sfx.card();
    after(520, () => {
      setMiddleDown(false);
      sfx.card();
    });
    after(1180, () => {
      const pairRank = rankValue(leftCard.rank);
      const isTrips = rankValue(third.rank) === pairRank;
      if (isTrips) {
        const gross = ante * 12; // 11:1 on the ante (11 profit + stake)
        wallet.win(gross);
        setPayout(gross);
        setDelta(gross - ante);
        setOutcome("trips");
        setResultText(`Three of a Kind! 11:1 — Win ${formatChips(gross - ante)}`);
        sfx.jackpot();
      } else {
        wallet.win(ante); // push, ante returned
        setPayout(ante);
        setDelta(0);
        setOutcome("push");
        setResultText("Pair — no trips. Push, ante returned.");
        sfx.thud();
      }
      dealing.current = false;
      setPhase("resolved");
    });
  }, [after, ante, drawCard, wallet]);

  const deal = useCallback(() => {
    if (phase !== "betting" && phase !== "resolved") return;
    if (dealing.current) return; // guard rapid double-clicks
    if (ante <= 0 || ante > wallet.balance) return;
    if (!wallet.bet(ante)) return; // unaffordable -> abort round
    dealing.current = true;

    // Reset table
    timers.current.forEach(clearTimeout);
    timers.current = [];
    setOutcome(null);
    setResultText("");
    setPayout(0);
    setDelta(0);
    setRaised(false);
    setSpread(0);
    setWinningTier(null);
    setMiddle(null);
    setMiddleDown(true);
    setShowMiddle(false);

    if (shoeRef.current.length < 10) shoeRef.current = makeShoe(1);

    const c1 = drawCard();
    const c2 = drawCard();
    setLeft(c1);
    setRight(c2);
    setLeftDown(true);
    setRightDown(true);
    setPhase("dealing");
    sfx.card();

    after(360, () => sfx.card());
    after(560, () => {
      setLeftDown(false);
      sfx.card();
    });
    after(900, () => {
      setRightDown(false);
      sfx.card();
    });

    // After both flips, evaluate the matchup.
    after(1550, () => {
      const a = rankValue(c1.rank);
      const b = rankValue(c2.rank);
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      const diff = hi - lo;

      if (diff === 0) {
        // Pair -> deal a third card. Pass c1 directly to avoid stale `left` state.
        sfx.tick();
        resolvePair(c1);
      } else if (diff === 1) {
        // Consecutive -> immediate push.
        wallet.win(ante);
        setPayout(ante);
        setDelta(0);
        setOutcome("push");
        setResultText("Consecutive cards — Push, ante returned.");
        sfx.thud();
        dealing.current = false;
        setPhase("resolved");
      } else {
        const sp = diff - 1;
        setSpread(sp);
        dealing.current = false;
        setPhase("decision");
        sfx.tick();
      }
    });
  }, [after, ante, drawCard, phase, resolvePair, wallet]);

  // -------------------------------------------------------------------------
  // Derived display values
  // -------------------------------------------------------------------------

  const canAffordRaise = wallet.ready ? wallet.balance >= ante : false;
  const betDisabled = inRound;
  const dealDisabled =
    inRound || ante <= 0 || (wallet.ready && ante > wallet.balance);

  const setBetSafe = useCallback(
    (n: number) => {
      const max = wallet.ready ? wallet.balance : n;
      setAnte(Math.max(0, Math.min(Math.floor(n), Math.max(0, max))));
    },
    [wallet.balance, wallet.ready],
  );

  const addChip = useCallback(
    (v: number) => {
      if (betDisabled) return;
      sfx.chip();
      setBetSafe(ante + v);
    },
    [ante, betDisabled, setBetSafe],
  );

  const potentialWin = useMemo(() => {
    if (phase !== "decision") return null;
    const ratio = ratioForSpread(spread);
    const stay = ante * (ratio + 1) - ante;
    const dbl = ante * 2 * (ratio + 1) - ante * 2;
    return { ratio, stay, dbl };
  }, [ante, phase, spread]);

  const outcomeColor =
    outcome === "win" || outcome === "trips"
      ? ACCENT_LIGHT
      : outcome === "lose"
        ? "#ef4444"
        : outcome === "push"
          ? "#cbd5e1"
          : "#ffffff";

  // Fire confetti only on a notable win: trips (11:1) always, or a between-win
  // paying >= ~4:1 (i.e. net profit >= ~4x the total wager). Skips push/lose
  // and the slim 2:1 / 1:1 spread payouts.
  const celebrate =
    outcome === "trips" || (outcome === "win" && delta >= totalWager * 4);
  const celebrateTier: "win" | "big" | "jackpot" =
    outcome === "trips" ? "jackpot" : delta >= totalWager * 5 ? "big" : "win";

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-2 sm:gap-4">
      {/* Title strip */}
      <div
        className="glass flex items-center justify-between gap-3 rounded-2xl px-4 py-3"
        style={{ borderColor: `${ACCENT}55` }}
      >
        <div className="flex items-center gap-3">
          <span
            className="grid h-10 w-10 place-items-center rounded-xl text-2xl"
            style={{
              background: `linear-gradient(135deg, ${ACCENT_LIGHT}, ${ACCENT_DARK})`,
              boxShadow: `0 0 18px ${ACCENT}66`,
            }}
          >
            🐕
          </span>
          <div>
            <div
              className="font-display text-lg font-bold leading-none"
              style={{ color: ACCENT_LIGHT }}
            >
              Red Dog
            </div>
            <div className="text-[11px] text-white/45">Acey-Deucey · single deck</div>
          </div>
        </div>
        <Stat label="Wager" value={inRound || outcome ? formatChips(totalWager) : formatChips(ante)} />
      </div>

      {/* Felt surface */}
      <div
        className="felt relative overflow-hidden rounded-3xl p-4 sm:p-8 [@media(max-height:600px)]:p-3"
        style={{ boxShadow: `inset 0 0 120px ${ACCENT_DARK}33` }}
      >
        <RadialGlow />

        <Celebration
          show={celebrate}
          seed={payout}
          tier={celebrateTier}
          colors={["#d35400", "#ffd24a", "#22e1ff", "#ffffff"]}
        />

        {/* Spread meter */}
        <SpreadMeter phase={phase} spread={spread} sorted={sorted} accent={ACCENT_LIGHT} />

        {/* Card table */}
        <div className="relative mt-2 grid min-h-[140px] place-items-center sm:min-h-[210px] [@media(max-height:600px)]:min-h-[120px]">
          <div className="relative flex items-center justify-center gap-5 sm:gap-12">
            {/* Left card */}
            <DealtCard
              card={left}
              faceDown={leftDown}
              from={-180}
              label="LOW"
              show={!!left}
              accent={ACCENT_LIGHT}
            />

            {/* Middle slot — third card slides DOWN into the gap */}
            <div className="relative grid place-items-center" style={{ width: 96 }}>
              <AnimatePresence>
                {showMiddle ? (
                  <motion.div
                    key="middle"
                    initial={{ y: -150, opacity: 0, scale: 0.6, rotate: -8 }}
                    animate={{ y: 0, opacity: 1, scale: 1, rotate: 0 }}
                    exit={{ opacity: 0, scale: 0.6 }}
                    transition={{ type: "spring", stiffness: 220, damping: 20 }}
                    className="relative z-20"
                  >
                    <PlayingCard
                      card={middle}
                      faceDown={middleDown}
                      size="md"
                      highlight={outcome === "win" || outcome === "trips"}
                    />
                  </motion.div>
                ) : (
                  <motion.div
                    key="slot"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: phase === "decision" ? 1 : 0.35 }}
                    className="grid h-[92px] w-[66px] place-items-center rounded-lg border-2 border-dashed text-2xl"
                    style={{ borderColor: `${ACCENT_LIGHT}66`, color: `${ACCENT_LIGHT}88` }}
                  >
                    {phase === "decision" ? "?" : ""}
                  </motion.div>
                )}
              </AnimatePresence>
              {/* connector arrow when awaiting decision */}
              {phase === "decision" && (
                <motion.div
                  initial={{ opacity: 0, y: -6 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="absolute -bottom-7 text-[10px] uppercase tracking-widest"
                  style={{ color: ACCENT_LIGHT }}
                >
                  fills here
                </motion.div>
              )}
            </div>

            {/* Right card */}
            <DealtCard
              card={right}
              faceDown={rightDown}
              from={180}
              label="HIGH"
              show={!!right}
              accent={ACCENT_LIGHT}
            />
          </div>

          {/* Idle prompt */}
          {phase === "betting" && !left && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="absolute text-center text-white/40"
            >
              <div className="text-sm">Place your ante and deal.</div>
            </motion.div>
          )}
        </div>

        {/* Result banner */}
        <div className="mt-3 grid min-h-[40px] place-items-center sm:min-h-[56px] [@media(max-height:600px)]:mt-2 [@media(max-height:600px)]:min-h-[32px]">
          <AnimatePresence mode="wait">
            {outcome && (
              <motion.div
                key={outcome + resultText}
                data-testid="round-result"
                initial={{ opacity: 0, scale: 0.7, y: 10 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.9 }}
                transition={{ type: "spring", stiffness: 260, damping: 18 }}
                className="relative rounded-2xl px-6 py-2 text-center font-display text-lg font-bold sm:text-2xl"
                style={{
                  color: outcomeColor,
                  textShadow: `0 0 22px ${outcomeColor}77`,
                  background: "rgba(0,0,0,0.35)",
                  border: `1px solid ${outcomeColor}44`,
                }}
              >
                {resultText}
                {(outcome === "win" || outcome === "trips") && (
                  <BurstRing color={ACCENT_LIGHT} />
                )}
              </motion.div>
            )}
            {!outcome && phase === "decision" && (
              <motion.div
                key="decision-prompt"
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                className="text-center"
              >
                <div
                  className="font-display text-xl font-bold sm:text-2xl"
                  style={{ color: ACCENT_LIGHT, textShadow: `0 0 18px ${ACCENT}66` }}
                >
                  Spread of {spread} — {ratioForSpread(spread)}:1
                </div>
                <div className="text-xs text-white/55">
                  Raise to double your ante, or call to keep it.
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Net delta float */}
        <AnimatePresence>
          {outcome && delta !== 0 && (
            <motion.div
              key={"delta" + payout}
              initial={{ opacity: 0, y: 0, scale: 0.8 }}
              animate={{ opacity: 1, y: -28, scale: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.5 }}
              className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 font-display text-3xl font-black tabular-nums"
              style={{
                color: delta > 0 ? ACCENT_LIGHT : "#ef4444",
                textShadow: `0 0 24px ${delta > 0 ? ACCENT : "#ef4444"}aa`,
              }}
            >
              {formatDelta(delta)}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Controls + paytable */}
      <div className="grid gap-4 lg:grid-cols-[1fr_280px]">
        {/* Action / bet bar */}
        <div className="glass flex flex-col gap-2 rounded-2xl p-3 sm:gap-3 sm:p-4">
          {/* Chips */}
          <div className="flex flex-wrap items-center justify-center gap-2 sm:gap-3">
            {DEFAULT_CHIPS.map((v) => (
              <Chip
                key={v}
                value={v}
                size={50}
                onClick={betDisabled || (wallet.ready && v > wallet.balance) ? undefined : () => addChip(v)}
              />
            ))}
          </div>

          {/* Quick adjusters */}
          <div className="flex flex-wrap items-center justify-center gap-2">
            <Button size="sm" variant="ghost" disabled={betDisabled} data-testid="bet-clear" onClick={() => { sfx.click(); setBetSafe(0); }}>
              Clear
            </Button>
            <Button size="sm" variant="ghost" disabled={betDisabled} data-testid="bet-half" onClick={() => { sfx.click(); setBetSafe(Math.floor(ante / 2)); }}>
              ½
            </Button>
            <Button size="sm" variant="ghost" disabled={betDisabled} data-testid="bet-double" onClick={() => { sfx.click(); setBetSafe(ante * 2); }}>
              2×
            </Button>
            <Button size="sm" variant="ghost" disabled={betDisabled} data-testid="bet-max" onClick={() => { sfx.click(); setBetSafe(wallet.ready ? wallet.balance : ante); }}>
              Max
            </Button>

            <div
              className="ml-1 min-w-[110px] rounded-xl border bg-black/40 px-4 py-2 text-center"
              style={{ borderColor: `${ACCENT}55` }}
            >
              <div className="text-[9px] uppercase tracking-widest text-white/40">Ante</div>
              <AnimatePresence mode="popLayout">
                <motion.div
                  key={ante}
                  initial={{ scale: 0.85, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="text-lg font-bold tabular-nums"
                  style={{ color: ACCENT_LIGHT }}
                >
                  {formatChips(ante)}
                </motion.div>
              </AnimatePresence>
            </div>
          </div>

          {/* Primary actions */}
          <div className="flex flex-wrap items-center justify-center gap-3 pt-1">
            {phase === "decision" ? (
              <>
                <Button
                  size="lg"
                  variant="gold"
                  data-testid="raise-btn"
                  disabled={!canAffordRaise}
                  onClick={handleRaise}
                >
                  Raise (+{formatChips(ante)})
                </Button>
                <Button
                  size="lg"
                  variant="felt"
                  data-testid="call-btn"
                  onClick={handleCall}
                >
                  Call (stay)
                </Button>
              </>
            ) : (
              <Button
                size="lg"
                variant="gold"
                data-testid="play-btn"
                disabled={dealDisabled}
                onClick={deal}
              >
                {phase === "resolved" ? "Deal Again" : "Deal"}
              </Button>
            )}
          </div>

          {/* Decision math hint */}
          <AnimatePresence>
            {potentialWin && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                className="flex justify-center gap-6 overflow-hidden text-center text-xs text-white/60"
              >
                <span>
                  Call wins{" "}
                  <span style={{ color: ACCENT_LIGHT }} className="font-bold tabular-nums">
                    +{formatChips(potentialWin.stay)}
                  </span>
                </span>
                <span>
                  Raise wins{" "}
                  <span style={{ color: ACCENT_LIGHT }} className="font-bold tabular-nums">
                    +{formatChips(potentialWin.dbl)}
                  </span>
                </span>
              </motion.div>
            )}
          </AnimatePresence>

          {wallet.ready && ante > wallet.balance && phase === "betting" && (
            <div className="text-center text-xs text-red-400">
              Ante exceeds your balance.
            </div>
          )}
        </div>

        {/* Paytable */}
        <Paytable winningTier={winningTier} accent={ACCENT_LIGHT} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-white/10 bg-black/40 px-3 py-1.5 text-right">
      <div className="text-[9px] uppercase tracking-widest text-white/40">{label}</div>
      <AnimatePresence mode="popLayout">
        <motion.div
          key={value}
          initial={{ y: -6, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: 6, opacity: 0 }}
          className="text-sm font-bold tabular-nums"
          style={{ color: ACCENT_LIGHT }}
        >
          {value}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

function RadialGlow() {
  return (
    <div
      className="pointer-events-none absolute inset-0"
      style={{
        background: `radial-gradient(60% 80% at 50% 30%, ${ACCENT}1f 0%, transparent 70%)`,
      }}
    />
  );
}

function DealtCard({
  card,
  faceDown,
  from,
  label,
  show,
  accent,
}: {
  card: Card | null;
  faceDown: boolean;
  from: number;
  label: string;
  show: boolean;
  accent: string;
}) {
  return (
    <div className="relative grid place-items-center">
      <AnimatePresence>
        {show ? (
          <motion.div
            key={card?.id ?? "card"}
            initial={{ x: from, y: -40, opacity: 0, rotate: from < 0 ? -14 : 14, scale: 0.7 }}
            animate={{ x: 0, y: 0, opacity: 1, rotate: 0, scale: 1 }}
            exit={{ opacity: 0, scale: 0.7 }}
            transition={{ type: "spring", stiffness: 200, damping: 22 }}
          >
            <PlayingCard card={card} faceDown={faceDown} size="md" />
          </motion.div>
        ) : (
          <div className="h-[92px] w-[66px] rounded-lg border-2 border-dashed border-white/10" />
        )}
      </AnimatePresence>
      <div
        className="mt-2 text-[10px] font-semibold uppercase tracking-widest"
        style={{ color: show ? accent : "rgba(255,255,255,0.25)" }}
      >
        {label}
      </div>
    </div>
  );
}

function SpreadMeter({
  phase,
  spread,
  sorted,
  accent,
}: {
  phase: Phase;
  spread: number;
  sorted: { low: number; high: number } | null;
  accent: string;
}) {
  const active = (phase === "decision" || phase === "thirdDeal" || phase === "resolved") && spread > 0 && !!sorted;
  // Map the full rank line 2..14 (13 steps). Fill the strictly-between zone.
  const min = 2;
  const max = 14;
  const span = max - min;
  const lo = sorted ? sorted.low : min;
  const hi = sorted ? sorted.high : max;
  const leftPct = ((lo - min) / span) * 100;
  const rightPct = ((hi - min) / span) * 100;
  const fillW = Math.max(0, rightPct - leftPct);

  return (
    <div className="relative mx-auto mb-3 max-w-xl">
      <div className="mb-1 flex items-center justify-center gap-2">
        <span className="text-[10px] uppercase tracking-widest text-white/40">Spread</span>
        <AnimatePresence mode="popLayout">
          <motion.span
            key={active ? spread : "idle"}
            initial={{ scale: 0.4, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.4, opacity: 0 }}
            transition={{ type: "spring", stiffness: 320, damping: 16 }}
            className="font-display text-base font-black tabular-nums"
            style={{ color: active ? accent : "rgba(255,255,255,0.3)" }}
          >
            {active ? spread : "—"}
          </motion.span>
        </AnimatePresence>
      </div>
      <div className="relative h-3 w-full overflow-hidden rounded-full border border-white/10 bg-black/40">
        {/* tick marks */}
        {Array.from({ length: span + 1 }).map((_, i) => (
          <span
            key={i}
            className="absolute top-0 h-full w-px bg-white/10"
            style={{ left: `${(i / span) * 100}%` }}
          />
        ))}
        {active && (
          <motion.span
            className="absolute top-0 h-full rounded-full"
            initial={{ left: `${leftPct}%`, width: 0 }}
            animate={{ left: `${leftPct}%`, width: `${fillW}%` }}
            transition={{ type: "spring", stiffness: 120, damping: 18 }}
            style={{
              background: `linear-gradient(90deg, ${accent}cc, ${ACCENT_LIGHT}aa)`,
              boxShadow: `0 0 12px ${accent}aa`,
            }}
          />
        )}
        {active && (
          <>
            <Marker pct={leftPct} accent={accent} />
            <Marker pct={rightPct} accent={accent} />
          </>
        )}
      </div>
    </div>
  );
}

function Marker({ pct, accent }: { pct: number; accent: string }) {
  return (
    <motion.span
      className="absolute top-1/2 h-4 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full"
      initial={{ scaleY: 0 }}
      animate={{ scaleY: 1, left: `${pct}%` }}
      transition={{ type: "spring", stiffness: 260, damping: 18 }}
      style={{ left: `${pct}%`, background: accent, boxShadow: `0 0 10px ${accent}` }}
    />
  );
}

function BurstRing({ color }: { color: string }) {
  return (
    <>
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          className="pointer-events-none absolute inset-0 rounded-2xl"
          initial={{ opacity: 0.6, scale: 0.9 }}
          animate={{ opacity: 0, scale: 1.6 }}
          transition={{ duration: 1, delay: i * 0.18, repeat: Infinity, repeatDelay: 0.4 }}
          style={{ border: `2px solid ${color}` }}
        />
      ))}
    </>
  );
}

function Paytable({
  winningTier,
  accent,
}: {
  winningTier: number | null;
  accent: string;
}) {
  return (
    <CollapsiblePanel title="Paytable" accent={accent} summary={<>up to 11:1</>}>
      <div className="flex flex-col gap-1.5">
        {SPREAD_TIERS.map((t, i) => (
          <motion.div
            key={t.label}
            animate={
              winningTier === i
                ? { scale: [1, 1.06, 1], backgroundColor: `${accent}22` }
                : { scale: 1, backgroundColor: "rgba(255,255,255,0.03)" }
            }
            transition={{ duration: 0.5 }}
            className="flex items-center justify-between rounded-lg border border-white/5 px-3 py-1.5 text-sm"
          >
            <span className="text-white/70">
              Spread <span className="font-bold text-white/90">{t.label}</span>
            </span>
            <span className="font-bold tabular-nums" style={{ color: accent }}>
              {t.ratio}:1
            </span>
          </motion.div>
        ))}
        <div className="my-1 h-px bg-white/10" />
        <Row label="Three of a kind (pair)" value="11:1" accent={accent} />
        <Row label="Pair, no trips" value="Push" accent="#cbd5e1" />
        <Row label="Consecutive" value="Push" accent="#cbd5e1" />
      </div>
      <p className="mt-1 text-[11px] leading-relaxed text-white/40">
        Spread is the count of ranks strictly between your two cards. The third
        card must land inside that gap. Payouts apply to your total wager.
      </p>
    </CollapsiblePanel>
  );
}

function Row({ label, value, accent }: { label: string; value: string; accent: string }) {
  return (
    <div className="flex items-center justify-between rounded-lg px-3 py-1.5 text-sm">
      <span className="text-white/70">{label}</span>
      <span className="font-bold tabular-nums" style={{ color: accent }}>
        {value}
      </span>
    </div>
  );
}
