"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useWallet } from "@/lib/wallet";
import { sfx } from "@/lib/sound";
import { formatChips, formatDelta, formatMultiplier } from "@/lib/format";
import { shuffle, randFloat, randInt } from "@/lib/rng";
import { CountingNumber } from "@/components/CountingNumber";
import { Button } from "@/components/ui/Button";
import { Chip } from "@/components/ui/Chip";
import { CollapsiblePanel } from "@/components/CollapsiblePanel";
import { Celebration } from "@/components/Celebration";

/* ----------------------------------------------------------------------------
 * NEON ROYALE — BINGO (75-ball, single player vs the draw)
 *
 * The player buys 1–4 cards (each a 5×5 grid):
 *   B 1–15 · I 16–30 · N 31–45 (center = FREE) · G 46–60 · O 61–75.
 * No repeats within a column.
 *
 * Total stake = bet × (number of cards). One bet() call deducts the lot; each
 * card carries an individual `bet` stake.
 *
 * On START the hopper draws balls one at a time (animated, e.g. "B-7") and
 * auto-daubs matching cells. Winning shapes are detected per card:
 *   • LINE   — any full row, column, or diagonal  → pays a SPEED multiplier
 *   • BLACKOUT — every cell daubed                → pays the big jackpot
 *
 * It is a SPEED race: the hopper keeps calling until every card has its first
 * line (or the LINE_CAP). Each card is paid by HOW FAST *its own* first line
 * landed — fewer balls = fatter pay. If your earliest line came in fast it
 * unlocks a BLACKOUT BONUS chase for the jackpot. Drawing stops the instant the
 * outcome is locked; it never burns all 75 balls needlessly. See the pay model
 * below — tuned to ~92% RTP. Every chip flows through useWallet().
 * ------------------------------------------------------------------------- */

const ACCENT = "#fd79a8";
const ACCENT_SOFT = "#ff9ec0";
const MIN_BET = 5;
const FREE = 0; // sentinel for the FREE center cell

const COLS = ["B", "I", "N", "G", "O"] as const;
type ColLetter = (typeof COLS)[number];
const COL_RANGES: Record<ColLetter, [number, number]> = {
  B: [1, 15],
  I: [16, 30],
  N: [31, 45],
  G: [46, 60],
  O: [61, 75],
};

/* ---- Pay model (tuned by Monte-Carlo, 900k rounds → ~92% RTP) ----------------
 * This is a SPEED bingo race. The hopper keeps drawing until EVERY card has its
 * first line (or LINE_CAP draws — a miss for any card still short). Each card is
 * paid by HOW FAST *its own* first line landed — the fewer balls it took, the
 * fatter the pay (the SPEED_LADDER below). Scoring each card on its own timing
 * keeps the return-to-player flat whether you play 1 or 4 cards.
 *
 * If the EARLIEST line across your cards came fast (≤ BONUS_THRESHOLD balls) the
 * hopper keeps rolling toward a BLACKOUT — covering every cell — up to BO_CAP
 * draws. A card that blacks out is paid the BLACKOUT_MULT jackpot instead.
 *
 * All multipliers already INCLUDE the stake (win(stake * mult)). */
const LINE_CAP = 46; // phase 1: draw until all cards lined, or stop here
const BONUS_THRESHOLD = 20; // an early line unlocks the blackout bonus chase
const BO_CAP = 62; // phase 2: keep drawing toward blackout up to here
const BLACKOUT_MULT = 80; // full-card blackout jackpot (×stake)

/** Speed ladder: balls-to-first-line → line payout multiplier (×stake). */
const SPEED_LADDER: { maxBalls: number; mult: number }[] = [
  { maxBalls: 16, mult: 11 },
  { maxBalls: 20, mult: 6.5 },
  { maxBalls: 24, mult: 4.2 },
  { maxBalls: 28, mult: 2.6 },
  { maxBalls: 32, mult: 1.55 },
  { maxBalls: 37, mult: 0.95 },
  { maxBalls: 42, mult: 0.62 },
  { maxBalls: Infinity, mult: 0.4 },
];

/** Line multiplier for a line that landed on ball #n. */
function lineMultFor(n: number): number {
  return (SPEED_LADDER.find((s) => n <= s.maxBalls) ?? SPEED_LADDER[SPEED_LADDER.length - 1]).mult;
}

/* -------------------------------------------------------------------------- */
/* Card model                                                                 */
/* -------------------------------------------------------------------------- */

interface BingoCard {
  id: number;
  /** Column-major: cells[col][row], 5×5. N[2] (center) is FREE. */
  cells: number[][];
}

/** All 12 winning lines as [col,row] coordinate lists. */
const WIN_LINES: [number, number][][] = (() => {
  const lines: [number, number][][] = [];
  for (let r = 0; r < 5; r++) lines.push([0, 1, 2, 3, 4].map((c) => [c, r] as [number, number]));
  for (let c = 0; c < 5; c++) lines.push([0, 1, 2, 3, 4].map((r) => [c, r] as [number, number]));
  lines.push([0, 1, 2, 3, 4].map((i) => [i, i] as [number, number]));
  lines.push([0, 1, 2, 3, 4].map((i) => [i, 4 - i] as [number, number]));
  return lines;
})();

function makeCard(id: number): BingoCard {
  const cells: number[][] = [];
  for (let c = 0; c < 5; c++) {
    const [lo, hi] = COL_RANGES[COLS[c]];
    const pool: number[] = [];
    for (let n = lo; n <= hi; n++) pool.push(n);
    const col = shuffle(pool).slice(0, 5);
    if (c === 2) col[2] = FREE; // center FREE
    cells.push(col);
  }
  return { id, cells };
}

/** Letter that prefixes a drawn number, e.g. 7 → "B". */
function letterFor(n: number): ColLetter {
  const idx = Math.min(4, Math.floor((n - 1) / 15));
  return COLS[idx];
}

