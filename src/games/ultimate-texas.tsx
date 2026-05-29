"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AnimatePresence,
  motion,
  useMotionValue,
  useTransform,
  animate,
} from "framer-motion";
import { useWallet } from "@/lib/wallet";
import {
  type Card,
  makeShoe,
  evaluateBest,
  HandCategory,
} from "@/lib/cards";
import { sleep } from "@/lib/async";
import { formatChips, formatDelta } from "@/lib/format";
import { sfx } from "@/lib/sound";
import { Button } from "@/components/ui/Button";
import { Chip } from "@/components/ui/Chip";
import { PlayingCard } from "@/components/PlayingCard";
import { CollapsiblePanel } from "@/components/CollapsiblePanel";

const ACCENT = "#27ae60";
const ACCENT_SOFT = "rgba(39,174,96,0.18)";

// ---------------------------------------------------------------------------
// Paytables
// ---------------------------------------------------------------------------

/** BLIND bonus paytable — multiplier is the PROFIT ratio (X:1). Pays only on a
 *  player win; "< straight" pushes (ratio 0). */
const BLIND_PAY: { cat: HandCategory; label: string; ratio: number }[] = [
  { cat: HandCategory.RoyalFlush, label: "Royal Flush", ratio: 500 },
  { cat: HandCategory.StraightFlush, label: "Straight Flush", ratio: 50 },
  { cat: HandCategory.FourOfAKind, label: "Four of a Kind", ratio: 10 },
  { cat: HandCategory.FullHouse, label: "Full House", ratio: 3 },
  { cat: HandCategory.Flush, label: "Flush", ratio: 1.5 },
  { cat: HandCategory.Straight, label: "Straight", ratio: 1 },
];

function blindRatio(cat: HandCategory): number {
  const row = BLIND_PAY.find((r) => r.cat === cat);
  return row ? row.ratio : 0; // less than straight -> push (no extra, no loss)
}

/** TRIPS side bet — pays on the player's final hand regardless of the result. */
const TRIPS_PAY: { cat: HandCategory; label: string; ratio: number }[] = [
  { cat: HandCategory.RoyalFlush, label: "Royal Flush", ratio: 50 },
  { cat: HandCategory.StraightFlush, label: "Straight Flush", ratio: 40 },
  { cat: HandCategory.FourOfAKind, label: "Four of a Kind", ratio: 30 },
  { cat: HandCategory.FullHouse, label: "Full House", ratio: 8 },
  { cat: HandCategory.Flush, label: "Flush", ratio: 6 },
  { cat: HandCategory.Straight, label: "Straight", ratio: 5 },
  { cat: HandCategory.ThreeOfAKind, label: "Three of a Kind", ratio: 3 },
];

function tripsRatio(cat: HandCategory): number {
  const row = TRIPS_PAY.find((r) => r.cat === cat);
  return row ? row.ratio : -1; // -1 == loses
}

// ---------------------------------------------------------------------------
// Game phases
// ---------------------------------------------------------------------------

type Phase =
  | "betting" // set ante/trips, deal
  | "preflop" // saw 2 hole cards: check or bet 3x/4x
  | "flop" // saw 3 community: check or bet 2x (only if checked pre-flop)
  | "river" // saw 5 community: bet 1x or fold (only if checked twice)
  | "showdown" // everything revealed, settled
  ;

interface Settlement {
  net: number; // net change to balance this round (profit, can be negative)
  win: boolean; // did the player come out ahead (or push positive)
  push: boolean;
  folded: boolean;
  headline: string;
  lines: { label: string; amount: number }[];
  playerCat: HandCategory;
  dealerCat: HandCategory;
  dealerQualified: boolean;
}

const CHIP_DENOMS = [5, 25, 100, 500];

// ---------------------------------------------------------------------------
// Animated number counter
// ---------------------------------------------------------------------------

function Counter({ value, className }: { value: number; className?: string }) {
  const mv = useMotionValue(value);
  const text = useTransform(mv, (v) => formatChips(v));
  useEffect(() => {
    const controls = animate(mv, value, { duration: 0.5, ease: "easeOut" });
    return controls.stop;
  }, [value, mv]);
  return <motion.span className={className}>{text}</motion.span>;
}

// ---------------------------------------------------------------------------
// Win burst overlay
// ---------------------------------------------------------------------------

