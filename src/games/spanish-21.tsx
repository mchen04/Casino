"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { type Card, blackjackTotal } from "@/lib/cards";
import { useWallet } from "@/lib/wallet";
import { usePlayRound } from "@/lib/playRound";
import { formatChips, formatDelta } from "@/lib/format";
import { sleep } from "@/lib/async";
import { sfx } from "@/lib/sound";
import { Button } from "@/components/ui/Button";
import { Chip } from "@/components/ui/Chip";
import { PlayingCard } from "@/components/PlayingCard";
import { CollapsiblePanel } from "@/components/CollapsiblePanel";
import { Celebration } from "@/components/Celebration";

/* ------------------------------------------------------------------ */
/* Theme                                                               */
/* ------------------------------------------------------------------ */

const ACCENT = "#e0b341";
const CHIP_VALUES = [5, 25, 100, 500] as const;
const DEAL_GAP = 360; // ms between dealt cards
const DEALER_GAP = 560; // ms between dealer draws

/* ------------------------------------------------------------------ */
/* Bonus evaluation — LABELS ONLY                                      */
/* ------------------------------------------------------------------ */
/* The server owns all money. We re-derive a display-only bonus label  */
/* from a winning hand's cards purely to keep the celebration visuals. */

type BonusKind = "five" | "six" | "seven" | "678" | "777";

interface Bonus {
  kind: BonusKind;
  /** multiplier on the ORIGINAL base bet (e.g. 1.5 = 3:2). Display only. */
  mult: number;
  label: string;
}

/**
 * Evaluate the Spanish-21 bonus for a winning player 21 — FOR DISPLAY LABELS
 * ONLY. Bonuses are voided after a split, so the caller passes `fromSplit`.
 * The money never comes from this; the server's `payout` is authoritative.
 */
function evalBonus(cards: Card[], fromSplit: boolean): Bonus | null {
  if (fromSplit) return null;
  const { total } = blackjackTotal(cards);
  if (total !== 21) return null;

  // --- 6-7-8 and 7-7-7 (exactly the 3 cards, in any order) ---
  if (cards.length === 3) {
    const ranks = cards.map((c) => c.rank).sort();
    const suits = cards.map((c) => c.suit);
    const allSpades = suits.every((s) => s === "spades");
    const firstSuit = suits[0];
    const sameSuit = firstSuit !== undefined && suits.every((s) => s === firstSuit);
    const is678 = ranks.join() === ["6", "7", "8"].sort().join();
    const is777 = ranks.every((r) => r === "7");
    if (is678 || is777) {
      const kind: BonusKind = is777 ? "777" : "678";
      if (allSpades) {
        return { kind, mult: 3, label: is777 ? "Suited 7-7-7 ♠♠♠" : "Suited 6-7-8 ♠♠♠" };
      }
      if (sameSuit) {
        return { kind, mult: 2, label: is777 ? "Same-suit 7-7-7" : "Same-suit 6-7-8" };
      }
      return { kind, mult: 1.5, label: is777 ? "Mixed 7-7-7" : "Mixed 6-7-8" };
    }
  }

  // --- card-count 21 bonuses ---
  if (cards.length >= 7) return { kind: "seven", mult: 3, label: "7+ Card 21" };
  if (cards.length === 6) return { kind: "six", mult: 2, label: "6 Card 21" };
  if (cards.length === 5) return { kind: "five", mult: 1.5, label: "5 Card 21" };
  return null;
}

/* ------------------------------------------------------------------ */
/* Hand model                                                          */
/* ------------------------------------------------------------------ */

type HandOutcome =
  | "win"
  | "lose"
  | "push"
  | "blackjack"
  | "twentyone"
  | "bonus"
  | "bust"
  | null;

interface Hand {
  id: number;
  cards: Card[];
  bet: number; // current stake on this hand (doubles after a Double)
  doubled: boolean;
  fromSplit: boolean;
  done: boolean; // standing / busted / resolved
  outcome: HandOutcome;
  bonus: Bonus | null; // display-only label
}

let HAND_SEQ = 1;

const isBlackjack = (cards: Card[]) =>
  cards.length === 2 && blackjackTotal(cards).total === 21;

/* ------------------------------------------------------------------ */
/* Server hand view → the client's Hand shape (display only).          */
/* ------------------------------------------------------------------ */

interface ServerHand {
  cards: Card[];
  bet: number;
  done?: boolean;
  doubled?: boolean;
  fromSplit?: boolean;
  total?: number;
}