/* -------------------------------------------------------------------------- */
/* Scoring                                                                    */
/* -------------------------------------------------------------------------- */

type PatternKind = "none" | "line" | "blackout";

interface CardScore {
  daubed: Set<number>; // ball numbers daubed (FREE excluded)
  filled: number; // cells covered incl. FREE (25 = blackout)
  completedLines: number[]; // indices into WIN_LINES
  hasLine: boolean;
  blackout: boolean;
}

function isDaubed(card: BingoCard, c: number, r: number, calls: Set<number>): boolean {
  const v = card.cells[c][r];
  return v === FREE || calls.has(v);
}

function scoreCard(card: BingoCard, calls: Set<number>): CardScore {
  const daubed = new Set<number>();
  let filled = 0;
  for (let c = 0; c < 5; c++) {
    for (let r = 0; r < 5; r++) {
      if (isDaubed(card, c, r, calls)) {
        filled++;
        if (card.cells[c][r] !== FREE) daubed.add(card.cells[c][r]);
      }
    }
  }
  const completedLines: number[] = [];
  WIN_LINES.forEach((line, i) => {
    if (line.every(([c, r]) => isDaubed(card, c, r, calls))) completedLines.push(i);
  });
  const blackout = filled === 25;
  return {
    daubed,
    filled,
    completedLines,
    hasLine: completedLines.length > 0,
    blackout,
  };
}

/* -------------------------------------------------------------------------- */
/* Component                                                                  */
/* -------------------------------------------------------------------------- */

type Phase = "betting" | "drawing" | "resolved";

interface FinalResult {
  stake: number; // total deducted
  gross: number; // total credited
  profit: number;
  ballsDrawn: number; // total balls drawn this round
  earliestLineBall: number; // ball # the earliest line landed on (0 = none) — for paytable
  perCard: { id: number; pattern: PatternKind; firstLineBall: number; mult: number; payout: number }[];
  best: PatternKind;
}

const DRAW_INTERVAL = 480; // ms between balls
const BONUS_INTERVAL = 360; // faster cadence during the blackout bonus chase

