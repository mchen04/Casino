"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
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
import { BetControls } from "@/components/BetControls";
import { PlayingCard } from "@/components/PlayingCard";
import { CountingNumber } from "@/components/CountingNumber";
import { CollapsiblePanel } from "@/components/CollapsiblePanel";

const ACCENT = "#1abc9c";
const MIN_BET = 5;

type Phase = "betting" | "dealing" | "decision" | "revealing" | "result";

type Outcome = "win" | "lose" | "push";

interface RaisePayoutRow {
  category: HandCategory;
  label: string;
  /** Multiplier the raise is paid at (profit ratio, e.g. 2 means 2:1). */
  raise: number;
}

// Raise paytable — paid on the RAISE bet when the player WINS a qualified showdown.
const RAISE_TABLE: RaisePayoutRow[] = [
  { category: HandCategory.RoyalFlush, label: "Royal Flush", raise: 100 },
  { category: HandCategory.StraightFlush, label: "Straight Flush", raise: 50 },
  { category: HandCategory.FourOfAKind, label: "Four of a Kind", raise: 20 },
  { category: HandCategory.FullHouse, label: "Full House", raise: 7 },
  { category: HandCategory.Flush, label: "Flush", raise: 5 },
  { category: HandCategory.Straight, label: "Straight", raise: 4 },
  { category: HandCategory.ThreeOfAKind, label: "Three of a Kind", raise: 3 },
  { category: HandCategory.TwoPair, label: "Two Pair", raise: 2 },
  { category: HandCategory.Pair, label: "Pair or Less", raise: 1 },
];

function raiseMultiplierFor(category: HandCategory): number {
  // Pair, High Card and anything not listed pays 1:1.
  const row = RAISE_TABLE.find((r) => r.category === category);
  if (row) return row.raise;
  return 1; // High Card / Pair
}

/** Dealer qualifies with Ace-King high or better (any pair+ also qualifies). */
function dealerQualifies(hand: Card[]): boolean {
  const rank = evaluate5(hand);
  if (rank.category > HandCategory.HighCard) return true; // any pair or better
  // High card: needs an Ace AND a King among the 5 cards.
  const vals = new Set(hand.map((c) => rankValue(c.rank)));
  return vals.has(14) && vals.has(13);
}

// ---------------------------------------------------------------------------
// Win burst (radiating sparks)
// ---------------------------------------------------------------------------
function WinBurst({ show, big }: { show: boolean; big: boolean }) {
  const sparks = useMemo(
    () =>
      Array.from({ length: big ? 22 : 12 }, (_, i) => ({
        id: i,
        angle: (360 / (big ? 22 : 12)) * i + (i % 2 ? 8 : -8),
        dist: big ? 150 : 110,
        delay: (i % 5) * 0.03,
        color: i % 3 === 0 ? "#f5d060" : i % 3 === 1 ? ACCENT : "#fff",
      })),
    [big],
  );
  return (
    <AnimatePresence>
      {show && (
        <div className="pointer-events-none absolute inset-0 z-30 grid place-items-center">
          {sparks.map((s) => {
            const rad = (s.angle * Math.PI) / 180;
            return (
              <motion.span
                key={s.id}
                className="absolute h-2 w-2 rounded-full"
                style={{ background: s.color, boxShadow: `0 0 10px ${s.color}` }}
                initial={{ x: 0, y: 0, scale: 0, opacity: 0 }}
                animate={{
                  x: Math.cos(rad) * s.dist,
                  y: Math.sin(rad) * s.dist,
                  scale: [0, 1.4, 0],
                  opacity: [0, 1, 0],
                }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.9, delay: s.delay, ease: "easeOut" }}
              />
            );
          })}
        </div>
      )}
    </AnimatePresence>
  );
}