/** Map server hands to local Hand objects. Outcome/bonus labels optional. */
function serverHandsToLocal(serverHands: ServerHand[], outcomes?: HandOutcome[]): Hand[] {
  return serverHands.map((h, i) => {
    const outcome = outcomes ? outcomes[i] ?? null : null;
    const fromSplit = !!h.fromSplit;
    // Display-only bonus label for a winning bonus 21.
    const bonus = outcome === "bonus" ? evalBonus(h.cards, fromSplit) : null;
    return {
      id: HAND_SEQ++,
      cards: h.cards,
      bet: h.bet,
      doubled: !!h.doubled,
      fromSplit,
      done: !!h.done,
      outcome,
      bonus,
    };
  });
}

type Phase = "betting" | "dealing" | "player" | "dealer" | "resolved";

/* ------------------------------------------------------------------ */
/* Small presentational helpers                                        */
/* ------------------------------------------------------------------ */

function TotalBadge({
  cards,
  hidden,
}: {
  cards: Card[];
  hidden?: boolean;
}) {
  if (hidden) {
    return (
      <span className="rounded-full bg-black/50 px-3 py-1 text-sm font-bold text-white/60 tabular-nums">
        ?
      </span>
    );
  }
  const { total, soft } = blackjackTotal(cards);
  const bust = total > 21;
  const twentyOne = total === 21;
  return (
    <span
      className="rounded-full px-3 py-1 text-sm font-bold tabular-nums"
      style={{
        background: bust
          ? "rgba(220,38,38,0.25)"
          : twentyOne
            ? "rgba(224,179,65,0.28)"
            : "rgba(0,0,0,0.5)",
        color: bust ? "#ff7a7a" : twentyOne ? ACCENT : "#fff",
        boxShadow: twentyOne ? `0 0 14px ${ACCENT}88` : undefined,
      }}
    >
      {soft && total !== 21 ? `${total - 10}/${total}` : total}
    </span>
  );
}

