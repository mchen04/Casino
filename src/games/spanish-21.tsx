"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { type Card, blackjackTotal, makeDeck } from "@/lib/cards";
import { shuffle } from "@/lib/rng";
import { useWallet } from "@/lib/wallet";
import { formatChips, formatDelta } from "@/lib/format";
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

/* ------------------------------------------------------------------ */
/* Shoe — 6 Spanish decks (every rank-"10" card removed).              */
/* ------------------------------------------------------------------ */

function freshShoe(): Card[] {
  // makeDeck(6) -> 312 cards, strip all 24 "10" spot cards -> 288-card Spanish shoe.
  return shuffle(makeDeck(6).filter((c) => c.rank !== "10"));
}

/* ------------------------------------------------------------------ */
/* Bonus evaluation                                                    */
/* ------------------------------------------------------------------ */

type BonusKind = "five" | "six" | "seven" | "678" | "777";

interface Bonus {
  kind: BonusKind;
  /** multiplier applied to the ORIGINAL base bet (e.g. 1.5 = 3:2). */
  mult: number;
  label: string;
}

/**
 * Evaluate the Spanish-21 bonus for a winning player 21.
 * Bonuses are voided after a split (standard Spanish-21 rule) — caller passes
 * `fromSplit` so we can suppress them. Returns the single best applicable bonus.
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
  | "bust";

interface Hand {
  id: number;
  cards: Card[];
  bet: number; // current stake on this hand (doubles after a Double)
  doubled: boolean;
  fromSplit: boolean;
  done: boolean; // standing / busted / resolved
  outcome: HandOutcome | null;
  bonus: Bonus | null;
  payout: number; // gross returned to wallet on resolve
}

let HAND_SEQ = 1;
function newHand(cards: Card[], bet: number, fromSplit: boolean): Hand {
  return {
    id: HAND_SEQ++,
    cards,
    bet,
    doubled: false,
    fromSplit,
    done: false,
    outcome: null,
    bonus: null,
    payout: 0,
  };
}

type Phase = "betting" | "dealing" | "player" | "dealer" | "resolved";

const isBlackjack = (cards: Card[]) =>
  cards.length === 2 && blackjackTotal(cards).total === 21;

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

  const shoeRef = useRef<Card[]>(freshShoe());
  const [shoeCount, setShoeCount] = useState<number>(shoeRef.current.length);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  const [bet, setBet] = useState<number>(50);
  const [phase, setPhase] = useState<Phase>("betting");

  const [dealer, setDealer] = useState<Card[]>([]);
  const [hideHole, setHideHole] = useState<boolean>(true);
  const [hands, setHandsState] = useState<Hand[]>([]);
  const [active, setActive] = useState<number>(0); // index into hands

  // Refs mirror state so action handlers can read & write the live board
  // without scheduling side effects inside React state updaters (which would
  // double-fire under StrictMode and double-deal cards).
  const handsRef = useRef<Hand[]>([]);
  const dealerRef = useRef<Card[]>([]);

  const setHands = useCallback((next: Hand[]) => {
    handsRef.current = next;
    setHandsState(next);
  }, []);
  const setDealerCards = useCallback((next: Card[]) => {
    dealerRef.current = next;
    setDealer(next);
  }, []);

  const cloneHands = () =>
    handsRef.current.map((h) => ({ ...h, cards: [...h.cards] }));

  // Stable refs that always point to the latest settle / dealerPlay / finishDeal
  // so that closures scheduled via setTimeout never hold stale wallet references.
  const settleRef = useRef<(playerHands: Hand[], dealerCards: Card[], natural: boolean) => void>(
    () => { /* placeholder, replaced before first use */ },
  );
  const dealerPlayRef = useRef<(playerHands: Hand[]) => void>(
    () => { /* placeholder */ },
  );
  const finishDealRef = useRef<(pCards: Card[], dCards: Card[], stake: number, id: number) => void>(
    () => { /* placeholder */ },
  );

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

  // Clear any scheduled timers on unmount.
  useEffect(() => {
    return () => {
      timers.current.forEach(clearTimeout);
    };
  }, []);

  const schedule = useCallback((fn: () => void, ms: number) => {
    const t = setTimeout(fn, ms);
    timers.current.push(t);
  }, []);

  /** Draw a card from the shoe, reshuffling when it runs low. */
  const draw = useCallback((): Card => {
    if (shoeRef.current.length < 20) {
      shoeRef.current = freshShoe();
    }
    const card = shoeRef.current.pop()!;
    setShoeCount(shoeRef.current.length);
    return card;
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
  /* Deal                                                              */
  /* ---------------------------------------------------------------- */

  const deal = useCallback(() => {
    if (inRound) return;
    if (!canAfford) return;
    if (!wallet.bet(bet)) return; // deduct stake; abort if unaffordable

    // reset board
    timers.current.forEach(clearTimeout);
    timers.current = [];
    setResult("");
    setDelta(0);
    setShowBurst(false);
    setBigBurst(false);
    setCelebrate((c) => ({ ...c, show: false }));
    setDealerCards([]);
    setHands([]);
    setActive(0);
    setHideHole(true);
    setPhase("dealing");

    // Deal sequence: player, dealer(up), player, dealer(hole).
    const p1 = draw();
    const d1 = draw();
    const p2 = draw();
    const d2 = draw();

    const baseHand = newHand([], bet, false);

    schedule(() => {
      sfx.card();
      setHands([{ ...baseHand, cards: [p1] }]);
    }, DEAL_GAP * 0);
    schedule(() => {
      sfx.card();
      setDealerCards([d1]);
    }, DEAL_GAP * 1);
    schedule(() => {
      sfx.card();
      setHands([{ ...baseHand, cards: [p1, p2] }]);
    }, DEAL_GAP * 2);
    schedule(() => {
      sfx.card();
      setDealerCards([d1, d2]);
      // After the deal, check for naturals.
      schedule(() => finishDealRef.current([p1, p2], [d1, d2], bet, baseHand.id), 420);
    }, DEAL_GAP * 3);
  }, [bet, canAfford, draw, inRound, schedule, setDealerCards, setHands, wallet]);

  /** After the opening 4 cards land, resolve naturals or hand control to player. */
  const finishDeal = useCallback(
    (pCards: Card[], dCards: Card[], stake: number, id: number) => {
      const playerBJ = isBlackjack(pCards);
      const dealerBJ = isBlackjack(dCards);
      const base: Hand = { ...newHand(pCards, stake, false), id };

      if (playerBJ || dealerBJ) {
        setHideHole(false);
        sfx.card();
        // Player BJ BEATS dealer BJ in Spanish 21; player BJ pays 3:2.
        if (playerBJ) {
          const hand: Hand = {
            ...base,
            done: true,
            outcome: "blackjack",
            payout: stake * 2.5, // 3:2 incl. stake (exact)
          };
          settleRef.current([hand], dCards, true);
        } else {
          // dealer natural, player has none -> player loses the hand.
          const hand: Hand = { ...base, done: true, outcome: "lose", payout: 0 };
          settleRef.current([hand], dCards, true);
        }
        return;
      }

      // Normal play.
      setHands([base]);
      setActive(0);
      setPhase("player");
    },
    [setHands],
  );
  // Keep ref current so deal's scheduled callback always calls the live version.
  finishDealRef.current = finishDeal;

  /* ---------------------------------------------------------------- */
  /* Player actions                                                    */
  /* ---------------------------------------------------------------- */

  const activeHand = hands[active];

  const handValue = (h: Hand | undefined) =>
    h ? blackjackTotal(h.cards).total : 0;

  const canHit =
    phase === "player" && !!activeHand && !activeHand.done && handValue(activeHand) < 21;
  const canDouble =
    phase === "player" &&
    !!activeHand &&
    !activeHand.done &&
    handValue(activeHand) < 21 &&
    balance >= activeHand.bet;
  const canSplit = (() => {
    if (phase !== "player" || !activeHand || activeHand.done) return false;
    if (activeHand.cards.length !== 2) return false;
    if (hands.length >= 4 || balance < activeHand.bet) return false;
    const c0 = activeHand.cards[0];
    const c1 = activeHand.cards[1];
    return c0 !== undefined && c1 !== undefined && c0.rank === c1.rank;
  })();

  /** Advance to the next unfinished hand, or move to the dealer's turn. */
  const advance = useCallback(
    (updated: Hand[]) => {
      const next = updated.findIndex((h) => !h.done);
      if (next === -1) {
        // All player hands resolved (stood / busted / made 21) -> dealer plays.
        setPhase("dealer");
        schedule(() => dealerPlayRef.current(updated), 380);
      } else {
        setActive(next);
      }
    },
    [schedule],
  );

  const hit = useCallback(() => {
    if (!canHit || !activeHand) return;
    sfx.card();
    const card = draw();
    const copy = cloneHands();
    const h = copy[active];
    if (!h) return;
    h.cards.push(card);
    const { total } = blackjackTotal(h.cards);
    if (total > 21) {
      h.done = true;
      h.outcome = "bust";
      h.payout = 0;
      sfx.thud();
    } else if (total === 21) {
      // Player 21 always wins immediately in Spanish 21.
      h.done = true;
    }
    setHands(copy);
    if (h.done) schedule(() => advance(copy), 360);
  }, [active, activeHand, advance, canHit, draw, schedule, setHands]);

  const stand = useCallback(() => {
    if (phase !== "player" || !activeHand) return;
    sfx.click();
    const copy = cloneHands();
    const standHand = copy[active];
    if (!standHand) return;
    standHand.done = true;
    setHands(copy);
    schedule(() => advance(copy), 200);
  }, [active, activeHand, advance, phase, schedule, setHands]);

  const double = useCallback(() => {
    if (!canDouble || !activeHand) return;
    if (!wallet.bet(activeHand.bet)) return; // take the extra stake
    sfx.chip();
    const card = draw();
    schedule(() => sfx.card(), 60);
    const copy = cloneHands();
    const h = copy[active];
    if (!h) return;
    h.bet = h.bet * 2;
    h.doubled = true;
    h.cards.push(card);
    h.done = true;
    const { total } = blackjackTotal(h.cards);
    if (total > 21) {
      h.outcome = "bust";
      h.payout = 0;
      schedule(() => sfx.thud(), 200);
    }
    setHands(copy);
    schedule(() => advance(copy), 420);
  }, [active, activeHand, advance, canDouble, draw, schedule, setHands, wallet]);

  const split = useCallback(() => {
    if (!canSplit || !activeHand) return;
    if (!wallet.bet(activeHand.bet)) return; // second hand's stake
    sfx.chip();
    const copy = cloneHands();
    const h = copy[active];
    // canSplit guarantees cards.length === 2 and same rank; guard for TS strict.
    if (!h) return;
    const card0 = h.cards[0];
    const card1 = h.cards[1];
    if (!card0 || !card1) return;
    // first hand keeps card[0] + a fresh draw
    const firstDraw = draw();
    h.cards = [card0, firstDraw];
    h.fromSplit = true;
    // second hand: moved card + a fresh draw
    const secondDraw = draw();
    const second = newHand([card1, secondDraw], activeHand.bet, true);
    copy.splice(active + 1, 0, second);

    // Auto-resolve any split hand that immediately makes 21.
    copy.forEach((hh) => {
      if (blackjackTotal(hh.cards).total === 21) hh.done = true;
    });
    setHands(copy);
    schedule(() => sfx.card(), 80);
    schedule(() => sfx.card(), 220);

    // If the active hand auto-finished, advance.
    if (copy[active]?.done) {
      schedule(() => advance(copy), 420);
    }
  }, [active, activeHand, advance, canSplit, draw, schedule, setHands, wallet]);

  /* ---------------------------------------------------------------- */
  /* Dealer play                                                       */
  /* ---------------------------------------------------------------- */

  const dealerPlay = useCallback(
    (playerHands: Hand[]) => {
      setHideHole(false);
      sfx.card();

      // If every live hand busted, dealer need not draw.
      const liveHands = playerHands.filter((h) => h.outcome !== "bust");
      const dealerNeedsToPlay = liveHands.length > 0;

      const run = (current: Card[]) => {
        const { total, soft } = blackjackTotal(current);
        // Dealer hits soft 17.
        const mustHit = total < 17 || (total === 17 && soft);
        if (dealerNeedsToPlay && mustHit) {
          const card = draw();
          const next = [...current, card];
          setDealerCards(next);
          sfx.card();
          schedule(() => run(next), 600);
        } else {
          schedule(() => settleRef.current(playerHands, current, false), 500);
        }
      };

      schedule(() => run(dealerRef.current), 450);
    },
    [draw, schedule, setDealerCards],
  );
  // Keep the ref current after every render so closures always call the live version.
  dealerPlayRef.current = dealerPlay;

  /* ---------------------------------------------------------------- */
  /* Settle — compute outcomes, pay the wallet, show the result        */
  /* ---------------------------------------------------------------- */

  const settle = useCallback(
    (playerHands: Hand[], dealerCards: Card[], natural: boolean) => {
      const dTotal = blackjackTotal(dealerCards).total;
      const dBust = dTotal > 21;
      const dealerBJ = isBlackjack(dealerCards);

      let totalReturn = 0;
      let totalStake = 0;

      const resolved: Hand[] = playerHands.map((h) => {
        const out = { ...h, cards: [...h.cards] };
        totalStake += out.bet;

        // Pre-resolved naturals carry their outcome/payout already.
        if (out.outcome === "blackjack") {
          totalReturn += out.payout;
          return out;
        }
        if (out.outcome === "bust") {
          out.payout = 0;
          return out;
        }
        if (out.outcome === "lose") {
          out.payout = 0;
          return out;
        }

        const pTotal = blackjackTotal(out.cards).total;
        const playerBJ = !out.fromSplit && isBlackjack(out.cards);

        // Player blackjack (post-deal path is rare but covered).
        if (playerBJ) {
          out.outcome = "blackjack";
          out.payout = out.bet * 2.5; // 3:2 incl. stake (exact)
          totalReturn += out.payout;
          return out;
        }

        // A player total of 21 ALWAYS wins in Spanish 21.
        if (pTotal === 21) {
          out.outcome = "twentyone";
          // even money on the (possibly doubled) stake...
          let pay = out.bet * 2;
          // ...plus the bonus, paid at the BASE bet rate (not the doubled stake).
          const base = out.doubled ? out.bet / 2 : out.bet;
          const bonus = evalBonus(out.cards, out.fromSplit);
          out.bonus = bonus;
          if (bonus) pay += base * bonus.mult; // exact bonus — wallet rounds to the cent
          out.payout = pay;
          totalReturn += out.payout;
          return out;
        }

        // Player did not bust and is < 21. Compare to dealer.
        if (dBust) {
          out.outcome = "win";
          out.payout = out.bet * 2;
        } else if (dealerBJ) {
          out.outcome = "lose";
          out.payout = 0;
        } else if (pTotal > dTotal) {
          out.outcome = "win";
          out.payout = out.bet * 2;
        } else if (pTotal < dTotal) {
          out.outcome = "lose";
          out.payout = 0;
        } else {
          out.outcome = "push";
          out.payout = out.bet; // refund stake
        }
        totalReturn += out.payout;
        return out;
      });

      if (totalReturn > 0) wallet.win(totalReturn);

      // Net delta vs. the staked chips for this round.
      const net = totalReturn - totalStake;
      setHands(resolved);
      setDealerCards(dealerCards);
      setHideHole(false);
      setPhase("resolved");
      setDelta(net);

      // Build the headline result text.
      const text = buildResultText(resolved, dealerCards, net, natural);
      setResult(text);

      // Feedback.
      if (net > 0) {
        const big = net >= totalStake * 1.5 || resolved.some((h) => h.bonus);
        setShowBurst(true);
        setBigBurst(big);
        if (big) sfx.jackpot();
        else sfx.win();
        schedule(() => setShowBurst(false), big ? 1200 : 900);

        // Celebration overlay: fire only on NOTABLE wins, never plain 1:1.
        const hasNatural = resolved.some(
          (h) => h.outcome === "blackjack" || h.outcome === "twentyone",
        );
        const hasBonus = resolved.some((h) => h.bonus);
        const topBonus = resolved.some(
          (h) => h.bonus?.kind === "777" && h.bonus.mult === 3,
        );
        const ret = totalReturn / Math.max(1, totalStake);
        const notable = hasNatural || hasBonus || ret >= 2.5;
        if (notable) {
          const tier: "win" | "big" | "jackpot" =
            topBonus || ret >= 10 ? "jackpot" : hasNatural || hasBonus || ret >= 2.5 ? "big" : "win";
          setCelebrate({ show: true, seed: totalReturn, tier });
          schedule(() => setCelebrate((c) => ({ ...c, show: false })), 1600);
        }
      } else if (net < 0) {
        sfx.lose();
      } else {
        sfx.thud();
      }
    },
    [wallet, schedule, setDealerCards, setHands],
  );
  // Keep the ref current after every render.
  settleRef.current = settle;

  function buildResultText(
    resolved: Hand[],
    dealerCards: Card[],
    net: number,
    natural: boolean,
  ): string {
    const dTotal = blackjackTotal(dealerCards).total;

    if (resolved.length === 1) {
      const h = resolved[0];
      if (!h) return "";
      switch (h.outcome) {
        case "blackjack":
          return natural
            ? `Spanish Blackjack! Pays 3:2  ${formatDelta(net)}`
            : `Blackjack! Pays 3:2  ${formatDelta(net)}`;
        case "twentyone": {
          const b = h.bonus ? ` · ${h.bonus.label}` : "";
          return `Twenty-One wins!${b}  ${formatDelta(net)}`;
        }
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
      (h) => h.outcome === "win" || h.outcome === "twentyone" || h.outcome === "blackjack",
    ).length;
    const pushes = resolved.filter((h) => h.outcome === "push").length;
    const losses = resolved.length - wins - pushes;
    const head =
      net > 0 ? "Split — net win" : net < 0 ? "Split — net loss" : "Split — even";
    return `${head}: ${wins}W / ${pushes}P / ${losses}L  ${formatDelta(net)}`;
  }

  const newRound = useCallback(() => {
    if (inRound) return;
    sfx.click();
    setPhase("betting");
    setResult("");
    setDelta(0);
    setShowBurst(false);
    setCelebrate((c) => ({ ...c, show: false }));
    setDealerCards([]);
    setHands([]);
    setActive(0);
    setHideHole(true);
  }, [inRound, setDealerCards, setHands]);

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
              Dealer hits soft 17 · BJ pays 3:2
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
            Paid on a winning 21 at the base-bet rate (kept even after doubling;
            voided after a split).
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
              <li>• Dealer hits soft 17.</li>
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