function WinBurst({ show, big }: { show: boolean; big: boolean }) {
  const sparks = useMemo(
    () =>
      Array.from({ length: big ? 26 : 14 }, (_, i) => ({
        id: i,
        angle: (i / (big ? 26 : 14)) * Math.PI * 2,
        dist: 90 + Math.random() * 140,
        size: 6 + Math.random() * 10,
        color: i % 3 === 0 ? "#f5d060" : i % 3 === 1 ? ACCENT : "#22e1ff",
        delay: Math.random() * 0.12,
      })),
    [big],
  );
  return (
    <AnimatePresence>
      {show && (
        <motion.div
          className="pointer-events-none absolute inset-0 z-30 grid place-items-center overflow-hidden"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          {sparks.map((s) => (
            <motion.div
              key={s.id}
              className="absolute rounded-full"
              style={{ width: s.size, height: s.size, background: s.color }}
              initial={{ x: 0, y: 0, opacity: 1, scale: 1 }}
              animate={{
                x: Math.cos(s.angle) * s.dist,
                y: Math.sin(s.angle) * s.dist,
                opacity: 0,
                scale: 0.3,
              }}
              transition={{ duration: 1.1, delay: s.delay, ease: "easeOut" }}
            />
          ))}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// ---------------------------------------------------------------------------
// Bet pad — shows a labeled circular betting spot with stacked chip badge
// ---------------------------------------------------------------------------

function BetSpot({
  label,
  amount,
  active,
  glow,
}: {
  label: string;
  amount: number;
  active?: boolean;
  glow?: boolean;
}) {
  return (
    <div className="flex flex-col items-center gap-1">
      <motion.div
        className="relative grid h-16 w-16 place-items-center rounded-full border-2 sm:h-[72px] sm:w-[72px]"
        style={{
          borderColor: active ? ACCENT : "rgba(255,255,255,0.18)",
          background: active
            ? "radial-gradient(circle at 50% 35%, rgba(39,174,96,0.28), rgba(0,0,0,0.35))"
            : "rgba(0,0,0,0.28)",
          boxShadow: glow ? `0 0 18px ${ACCENT}` : "none",
        }}
        animate={glow ? { scale: [1, 1.06, 1] } : { scale: 1 }}
        transition={glow ? { duration: 1.4, repeat: Infinity } : {}}
      >
        <span className="text-[9px] font-semibold uppercase tracking-widest text-white/55">
          {label}
        </span>
        <AnimatePresence>
          {amount > 0 && (
            <motion.div
              key={amount}
              className="absolute -bottom-2 left-1/2 -translate-x-1/2"
              initial={{ y: -28, opacity: 0, scale: 0.6 }}
              animate={{ y: 0, opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.6 }}
              transition={{ type: "spring", stiffness: 360, damping: 22 }}
            >
              <Chip value={amount} size={34} />
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
      <span className="text-[11px] font-bold tabular-nums text-white/80">
        {amount > 0 ? formatChips(amount) : "—"}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// A single dealt card that flies in from the top (stable identity so the
// fly-in only plays once, on mount).
// ---------------------------------------------------------------------------

function DealtCard({
  card,
  faceDown,
  delay,
  highlight,
  size = "md",
}: {
  card: Card | null;
  faceDown?: boolean;
  delay: number;
  highlight?: boolean;
  size?: "sm" | "md" | "lg";
}) {
  return (
    <motion.div
      initial={{ y: -120, opacity: 0, rotate: -8 }}
      animate={{ y: 0, opacity: 1, rotate: 0 }}
      transition={{ type: "spring", stiffness: 300, damping: 24, delay }}
    >
      <PlayingCard card={card} faceDown={faceDown} size={size} highlight={highlight} />
    </motion.div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function UltimateTexasHoldem() {
  const wallet = useWallet();

  // Guards async reveal sequences against setState-after-unmount.
  const mountedRef = useRef(true);
  useEffect(() => () => {
    mountedRef.current = false;
  }, []);

  // bet config
  const [ante, setAnte] = useState(25);
  const [trips, setTrips] = useState(0);

  // round state
  const [phase, setPhase] = useState<Phase>("betting");
  const [playerHole, setPlayerHole] = useState<Card[]>([]);
  const [dealerHole, setDealerHole] = useState<Card[]>([]);
  const [community, setCommunity] = useState<Card[]>([]);
  const [revealCount, setRevealCount] = useState(0); // how many community face-up
  const [dealerRevealed, setDealerRevealed] = useState(false);

  const [playBet, setPlayBet] = useState(0); // the PLAY raise amount
  const [settle, setSettle] = useState<Settlement | null>(null);
  const [busy, setBusy] = useState(false); // animations in flight
  const [showBurst, setShowBurst] = useState(false);
  const [bigBurst, setBigBurst] = useState(false);
  const [highlightBest, setHighlightBest] = useState<Set<string>>(new Set());

  const balance = wallet.balance;
  const inRound = phase !== "betting";

  // ----- helpers ----------------------------------------------------------

  const canAfford = useCallback(
    (extra: number) => extra <= wallet.balance,
    [wallet.balance],
  );

  // ----- deal --------------------------------------------------------------

  const startRound = useCallback(async () => {
    if (busy || inRound) return;
    if (ante < 1) return;
    // ante + blind posted now; trips posted now. Play bet comes later.
    const upfront = ante * 2 + trips;
    if (!canAfford(upfront)) return;
    if (!wallet.bet(upfront)) return; // deduct ante+blind+trips together

    setBusy(true);
    setSettle(null);
    setPlayBet(0);
    setShowBurst(false);
    setBigBurst(false);
    setHighlightBest(new Set());
    setDealerRevealed(false);
    setRevealCount(0);

    const shoe = makeShoe(1);
    const ph: Card[] = [shoe[0], shoe[2]];
    const dh: Card[] = [shoe[1], shoe[3]];
    const comm: Card[] = [shoe[4], shoe[5], shoe[6], shoe[7], shoe[8]];

    setPlayerHole([]);
    setDealerHole([]);
    setCommunity(comm);

    // animated deal: player1, dealer1, player2, dealer2
    await sleep(120);
    if (!mountedRef.current) return;
    setPlayerHole([ph[0]]);
    sfx.card();
    await sleep(180);
    if (!mountedRef.current) return;
    setDealerHole([dh[0]]);
    sfx.card();
    await sleep(180);
    if (!mountedRef.current) return;
    setPlayerHole([ph[0], ph[1]]);
    sfx.card();
    await sleep(180);
    if (!mountedRef.current) return;
    setDealerHole([dh[0], dh[1]]);
    sfx.card();
    await sleep(260);
    if (!mountedRef.current) return;
    setPhase("preflop");
    setBusy(false);
  }, [busy, inRound, ante, trips, canAfford, wallet]);

  // ----- settlement --------------------------------------------------------

  // Commit a settlement + trigger feedback. Declared before `resolve` so it
  // can be properly included in resolve's dependency array.
  const finishSettle = useCallback(
    (s: Settlement & { best: Card[] }) => {
      const { best, ...settlement } = s;
      setSettle(settlement);
      setHighlightBest(new Set(best.map((c) => c.id)));

      if (settlement.net > 0) {
        const big = settlement.net >= ante * 10;
        setShowBurst(true);
        setBigBurst(big);
        if (big) sfx.jackpot();
        else sfx.win();
        setTimeout(() => setShowBurst(false), 1300);
      } else if (settlement.net < 0) {
        sfx.lose();
      } else {
        sfx.thud();
      }
    },
    [ante],
  );

  const resolve = useCallback(
    (finalPlay: number, folded: boolean) => {
      // Build full hands.
      const pHand = evaluateBest([...playerHole, ...community]);
      const dHand = evaluateBest([...dealerHole, ...community]);
      const dealerQualified = dHand.category >= HandCategory.Pair;

      const lines: { label: string; amount: number }[] = [];
      let net = 0; // profit relative to all chips already deducted

      // --- Trips side bet (resolves regardless of fold / outcome) ---------
      if (trips > 0) {
        const tr = tripsRatio(pHand.category);
        if (tr >= 0) {
          const gross = trips * (tr + 1);
          wallet.win(gross);
          net += gross - trips;
          lines.push({ label: `Trips (${pHand.name})`, amount: gross - trips });
        } else {
          net -= trips;
          lines.push({ label: "Trips", amount: -trips });
        }
      }

      if (folded) {
        // Forfeit ante + blind. (Trips already settled above.)
        net -= ante * 2;
        lines.push({ label: "Ante", amount: -ante });
        lines.push({ label: "Blind", amount: -ante });
        return finishSettle({
          net,
          win: net > 0,
          push: false,
          folded: true,
          headline: "Folded",
          lines,
          playerCat: pHand.category,
          dealerCat: dHand.category,
          dealerQualified,
          best: pHand.best,
        });
      }

      const cmp = pHand.score - dHand.score; // >0 player wins
      const playerWins = cmp > 0;
      const tie = cmp === 0;

      // --- PLAY bet: 1:1 on win, push on tie, loss otherwise -------------
      if (playerWins) {
        wallet.win(finalPlay * 2);
        net += finalPlay;
        lines.push({ label: "Play", amount: finalPlay });
      } else if (tie) {
        wallet.win(finalPlay); // push
        lines.push({ label: "Play (push)", amount: 0 });
      } else {
        net -= finalPlay;
        lines.push({ label: "Play", amount: -finalPlay });
      }

      // --- ANTE: pays 1:1 on win, but PUSHES if dealer doesn't qualify;
      //           loses if dealer wins; pushes on tie. -------------------
      if (playerWins) {
        if (dealerQualified) {
          wallet.win(ante * 2);
          net += ante;
          lines.push({ label: "Ante", amount: ante });
        } else {
          wallet.win(ante); // push — dealer didn't qualify
          lines.push({ label: "Ante (push)", amount: 0 });
        }
      } else if (tie) {
        wallet.win(ante); // push
        lines.push({ label: "Ante (push)", amount: 0 });
      } else {
        net -= ante;
        lines.push({ label: "Ante", amount: -ante });
      }

      // --- BLIND: pays bonus paytable on player win only; push if win but
      //            < straight; loses on a dealer win; pushes on tie. -----
      if (playerWins) {
        const ratio = blindRatio(pHand.category);
        if (ratio > 0) {
          const profit = Math.round(ante * ratio);
          wallet.win(ante + profit); // stake back + bonus profit
          net += profit;
          lines.push({ label: `Blind (${pHand.name})`, amount: profit });
        } else {
          wallet.win(ante); // push — win but below a straight
          lines.push({ label: "Blind (push)", amount: 0 });
        }
      } else if (tie) {
        wallet.win(ante); // push
        lines.push({ label: "Blind (push)", amount: 0 });
      } else {
        net -= ante;
        lines.push({ label: "Blind", amount: -ante });
      }

      let headline: string;
      if (tie) headline = "Push";
      else if (playerWins) headline = "You Win!";
      else headline = "Dealer Wins";

      return finishSettle({
        net,
        win: playerWins,
        push: tie,
        folded: false,
        headline,
        lines,
        playerCat: pHand.category,
        dealerCat: dHand.category,
        dealerQualified,
        best: pHand.best,
      });
    },
    [playerHole, dealerHole, community, ante, trips, wallet, finishSettle],
  );

  // ----- reveal sequence to showdown --------------------------------------

  const goToShowdown = useCallback(
    async (finalPlay: number, folded: boolean) => {
      setBusy(true);

      // Reveal any community cards not yet shown.
      const target = 5;
      let shown = revealCount;
      while (shown < target) {
        shown += 1;
        setRevealCount(shown);
        sfx.card();
        // eslint-disable-next-line no-await-in-loop
        await sleep(260);
        if (!mountedRef.current) return;
        }

      // Flip the dealer's hole cards.
      await sleep(220);
      if (!mountedRef.current) return;
      setDealerRevealed(true);
      sfx.card();
      await sleep(520);
      if (!mountedRef.current) return;
      setPhase("showdown");
      resolve(finalPlay, folded);
      setBusy(false);
    },
    [revealCount, resolve],
  );

  // ----- player decisions --------------------------------------------------

  // Pre-flop raise (3x or 4x). Posts the play bet, then runs straight to showdown.
  const raisePreflop = useCallback(
    (mult: 3 | 4) => {
      if (busy || phase !== "preflop") return;
      const amt = ante * mult;
      if (!canAfford(amt)) return;
      if (!wallet.bet(amt)) return;
      setBusy(true);
      setPlayBet(amt);
      sfx.chip();
      void goToShowdown(amt, false);
    },
    [busy, phase, ante, canAfford, wallet, goToShowdown],
  );

  // Pre-flop check -> reveal flop.
  const checkPreflop = useCallback(async () => {
    if (busy || phase !== "preflop") return;
    sfx.click();
    setBusy(true);
    // reveal 3 flop cards
    for (let i = 1; i <= 3; i++) {
      setRevealCount(i);
      sfx.card();
      // eslint-disable-next-line no-await-in-loop
      await sleep(240);
      if (!mountedRef.current) return;
      }
    await sleep(180);
    if (!mountedRef.current) return;
    setPhase("flop");
    setBusy(false);
  }, [busy, phase]);

  // Flop raise (2x). Posts play bet, runs to showdown.
  const raiseFlop = useCallback(() => {
    if (busy || phase !== "flop") return;
    const amt = ante * 2;
    if (!canAfford(amt)) return;
    if (!wallet.bet(amt)) return;
    setBusy(true);
    setPlayBet(amt);
    sfx.chip();
    void goToShowdown(amt, false);
  }, [busy, phase, ante, canAfford, wallet, goToShowdown]);

  // Flop check -> go to river decision (reveal turn + river).
  const checkFlop = useCallback(async () => {
    if (busy || phase !== "flop") return;
    sfx.click();
    setBusy(true);
    for (let i = 4; i <= 5; i++) {
      setRevealCount(i);
      sfx.card();
      // eslint-disable-next-line no-await-in-loop
      await sleep(260);
      if (!mountedRef.current) return;
      }
    await sleep(180);
    if (!mountedRef.current) return;
    setPhase("river");
    setBusy(false);
  }, [busy, phase]);

  // River play (1x) — community already fully shown, just flip dealer.
  const playRiver = useCallback(() => {
    if (busy || phase !== "river") return;
    const amt = ante;
    if (!canAfford(amt)) return;
    if (!wallet.bet(amt)) return;
    setBusy(true);
    setPlayBet(amt);
    sfx.chip();
    void goToShowdown(amt, false);
  }, [busy, phase, ante, canAfford, wallet, goToShowdown]);

  // River fold — loses ante + blind.
  const fold = useCallback(() => {
    if (busy || phase !== "river") return;
    setBusy(true);
    sfx.click();
    void goToShowdown(0, true);
  }, [busy, phase, goToShowdown]);

  // ----- new round / reset -------------------------------------------------

  const nextRound = useCallback(() => {
    setPhase("betting");
    setPlayerHole([]);
    setDealerHole([]);
    setCommunity([]);
    setRevealCount(0);
    setDealerRevealed(false);
    setPlayBet(0);
    setSettle(null);
    setShowBurst(false);
    setHighlightBest(new Set());
  }, []);

  // ----- derived UI --------------------------------------------------------

  const communityToShow = Math.max(revealCount, 0);
  const dealerFaceDown = !dealerRevealed;

  const decisionLabel =
    phase === "preflop"
      ? "Pre-Flop — Check or raise the Play"
      : phase === "flop"
        ? "Flop — Check or raise 2×"
        : phase === "river"
          ? "Turn & River — make the Play or fold"
          : "";

  const netDelta = settle?.net ?? 0;

  // ===========================================================================

  return (
    <div className="mx-auto w-full max-w-5xl">
      {/* ---------------- Table surface ---------------- */}
      <div className="felt relative overflow-hidden rounded-3xl p-4 shadow-felt sm:p-6">
        <WinBurst show={showBurst} big={bigBurst} />

        {/* Title strip */}
        <div className="mb-3 flex items-center justify-between">
          <div>
            <h2 className="font-display text-xl font-bold text-white sm:text-2xl">
              Ultimate Texas Hold&apos;em
            </h2>
            <p className="text-[11px] uppercase tracking-[0.2em] text-white/45">
              You vs the Dealer
            </p>
          </div>
          <div className="rounded-xl border border-white/10 bg-black/30 px-3 py-1.5 text-right">
            <div className="text-[9px] uppercase tracking-widest text-white/40">
              Balance
            </div>
            <div className="gold-text text-base font-bold tabular-nums sm:text-lg">
              <Counter value={balance} />
            </div>
          </div>
        </div>

        {/* ---------------- Dealer row ---------------- */}
        <div className="rounded-2xl border border-white/5 bg-black/20 p-3">
          <div className="mb-2 flex items-center justify-between">
            <span
              className="text-xs font-bold uppercase tracking-widest"
              style={{ color: ACCENT }}
            >
              Dealer
            </span>
            {phase === "showdown" && settle && (
              <span
                className="rounded-full px-2 py-0.5 text-[10px] font-semibold"
                style={{
                  background: settle.dealerQualified
                    ? "rgba(255,255,255,0.12)"
                    : "rgba(231,76,60,0.18)",
                  color: settle.dealerQualified ? "#fff" : "#ffb4ab",
                }}
              >
                {settle.dealerQualified ? "Qualified" : "Did not qualify"}
              </span>
            )}
          </div>
          <div className="flex min-h-[72px] items-center gap-2 sm:min-h-[96px]">
            {dealerHole.length === 0 ? (
              <div className="text-sm text-white/30">—</div>
            ) : (
              dealerHole.map((c, i) => (
                <DealtCard
                  key={c.id}
                  card={c}
                  faceDown={dealerFaceDown}
                  delay={i * 0.05}
                />
              ))
            )}
            {phase === "showdown" && settle && (
              <span className="ml-2 text-sm font-semibold text-white/70">
                {(() => {
                  const dHand = evaluateBest([...dealerHole, ...community]);
                  return dHand.name;
                })()}
              </span>
            )}
          </div>
        </div>

        {/* ---------------- Community row ---------------- */}
        <div className="my-2 rounded-2xl border border-white/5 bg-black/10 p-3 sm:my-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[11px] font-bold uppercase tracking-widest text-white/55">
              Community
            </span>
            <span className="text-[10px] uppercase tracking-widest text-white/30">
              Flop · Turn · River
            </span>
          </div>
          <div className="flex min-h-[72px] flex-wrap items-center justify-center gap-2 sm:min-h-[96px] sm:gap-3">
            {community.length === 0 ? (
              <div className="text-sm text-white/30">Waiting for deal…</div>
            ) : (
              [0, 1, 2, 3, 4].map((i) => {
                const revealed = i < communityToShow;
                const card = community[i] ?? null;
                return (
                  <motion.div
                    key={card ? card.id : `slot-${i}`}
                    initial={{ scale: 0.85, opacity: 0.4 }}
                    animate={{ scale: 1, opacity: 1 }}
                    transition={{ type: "spring", stiffness: 280, damping: 22 }}
                  >
                    <PlayingCard
                      card={card}
                      faceDown={!revealed}
                      size="md"
                      highlight={highlightBest.has(card?.id ?? "")}
                    />
                  </motion.div>
                );
              })
            )}
          </div>
        </div>

        {/* ---------------- Player row ---------------- */}
        <div className="rounded-2xl border border-white/5 bg-black/20 p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-bold uppercase tracking-widest text-gold">
              You
            </span>
            {phase === "showdown" && settle && (
              <span className="text-sm font-semibold text-white/80">
                {(() => {
                  const pHand = evaluateBest([...playerHole, ...community]);
                  return pHand.name;
                })()}
              </span>
            )}
          </div>
          <div className="flex min-h-[72px] items-center gap-2 sm:min-h-[96px]">
            {playerHole.length === 0 ? (
              <div className="text-sm text-white/30">—</div>
            ) : (
              playerHole.map((c, i) => (
                <DealtCard
                  key={c.id}
                  card={c}
                  delay={i * 0.05}
                  highlight={highlightBest.has(c.id)}
                />
              ))
            )}
          </div>
        </div>

        {/* ---------------- Bet spots strip ---------------- */}
        <div className="mt-2 flex items-end justify-center gap-4 sm:mt-3 sm:gap-8">
          <BetSpot
            label="Ante"
            amount={inRound || ante > 0 ? ante : 0}
            active={inRound}
          />
          <BetSpot
            label="Blind"
            amount={inRound || ante > 0 ? ante : 0}
            active={inRound}
          />
          <BetSpot
            label="Play"
            amount={playBet}
            active={playBet > 0}
            glow={
              playBet === 0 &&
              (phase === "preflop" || phase === "flop" || phase === "river")
            }
          />
          <BetSpot label="Trips" amount={trips} active={trips > 0} />
        </div>

        {/* ---------------- Round result banner ---------------- */}
        <AnimatePresence>
          {phase === "showdown" && settle && (
            <motion.div
              key="result"
              data-testid="round-result"
              initial={{ y: 24, opacity: 0, scale: 0.9 }}
              animate={{ y: 0, opacity: 1, scale: 1 }}
              exit={{ opacity: 0 }}
              transition={{ type: "spring", stiffness: 280, damping: 20 }}
              className="relative z-20 mx-auto mt-4 max-w-md rounded-2xl border p-4 text-center"
              style={{
                borderColor:
                  netDelta > 0
                    ? ACCENT
                    : netDelta < 0
                      ? "rgba(231,76,60,0.6)"
                      : "rgba(255,255,255,0.25)",
                background:
                  netDelta > 0
                    ? ACCENT_SOFT
                    : netDelta < 0
                      ? "rgba(231,76,60,0.12)"
                      : "rgba(255,255,255,0.06)",
                boxShadow:
                  netDelta > 0 ? `0 0 30px ${ACCENT}` : "none",
              }}
            >
              <div
                className="font-display text-2xl font-bold"
                style={{
                  color:
                    netDelta > 0
                      ? "#eafff3"
                      : netDelta < 0
                        ? "#ffb4ab"
                        : "#fff",
                }}
              >
                {settle.headline}
              </div>
              <motion.div
                className="mt-1 text-xl font-bold tabular-nums"
                initial={{ scale: 0.7 }}
                animate={{ scale: 1 }}
                style={{
                  color:
                    netDelta > 0
                      ? "#7CFFB2"
                      : netDelta < 0
                        ? "#ff8a80"
                        : "#fff",
                }}
              >
                {formatDelta(netDelta)}
              </motion.div>
              <div className="mx-auto mt-3 max-w-[20rem] space-y-0.5 text-left text-[12px]">
                {settle.lines.map((l, i) => (
                  <div
                    key={`${l.label}-${i}`}
                    className="flex justify-between border-b border-white/5 pb-0.5"
                  >
                    <span className="text-white/55">{l.label}</span>
                    <span
                      className="font-semibold tabular-nums"
                      style={{
                        color:
                          l.amount > 0
                            ? "#7CFFB2"
                            : l.amount < 0
                              ? "#ff8a80"
                              : "#fff",
                      }}
                    >
                      {l.amount === 0 ? "push" : formatDelta(l.amount)}
                    </span>
                  </div>
                ))}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* ---------------- Action area ---------------- */}
        <div className="relative z-20 mt-2 sm:mt-4">
          {/* BETTING phase — set ante / trips and deal */}
          {phase === "betting" && (
            <div className="space-y-3">
              <div className="glass rounded-2xl p-3 sm:p-4">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {/* Ante selector */}
                  <div className="rounded-xl border border-white/10 bg-black/30 p-3">
                    <div className="mb-2 flex items-center justify-between">
                      <span className="text-[10px] uppercase tracking-widest text-white/50">
                        Ante + Blind (each)
                      </span>
                      <span className="gold-text text-sm font-bold tabular-nums">
                        {formatChips(ante)}
                      </span>
                    </div>
                    <div className="flex flex-wrap items-center justify-center gap-2">
                      {CHIP_DENOMS.map((v) => (
                        <Chip
                          key={`ante-${v}`}
                          value={v}
                          size={44}
                          onClick={
                            ante + v > balance / 2
                              ? undefined
                              : () => {
                                  sfx.chip();
                                  setAnte((a) => a + v);
                                }
                          }
                        />
                      ))}
                    </div>
                    <div className="mt-2 flex justify-center gap-2">
                      <Button
                        size="sm"
                        variant="ghost"
                        data-testid="ante-clear"
                        onClick={() => setAnte(0)}
                      >
                        Clear
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        data-testid="ante-25"
                        onClick={() => setAnte(25)}
                      >
                        25
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        data-testid="ante-100"
                        onClick={() => setAnte(100)}
                      >
                        100
                      </Button>
                    </div>
                  </div>

                  {/* Trips selector */}
                  <div className="rounded-xl border border-white/10 bg-black/30 p-3">
                    <div className="mb-2 flex items-center justify-between">
                      <span className="text-[10px] uppercase tracking-widest text-white/50">
                        Trips (optional)
                      </span>
                      <span
                        className="text-sm font-bold tabular-nums"
                        style={{ color: ACCENT }}
                      >
                        {formatChips(trips)}
                      </span>
                    </div>
                    <div className="flex flex-wrap items-center justify-center gap-2">
                      {CHIP_DENOMS.map((v) => (
                        <Chip
                          key={`trips-${v}`}
                          value={v}
                          size={44}
                          onClick={
                            ante * 2 + trips + v > balance
                              ? undefined
                              : () => {
                                  sfx.chip();
                                  setTrips((t) => t + v);
                                }
                          }
                        />
                      ))}
                    </div>
                    <div className="mt-2 flex justify-center gap-2">
                      <Button
                        size="sm"
                        variant="ghost"
                        data-testid="trips-clear"
                        onClick={() => setTrips(0)}
                      >
                        Clear
                      </Button>
                    </div>
                  </div>
                </div>

                <div className="mt-3 flex flex-col items-center gap-2">
                  <div className="text-[11px] text-white/50">
                    Posts now:{" "}
                    <span className="font-bold text-white/80">
                      {formatChips(ante * 2 + trips)}
                    </span>{" "}
                    (Ante {formatChips(ante)} + Blind {formatChips(ante)}
                    {trips > 0 ? ` + Trips ${formatChips(trips)}` : ""})
                  </div>
                  <Button
                    data-testid="play-btn"
                    variant="gold"
                    size="lg"
                    disabled={
                      busy ||
                      ante < 1 ||
                      ante * 2 + trips > balance
                    }
                    onClick={() => void startRound()}
                  >
                    Deal
                  </Button>
                  {ante * 2 + trips > balance && ante >= 1 && (
                    <div className="text-[11px] text-ruby">
                      Not enough chips for this bet.
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Decision phases */}
          {(phase === "preflop" || phase === "flop" || phase === "river") && (
            <div className="glass rounded-2xl p-3 sm:p-4">
              <div className="mb-3 text-center text-sm font-semibold text-white/80">
                {decisionLabel}
              </div>
              <div className="flex flex-wrap items-center justify-center gap-2 sm:gap-3">
                {phase === "preflop" && (
                  <>
                    <Button
                      data-testid="raise-4x"
                      variant="gold"
                      size="lg"
                      disabled={busy || !canAfford(ante * 4)}
                      onClick={() => raisePreflop(4)}
                    >
                      Raise 4× ({formatChips(ante * 4)})
                    </Button>
                    <Button
                      data-testid="raise-3x"
                      variant="neon"
                      size="lg"
                      disabled={busy || !canAfford(ante * 3)}
                      onClick={() => raisePreflop(3)}
                    >
                      Raise 3× ({formatChips(ante * 3)})
                    </Button>
                    <Button
                      data-testid="check-btn"
                      variant="ghost"
                      size="lg"
                      disabled={busy}
                      onClick={() => void checkPreflop()}
                    >
                      Check
                    </Button>
                  </>
                )}

                {phase === "flop" && (
                  <>
                    <Button
                      data-testid="raise-2x"
                      variant="gold"
                      size="lg"
                      disabled={busy || !canAfford(ante * 2)}
                      onClick={raiseFlop}
                    >
                      Raise 2× ({formatChips(ante * 2)})
                    </Button>
                    <Button
                      data-testid="check-btn"
                      variant="ghost"
                      size="lg"
                      disabled={busy}
                      onClick={() => void checkFlop()}
                    >
                      Check
                    </Button>
                  </>
                )}

                {phase === "river" && (
                  <>
                    <Button
                      data-testid="raise-1x"
                      variant="gold"
                      size="lg"
                      disabled={busy || !canAfford(ante * 1)}
                      onClick={playRiver}
                    >
                      Play 1× ({formatChips(ante)})
                    </Button>
                    <Button
                      data-testid="fold-btn"
                      variant="danger"
                      size="lg"
                      disabled={busy}
                      onClick={fold}
                    >
                      Fold
                    </Button>
                  </>
                )}
              </div>
              <div className="mt-2 text-center text-[11px] text-white/40">
                {phase === "river"
                  ? "Folding forfeits your Ante and Blind."
                  : "Checking is free — see the next cards."}
              </div>
            </div>
          )}

          {/* Showdown — play again */}
          {phase === "showdown" && (
            <div className="mt-3 flex justify-center">
              <Button
                data-testid="next-round"
                variant="gold"
                size="lg"
                disabled={busy}
                onClick={nextRound}
              >
                Next Hand
              </Button>
            </div>
          )}
        </div>
      </div>

      {/* ---------------- Paytables ---------------- */}
      <div className="mt-2 grid grid-cols-1 gap-3 sm:mt-4 sm:grid-cols-2">
        <CollapsiblePanel
          title="Blind Bonus"
          accent={ACCENT}
          summary={<>up to 500 : 1</>}
        >
          <p className="mb-2 text-[11px] text-white/45">
            Pays on a winning hand. Below a straight pushes.
          </p>
          <ul className="space-y-1 text-[12px]">
            {BLIND_PAY.map((r) => (
              <li
                key={r.label}
                className="flex justify-between border-b border-white/5 pb-0.5"
              >
                <span className="text-white/70">{r.label}</span>
                <span className="font-semibold text-gold tabular-nums">
                  {r.ratio === 1.5 ? "3 : 2" : `${r.ratio} : 1`}
                </span>
              </li>
            ))}
          </ul>
        </CollapsiblePanel>

        <CollapsiblePanel
          title="Trips Side Bet"
          accent={ACCENT}
          summary={<>up to 50 : 1</>}
        >
          <p className="mb-2 text-[11px] text-white/45">
            Pays on your final hand regardless of the result.
          </p>
          <ul className="space-y-1 text-[12px]">
            {TRIPS_PAY.map((r) => (
              <li
                key={r.label}
                className="flex justify-between border-b border-white/5 pb-0.5"
              >
                <span className="text-white/70">{r.label}</span>
                <span className="font-semibold text-gold tabular-nums">
                  {r.ratio} : 1
                </span>
              </li>
            ))}
          </ul>
        </CollapsiblePanel>
      </div>

      {/* Rules note */}
      <div className="mt-3">
        <CollapsiblePanel title="How to play" accent={ACCENT}>
          <p className="text-[11px] leading-relaxed text-white/45">
            <span className="font-semibold text-white/65">How it works:</span>{" "}
            Post equal Ante &amp; Blind. Pre-flop raise 3× or 4×, or check. After the
            flop raise 2× or check. After the turn &amp; river make a 1× Play or fold.
            Play pays 1:1 if you beat the dealer (push on tie). The dealer needs a pair
            or better to qualify — if not, your Ante pushes. The Blind pays the bonus
            table only when you win.
          </p>
        </CollapsiblePanel>
      </div>
    </div>
  );
}