/** A fanned, animated row of cards. */
function CardRow({
  cards,
  hideHole,
  highlight,
  size,
}: {
  cards: Card[];
  hideHole?: boolean;
  highlight?: boolean;
  size: "sm" | "md" | "lg";
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <AnimatePresence initial={false}>
        {cards.map((card, i) => {
          const faceDown = hideHole === true && i === 1;
          return (
            <motion.div
              key={card.id}
              layout
              initial={{ y: -120, x: 60, opacity: 0, rotate: -18, scale: 0.85 }}
              animate={{ y: 0, x: 0, opacity: 1, rotate: 0, scale: 1 }}
              exit={{ opacity: 0, scale: 0.8, transition: { duration: 0.15 } }}
              transition={{
                type: "spring",
                stiffness: 320,
                damping: 26,
                mass: 0.7,
              }}
            >
              <PlayingCard
                card={card}
                faceDown={faceDown}
                size={size}
                highlight={highlight && !faceDown}
              />
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Win burst overlay                                                   */
/* ------------------------------------------------------------------ */

function WinBurst({ show, big }: { show: boolean; big: boolean }) {
  const sparks = useMemo(
    () =>
      Array.from({ length: 16 }, (_, i) => ({
        a: (i / 16) * Math.PI * 2,
        d: 90 + (i % 4) * 26,
        s: 0.5 + (i % 3) * 0.3,
      })),
    [],
  );
  return (
    <AnimatePresence>
      {show && (
        <motion.div
          className="pointer-events-none absolute inset-0 z-30 grid place-items-center"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          {sparks.map((p, i) => (
            <motion.span
              key={i}
              className="absolute h-2 w-2 rounded-full"
              style={{
                background: i % 2 ? ACCENT : "#fff",
                boxShadow: `0 0 10px ${ACCENT}`,
              }}
              initial={{ x: 0, y: 0, opacity: 1, scale: 1 }}
              animate={{
                x: Math.cos(p.a) * p.d * (big ? 1.6 : 1),
                y: Math.sin(p.a) * p.d * (big ? 1.6 : 1),
                opacity: 0,
                scale: p.s,
              }}
              transition={{ duration: big ? 1.1 : 0.8, ease: "easeOut" }}
            />
          ))}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/* ------------------------------------------------------------------ */
/* Animated balance-delta counter                                     */
/* ------------------------------------------------------------------ */

function DeltaCounter({ value }: { value: number }) {
  const positive = value > 0;
  const zero = value === 0;
  return (
    <motion.div
      key={value}
      initial={{ scale: 0.6, opacity: 0, y: 8 }}
      animate={{ scale: 1, opacity: 1, y: 0 }}
      transition={{ type: "spring", stiffness: 400, damping: 18 }}
      className="text-3xl font-extrabold tabular-nums sm:text-4xl"
      style={{
        color: zero ? "#cbd5e1" : positive ? ACCENT : "#ff6b6b",
        textShadow: positive ? `0 0 22px ${ACCENT}99` : undefined,
      }}
    >
      {zero ? "Push" : formatDelta(value)}
    </motion.div>
  );
}

/* ------------------------------------------------------------------ */
/* Component                                                           */
/* ------------------------------------------------------------------ */

export default function Spanish21() {
  const wallet = useWallet();
  const { balance, ready } = wallet;

  // The server owns the real 6-deck Spanish shoe (one per round), dealer play,
  // and ALL payouts. The client only routes decisions through /api/round and
  // animates the cards the server deals back.
  const { start: roundStart, act: roundAct } = usePlayRound();
  const roundIdRef = useRef<string | null>(null);

  const [bet, setBet] = useState<number>(50);
  const [phase, setPhase] = useState<Phase>("betting");

  const [dealer, setDealer] = useState<Card[]>([]);
  const [hideHole, setHideHole] = useState<boolean>(true);
  const [hands, setHands] = useState<Hand[]>([]);
  const [active, setActive] = useState<number>(0); // index into hands

  // The server's legal-action list for the active hand.
  const [stepActions, setStepActions] = useState<string[]>([]);

  // Generation token to abort stale async sequences across rapid re-deals.
  const genRef = useRef(0);
  // Guard against re-entrant action clicks while a request is in flight.
  const acting = useRef(false);
  // Cosmetic shoe counter (visual only — the server owns the real shoe).
  const [shoeCount, setShoeCount] = useState<number>(288);

  const [result, setResult] = useState<string>("");
  const [delta, setDelta] = useState<number>(0);
  const [showBurst, setShowBurst] = useState<boolean>(false);
  const [bigBurst, setBigBurst] = useState<boolean>(false);
  // Notable-win celebration overlay: confetti + coin fountain for naturals,
  // 21 bonuses, and big multiples of the wager. Plain 1:1 wins are skipped.
  const [celebrate, setCelebrate] = useState<{
    show: boolean;
    seed: number;
    tier: "win" | "big" | "jackpot";
  }>({ show: false, seed: 0, tier: "win" });

  // On unmount, advance the generation so any in-flight async aborts.
  useEffect(() => {
    return () => {
      genRef.current++;
    };
  }, []);

  const canAfford = bet > 0 && bet <= balance;
  const inRound = phase !== "betting" && phase !== "resolved";

  const adjustBet = useCallback(
    (next: number) => {
      if (inRound) return;
      const ceil = Math.max(0, balance);
      setBet(Math.max(0, Math.min(Math.floor(next), ceil)));
      sfx.chip();
    },
    [balance, inRound],
  );

  /* ---------------------------------------------------------------- */
  /* Settlement display — the server already credited the balance;     */
  /* this only renders the resolved hands, dealer, banner, celebration.*/
  /* ---------------------------------------------------------------- */

  const settleDisplay = useCallback(
    (pv: Record<string, unknown>, payout: number, settle: () => void) => {
      const serverHands = (pv.playerHands ?? []) as ServerHand[];
      const outcomes = (pv.outcomes ?? []) as HandOutcome[];
      const dealerCards = (pv.dealer ?? []) as Card[];
      const resolved = serverHandsToLocal(serverHands, outcomes);
      const totalStake = serverHands.reduce((s, h) => s + h.bet, 0);
      const net = payout - totalStake;

      setHands(resolved);
      setDealer(dealerCards);
      setHideHole(false);
      setActive(-1);
      setStepActions([]);
      setPhase("resolved");
      setDelta(net);

      const text = buildResultText(resolved, dealerCards, net);
      setResult(text);

      // Reveal is on screen (dealer drawn out, banner + delta shown) — NOW credit
      // the withheld winnings so the header balance never jumps ahead of the result.
      settle();

      // Feedback.
      if (net > 0) {
        const big = net >= totalStake * 1.5 || resolved.some((h) => h.bonus);
        setShowBurst(true);
        setBigBurst(big);
        if (big) sfx.jackpot();
        else sfx.win();

        // Celebration overlay: fire only on NOTABLE wins, never plain 1:1.
        const hasNatural = resolved.some(
          (h) =>
            h.outcome === "blackjack" ||
            h.outcome === "twentyone" ||
            h.outcome === "bonus",
        );
        const hasBonus = resolved.some((h) => h.bonus);
        const topBonus = resolved.some(
          (h) => h.bonus?.kind === "777" && h.bonus.mult === 3,
        );
        const ret = payout / Math.max(1, totalStake);
        const notable = hasNatural || hasBonus || ret >= 2.5;
        if (notable) {
          const tier: "win" | "big" | "jackpot" =
            topBonus || ret >= 10 ? "jackpot" : "big";
          setCelebrate({ show: true, seed: payout, tier });
        } else {
          setCelebrate((c) => ({ ...c, show: false }));
        }
      } else if (net < 0) {
        setShowBurst(false);
        setCelebrate((c) => ({ ...c, show: false }));
        sfx.lose();
      } else {
        setShowBurst(false);
        setCelebrate((c) => ({ ...c, show: false }));
        sfx.thud();
      }
    },
    [],
  );

  /* ---------------------------------------------------------------- */
  /* Animate the dealer drawing out, then settle. (Dealer cards come    */
  /* from the server, which has already played the hand to S17.)        */
  /* ---------------------------------------------------------------- */

  const revealDealerAndSettle = useCallback(
    async (gen: number, pv: Record<string, unknown>, payout: number, settle: () => void) => {
      const dealerCards = (pv.dealer ?? []) as Card[];
      setActive(-1);
      setStepActions([]);
      setPhase("dealer");
      setHideHole(false);
      setHands(serverHandsToLocal((pv.playerHands ?? []) as ServerHand[]));

      // Reveal the hole, then draw the rest one at a time.
      setDealer(dealerCards.slice(0, 2));
      sfx.card();
      await sleep(560);
      if (gen !== genRef.current) return;
      for (let k = 2; k < dealerCards.length; k++) {
        setDealer(dealerCards.slice(0, k + 1));
        setShoeCount((c) => Math.max(0, c - 1));
        sfx.card();
        await sleep(DEALER_GAP);
        if (gen !== genRef.current) return;
      }
      if (blackjackTotal(dealerCards).total > 21) sfx.thud();
      await sleep(300);
      if (gen !== genRef.current) return;
      settleDisplay(pv, payout, settle);
    },
    [settleDisplay],
  );

  /* ---------------------------------------------------------------- */
  /* Apply a non-terminal server step (next hand) or settle.           */
  /* ---------------------------------------------------------------- */

  const applyStep = useCallback(
    async (
      gen: number,
      res: { done?: boolean; publicView: Record<string, unknown>; actions?: string[]; payout?: number; settle: () => void },
    ) => {
      const pv = res.publicView;
      if (res.done) {
        await revealDealerAndSettle(gen, pv, res.payout ?? 0, res.settle);
        return;
      }
      const serverHands = (pv.playerHands ?? []) as ServerHand[];
      setHands(serverHandsToLocal(serverHands));
      setActive((pv.active as number) ?? 0);
      setStepActions(res.actions ?? []);
      setPhase("player");
    },
    [revealDealerAndSettle],
  );

  /* ---------------------------------------------------------------- */
  /* Deal a fresh round (server-authoritative).                        */
  /* ---------------------------------------------------------------- */

  const deal = useCallback(async () => {
    if (inRound) return;
    if (!canAfford) return;

    const gen = ++genRef.current;
    let res;
    try {
      res = await roundStart("spanish-21", bet, {}, { defer: true }); // server debits the main bet; win held until reveal
    } catch {
      return; // insufficient funds / network — abort back to idle, no balance change
    }
    if (gen !== genRef.current) return;
    roundIdRef.current = res.roundId ?? null;

    // Reset board visuals.
    setResult("");
    setDelta(0);
    setShowBurst(false);
    setBigBurst(false);
    setCelebrate((c) => ({ ...c, show: false }));
    setDealer([]);
    setHands([]);
    setActive(0);
    setStepActions([]);
    setHideHole(true);
    setShoeCount(288);
    setPhase("dealing");

    const pv = res.publicView;
    const serverHands = (pv.playerHands ?? []) as ServerHand[];
    const playerCards = serverHands[0]?.cards ?? [];
    const dealerUp = (pv.dealerUp as Card) ?? ((pv.dealer as Card[]) ?? [])[0];
    const holePlaceholder = ((pv.dealer as Card[]) ?? [])[1] ?? playerCards[0];

    const baseHand: Hand = {
      id: HAND_SEQ++,
      cards: [],
      bet,
      doubled: false,
      fromSplit: false,
      done: false,
      outcome: null,
      bonus: null,
    };
    setHands([baseHand]);

    // Staged deal: player, dealer-up, player, dealer-hole(face-down).
    await sleep(DEAL_GAP * 0.5);
    if (gen !== genRef.current) return;
    sfx.card();
    setHands([{ ...baseHand, cards: [playerCards[0]] }]);
    setShoeCount((c) => Math.max(0, c - 1));
    await sleep(DEAL_GAP);
    if (gen !== genRef.current) return;
    sfx.card();
    setDealer([dealerUp]);
    setShoeCount((c) => Math.max(0, c - 1));
    await sleep(DEAL_GAP);
    if (gen !== genRef.current) return;
    sfx.card();
    setHands([{ ...baseHand, cards: playerCards }]);
    setShoeCount((c) => Math.max(0, c - 1));
    await sleep(DEAL_GAP);
    if (gen !== genRef.current) return;
    sfx.card();
    setDealer([dealerUp, holePlaceholder]); // face-down placeholder hole
    setShoeCount((c) => Math.max(0, c - 1));
    await sleep(DEAL_GAP);
    if (gen !== genRef.current) return;

    if (res.done) {
      // Natural (player and/or dealer) — settle after the dealer reveal.
      await revealDealerAndSettle(gen, pv, res.payout ?? 0, res.settle);
      return;
    }

    // Hand control to the player.
    setHands(serverHandsToLocal(serverHands));
    setActive((pv.active as number) ?? 0);
    setStepActions(res.actions ?? []);
    setPhase("player");
  }, [bet, canAfford, inRound, roundStart, revealDealerAndSettle]);

  /* ---------------------------------------------------------------- */
  /* Player actions — each routes a decision through the server.       */
  /* ---------------------------------------------------------------- */

  const sendAction = useCallback(
    async (action: string) => {
      const rid = roundIdRef.current;
      if (!rid || acting.current) return;
      if (!stepActions.includes(action)) return; // server gates legality
      acting.current = true;
      const gen = genRef.current;
      try {
        if (action === "double" || action === "split") sfx.chip();
        else if (action === "hit") sfx.card();
        else sfx.click();
        let res;
        try {
          res = await roundAct(rid, action, undefined, { defer: true }); // win held until the dealer-reveal settle
        } catch {
          return;
        }
        if (gen !== genRef.current) return;
        await applyStep(gen, res);
      } finally {
        acting.current = false;
      }
    },
    [roundAct, applyStep, stepActions],
  );

  const activeHand = active >= 0 ? hands[active] : undefined;

  const canHit = phase === "player" && stepActions.includes("hit");
  const canStand = phase === "player" && stepActions.includes("stand");
  const canDouble =
    phase === "player" &&
    stepActions.includes("double") &&
    !!activeHand &&
    balance >= activeHand.bet;
  const canSplit =
    phase === "player" &&
    stepActions.includes("split") &&
    !!activeHand &&
    balance >= activeHand.bet;

  const hit = useCallback(() => {
    if (!canHit) return;
    void sendAction("hit");
  }, [canHit, sendAction]);

  const stand = useCallback(() => {
    if (!canStand) return;
    void sendAction("stand");
  }, [canStand, sendAction]);

  const double = useCallback(() => {
    if (!canDouble) return;
    void sendAction("double");
  }, [canDouble, sendAction]);

  const split = useCallback(() => {
    if (!canSplit) return;
    void sendAction("split");
  }, [canSplit, sendAction]);

  /* ---------------------------------------------------------------- */
  /* Result text                                                       */
  /* ---------------------------------------------------------------- */

  function buildResultText(
    resolved: Hand[],
    dealerCards: Card[],
    net: number,
  ): string {
    const dTotal = blackjackTotal(dealerCards).total;

    if (resolved.length === 1) {
      const h = resolved[0];
      if (!h) return "";
      switch (h.outcome) {
        case "blackjack":
          return `Spanish Blackjack! Pays 3:2  ${formatDelta(net)}`;
        case "bonus": {
          const b = h.bonus ? ` · ${h.bonus.label}` : "";
          return `Bonus 21!${b}  ${formatDelta(net)}`;
        }
        case "twentyone":
          return `Twenty-One wins!  ${formatDelta(net)}`;
        case "win":
          return dTotal > 21
            ? `Dealer busts — you win  ${formatDelta(net)}`
            : `You win!  ${formatDelta(net)}`;
        case "push":
          return `Push — bet returned`;
        case "bust":
          return `Bust — you lose  ${formatDelta(net)}`;
        case "lose":
          return isBlackjack(dealerCards)
            ? `Dealer blackjack — you lose  ${formatDelta(net)}`
            : `Dealer wins  ${formatDelta(net)}`;
        default:
          return "";
      }
    }

    // Multiple (split) hands -> summarise.
    const wins = resolved.filter(
      (h) =>
        h.outcome === "win" ||
        h.outcome === "twentyone" ||
        h.outcome === "bonus" ||
        h.outcome === "blackjack",
    ).length;
    const pushes = resolved.filter((h) => h.outcome === "push").length;
    const losses = resolved.length - wins - pushes;
    const head =
      net > 0 ? "Split — net win" : net < 0 ? "Split — net loss" : "Split — even";
    return `${head}: ${wins}W / ${pushes}P / ${losses}L  ${formatDelta(net)}`;
  }

  const newRound = useCallback(() => {
    if (inRound) return;
    genRef.current++;
    roundIdRef.current = null;
    sfx.click();
    setPhase("betting");
    setResult("");
    setDelta(0);
    setShowBurst(false);
    setCelebrate((c) => ({ ...c, show: false }));
    setDealer([]);
    setHands([]);
    setActive(0);
    setStepActions([]);
    setHideHole(true);
  }, [inRound]);

  /* ---------------------------------------------------------------- */
  /* Render                                                            */
  /* ---------------------------------------------------------------- */

  const dealerHidden = hideHole && dealer.length >= 2 && inRound;
  // Use slice(0,1) to avoid a `Card | undefined` element under strict TS.
  const dealerVisibleCards = dealerHidden ? dealer.slice(0, 1) : dealer;

  return (
    <div className="mx-auto w-full max-w-5xl">
      {/* ---- Top bar: title / shoe / balance ---- */}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2
            className="font-display text-xl font-bold tracking-wide sm:text-2xl"
            style={{ color: ACCENT }}
          >
            Spanish 21
          </h2>
          <p className="text-[11px] uppercase tracking-[0.2em] text-white/40">
            6 Spanish decks · No ten-spot cards
          </p>
        </div>
        <div className="flex items-center gap-3 text-right">
          <div className="rounded-xl border border-white/10 bg-black/30 px-3 py-1.5">
            <div className="text-[9px] uppercase tracking-widest text-white/40">
              Shoe
            </div>
            <div className="text-sm font-bold tabular-nums text-white/80">
              {shoeCount}
            </div>
          </div>
          <div className="rounded-xl border border-white/10 bg-black/30 px-3 py-1.5">
            <div className="text-[9px] uppercase tracking-widest text-white/40">
              Balance
            </div>
            <div
              className="text-sm font-bold tabular-nums"
              style={{ color: ACCENT }}
            >
              {ready ? formatChips(balance) : "—"}
            </div>
          </div>
        </div>
      </div>

      <div className="grid gap-2 sm:gap-3 lg:grid-cols-[1fr_260px]">
        {/* ============================ TABLE ============================ */}
        <div className="felt relative overflow-hidden rounded-3xl p-4 [@media(max-height:600px)]:p-3 sm:p-6">
          <WinBurst show={showBurst} big={bigBurst} />
          <Celebration
            show={celebrate.show}
            seed={celebrate.seed}
            tier={celebrate.tier}
            colors={["#e0b341", "#ffd24a", "#e74c3c", "#ffffff"]}
          />

          {/* "No tens" note */}
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2 [@media(max-height:600px)]:mb-2">
            <span
              className="rounded-full border px-3 py-1 text-[10px] font-semibold uppercase tracking-widest"
              style={{
                borderColor: `${ACCENT}55`,
                color: ACCENT,
                background: "rgba(0,0,0,0.25)",
              }}
            >
              No 10s in the shoe · J Q K remain
            </span>
            <span className="text-[10px] uppercase tracking-widest text-white/35">
              Dealer stands on all 17 · BJ pays 3:2
            </span>
          </div>

          {/* Dealer */}
          <div className="mb-1 flex items-center gap-3">
            <span className="text-[11px] font-semibold uppercase tracking-widest text-white/50">
              Dealer
            </span>
            {dealer.length > 0 && (
              <TotalBadge cards={dealerVisibleCards} hidden={dealerHidden} />
            )}
          </div>
          <div className="min-h-[80px] [@media(max-height:600px)]:min-h-[64px] sm:min-h-[128px]">
            <CardRow
              cards={dealer}
              hideHole={dealerHidden}
              size="md"
              highlight={
                phase === "resolved" && blackjackTotal(dealer).total <= 21
              }
            />
          </div>

          {/* Divider with result */}
          <div className="my-3 flex min-h-[44px] items-center justify-center [@media(max-height:600px)]:my-2 [@media(max-height:600px)]:min-h-[32px]">
            <AnimatePresence mode="wait">
              {phase === "resolved" && result ? (
                <motion.div
                  key={result}
                  data-testid="round-result"
                  initial={{ opacity: 0, scale: 0.9, y: 6 }}
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  transition={{ type: "spring", stiffness: 360, damping: 22 }}
                  className="rounded-full px-4 py-1.5 text-center text-sm font-bold sm:text-base"
                  style={{
                    color:
                      delta > 0 ? ACCENT : delta < 0 ? "#ff7a7a" : "#cbd5e1",
                    background: "rgba(0,0,0,0.4)",
                    boxShadow:
                      delta > 0 ? `0 0 22px ${ACCENT}55` : undefined,
                  }}
                >
                  {result}
                </motion.div>
              ) : phase === "player" && hands.length > 1 ? (
                <motion.div
                  key="active-tag"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="text-xs uppercase tracking-widest text-white/40"
                >
                  Playing hand {active + 1} of {hands.length}
                </motion.div>
              ) : (
                <div className="h-px w-2/3 bg-white/10" />
              )}
            </AnimatePresence>
          </div>

          {/* Player hand(s) */}
          <div className="flex items-center gap-3">
            <span className="text-[11px] font-semibold uppercase tracking-widest text-white/50">
              {hands.length > 1 ? "Your Hands" : "Player"}
            </span>
          </div>
          <div
            className={`mt-1 grid gap-3 ${
              hands.length > 1 ? "sm:grid-cols-2" : ""
            }`}
          >
            {hands.length === 0 ? (
              <div className="min-h-[80px] [@media(max-height:600px)]:min-h-[64px] sm:min-h-[128px]" />
            ) : (
              hands.map((h, i) => {
                const isActive = phase === "player" && i === active && !h.done;
                const won =
                  h.outcome === "win" ||
                  h.outcome === "twentyone" ||
                  h.outcome === "bonus" ||
                  h.outcome === "blackjack";
                return (
                  <motion.div
                    key={h.id}
                    layout
                    animate={{
                      boxShadow: isActive
                        ? `0 0 0 2px ${ACCENT}, 0 0 22px ${ACCENT}66`
                        : "0 0 0 1px rgba(255,255,255,0.06)",
                    }}
                    className="relative rounded-2xl bg-black/20 p-2.5"
                  >
                    <div className="mb-1 flex items-center gap-2">
                      <TotalBadge cards={h.cards} />
                      <span className="text-[10px] uppercase tracking-widest text-white/40">
                        Bet {formatChips(h.bet)}
                        {h.doubled ? " · 2×" : ""}
                      </span>
                      {phase === "resolved" && h.outcome && (
                        <span
                          className="ml-auto rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide"
                          style={{
                            color: won
                              ? "#062"
                              : h.outcome === "push"
                                ? "#0b0f16"
                                : "#fff",
                            background: won
                              ? ACCENT
                              : h.outcome === "push"
                                ? "#cbd5e1"
                                : "rgba(220,38,38,0.85)",
                          }}
                        >
                          {h.outcome === "twentyone"
                            ? "21"
                            : h.outcome === "bonus"
                              ? "21+"
                              : h.outcome === "blackjack"
                                ? "BJ"
                                : h.outcome}
                        </span>
                      )}
                    </div>
                    <CardRow
                      cards={h.cards}
                      size={hands.length > 1 ? "sm" : "md"}
                      highlight={won}
                    />
                    {h.bonus && phase === "resolved" && (
                      <motion.div
                        initial={{ opacity: 0, y: 6 }}
                        animate={{ opacity: 1, y: 0 }}
                        className="mt-1.5 inline-block rounded-md px-2 py-0.5 text-[10px] font-bold"
                        style={{
                          color: "#0b0f16",
                          background: ACCENT,
                          boxShadow: `0 0 14px ${ACCENT}88`,
                        }}
                      >
                        BONUS · {h.bonus.label} pays {bonusRatio(h.bonus.mult)}
                      </motion.div>
                    )}
                  </motion.div>
                );
              })
            )}
          </div>

          {/* Delta counter on resolve */}
          <div className="mt-4 flex min-h-[44px] items-center justify-center [@media(max-height:600px)]:mt-2 [@media(max-height:600px)]:min-h-[32px]">
            <AnimatePresence>
              {phase === "resolved" && <DeltaCounter value={delta} />}
            </AnimatePresence>
          </div>

          {/* -------------------- Action area -------------------- */}
          <div className="mt-3 [@media(max-height:600px)]:mt-2">
            {phase === "betting" && (
              <div className="flex flex-col items-center gap-3">
                <div className="flex flex-wrap items-center justify-center gap-2 sm:gap-3">
                  {CHIP_VALUES.map((v) => (
                    <Chip
                      key={v}
                      value={v}
                      size={50}
                      onClick={
                        v > balance ? undefined : () => adjustBet(bet + v)
                      }
                    />
                  ))}
                </div>
                <div className="flex flex-wrap items-center justify-center gap-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    data-testid="bet-clear"
                    onClick={() => adjustBet(0)}
                  >
                    Clear
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    data-testid="bet-half"
                    onClick={() => adjustBet(Math.floor(bet / 2))}
                  >
                    ½
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    data-testid="bet-double"
                    onClick={() => adjustBet(bet * 2)}
                  >
                    2×
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    data-testid="bet-max"
                    onClick={() => adjustBet(balance)}
                  >
                    Max
                  </Button>
                  <div className="ml-1 min-w-[110px] rounded-xl border px-4 py-2 text-center"
                    style={{ borderColor: `${ACCENT}55`, background: "rgba(0,0,0,0.4)" }}
                  >
                    <div className="text-[9px] uppercase tracking-widest text-white/40">
                      Bet
                    </div>
                    <motion.div
                      key={bet}
                      initial={{ scale: 0.85 }}
                      animate={{ scale: 1 }}
                      className="text-lg font-bold tabular-nums"
                      style={{ color: ACCENT }}
                    >
                      {formatChips(bet)}
                    </motion.div>
                  </div>
                  <Button
                    size="lg"
                    variant="gold"
                    data-testid="play-btn"
                    disabled={!canAfford || !ready}
                    onClick={deal}
                  >
                    Deal
                  </Button>
                </div>
                {!canAfford && bet > balance && (
                  <p className="text-xs text-ruby/90">
                    Bet exceeds balance — lower your bet.
                  </p>
                )}
              </div>
            )}

            {(phase === "dealing" || phase === "dealer") && (
              <div className="flex items-center justify-center py-2">
                <motion.span
                  className="text-xs uppercase tracking-[0.3em] text-white/40"
                  animate={{ opacity: [0.3, 1, 0.3] }}
                  transition={{ duration: 1.2, repeat: Infinity }}
                >
                  {phase === "dealing" ? "Dealing…" : "Dealer plays…"}
                </motion.span>
              </div>
            )}

            {phase === "player" && (
              <div className="flex flex-wrap items-center justify-center gap-2 sm:gap-3">
                <Button
                  size="lg"
                  variant="gold"
                  data-testid="play-btn"
                  disabled={!canHit}
                  onClick={hit}
                >
                  Hit
                </Button>
                <Button
                  size="lg"
                  variant="felt"
                  data-testid="stand-btn"
                  disabled={!canStand}
                  onClick={stand}
                >
                  Stand
                </Button>
                <Button
                  size="lg"
                  variant="neon"
                  data-testid="double-btn"
                  disabled={!canDouble}
                  onClick={double}
                >
                  Double
                </Button>
                <Button
                  size="lg"
                  variant="ghost"
                  data-testid="split-btn"
                  disabled={!canSplit}
                  onClick={split}
                >
                  Split
                </Button>
              </div>
            )}

            {phase === "resolved" && (
              <div className="flex items-center justify-center">
                <Button
                  size="lg"
                  variant="gold"
                  data-testid="play-btn"
                  disabled={!ready}
                  onClick={newRound}
                >
                  New Hand
                </Button>
              </div>
            )}
          </div>
        </div>

        {/* ============================ PAYTABLE ============================ */}
        <CollapsiblePanel
          title="Paytable"
          accent={ACCENT}
          summary={<>BJ 3:2 · 21 bonuses</>}
          className="self-start"
        >
          <ul className="space-y-1 text-xs text-white/75">
            <PayRow label="Blackjack (2-card 21)" value="3 : 2" />
            <PayRow label="Win" value="1 : 1" />
            <PayRow label="Player 21 vs dealer 21" value="Player wins" />
            <PayRow label="Push" value="Bet back" />
          </ul>

          <h3
            className="mb-2 mt-4 font-display text-sm font-bold uppercase tracking-widest"
            style={{ color: ACCENT }}
          >
            21 Bonuses
          </h3>
          <p className="mb-2 text-[10px] leading-relaxed text-white/45">
            Paid on a winning 21 at the base-bet rate (voided after a double or a
            split).
          </p>
          <ul className="space-y-1 text-xs text-white/75">
            <PayRow label="5-card 21" value="3 : 2" />
            <PayRow label="6-card 21" value="2 : 1" />
            <PayRow label="7+ card 21" value="3 : 1" />
            <div className="my-1 h-px w-full bg-white/10" />
            <PayRow label="6-7-8 / 7-7-7 mixed" value="3 : 2" />
            <PayRow label="6-7-8 / 7-7-7 same suit" value="2 : 1" />
            <PayRow label="6-7-8 / 7-7-7 spades" value="3 : 1" />
          </ul>

          <div className="mt-4 rounded-xl border border-white/10 bg-black/30 p-3">
            <h4 className="mb-1 text-[10px] font-bold uppercase tracking-widest text-white/50">
              Rules
            </h4>
            <ul className="space-y-1 text-[11px] leading-relaxed text-white/55">
              <li>• A player total of 21 always wins.</li>
              <li>• Player blackjack beats dealer blackjack.</li>
              <li>• Dealer stands on all 17 (S17).</li>
              <li>• Double on any number of cards.</li>
              <li>• Split equal-rank pairs (up to 4 hands).</li>
            </ul>
          </div>
        </CollapsiblePanel>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Tiny render helpers                                                 */
/* ------------------------------------------------------------------ */

function bonusRatio(mult: number): string {
  if (mult === 3) return "3:1";
  if (mult === 2) return "2:1";
  return "3:2";
}

function PayRow({ label, value }: { label: string; value: string }) {
  return (
    <li className="flex items-center justify-between gap-2">
      <span>{label}</span>
      <span className="font-bold tabular-nums" style={{ color: ACCENT }}>
        {value}
      </span>
    </li>
  );
}