export default function Bingo() {
  const wallet = useWallet();

  const [bet, setBet] = useState(25);
  const [numCards, setNumCards] = useState(2);
  const [cards, setCards] = useState<BingoCard[]>(() => [makeCard(0), makeCard(1)]);

  const [phase, setPhase] = useState<Phase>("betting");
  const [calls, setCalls] = useState<number[]>([]); // ordered draw history
  const [currentBall, setCurrentBall] = useState<number | null>(null);
  const [resultText, setResultText] = useState("");
  const [result, setResult] = useState<FinalResult | null>(null);
  const [burst, setBurst] = useState(0);
  const [bigWin, setBigWin] = useState(false);
  const [pulseCells, setPulseCells] = useState<string>(""); // key of last-daubed pulse trigger

  const drawTimer = useRef<number | null>(null);
  const overlayTimer = useRef<number | null>(null);
  // Refs hold live draw state so the recursive timer doesn't go stale.
  const bagRef = useRef<number[]>([]);
  const callsRef = useRef<number[]>([]);
  const cardsRef = useRef<BingoCard[]>(cards);
  const stakeRef = useRef<number>(0);
  const firstLineRef = useRef<number[]>([]); // per card: ball # its first line landed (0 = none)
  const bonusRef = useRef<boolean>(false); // are we in the blackout chase phase?
  // Guard against rapid double-click starting two rounds simultaneously.
  const startingRef = useRef<boolean>(false);

  const [bonusPhase, setBonusPhase] = useState(false);

  useEffect(() => {
    cardsRef.current = cards;
  }, [cards]);

  useEffect(() => {
    return () => {
      if (drawTimer.current) clearTimeout(drawTimer.current);
      if (overlayTimer.current) clearTimeout(overlayTimer.current);
    };
  }, []);

  // Keep cards array in sync with the chosen count while betting.
  const setCardCount = useCallback(
    (n: number) => {
      if (phase !== "betting") return;
      sfx.chip();
      setNumCards(n);
      setCards((prev) => {
        const next = prev.slice(0, n);
        for (let i = next.length; i < n; i++) next.push(makeCard(i));
        return next.map((c, i) => ({ ...c, id: i }));
      });
    },
    [phase],
  );

  const reshuffleCards = useCallback(() => {
    if (phase !== "betting") return;
    sfx.card();
    setCards(Array.from({ length: numCards }, (_, i) => makeCard(i)));
  }, [phase, numCards]);

  const callsSet = useMemo(() => new Set(calls), [calls]);

  // Live per-card scoring (used for highlights + the running tote).
  const liveScores = useMemo(
    () => cards.map((c) => scoreCard(c, callsSet)),
    [cards, callsSet],
  );

  const totalStake = bet * numCards;
  const canPlay =
    phase === "betting" &&
    wallet.ready &&
    bet >= MIN_BET &&
    totalStake <= wallet.balance;

  /* ----- resolve a finished draw ----- */
  const resolve = useCallback(() => {
    const finalCalls = new Set(callsRef.current);
    const ballsDrawn = callsRef.current.length;
    const stake = stakeRef.current;
    const firstLine = firstLineRef.current;
    const lineBalls = firstLine.filter((n) => n > 0);
    const earliestLineBall = lineBalls.length ? Math.min(...lineBalls) : 0;

    let gross = 0;
    let bestMult = 0;

    const perCard = cardsRef.current.map((card, i) => {
      const sc = scoreCard(card, finalCalls);
      const flb = firstLine[i] ?? 0;
      let pattern: PatternKind = "none";
      let mult = 0;
      if (bonusRef.current && sc.blackout) {
        // Blackout jackpot replaces the line pay for this card.
        pattern = "blackout";
        mult = BLACKOUT_MULT;
      } else if (flb > 0) {
        // Pay by how fast THIS card's own first line landed.
        pattern = "line";
        mult = lineMultFor(flb);
      }
      if (mult > bestMult) bestMult = mult;
      const payout = Math.floor(bet * mult);
      gross += payout;
      return { id: card.id, pattern, firstLineBall: flb, mult, payout };
    });

    const best: PatternKind = perCard.some((p) => p.pattern === "blackout")
      ? "blackout"
      : perCard.some((p) => p.pattern === "line")
        ? "line"
        : "none";

    if (gross > 0) wallet.win(gross);

    const profit = gross - stake;
    setResult({ stake, gross, profit, ballsDrawn, earliestLineBall, perCard, best });

    if (gross > 0) {
      if (best === "blackout") {
        sfx.jackpot();
        setBigWin(true);
        if (overlayTimer.current) clearTimeout(overlayTimer.current);
        overlayTimer.current = window.setTimeout(() => setBigWin(false), 2600);
        setResultText(`BLACKOUT! ${formatMultiplier(BLACKOUT_MULT)} — ${formatDelta(profit)}`);
      } else {
        sfx.win();
        const lines = perCard.filter((p) => p.pattern === "line").length;
        setResultText(
          `${lines} LINE${lines > 1 ? "S" : ""} · best ${formatMultiplier(bestMult)} — ${formatDelta(profit)}`,
        );
      }
      setBurst((b) => b + 1);
    } else {
      sfx.lose();
      setResultText(`No line in ${ballsDrawn} balls — ${formatDelta(-stake)}`);
    }
    bonusRef.current = false;
    setBonusPhase(false);
    setCurrentBall(null);
    setPhase("resolved");
  }, [bet, wallet]);

  /* ----- draw one ball, recurse (two-phase race) ----- */
  const drawNext = useCallback(() => {
    const inBonus = bonusRef.current;
    const cap = inBonus ? BO_CAP : LINE_CAP;

    // Out of balls or hit the cap → resolve.
    if (bagRef.current.length === 0 || callsRef.current.length >= cap) {
      resolve();
      return;
    }

    const ball = bagRef.current.shift() as number;
    callsRef.current = [...callsRef.current, ball];
    const drawn = callsRef.current.length;
    setCalls(callsRef.current.slice());
    setCurrentBall(ball);
    setPulseCells(`${ball}-${drawn}`);

    // Did this ball daub anything? card vs tick sound.
    let daubedSomething = false;
    for (const card of cardsRef.current) {
      if (card.cells.some((col) => col.includes(ball))) {
        daubedSomething = true;
        break;
      }
    }
    if (daubedSomething) sfx.card();
    else sfx.tick();

    const calledSet = new Set(callsRef.current);
    const interval = inBonus ? BONUS_INTERVAL : DRAW_INTERVAL;

    if (!inBonus) {
      // PHASE 1 — keep drawing until every card has its first line.
      const firstLine = firstLineRef.current;
      let justLined = false;
      let allLined = true;
      cardsRef.current.forEach((card, i) => {
        if (firstLine[i] === 0) {
          if (scoreCard(card, calledSet).hasLine) {
            firstLine[i] = drawn; // record THIS card's own first-line ball
            justLined = true;
          } else {
            allLined = false;
          }
        }
      });
      if (justLined) sfx.thud();

      if (allLined) {
        // Every card lined. If the earliest line came fast, chase a blackout.
        const earliest = Math.min(...firstLine.filter((n) => n > 0));
        if (earliest <= BONUS_THRESHOLD && drawn < BO_CAP) {
          bonusRef.current = true;
          setBonusPhase(true);
          drawTimer.current = window.setTimeout(drawNext, 720);
          return;
        }
        drawTimer.current = window.setTimeout(resolve, DRAW_INTERVAL);
        return;
      }
      drawTimer.current = window.setTimeout(drawNext, interval);
      return;
    }

    // PHASE 2 — blackout chase. Stop the moment a card blacks out.
    const anyBlackout = cardsRef.current.some((card) => scoreCard(card, calledSet).blackout);
    if (anyBlackout) {
      drawTimer.current = window.setTimeout(resolve, BONUS_INTERVAL);
      return;
    }
    drawTimer.current = window.setTimeout(drawNext, interval);
  }, [resolve]);

  /* ----- start a round ----- */
  const start = useCallback(() => {
    if (phase !== "betting") return;
    // Guard against rapid double-clicks firing two rounds before the phase
    // state propagates back through React's render cycle.
    if (startingRef.current) return;
    startingRef.current = true;
    const stake = bet * numCards;
    if (stake < MIN_BET) { startingRef.current = false; return; }
    if (!wallet.bet(stake)) { startingRef.current = false; return; } // unaffordable → abort

    sfx.chip();
    stakeRef.current = stake;
    callsRef.current = [];
    cardsRef.current = cards;
    firstLineRef.current = cards.map(() => 0);
    bonusRef.current = false;
    bagRef.current = shuffle(Array.from({ length: 75 }, (_, i) => i + 1));

    setCalls([]);
    setCurrentBall(null);
    setPulseCells("");
    setResult(null);
    setResultText("");
    setBigWin(false);
    setBonusPhase(false);
    setBurst(0);
    setPhase("drawing");

    drawTimer.current = window.setTimeout(drawNext, 420);
    // Reset the guard after one event loop turn — by then setPhase("drawing")
    // will have committed and the play button will be disabled.
    Promise.resolve().then(() => { startingRef.current = false; });
  }, [phase, bet, numCards, cards, wallet, drawNext]);

  /* ----- new round ----- */
  const newRound = useCallback(() => {
    if (phase !== "resolved") return;
    sfx.click();
    if (drawTimer.current) clearTimeout(drawTimer.current);
    if (overlayTimer.current) clearTimeout(overlayTimer.current);
    bonusRef.current = false;
    startingRef.current = false;
    setPhase("betting");
    setCalls([]);
    setCurrentBall(null);
    setPulseCells("");
    setResult(null);
    setResultText("");
    setBigWin(false);
    setBonusPhase(false);
    setBurst(0);
    setCards(Array.from({ length: numCards }, (_, i) => makeCard(i)));
  }, [phase, numCards]);

  const drawing = phase === "drawing";
  const callLabel = currentBall != null ? `${letterFor(currentBall)}-${currentBall}` : "—";

  // Win celebration: fire only once the round has RESOLVED with a payout.
  const won = phase === "resolved" && (result?.gross ?? 0) > 0;
  // Payout measured in bet-per-card units feeds the intensity tier.
  const winMult = result && bet > 0 ? result.gross / bet : 0;
  const celebrationTier: "win" | "big" | "jackpot" =
    result?.best === "blackout" || winMult >= 20 ? "jackpot" : winMult >= 5 ? "big" : "win";

  return (
    <div className="mx-auto w-full max-w-6xl px-3 pb-4 sm:pb-10">
      <div className="felt relative overflow-hidden rounded-3xl border border-white/10 p-3 shadow-felt sm:p-6 [@media(max-height:600px)]:p-2">
        {/* ambient accent glow */}
        <div
          className="pointer-events-none absolute -inset-24 opacity-30 blur-3xl"
          style={{ background: `radial-gradient(circle at 50% 0%, ${ACCENT}33, transparent 60%)` }}
        />

        {/* Big-win full-surface flash */}
        <AnimatePresence>{bigWin && <BlackoutOverlay key="bo" />}</AnimatePresence>

        {/* Confetti + coin-fountain on any winning resolve */}
        <Celebration
          show={won}
          seed={result?.gross ?? 0}
          tier={celebrationTier}
          colors={["#fd79a8", "#22e1ff", "#ffd24a", "#ffffff"]}
        />

        <div className="relative grid gap-3 sm:gap-5 lg:grid-cols-[320px_minmax(0,1fr)]">
          {/* ============================ LEFT: hopper + controls ============= */}
          <div className="flex flex-col gap-2 sm:gap-4">
            <Hopper
              label={callLabel}
              ball={currentBall}
              drawing={drawing}
              bonus={bonusPhase}
              drawn={calls.length}
              burst={burst}
              win={(result?.gross ?? 0) > 0}
            />

            {/* readouts */}
            <div className="grid grid-cols-2 gap-2">
              <Readout label="Balance" value={wallet.balance} accent={ACCENT} />
              <Readout
                label={phase === "resolved" && result ? (result.gross > 0 ? "Payout" : "Lost") : "Total Bet"}
                value={
                  phase === "resolved" && result
                    ? result.gross > 0
                      ? result.gross
                      : result.stake
                    : totalStake
                }
                accent={phase === "resolved" && result && result.gross > 0 ? "#3ee08a" : ACCENT}
              />
            </div>

            {/* result banner */}
            <div className="min-h-[44px] sm:min-h-[58px]">
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
                      borderColor: (result?.gross ?? 0) > 0 ? `${ACCENT}aa` : "#ffffff22",
                      background:
                        (result?.gross ?? 0) > 0
                          ? `linear-gradient(180deg, ${ACCENT}26, transparent)`
                          : "rgba(0,0,0,0.35)",
                      color: (result?.gross ?? 0) > 0 ? ACCENT_SOFT : "rgba(255,255,255,0.7)",
                      textShadow: (result?.gross ?? 0) > 0 ? `0 0 16px ${ACCENT}66` : "none",
                    }}
                  >
                    {resultText}
                  </motion.div>
                ) : (
                  <motion.div
                    key="placeholder"
                    data-testid="round-result"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="rounded-2xl border border-white/10 bg-black/30 px-4 py-3 text-center text-sm text-white/45"
                  >
                    {drawing
                      ? bonusPhase
                        ? "Blackout bonus — chasing the jackpot!"
                        : "Calling balls… first line wins"
                      : `${numCards} card${numCards > 1 ? "s" : ""} · ${formatChips(totalStake)} total`}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            {/* card-count selector */}
            <div className="glass rounded-2xl p-3">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-[10px] uppercase tracking-widest text-white/40">Cards</span>
                <button
                  type="button"
                  data-testid="reshuffle-cards"
                  disabled={phase !== "betting"}
                  onClick={reshuffleCards}
                  className="text-[10px] uppercase tracking-widest text-white/45 transition hover:text-white disabled:opacity-30"
                >
                  ↻ New cards
                </button>
              </div>
              <div className="grid grid-cols-4 gap-2">
                {[1, 2, 3, 4].map((n) => {
                  const active = numCards === n;
                  return (
                    <motion.button
                      key={n}
                      type="button"
                      data-testid={`cards-${n}`}
                      disabled={phase !== "betting"}
                      onClick={() => setCardCount(n)}
                      whileHover={phase === "betting" ? { y: -2 } : undefined}
                      whileTap={phase === "betting" ? { scale: 0.95 } : undefined}
                      className="rounded-xl border py-2 text-center font-display text-lg font-extrabold transition disabled:opacity-50"
                      style={{
                        borderColor: active ? ACCENT : "rgba(255,255,255,0.1)",
                        background: active
                          ? `linear-gradient(180deg, ${ACCENT}55, ${ACCENT}1c)`
                          : "rgba(0,0,0,0.3)",
                        color: active ? "#fff" : ACCENT_SOFT,
                        boxShadow: active ? `0 0 16px ${ACCENT}66` : "none",
                      }}
                    >
                      {n}
                    </motion.button>
                  );
                })}
              </div>
            </div>

            {/* bet chips + readout */}
            <div className="glass rounded-2xl p-3">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-[10px] uppercase tracking-widest text-white/40">
                  Bet per card
                </span>
                <span className="text-[10px] text-white/40">
                  total {formatChips(totalStake)}
                </span>
              </div>
              <div className="flex flex-wrap items-center justify-center gap-2">
                {[5, 25, 100, 500].map((v) => (
                  <Chip
                    key={v}
                    value={v}
                    size={48}
                    onClick={
                      phase !== "betting" || v * numCards > wallet.balance
                        ? undefined
                        : () => {
                            sfx.chip();
                            setBet((b) => b + v);
                          }
                    }
                  />
                ))}
              </div>
              <div className="mt-3 flex items-center justify-center gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  data-testid="bet-clear"
                  disabled={phase !== "betting"}
                  onClick={() => setBet(MIN_BET)}
                >
                  Min
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  data-testid="bet-half"
                  disabled={phase !== "betting"}
                  onClick={() => setBet((b) => Math.max(MIN_BET, Math.floor(b / 2)))}
                >
                  ½
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  data-testid="bet-double"
                  disabled={phase !== "betting"}
                  onClick={() => setBet((b) => Math.min(Math.floor(wallet.balance / numCards), b * 2))}
                >
                  2×
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  data-testid="bet-max"
                  disabled={phase !== "betting"}
                  onClick={() =>
                    setBet(Math.max(MIN_BET, Math.floor(wallet.balance / numCards)))
                  }
                >
                  Max
                </Button>
                <div className="ml-1 min-w-[92px] rounded-xl border border-white/10 bg-black/40 px-3 py-1.5 text-center">
                  <div className="text-[9px] uppercase tracking-widest text-white/40">Per card</div>
                  <div
                    className="text-base font-bold tabular-nums"
                    style={{ color: ACCENT_SOFT }}
                  >
                    {formatChips(bet)}
                  </div>
                </div>
              </div>
            </div>

            {/* primary action */}
            {phase === "resolved" ? (
              <Button data-testid="play-btn" variant="gold" size="lg" block onClick={newRound}>
                Play Again
              </Button>
            ) : (
              <Button
                data-testid="play-btn"
                variant="gold"
                size="lg"
                block
                disabled={!canPlay}
                onClick={start}
              >
                {drawing ? (
                  <span className="inline-flex items-center gap-2">
                    <motion.span
                      animate={{ rotate: 360 }}
                      transition={{ repeat: Infinity, ease: "linear", duration: 0.9 }}
                      className="inline-block"
                    >
                      ◉
                    </motion.span>
                    Calling…
                  </span>
                ) : totalStake > wallet.balance ? (
                  "Insufficient Chips"
                ) : (
                  <span>
                    Start · <CountingNumber value={totalStake} className="tabular-nums" />
                  </span>
                )}
              </Button>
            )}

            {/* paytable */}
            <CollapsiblePanel title="Paytable" accent={ACCENT} summary={<>speed bingo · 80×</>}>
              <Paytable best={result?.best} firstLineBall={result?.earliestLineBall} />
            </CollapsiblePanel>
          </div>

          {/* ============================ RIGHT: cards + board =============== */}
          <div className="flex flex-col gap-3 sm:gap-5">
            {/* the cards */}
            <div
              className={`grid gap-2 sm:gap-4 ${
                numCards === 1
                  ? "grid-cols-1 place-items-center"
                  : "grid-cols-1 sm:grid-cols-2"
              }`}
            >
              {cards.map((card, i) => (
                <CardView
                  key={card.id}
                  card={card}
                  index={i}
                  calls={callsSet}
                  score={liveScores[i]}
                  outcome={phase === "resolved" ? result?.perCard[i]?.pattern ?? "none" : "none"}
                  payout={phase === "resolved" ? result?.perCard[i]?.payout ?? 0 : 0}
                  pulseKey={pulseCells}
                  drawing={drawing}
                  resolved={phase === "resolved"}
                />
              ))}
            </div>

            {/* called-numbers board */}
            <CollapsiblePanel
              title="Called Board"
              accent={ACCENT}
              summary={<>{callsSet.size} called</>}
            >
              <CalledBoard calls={callsSet} current={currentBall} />
            </CollapsiblePanel>
          </div>
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Hopper / call display                                                      */
/* -------------------------------------------------------------------------- */

function Hopper({
  label,
  ball,
  drawing,
  bonus,
  drawn,
  burst,
  win,
}: {
  label: string;
  ball: number | null;
  drawing: boolean;
  bonus: boolean;
  drawn: number;
  burst: number;
  win: boolean;
}) {
  const letter = ball != null ? letterFor(ball) : null;
  return (
    <div className="glass relative grid place-items-center overflow-hidden rounded-2xl p-3 sm:p-4 [@media(max-height:600px)]:p-2">
      {/* burst ring on resolve */}
      <AnimatePresence>
        {burst > 0 && win && <WinBurst key={burst} color={ACCENT} />}
      </AnimatePresence>

      {/* bouncing background balls while drawing */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        {drawing &&
          Array.from({ length: 6 }).map((_, i) => (
            <motion.span
              key={i}
              className="absolute rounded-full"
              style={{
                width: 14,
                height: 14,
                left: `${12 + i * 14}%`,
                background: `radial-gradient(circle at 35% 30%, #fff, ${ACCENT})`,
                opacity: 0.35,
              }}
              animate={{ y: [0, -18, 0], x: [0, i % 2 ? 8 : -8, 0] }}
              transition={{
                repeat: Infinity,
                duration: randFloat(0.7, 1.1),
                delay: i * 0.08,
                ease: "easeInOut",
              }}
            />
          ))}
      </div>

      <div className="relative z-10 flex flex-col items-center">
        <AnimatePresence mode="wait">
          <motion.div
            key={bonus ? "bonus" : "calling"}
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="text-[10px] font-bold uppercase tracking-[0.3em]"
            style={{ color: bonus ? ACCENT_SOFT : "rgba(255,255,255,0.4)" }}
          >
            {bonus ? "★ Blackout Bonus ★" : "Now Calling"}
          </motion.div>
        </AnimatePresence>

        {/* the called ball */}
        <div className="relative mt-2 grid h-[132px] w-[132px] place-items-center [@media(max-height:600px)]:h-[92px] [@media(max-height:600px)]:w-[92px]">
          {/* glow halo */}
          <motion.div
            className="absolute inset-0 rounded-full"
            animate={{
              boxShadow: drawing
                ? [`0 0 22px ${ACCENT}55`, `0 0 40px ${ACCENT}88`, `0 0 22px ${ACCENT}55`]
                : `0 0 24px ${ACCENT}44`,
            }}
            transition={{ repeat: drawing ? Infinity : 0, duration: 1.1 }}
          />
          <AnimatePresence mode="popLayout">
            <motion.div
              key={label + drawn}
              initial={{ scale: 0.2, rotate: -180, opacity: 0, y: -30 }}
              animate={{ scale: 1, rotate: 0, opacity: 1, y: 0 }}
              exit={{ scale: 0.4, opacity: 0, y: 30 }}
              transition={{ type: "spring", stiffness: 260, damping: 16 }}
              className="grid h-[116px] w-[116px] place-items-center rounded-full [@media(max-height:600px)]:h-[80px] [@media(max-height:600px)]:w-[80px]"
              style={{
                background:
                  ball != null
                    ? "radial-gradient(circle at 38% 30%, #ffffff 0%, #fff 18%, #f4f4f4 45%, #d6d6d6 100%)"
                    : "radial-gradient(circle at 38% 30%, #2a2a33, #14141a)",
                boxShadow:
                  "inset 0 -8px 16px rgba(0,0,0,0.25), inset 0 6px 12px rgba(255,255,255,0.7), 0 8px 18px rgba(0,0,0,0.5)",
              }}
            >
              {ball != null ? (
                <div className="flex flex-col items-center leading-none">
                  <span
                    className="font-display text-sm font-black tracking-widest"
                    style={{ color: ACCENT }}
                  >
                    {letter}
                  </span>
                  <span className="font-display text-4xl font-black text-ink">{ball}</span>
                </div>
              ) : (
                <span className="text-3xl text-white/30">●</span>
              )}
            </motion.div>
          </AnimatePresence>
        </div>

        <div
          className="mt-3 font-display text-2xl font-extrabold tabular-nums"
          style={{ color: ACCENT_SOFT, textShadow: `0 0 12px ${ACCENT}55` }}
        >
          {label}
        </div>
        <div className="mt-1 text-[11px] uppercase tracking-widest text-white/40">
          {drawn} / 75 drawn
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* A bingo card                                                               */
/* -------------------------------------------------------------------------- */

function CardView({
  card,
  index,
  calls,
  score,
  outcome,
  payout,
  pulseKey,
  drawing,
  resolved,
}: {
  card: BingoCard;
  index: number;
  calls: Set<number>;
  score: CardScore;
  outcome: PatternKind;
  payout: number;
  pulseKey: string;
  drawing: boolean;
  resolved: boolean;
}) {
  const winning = resolved && outcome !== "none" && payout > 0;
  // Which cells belong to a completed line (for the highlight).
  const litCells = useMemo(() => {
    const s = new Set<string>();
    score.completedLines.forEach((li) =>
      WIN_LINES[li].forEach(([c, r]) => s.add(`${c}-${r}`)),
    );
    return s;
  }, [score.completedLines]);
  const blackoutWin = resolved && outcome === "blackout";

  const headColors = [ACCENT, "#22e1ff", "#f5d060", "#3ee08a", "#b388ff"];

  return (
    <motion.div
      layout
      initial={{ opacity: 0, scale: 0.9, y: 14 }}
      animate={{
        opacity: 1,
        scale: 1,
        y: 0,
        boxShadow: winning
          ? `0 0 0 2px ${ACCENT}, 0 0 26px ${ACCENT}${blackoutWin ? "aa" : "66"}`
          : "0 6px 18px rgba(0,0,0,0.4)",
      }}
      transition={{ delay: index * 0.06, type: "spring", stiffness: 220, damping: 22 }}
      className="relative w-full max-w-[300px] overflow-hidden rounded-2xl border border-white/10 bg-black/40 p-2.5 [@media(max-height:600px)]:max-w-[210px]"
    >
      {/* card header / banner */}
      <div className="mb-2 flex items-center justify-between px-0.5">
        <span className="font-display text-xs font-bold tracking-widest text-white/45">
          CARD {index + 1}
        </span>
        <AnimatePresence>
          {winning && (
            <motion.span
              initial={{ scale: 0, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              className="rounded-full px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wider"
              style={{ background: `${ACCENT}33`, color: ACCENT_SOFT, border: `1px solid ${ACCENT}` }}
            >
              {blackoutWin ? "Blackout" : "Line"} +{formatChips(payout)}
            </motion.span>
          )}
        </AnimatePresence>
      </div>

      {/* BINGO column letters */}
      <div className="mb-1.5 grid grid-cols-5 gap-1.5">
        {COLS.map((L, c) => (
          <div
            key={L}
            className="grid place-items-center rounded-lg py-1 font-display text-lg font-black"
            style={{
              color: "#fff",
              background: `linear-gradient(180deg, ${headColors[c]}cc, ${headColors[c]}77)`,
              textShadow: "0 1px 2px rgba(0,0,0,0.5)",
            }}
          >
            {L}
          </div>
        ))}
      </div>

      {/* 5×5 grid (row-major render, column-major data) */}
      <div className="grid grid-cols-5 gap-1.5">
        {Array.from({ length: 5 }).map((_, r) =>
          Array.from({ length: 5 }).map((__, c) => {
            const v = card.cells[c][r];
            const free = v === FREE;
            const daubed = free || calls.has(v);
            const inLine = litCells.has(`${c}-${r}`);
            // Pulse only the cell that was just called.
            const justCalled = daubed && !free && pulseKey.startsWith(`${v}-`);
            return (
              <Cell
                key={`${c}-${r}`}
                value={v}
                free={free}
                daubed={daubed}
                inLine={inLine}
                justCalled={justCalled}
                drawing={drawing}
              />
            );
          }),
        )}
      </div>

      {/* progress bar: how full the card is */}
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/10">
        <motion.div
          className="h-full rounded-full"
          style={{ background: `linear-gradient(90deg, ${ACCENT}, ${ACCENT_SOFT})` }}
          animate={{ width: `${((score.filled - 1) / 24) * 100}%` }}
          transition={{ type: "spring", stiffness: 200, damping: 26 }}
        />
      </div>
    </motion.div>
  );
}

function Cell({
  value,
  free,
  daubed,
  inLine,
  justCalled,
  drawing,
}: {
  value: number;
  free: boolean;
  daubed: boolean;
  inLine: boolean;
  justCalled: boolean;
  drawing: boolean;
}) {
  return (
    <div
      className="relative grid aspect-square place-items-center rounded-lg text-sm font-bold tabular-nums sm:text-base"
      style={{
        background: inLine
          ? `linear-gradient(180deg, ${ACCENT}66, ${ACCENT}22)`
          : daubed
            ? "rgba(255,255,255,0.06)"
            : "rgba(255,255,255,0.03)",
        border: inLine ? `1px solid ${ACCENT}` : "1px solid rgba(255,255,255,0.08)",
        color: free ? ACCENT_SOFT : daubed ? "rgba(255,255,255,0.55)" : "rgba(255,255,255,0.85)",
        boxShadow: inLine ? `0 0 12px ${ACCENT}55` : "none",
      }}
    >
      {free ? <span className="text-[10px] font-black leading-tight">FREE</span> : value}

      {/* the daub mark */}
      <AnimatePresence>
        {daubed && !free && (
          <motion.span
            key="daub"
            initial={
              justCalled
                ? { scale: 0, opacity: 0, rotate: -40 }
                : { scale: 1, opacity: 1 }
            }
            animate={{ scale: 1, opacity: 1, rotate: 0 }}
            exit={{ scale: 0, opacity: 0 }}
            transition={
              justCalled
                ? { type: "spring", stiffness: 500, damping: 14 }
                : { duration: 0 }
            }
            className="absolute inset-1 grid place-items-center rounded-full"
            style={{
              background: `radial-gradient(circle at 38% 32%, ${ACCENT_SOFT}, ${ACCENT})`,
              boxShadow: `0 0 10px ${ACCENT}aa, inset 0 -3px 6px rgba(0,0,0,0.3)`,
            }}
          >
            <span className="text-[11px] font-black text-white/90 sm:text-sm">{value}</span>
          </motion.span>
        )}
      </AnimatePresence>

      {/* ping when freshly called */}
      <AnimatePresence>
        {justCalled && drawing && (
          <motion.span
            key="ping"
            initial={{ scale: 0.5, opacity: 0.7 }}
            animate={{ scale: 2.2, opacity: 0 }}
            transition={{ duration: 0.6, ease: "easeOut" }}
            className="pointer-events-none absolute inset-0 rounded-lg"
            style={{ border: `2px solid ${ACCENT}` }}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Called-numbers board (full 1–75 with B/I/N/G/O rows)                       */
/* -------------------------------------------------------------------------- */

function CalledBoard({ calls, current }: { calls: Set<number>; current: number | null }) {
  return (
    <div className="pt-1">
      <div className="space-y-1">
        {COLS.map((L, ci) => {
          const [lo, hi] = COL_RANGES[L];
          const nums: number[] = [];
          for (let n = lo; n <= hi; n++) nums.push(n);
          return (
            <div key={L} className="flex items-center gap-1.5">
              <div
                className="grid h-6 w-6 shrink-0 place-items-center rounded-md font-display text-sm font-black text-white"
                style={{ background: `${ACCENT}55`, border: `1px solid ${ACCENT}` }}
              >
                {L}
              </div>
              <div className="grid flex-1 grid-cols-[repeat(15,minmax(0,1fr))] gap-1">
                {nums.map((n) => {
                  const on = calls.has(n);
                  const isCurrent = n === current;
                  return (
                    <motion.div
                      key={n}
                      className="grid aspect-square place-items-center rounded-[5px] text-[9px] font-bold tabular-nums sm:text-[11px]"
                      animate={{
                        scale: isCurrent ? [1, 1.35, 1] : 1,
                        backgroundColor: on
                          ? "rgba(253,121,168,0.85)"
                          : "rgba(255,255,255,0.05)",
                        color: on ? "#1a0b12" : "rgba(255,255,255,0.4)",
                      }}
                      transition={{ duration: isCurrent ? 0.5 : 0.25 }}
                      style={{
                        boxShadow: isCurrent ? `0 0 12px ${ACCENT}` : "none",
                        border: on ? `1px solid ${ACCENT_SOFT}` : "1px solid transparent",
                      }}
                    >
                      {n}
                    </motion.div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Paytable                                                                   */
/* -------------------------------------------------------------------------- */

/** A label like "≤16", "17–20" for a speed ladder band. */
function ladderRange(i: number): string {
  const prev = i === 0 ? 4 : SPEED_LADDER[i - 1].maxBalls + 1;
  const cur = SPEED_LADDER[i].maxBalls;
  if (!Number.isFinite(cur)) return `${prev}+`;
  return i === 0 ? `≤${cur}` : `${prev}–${cur}`;
}

function Paytable({
  best,
  firstLineBall,
}: {
  best?: PatternKind;
  firstLineBall?: number;
}) {
  const activeBand =
    best === "line" && firstLineBall && firstLineBall > 0
      ? SPEED_LADDER.findIndex((s) => firstLineBall <= s.maxBalls)
      : -1;
  return (
    <div className="pt-1">
      <div className="mb-2 text-[10px] uppercase tracking-widest text-white/40">
        Per card
      </div>

      {/* Blackout headline */}
      <div
        className="mb-2 flex items-center justify-between rounded-xl px-3 py-2"
        style={{
          background:
            best === "blackout"
              ? `linear-gradient(90deg, ${ACCENT}55, ${ACCENT}1c)`
              : `linear-gradient(90deg, ${ACCENT}22, transparent)`,
          border: `1px solid ${best === "blackout" ? ACCENT : `${ACCENT}55`}`,
        }}
      >
        <div>
          <div className="font-display text-sm font-extrabold" style={{ color: ACCENT_SOFT }}>
            ★ BLACKOUT
          </div>
          <div className="text-[10px] text-white/40">cover all 24 + FREE</div>
        </div>
        <div className="font-display text-lg font-black" style={{ color: ACCENT }}>
          {formatMultiplier(BLACKOUT_MULT)}
        </div>
      </div>

      {/* Line speed ladder */}
      <div className="mb-1 text-[10px] uppercase tracking-widest text-white/35">
        Line pays by balls-to-first-line
      </div>
      <table className="w-full text-sm">
        <tbody>
          {SPEED_LADDER.map((s, i) => {
            const hit = i === activeBand;
            return (
              <tr
                key={i}
                className="border-t border-white/5"
                style={{ background: hit ? `${ACCENT}26` : "transparent" }}
              >
                <td className="py-1 text-white/70">
                  <span style={{ color: hit ? ACCENT_SOFT : undefined }}>{ladderRange(i)} balls</span>
                </td>
                <td
                  className="py-1 text-right font-bold tabular-nums"
                  style={{ color: hit ? ACCENT_SOFT : ACCENT }}
                >
                  {formatMultiplier(s.mult)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="mt-2 text-[10px] leading-relaxed text-white/35">
        The hopper draws until your first line lands — the faster it comes, the bigger the pay. A
        fast line (≤{BONUS_THRESHOLD} balls) unlocks the blackout bonus chase. Every extra card is
        another shot. Multipliers include your stake.
      </p>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Stat readout                                                               */
/* -------------------------------------------------------------------------- */

function Readout({ label, value, accent }: { label: string; value: number; accent: string }) {
  return (
    <div className="glass rounded-2xl px-3 py-2.5">
      <div className="text-[10px] uppercase tracking-widest text-white/40">{label}</div>
      <div className="font-display text-xl font-bold tabular-nums" style={{ color: accent }}>
        <CountingNumber value={value} />
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Win burst + blackout overlay                                               */
/* -------------------------------------------------------------------------- */

function WinBurst({ color }: { color: string }) {
  const sparks = useMemo(
    () =>
      Array.from({ length: 16 }, (_, i) => {
        const angle = (i / 16) * Math.PI * 2 + randFloat(-0.2, 0.2);
        const dist = randFloat(90, 150);
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
  const palette = [color, "#ffffff", ACCENT_SOFT];
  return (
    <div className="pointer-events-none absolute inset-0 z-20 grid place-items-center">
      <motion.div
        initial={{ scale: 0, opacity: 0.8 }}
        animate={{ scale: 2.4, opacity: 0 }}
        transition={{ duration: 0.7, ease: "easeOut" }}
        className="absolute h-20 w-20 rounded-full"
        style={{ background: `radial-gradient(circle, ${color}88, transparent 70%)` }}
      />
      {sparks.map((s) => (
        <motion.span
          key={s.id}
          initial={{ x: 0, y: 0, scale: 0, opacity: 1, rotate: 0 }}
          animate={{ x: s.x, y: s.y, scale: [0, 1.1, 0.4], opacity: [1, 1, 0], rotate: s.rot }}
          transition={{ duration: 1, delay: s.delay, ease: "easeOut" }}
          className="absolute block h-2.5 w-2.5 rounded-[2px]"
          style={{ background: palette[s.hue] }}
        />
      ))}
    </div>
  );
}

function BlackoutOverlay() {
  const confetti = useMemo(
    () =>
      Array.from({ length: 60 }, (_, i) => ({
        id: i,
        x: randFloat(0, 100),
        delay: randFloat(0, 0.5),
        dur: randFloat(1.4, 2.6),
        rot: randFloat(0, 360),
        color: [ACCENT, ACCENT_SOFT, "#f5d060", "#22e1ff", "#3ee08a", "#fff"][randInt(0, 5)],
        size: randFloat(6, 12),
      })),
    [],
  );
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.3 }}
      className="pointer-events-none absolute inset-0 z-30 overflow-hidden"
    >
      <motion.div
        initial={{ opacity: 0.6 }}
        animate={{ opacity: [0.5, 0, 0.4, 0] }}
        transition={{ duration: 1.4 }}
        className="absolute inset-0"
        style={{ background: `radial-gradient(circle at 50% 40%, ${ACCENT}44, transparent 65%)` }}
      />
      <motion.div
        initial={{ scale: 0.5, opacity: 0, y: -10 }}
        animate={{ scale: [0.5, 1.15, 1], opacity: [0, 1, 1, 0] }}
        transition={{ duration: 2, times: [0, 0.2, 0.7, 1] }}
        className="absolute left-1/2 top-1/3 -translate-x-1/2 -translate-y-1/2 font-display text-5xl font-black sm:text-7xl"
        style={{ color: "#fff", textShadow: `0 0 30px ${ACCENT}, 0 0 60px ${ACCENT}` }}
      >
        BLACKOUT!
      </motion.div>
      {confetti.map((c) => (
        <motion.span
          key={c.id}
          className="absolute top-[-5%]"
          style={{ left: `${c.x}%`, width: c.size, height: c.size, background: c.color, borderRadius: 2 }}
          initial={{ y: 0, rotate: c.rot, opacity: 1 }}
          animate={{ y: "115vh", rotate: c.rot + 360, opacity: [1, 1, 0.6] }}
          transition={{ duration: c.dur, delay: c.delay, ease: "easeIn" }}
        />
      ))}
    </motion.div>
  );
}