// ---------------------------------------------------------------------------
// A single dealt card with a deal-in slide/spin from the shoe.
// ---------------------------------------------------------------------------
function DealtCard({
  card,
  faceDown,
  visible,
  dealDelay,
  highlight,
  size = "md",
}: {
  card: Card | null;
  faceDown: boolean;
  visible: boolean;
  dealDelay: number;
  highlight?: boolean;
  size?: "sm" | "md" | "lg";
}) {
  return (
    <motion.div
      initial={{ x: -180, y: -120, rotate: -45, opacity: 0, scale: 0.7 }}
      animate={
        visible
          ? { x: 0, y: 0, rotate: 0, opacity: 1, scale: 1 }
          : { x: -180, y: -120, rotate: -45, opacity: 0, scale: 0.7 }
      }
      transition={{
        type: "spring",
        stiffness: 260,
        damping: 22,
        delay: visible ? dealDelay : 0,
      }}
    >
      <PlayingCard card={card} faceDown={faceDown} size={size} highlight={highlight} />
    </motion.div>
  );
}

export default function CaribbeanStud() {
  const wallet = useWallet();
  const { balance, bet: placeBet, win, ready } = wallet;

  const [ante, setAnte] = useState(25);
  const [phase, setPhase] = useState<Phase>("betting");

  const [playerCards, setPlayerCards] = useState<Card[]>([]);
  const [dealerCards, setDealerCards] = useState<Card[]>([]);
  // Which dealer card indices are currently shown face up.
  const [dealerRevealed, setDealerRevealed] = useState<boolean[]>([
    true, false, false, false, false,
  ]);
  // How many cards have been dealt (drives staggered deal-in).
  const [dealtCount, setDealtCount] = useState(0);

  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [resultText, setResultText] = useState("");
  const [resultDetail, setResultDetail] = useState("");
  const [netDelta, setNetDelta] = useState(0);
  const [qualifies, setQualifies] = useState<boolean | null>(null);
  const [showBurst, setShowBurst] = useState(false);
  const [bigWin, setBigWin] = useState(false);
  // Currently staked chips locked on the table (ante + raise).
  const [staked, setStaked] = useState({ ante: 0, raise: 0 });

  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const clearTimers = useCallback(() => {
    timers.current.forEach((t) => clearTimeout(t));
    timers.current = [];
  }, []);
  const after = useCallback((ms: number, fn: () => void) => {
    const t = setTimeout(fn, ms);
    timers.current.push(t);
  }, []);

  useEffect(() => () => clearTimers(), [clearTimers]);

  const playerEval = useMemo(
    () => (playerCards.length === 5 ? evaluate5(playerCards) : null),
    [playerCards],
  );
  const dealerEval = useMemo(
    () => (dealerCards.length === 5 ? evaluate5(dealerCards) : null),
    [dealerCards],
  );

  const inRound = phase !== "betting" && phase !== "result";
  const maxAnte = Math.floor(balance / 3); // need room for ante + 2x raise

  // -------------------------------------------------------------------------
  // Deal a fresh hand.
  // -------------------------------------------------------------------------
  const deal = useCallback(() => {
    if (phase !== "betting" && phase !== "result") return;
    const a = Math.floor(ante);
    if (a < MIN_BET) return;
    // Must be able to cover ante now AND a possible 2x raise later.
    if (a * 3 > balance) return;
    if (!placeBet(a)) return; // deduct ante up front

    clearTimers();
    const shoe = makeShoe(1);
    const player = shoe.slice(0, 5);
    const dealer = shoe.slice(5, 10);

    setStaked({ ante: a, raise: 0 });
    setPlayerCards(player);
    setDealerCards(dealer);
    setDealerRevealed([true, false, false, false, false]);
    setDealtCount(0);
    setOutcome(null);
    setResultText("");
    setResultDetail("");
    setNetDelta(0);
    setQualifies(null);
    setShowBurst(false);
    setBigWin(false);
    setPhase("dealing");

    // Stagger the deal: 5 player + 5 dealer = 10 cards.
    for (let i = 1; i <= 10; i++) {
      after(i * 130, () => {
        setDealtCount(i);
        sfx.card();
      });
    }
    after(10 * 130 + 250, () => setPhase("decision"));
  }, [phase, ante, balance, placeBet, clearTimers, after]);

  // -------------------------------------------------------------------------
  // Resolve the showdown once dealer cards are all flipped.
  // -------------------------------------------------------------------------
  const resolve = useCallback(
    (raiseAmt: number) => {
      const pEval = evaluate5(playerCards);
      const dEval = evaluate5(dealerCards);
      const dQual = dealerQualifies(dealerCards);
      setQualifies(dQual);

      const a = staked.ante;
      let payout = 0; // gross to credit via win()
      let result: Outcome = "lose"; // default; always overwritten in every branch below
      let text = "";
      let detail = "";

      if (!dQual) {
        // Dealer doesn't qualify: ante pays 1:1, raise pushes (returned).
        payout = a * 2 + raiseAmt; // ante stake + ante profit + raise back
        result = "win";
        text = "Dealer Doesn't Qualify";
        detail = `Ante pays 1:1 · Raise pushes${
          raiseAmt > 0 ? ` (${formatChips(raiseAmt)} returned)` : ""
        }`;
      } else {
        const cmp = pEval.score - dEval.score;
        if (cmp > 0) {
          // Player wins: ante 1:1, raise per paytable on player's hand.
          const mult = raiseMultiplierFor(pEval.category);
          const anteReturn = a * 2; // stake + 1:1
          const raiseReturn = raiseAmt + raiseAmt * mult; // stake + mult profit
          payout = anteReturn + raiseReturn;
          result = "win";
          text = "You Win!";
          detail = `${pEval.name} beats ${dEval.name} · Raise pays ${mult}:1`;
        } else if (cmp < 0) {
          payout = 0;
          result = "lose";
          text = "Dealer Wins";
          detail = `${dEval.name} beats your ${pEval.name}`;
        } else {
          payout = a + raiseAmt; // full push
          result = "push";
          text = "Push";
          detail = `Tie — ${pEval.name} · stakes returned`;
        }
      }

      const totalStaked = a + raiseAmt;
      const net = payout - totalStaked;

      if (payout > 0) win(payout);

      setOutcome(result);
      setResultText(text);
      setResultDetail(detail);
      setNetDelta(net);
      setPhase("result");

      if (result === "win") {
        const big = net >= a * 6;
        setBigWin(big);
        setShowBurst(true);
        if (big) sfx.jackpot();
        else sfx.win();
        after(1100, () => setShowBurst(false));
      } else if (result === "lose") {
        sfx.lose();
      } else {
        sfx.thud();
      }
    },
    [playerCards, dealerCards, staked.ante, win, after],
  );

  // -------------------------------------------------------------------------
  // Flip the dealer's hidden cards one by one, then resolve.
  // -------------------------------------------------------------------------
  const revealDealer = useCallback(
    (raiseAmt: number) => {
      setPhase("revealing");
      // Flip cards 1..4 (index 0 already up) one at a time.
      const flipGap = 420;
      for (let i = 1; i <= 4; i++) {
        after(i * flipGap, () => {
          setDealerRevealed((prev) => {
            const next = [...prev];
            next[i] = true;
            return next;
          });
          sfx.card();
        });
      }
      after(4 * flipGap + 520, () => resolve(raiseAmt));
    },
    [after, resolve],
  );

  const onRaise = useCallback(() => {
    if (phase !== "decision") return;
    const raiseAmt = staked.ante * 2;
    if (!placeBet(raiseAmt)) return; // shouldn't happen — we reserved room
    sfx.chip();
    setStaked((s) => ({ ...s, raise: raiseAmt }));
    revealDealer(raiseAmt);
  }, [phase, staked.ante, placeBet, revealDealer]);

  const onFold = useCallback(() => {
    if (phase !== "decision") return;
    sfx.thud();
    // Forfeit the ante. Still reveal the dealer for drama.
    setPhase("revealing");
    const flipGap = 380;
    for (let i = 1; i <= 4; i++) {
      after(i * flipGap, () => {
        setDealerRevealed((prev) => {
          const next = [...prev];
          next[i] = true;
          return next;
        });
        sfx.card();
      });
    }
    after(4 * flipGap + 420, () => {
      setQualifies(dealerQualifies(dealerCards));
      setOutcome("lose");
      setResultText("Folded");
      setResultDetail(`Ante forfeited (${formatChips(staked.ante)})`);
      setNetDelta(-staked.ante);
      setPhase("result");
      sfx.lose();
    });
  }, [phase, dealerCards, staked.ante, after]);

  const newRound = useCallback(() => {
    clearTimers();
    setPhase("betting");
    setPlayerCards([]);
    setDealerCards([]);
    setDealerRevealed([true, false, false, false, false]);
    setDealtCount(0);
    setOutcome(null);
    setResultText("");
    setResultDetail("");
    setNetDelta(0);
    setQualifies(null);
    setShowBurst(false);
    setBigWin(false);
    setStaked({ ante: 0, raise: 0 });
  }, [clearTimers]);

  const canDeal = ready && ante >= MIN_BET && ante * 3 <= balance;
  const raiseCost = staked.ante * 2;

  const outcomeColor =
    outcome === "win" ? ACCENT : outcome === "lose" ? "#ef4444" : "#f5d060";

  // Highlight winning side's cards at result.
  const playerWon =
    phase === "result" && outcome === "win" && resultText !== "Folded";
  const dealerWon = phase === "result" && outcome === "lose";

  return (
    <div className="mx-auto w-full max-w-5xl">
      <div
        className="felt relative overflow-hidden rounded-3xl p-4 sm:p-6"
        style={{ boxShadow: `0 0 0 1px ${ACCENT}22, 0 24px 60px rgba(0,0,0,0.5)` }}
      >
        <WinBurst show={showBurst} big={bigWin} />

        {/* Header */}
        <div className="mb-2 flex flex-wrap items-center justify-between gap-3 sm:mb-4">
          <div className="flex items-center gap-3">
            <span className="text-3xl drop-shadow">🏝️</span>
            <div>
              <h2
                className="font-display text-xl font-bold tracking-wide sm:text-2xl"
                style={{ color: ACCENT }}
              >
                Caribbean Stud
              </h2>
              <p className="text-[11px] uppercase tracking-widest text-white/40">
                Stud poker vs the dealer
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className="rounded-xl border border-white/10 bg-black/40 px-4 py-2 text-center">
              <div className="text-[9px] uppercase tracking-widest text-white/40">
                Balance
              </div>
              <CountingNumber
                value={balance}
                className="tabular-nums text-lg font-bold text-white"
              />
            </div>
            <div
              className="rounded-xl border px-4 py-2 text-center"
              style={{ borderColor: `${ACCENT}55`, background: `${ACCENT}11` }}
            >
              <div className="text-[9px] uppercase tracking-widest text-white/40">
                On Table
              </div>
              <div
                className="tabular-nums text-lg font-bold"
                style={{ color: ACCENT }}
              >
                {formatChips(staked.ante + staked.raise)}
              </div>
            </div>
          </div>
        </div>

        <div className="grid gap-2 sm:gap-4 lg:grid-cols-[1fr_240px]">
          {/* Table surface */}
          <div className="relative">
            {/* Dealer row */}
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-widest text-white/50">
                Dealer
              </span>
              <AnimatePresence>
                {qualifies !== null && (
                  <motion.span
                    initial={{ opacity: 0, scale: 0.7 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0 }}
                    className="rounded-full px-3 py-1 text-[11px] font-bold uppercase tracking-wider"
                    style={{
                      color: qualifies ? "#fff" : "#fbbf24",
                      background: qualifies ? `${ACCENT}33` : "#78350f55",
                      border: `1px solid ${qualifies ? ACCENT : "#f59e0b"}`,
                    }}
                  >
                    {qualifies ? "Qualifies ✓" : "No Qualify ✗"}
                  </motion.span>
                )}
              </AnimatePresence>
            </div>
            <div className="flex min-h-[100px] flex-wrap gap-1.5 sm:gap-2 [@media(max-height:600px)]:min-h-[80px]">
              {[0, 1, 2, 3, 4].map((i) => {
                const dealt = dealtCount >= 6 + i; // dealer cards dealt after 5 player
                const card = dealerCards[i] ?? null;
                return (
                  <DealtCard
                    key={`d-${i}-${card?.id ?? "x"}`}
                    card={card}
                    faceDown={!dealerRevealed[i]}
                    visible={dealt}
                    dealDelay={0}
                    highlight={dealerWon && dealerRevealed[i]}
                    size="md"
                  />
                );
              })}
              {dealerCards.length === 0 &&
                [0, 1, 2, 3, 4].map((i) => (
                  <div
                    key={`dp-${i}`}
                    className="h-[92px] w-[66px] rounded-lg border border-dashed border-white/10"
                  />
                ))}
            </div>
            {dealerEval && phase === "result" && (
              <motion.div
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                className="mt-1.5 text-xs font-semibold text-white/60"
              >
                {dealerEval.name}
              </motion.div>
            )}

            {/* Center result banner */}
            <div className="my-2 flex min-h-[44px] items-center justify-center sm:my-3 [@media(max-height:600px)]:my-1 [@media(max-height:600px)]:min-h-[36px]">
              <AnimatePresence mode="wait">
                {phase === "result" ? (
                  <motion.div
                    key="result"
                    data-testid="round-result"
                    initial={{ opacity: 0, scale: 0.8, y: 8 }}
                    animate={{ opacity: 1, scale: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.8 }}
                    transition={{ type: "spring", stiffness: 300, damping: 18 }}
                    className="flex flex-col items-center text-center"
                  >
                    <div
                      className="font-display text-2xl font-extrabold tracking-wide sm:text-3xl"
                      style={{ color: outcomeColor, textShadow: `0 0 18px ${outcomeColor}66` }}
                    >
                      {resultText}
                    </div>
                    <div className="text-xs text-white/60">{resultDetail}</div>
                    {netDelta !== 0 && (
                      <motion.div
                        initial={{ opacity: 0, y: 4 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: 0.15 }}
                        className="mt-1 text-lg font-bold tabular-nums"
                        style={{ color: outcomeColor }}
                      >
                        {formatDelta(netDelta)}
                      </motion.div>
                    )}
                  </motion.div>
                ) : phase === "decision" ? (
                  <motion.div
                    key="decide"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="text-center"
                  >
                    <div
                      className="font-display text-lg font-bold tracking-wide"
                      style={{ color: ACCENT }}
                    >
                      Raise or Fold?
                    </div>
                    <div className="text-[11px] text-white/50">
                      Raise costs {formatChips(raiseCost)} (2× ante)
                    </div>
                  </motion.div>
                ) : phase === "revealing" ? (
                  <motion.div
                    key="reveal"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="font-display text-lg font-semibold tracking-widest text-white/60"
                  >
                    Revealing…
                  </motion.div>
                ) : null}
              </AnimatePresence>
            </div>

            {/* Player row */}
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-widest text-white/50">
                You
              </span>
              {playerEval && phase !== "betting" && (
                <motion.span
                  key={playerEval.score}
                  initial={{ opacity: 0, scale: 0.8 }}
                  animate={{ opacity: 1, scale: 1 }}
                  className="rounded-full px-3 py-1 text-[11px] font-bold uppercase tracking-wider"
                  style={{
                    color: ACCENT,
                    background: `${ACCENT}1f`,
                    border: `1px solid ${ACCENT}66`,
                  }}
                >
                  {playerEval.name}
                </motion.span>
              )}
            </div>
            <div className="flex min-h-[100px] flex-wrap gap-1.5 sm:gap-2 [@media(max-height:600px)]:min-h-[80px]">
              {[0, 1, 2, 3, 4].map((i) => {
                const dealt = dealtCount >= 1 + i;
                const card = playerCards[i] ?? null;
                return (
                  <DealtCard
                    key={`p-${i}-${card?.id ?? "x"}`}
                    card={card}
                    faceDown={false}
                    visible={dealt}
                    dealDelay={0}
                    highlight={playerWon}
                    size="md"
                  />
                );
              })}
              {playerCards.length === 0 &&
                [0, 1, 2, 3, 4].map((i) => (
                  <div
                    key={`pp-${i}`}
                    className="h-[92px] w-[66px] rounded-lg border border-dashed border-white/10"
                  />
                ))}
            </div>

            {/* Action area */}
            <div className="mt-3 sm:mt-5 [@media(max-height:600px)]:mt-2">
              {phase === "betting" || phase === "result" ? (
                <div className="space-y-3">
                  <BetControls
                    bet={ante}
                    setBet={setAnte}
                    balance={balance}
                    min={MIN_BET}
                    max={Math.max(MIN_BET, maxAnte)}
                    chips={[5, 25, 100, 500, 1000]}
                    disabled={inRound}
                  />
                  <div className="flex flex-wrap items-center justify-center gap-3">
                    {phase === "result" && (
                      <Button
                        variant="ghost"
                        size="lg"
                        onClick={newRound}
                        data-testid="new-round-btn"
                      >
                        Clear Table
                      </Button>
                    )}
                    <Button
                      variant="gold"
                      size="lg"
                      onClick={deal}
                      disabled={!canDeal}
                      data-testid="play-btn"
                    >
                      {phase === "result" ? "Deal Again" : "Deal"} ·{" "}
                      {formatChips(Math.floor(ante))}
                    </Button>
                  </div>
                  {ante * 3 > balance && ante >= MIN_BET && (
                    <p className="text-center text-[11px] text-amber-400/80">
                      Need {formatChips(ante * 3)} free (ante + possible 2× raise).
                    </p>
                  )}
                </div>
              ) : (
                <div className="flex flex-wrap items-center justify-center gap-3">
                  <Button
                    variant="danger"
                    size="lg"
                    onClick={onFold}
                    disabled={phase !== "decision"}
                    data-testid="fold-btn"
                  >
                    Fold
                  </Button>
                  <Button
                    variant="neon"
                    size="lg"
                    onClick={onRaise}
                    disabled={phase !== "decision"}
                    data-testid="raise-btn"
                  >
                    Raise · {formatChips(raiseCost)}
                  </Button>
                </div>
              )}
            </div>
          </div>

          {/* Paytable / odds panel */}
          <CollapsiblePanel
            title="Raise Pays"
            accent={ACCENT}
            summary={<>up to 100:1</>}
          >
            <ul className="space-y-1 text-[12px]">
              {RAISE_TABLE.map((row) => {
                const active =
                  phase === "result" &&
                  outcome === "win" &&
                  resultText === "You Win!" &&
                  playerEval?.category === row.category;
                return (
                  <li
                    key={row.label}
                    className="flex items-center justify-between rounded-md px-2 py-1 transition-colors"
                    style={{
                      background: active ? `${ACCENT}33` : "transparent",
                      color: active ? "#fff" : "rgba(255,255,255,0.7)",
                      fontWeight: active ? 700 : 400,
                    }}
                  >
                    <span>{row.label}</span>
                    <span className="tabular-nums" style={{ color: active ? ACCENT : undefined }}>
                      {row.raise}:1
                    </span>
                  </li>
                );
              })}
            </ul>

            <div className="my-3 h-px bg-white/10" />

            <div className="space-y-1.5 text-[11px] leading-relaxed text-white/55">
              <p>
                <span className="font-semibold text-white/80">Ante</span> pays 1:1
                on any win.
              </p>
              <p>
                Dealer must hold{" "}
                <span className="font-semibold" style={{ color: ACCENT }}>
                  A-K high or better
                </span>{" "}
                to qualify.
              </p>
              <p>
                No qualify → ante pays 1:1, raise{" "}
                <span className="font-semibold text-white/80">pushes</span>.
              </p>
              <p>Tie → all stakes returned.</p>
            </div>

            <div className="my-3 h-px bg-white/10" />
            <div className="flex items-center justify-between text-[11px] text-white/55">
              <span>Lifetime rounds</span>
              <span className="tabular-nums text-white/80">
                {formatChips(wallet.rounds)}
              </span>
            </div>
            <div className="flex items-center justify-between text-[11px] text-white/55">
              <span>Biggest win</span>
              <span className="tabular-nums" style={{ color: ACCENT }}>
                {formatChips(wallet.biggestWin)}
              </span>
            </div>
          </CollapsiblePanel>
        </div>
      </div>
    </div>
  );
}
