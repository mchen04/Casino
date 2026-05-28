"use client";

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  type Card,
  blackjackTotal,
  makeShoe,
} from "@/lib/cards";
import { useWallet } from "@/lib/wallet";
import { formatChips, formatDelta } from "@/lib/format";
import { sfx } from "@/lib/sound";
import { Button } from "@/components/ui/Button";
import { Chip } from "@/components/ui/Chip";
import { PlayingCard } from "@/components/PlayingCard";

const ACCENT = "#d4af37";
const DECKS = 6;
const RESHUFFLE_AT = 26; // cut card: reshuffle when shoe drops below this
const CHIPS = [5, 25, 100, 500, 1000];
const DEFAULT_BET = 50;
const DEAL_GAP = 320; // ms between dealt cards
const DEALER_GAP = 520; // ms between dealer draws

type Phase = "betting" | "dealing" | "insurance" | "player" | "dealer" | "settle";

type HandOutcome =
  | "blackjack"
  | "win"
  | "push"
  | "lose"
  | "bust"
  | "surrender"
  | null;

interface PlayerHand {
  id: number;
  cards: Card[];
  bet: number;
  /** true once a card has been added after a split-ace or the hand is closed. */
  done: boolean;
  doubled: boolean;
  isSplitAces: boolean;
  outcome: HandOutcome;
  /** net chips returned by win() for this hand (gross). */
  payout: number;
}

let HAND_ID = 1;

// Sleep that can be cancelled by a generation token check at the call site.
function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

function isBlackjack(cards: Card[]): boolean {
  return cards.length === 2 && blackjackTotal(cards).total === 21;
}

export default function Blackjack() {
  const wallet = useWallet();

  // --- shoe ------------------------------------------------------------------
  const shoeRef = useRef<Card[]>([]);
  const [shoeCount, setShoeCount] = useState(DECKS * 52);
  const [shuffling, setShuffling] = useState(false);

  const ensureShoe = useCallback(() => {
    if (shoeRef.current.length < RESHUFFLE_AT) {
      shoeRef.current = makeShoe(DECKS);
      setShuffling(true);
      setTimeout(() => setShuffling(false), 650);
    }
    if (shoeRef.current.length === 0) {
      shoeRef.current = makeShoe(DECKS);
    }
  }, []);

  const draw = useCallback((): Card => {
    if (shoeRef.current.length === 0) shoeRef.current = makeShoe(DECKS);
    const c = shoeRef.current.shift()!;
    setShoeCount(shoeRef.current.length);
    return c;
  }, []);

  useEffect(() => {
    shoeRef.current = makeShoe(DECKS);
    setShoeCount(shoeRef.current.length);
  }, []);

  // --- round state -----------------------------------------------------------
  const [phase, setPhase] = useState<Phase>("betting");
  const [bet, setBet] = useState(DEFAULT_BET);
  const [hands, setHands] = useState<PlayerHand[]>([]);
  const [activeIdx, setActiveIdx] = useState(0);
  const [dealer, setDealer] = useState<Card[]>([]);
  const [holeHidden, setHoleHidden] = useState(true);
  const [insuranceBet, setInsuranceBet] = useState(0);
  const [message, setMessage] = useState("");
  const [roundResult, setRoundResult] = useState("");
  const [roundNet, setRoundNet] = useState<number | null>(null);
  const [showBurst, setShowBurst] = useState<"win" | "lose" | "push" | null>(null);

  // generation token to abort async sequences if the player resets / re-deals.
  const genRef = useRef(0);
  // freshly-dealt state stashed for the insurance branch (avoids stale closures).
  const pendingHandsRef = useRef<PlayerHand[]>([]);
  const pendingDealerRef = useRef<Card[]>([]);

  // Stable refs to the latest settle/dealerPlay/revealAndSettle so inner
  // callbacks always call the current version without stale-closure bugs.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const settleRef = useRef<(...args: any[]) => void>(() => {});
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dealerPlayRef = useRef<(...args: any[]) => Promise<void>>(async () => {});
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const revealAndSettleRef = useRef<(...args: any[]) => Promise<void>>(async () => {});

  const canAfford = bet >= 5 && bet <= wallet.balance;

  // ---------------------------------------------------------------------------
  // Deal a fresh round.
  // ---------------------------------------------------------------------------
  const startRound = useCallback(async () => {
    if (phase !== "betting") return;
    if (bet < 5 || bet > wallet.balance) return;
    // place the main bet
    if (!wallet.bet(bet)) return;

    const gen = ++genRef.current;
    ensureShoe();

    // reset visuals
    setRoundResult("");
    setRoundNet(null);
    setShowBurst(null);
    setInsuranceBet(0);
    setMessage("");
    setHoleHidden(true);
    setActiveIdx(0);
    setDealer([]);
    const hand: PlayerHand = {
      id: HAND_ID++,
      cards: [],
      bet,
      done: false,
      doubled: false,
      isSplitAces: false,
      outcome: null,
      payout: 0,
    };
    setHands([hand]);
    setPhase("dealing");

    // deal sequence: player, dealer(up), player, dealer(hole)
    const p1 = draw();
    sfx.card();
    setHands((prev) => prev.map((h, i) => (i === 0 ? { ...h, cards: [p1] } : h)));
    await sleep(DEAL_GAP);
    if (gen !== genRef.current) return;

    const d1 = draw();
    sfx.card();
    setDealer([d1]);
    await sleep(DEAL_GAP);
    if (gen !== genRef.current) return;

    const p2 = draw();
    sfx.card();
    setHands((prev) => prev.map((h, i) => (i === 0 ? { ...h, cards: [p1, p2] } : h)));
    await sleep(DEAL_GAP);
    if (gen !== genRef.current) return;

    const d2 = draw();
    sfx.card();
    setDealer([d1, d2]);
    await sleep(DEAL_GAP);
    if (gen !== genRef.current) return;

    const playerCards = [p1, p2];
    const dealerCards = [d1, d2];
    const freshHand: PlayerHand = { ...hand, cards: playerCards };

    // Insurance offer when dealer upcard is an Ace.
    if (d1.rank === "A") {
      // stash the dealt hand on the round so insurance resolution has it
      pendingHandsRef.current = [freshHand];
      pendingDealerRef.current = dealerCards;
      setPhase("insurance");
      setMessage("Insurance? Dealer shows an Ace.");
      return;
    }

    // Naturals: if either has blackjack, resolve immediately.
    const playerBJ = isBlackjack(playerCards);
    const dealerBJ = isBlackjack(dealerCards);
    if (playerBJ || dealerBJ) {
      // Use ref to guarantee the latest version (not a stale closure).
      void revealAndSettleRef.current(gen, dealerCards, { handsOverride: [freshHand] });
      return;
    }

    setPhase("player");
    setMessage("Your move.");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, bet, wallet, ensureShoe, draw]);

  // ---------------------------------------------------------------------------
  // Insurance choices.
  // ---------------------------------------------------------------------------
  const finishInsurance = useCallback(
    (took: boolean) => {
      const gen = genRef.current;
      const dealerCards = pendingDealerRef.current;
      const pendingHands = pendingHandsRef.current;
      let insBet = 0;
      if (took) {
        const cost = Math.floor(bet / 2);
        if (cost > 0 && wallet.bet(cost)) {
          insBet = cost;
          setInsuranceBet(cost);
          sfx.chip();
        }
      }

      const dealerBJ = isBlackjack(dealerCards);
      const playerBJ = pendingHands[0] ? isBlackjack(pendingHands[0].cards) : false;

      if (dealerBJ) {
        // Insurance pays 2:1 (gross = stake*3 = insBet + 2*insBet).
        // win() is called inside settle for the main hands; pay insurance here.
        if (insBet > 0) {
          wallet.win(insBet * 3);
          sfx.win();
        }
        // Use ref to guarantee the latest version (not a stale closure).
        void revealAndSettleRef.current(gen, dealerCards, {
          handsOverride: pendingHands,
          insuranceOverride: insBet,
        });
        return;
      }

      // Dealer has no blackjack: insurance lost (already deducted).
      if (playerBJ) {
        void revealAndSettleRef.current(gen, dealerCards, { handsOverride: pendingHands });
        return;
      }

      setPhase("player");
      setMessage(insBet > 0 ? "Insurance taken. Your move." : "Your move.");
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [bet, wallet],
  );

  // ---------------------------------------------------------------------------
  // Player actions.
  // ---------------------------------------------------------------------------
  const advanceAfterAction = useCallback(
    (updatedHands: PlayerHand[], idx: number, dealerCards: Card[]) => {
      // Move to next not-done hand; if none remain, go to dealer.
      let next = idx;
      while (next < updatedHands.length && updatedHands[next].done) next++;
      if (next < updatedHands.length) {
        setActiveIdx(next);
        setPhase("player");
        setMessage(updatedHands.length > 1 ? `Playing hand ${next + 1}.` : "Your move.");
        return;
      }
      // all hands done -> dealer turn (only if at least one hand is live)
      const anyLive = updatedHands.some((h) => blackjackTotal(h.cards).total <= 21);
      if (anyLive) {
        // Use ref so we always call the latest version (avoids stale closure).
        void dealerPlayRef.current(genRef.current, updatedHands, dealerCards);
      } else {
        void revealAndSettleRef.current(genRef.current, dealerCards, { handsOverride: updatedHands });
      }
    },
    // dealerPlayRef / revealAndSettleRef are stable refs — no extra deps needed.
    [],
  );

  const hit = useCallback(() => {
    if (phase !== "player") return;
    const idx = activeIdx;
    const c = draw();
    sfx.card();
    // Compute updated hands outside the setter so we can schedule side-effects
    // (sfx, setTimeout) without re-triggering them in StrictMode double-invoke.
    setHands((prev) => {
      const next = prev.map((h, i) =>
        i === idx ? { ...h, cards: [...h.cards, c] } : h,
      );
      const total = blackjackTotal(next[idx].cards).total;
      if (total > 21) {
        next[idx] = { ...next[idx], done: true, outcome: "bust" };
      } else if (total === 21) {
        next[idx] = { ...next[idx], done: true };
      }
      return next;
    });
    // Schedule side-effects after the state update (not inside the setter).
    const previewCards = [...(hands[idx]?.cards ?? []), c];
    const total = blackjackTotal(previewCards).total;
    if (total > 21) {
      sfx.thud();
      const snapshot = hands.map((h, i) =>
        i === idx ? { ...h, cards: previewCards, done: true, outcome: "bust" as const } : h,
      );
      setTimeout(() => advanceAfterAction(snapshot, idx, dealer), 420);
    } else if (total === 21) {
      const snapshot = hands.map((h, i) =>
        i === idx ? { ...h, cards: previewCards, done: true } : h,
      );
      setTimeout(() => advanceAfterAction(snapshot, idx, dealer), 420);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, activeIdx, draw, hands, dealer, advanceAfterAction]);

  const stand = useCallback(() => {
    if (phase !== "player") return;
    const idx = activeIdx;
    sfx.click();
    // Build snapshot with hand marked done, then update state and advance.
    const snapshot = hands.map((h, i) => (i === idx ? { ...h, done: true } : h));
    setHands(snapshot);
    advanceAfterAction(snapshot, idx, dealer);
  }, [phase, activeIdx, hands, dealer, advanceAfterAction]);

  const double = useCallback(() => {
    if (phase !== "player") return;
    const idx = activeIdx;
    const hand = hands[idx];
    if (!hand || hand.cards.length !== 2) return;
    if (!wallet.bet(hand.bet)) {
      setMessage("Not enough chips to double.");
      return;
    }
    sfx.chip();
    const c = draw();
    sfx.card();
    const newCards = [...hand.cards, c];
    const busted = blackjackTotal(newCards).total > 21;
    const snapshot = hands.map((h, i) =>
      i === idx
        ? {
            ...h,
            bet: h.bet * 2,
            doubled: true,
            cards: newCards,
            done: true,
            outcome: busted ? ("bust" as const) : h.outcome,
          }
        : h,
    );
    setHands(snapshot);
    if (busted) sfx.thud();
    setTimeout(() => advanceAfterAction(snapshot, idx, dealer), 480);
  }, [phase, activeIdx, hands, wallet, draw, dealer, advanceAfterAction]);

  const split = useCallback(() => {
    if (phase !== "player") return;
    const idx = activeIdx;
    const hand = hands[idx];
    if (!hand || hand.cards.length !== 2) return;
    if (hand.cards[0].rank !== hand.cards[1].rank) return;
    if (!wallet.bet(hand.bet)) {
      setMessage("Not enough chips to split.");
      return;
    }
    sfx.chip();
    const splittingAces = hand.cards[0].rank === "A";
    const left = draw();
    sfx.card();
    const right = draw();
    sfx.card();

    const handA: PlayerHand = {
      ...hands[idx],
      cards: [hands[idx].cards[0], left],
      isSplitAces: splittingAces,
      // split aces get exactly one card each and auto-stand.
      done: splittingAces,
    };
    const handB: PlayerHand = {
      id: HAND_ID++,
      cards: [hands[idx].cards[1], right],
      bet: hands[idx].bet,
      done: splittingAces,
      doubled: false,
      isSplitAces: splittingAces,
      outcome: null,
      payout: 0,
    };
    const snapshot = [...hands.slice(0, idx), handA, handB, ...hands.slice(idx + 1)];
    setHands(snapshot);

    if (splittingAces) {
      // both hands are done; advance after paint
      setTimeout(() => advanceAfterAction(snapshot, idx, dealer), 480);
    }
  }, [phase, activeIdx, hands, wallet, draw, dealer, advanceAfterAction]);

  // ---------------------------------------------------------------------------
  // Dealer turn: reveal hole, then draw to 17 (stands on all 17).
  // ---------------------------------------------------------------------------
  const dealerPlay = useCallback(
    async (gen: number, finalHands: PlayerHand[], startDealer: Card[]) => {
      setPhase("dealer");
      setActiveIdx(-1);
      setMessage("Dealer plays…");
      setHoleHidden(false);
      sfx.card();
      await sleep(560);
      if (gen !== genRef.current) return;

      let current = [...startDealer];
      // dealer draws until total >= 17 (stands on all 17 incl. soft 17)
      // safety cap to avoid any infinite loop
      let guard = 0;
      while (guard++ < 20) {
        const { total } = blackjackTotal(current);
        if (total >= 17) break;
        const c = draw();
        sfx.card();
        current = [...current, c];
        setDealer(current);
        await sleep(DEALER_GAP);
        if (gen !== genRef.current) return;
      }
      if (blackjackTotal(current).total > 21) sfx.thud();
      await sleep(300);
      if (gen !== genRef.current) return;
      // Use ref so we always call the latest settle (avoids stale-closure bug).
      settleRef.current(gen, finalHands, current, false, insuranceBet);
    },
    [draw, insuranceBet],
  );

  // Reveal hole card and settle immediately (used for naturals / dealer BJ).
  const revealAndSettle = useCallback(
    async (
      gen: number,
      dealerCards: Card[],
      opts?: { handsOverride?: PlayerHand[]; insuranceOverride?: number },
    ) => {
      setPhase("dealer");
      setActiveIdx(-1);
      setHoleHidden(false);
      sfx.card();
      await sleep(620);
      if (gen !== genRef.current) return;
      // Use ref so we always call the latest settle (avoids stale-closure bug).
      settleRef.current(
        gen,
        opts?.handsOverride ?? hands,
        dealerCards,
        true,
        opts?.insuranceOverride ?? insuranceBet,
      );
    },
    [hands, insuranceBet],
  );

  // ---------------------------------------------------------------------------
  // Settlement: compute outcome per hand, pay via wallet.win, show banners.
  // ---------------------------------------------------------------------------
  const settle = useCallback(
    (
      gen: number,
      finalHands: PlayerHand[],
      dealerCards: Card[],
      naturalsCheck: boolean,
      insBet: number,
    ) => {
      if (gen !== genRef.current) return;
      const dealerTotal = blackjackTotal(dealerCards).total;
      const dealerBJ = isBlackjack(dealerCards);
      const dealerBust = dealerTotal > 21;

      let net = 0; // net change vs. the chips wagered this round (excluding insurance handled separately)
      const wageredThisRound = finalHands.reduce((s, h) => s + h.bet, 0);

      const resolved: PlayerHand[] = finalHands.map((h) => {
        const pTotal = blackjackTotal(h.cards).total;
        const pBJ = naturalsCheck && isBlackjack(h.cards) && finalHands.length === 1 && !h.doubled;
        let outcome: HandOutcome;
        let payout = 0;

        if (pTotal > 21) {
          outcome = "bust";
          payout = 0;
        } else if (pBJ && dealerBJ) {
          outcome = "push";
          payout = h.bet; // refund stake
        } else if (pBJ) {
          outcome = "blackjack";
          payout = Math.round(h.bet * 2.5); // 3:2 incl. stake
        } else if (dealerBJ) {
          outcome = "lose";
          payout = 0;
        } else if (dealerBust) {
          outcome = "win";
          payout = h.bet * 2;
        } else if (pTotal > dealerTotal) {
          outcome = "win";
          payout = h.bet * 2;
        } else if (pTotal < dealerTotal) {
          outcome = "lose";
          payout = 0;
        } else {
          outcome = "push";
          payout = h.bet; // refund stake
        }

        if (payout > 0) wallet.win(payout);
        net += payout;
        return { ...h, done: true, outcome, payout };
      });

      net -= wageredThisRound; // subtract what we staked on the hands

      // include insurance in the net display (insBet already deducted; win credited above)
      if (insBet > 0) {
        if (dealerBJ) net += insBet * 3 - insBet; // profit of 2x
        else net -= insBet;
      }

      setHands(resolved);
      setActiveIdx(-1);
      setPhase("settle");
      setRoundNet(net);

      // headline banner
      const wins = resolved.filter((h) => h.outcome === "win" || h.outcome === "blackjack").length;
      const losses = resolved.filter((h) => h.outcome === "lose" || h.outcome === "bust").length;
      const pushes = resolved.filter((h) => h.outcome === "push").length;

      let banner: string;
      let burst: "win" | "lose" | "push";
      if (resolved.length === 1) {
        const o = resolved[0].outcome;
        if (o === "blackjack") {
          banner = "BLACKJACK! 3:2";
          burst = "win";
        } else if (o === "win") {
          banner = "YOU WIN";
          burst = "win";
        } else if (o === "push") {
          banner = "PUSH";
          burst = "push";
        } else if (o === "bust") {
          banner = "BUST";
          burst = "lose";
        } else {
          banner = dealerBJ ? "DEALER BLACKJACK" : "DEALER WINS";
          burst = "lose";
        }
      } else {
        const parts: string[] = [];
        if (wins) parts.push(`${wins} won`);
        if (pushes) parts.push(`${pushes} push`);
        if (losses) parts.push(`${losses} lost`);
        banner = parts.join(" · ") || "ROUND OVER";
        burst = net > 0 ? "win" : net < 0 ? "lose" : "push";
      }

      setRoundResult(net > 0 ? `${banner}  ${formatDelta(net)}` : banner);
      setShowBurst(burst);
      if (burst === "win") {
        if (net >= wageredThisRound * 2) sfx.jackpot();
        else sfx.win();
      } else if (burst === "lose") {
        sfx.lose();
      } else {
        sfx.tick();
      }
      setMessage("");
    },
    [wallet],
  );

  // Keep refs up to date so stale-closure consumers (advanceAfterAction,
  // dealerPlay, revealAndSettle) always invoke the current version.
  useEffect(() => { settleRef.current = settle; }, [settle]);
  useEffect(() => { dealerPlayRef.current = dealerPlay; }, [dealerPlay]);
  useEffect(() => { revealAndSettleRef.current = revealAndSettle; }, [revealAndSettle]);

  const newRound = useCallback(() => {
    genRef.current++;
    setPhase("betting");
    setHands([]);
    setDealer([]);
    setActiveIdx(0);
    setHoleHidden(true);
    setInsuranceBet(0);
    setRoundResult("");
    setRoundNet(null);
    setShowBurst(null);
    setMessage("");
    sfx.click();
  }, []);

  // ---------------------------------------------------------------------------
  // Derived UI flags.
  // ---------------------------------------------------------------------------
  const activeHand = activeIdx >= 0 ? hands[activeIdx] : undefined;
  const canHit = phase === "player" && !!activeHand && !activeHand.done;
  const canStand = canHit;
  const canDouble =
    phase === "player" &&
    !!activeHand &&
    activeHand.cards.length === 2 &&
    !activeHand.done &&
    wallet.balance >= activeHand.bet;
  const canSplit =
    phase === "player" &&
    !!activeHand &&
    activeHand.cards.length === 2 &&
    activeHand.cards[0].rank === activeHand.cards[1].rank &&
    !activeHand.done &&
    hands.length < 4 &&
    wallet.balance >= activeHand.bet;

  const dealerTotalNow = useMemo(() => {
    const visible = holeHidden ? dealer.slice(0, 1) : dealer;
    return blackjackTotal(visible);
  }, [dealer, holeHidden]);

  const dealerFullTotal = useMemo(() => blackjackTotal(dealer), [dealer]);

  const shoePct = Math.round((shoeCount / (DECKS * 52)) * 100);

  // ---------------------------------------------------------------------------
  // Render.
  // ---------------------------------------------------------------------------
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4">
      {/* Felt table surface */}
      <div
        className="felt relative overflow-hidden rounded-3xl p-4 sm:p-6"
        style={{ boxShadow: `0 0 0 1px ${ACCENT}22, 0 30px 80px rgba(0,0,0,0.5)` }}
      >
        {/* table arc + rules text */}
        <div className="pointer-events-none absolute inset-x-0 top-1/2 -z-0 mx-auto h-[60%] w-[120%] -translate-x-[8%] rounded-[50%] border border-white/5" />
        <div className="pointer-events-none absolute left-1/2 top-[46%] -translate-x-1/2 text-center">
          <div
            className="font-display text-xs uppercase tracking-[0.35em] sm:text-sm"
            style={{ color: `${ACCENT}55` }}
          >
            Blackjack pays 3 to 2
          </div>
          <div className="mt-1 text-[10px] uppercase tracking-[0.25em] text-white/15">
            Dealer stands on all 17 · Insurance pays 2 to 1
          </div>
        </div>

        {/* shoe indicator */}
        <div className="absolute right-3 top-3 z-10 flex items-center gap-2">
          <div className="relative h-8 w-12 rounded-md border border-white/10 bg-black/30">
            <motion.div
              className="absolute bottom-0 left-0 right-0 rounded-b-md"
              style={{ background: `linear-gradient(180deg, ${ACCENT}, ${ACCENT}66)` }}
              animate={{ height: `${Math.max(6, shoePct)}%` }}
              transition={{ type: "spring", stiffness: 120, damping: 18 }}
            />
            <span className="absolute inset-0 grid place-items-center text-[9px] font-bold text-white/70">
              SHOE
            </span>
          </div>
          <AnimatePresence>
            {shuffling && (
              <motion.span
                initial={{ opacity: 0, scale: 0.8 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0 }}
                className="rounded-full bg-black/50 px-2 py-1 text-[9px] font-bold uppercase tracking-wider"
                style={{ color: ACCENT }}
              >
                Shuffling…
              </motion.span>
            )}
          </AnimatePresence>
        </div>

        {/* DEALER ROW */}
        <div className="relative z-10 mb-2 flex flex-col items-center gap-2">
          <HandHeader
            label="Dealer"
            total={
              phase === "betting"
                ? null
                : holeHidden
                  ? dealerTotalNow.total
                  : dealerFullTotal.total
            }
            soft={!holeHidden && dealerFullTotal.soft}
            partial={holeHidden && dealer.length > 1}
            bust={!holeHidden && dealerFullTotal.total > 21}
          />
          <CardRow>
            <AnimatePresence>
              {dealer.map((c, i) => (
                <DealtCard
                  key={c.id}
                  card={c}
                  faceDown={i === 1 && holeHidden}
                  index={i}
                  from="top"
                />
              ))}
            </AnimatePresence>
            {dealer.length === 0 && phase !== "betting" && <CardSlot />}
          </CardRow>
        </div>

        {/* CENTER BANNER */}
        <div className="relative z-20 my-2 flex min-h-[44px] items-center justify-center">
          <AnimatePresence mode="wait">
            {roundResult ? (
              <motion.div
                key="result"
                data-testid="round-result"
                initial={{ scale: 0.5, opacity: 0, y: 10 }}
                animate={{ scale: 1, opacity: 1, y: 0 }}
                exit={{ scale: 0.8, opacity: 0 }}
                transition={{ type: "spring", stiffness: 320, damping: 18 }}
                className="rounded-2xl px-5 py-2 text-center font-display text-lg font-extrabold tracking-wide sm:text-2xl"
                style={{
                  color:
                    showBurst === "win" ? "#0a3" : showBurst === "lose" ? "#fff" : "#e9eef5",
                  background:
                    showBurst === "win"
                      ? `linear-gradient(180deg, ${ACCENT}, #b8860b)`
                      : showBurst === "lose"
                        ? "linear-gradient(180deg,#b91c1c,#7f1d1d)"
                        : "rgba(255,255,255,0.08)",
                  boxShadow:
                    showBurst === "win"
                      ? `0 0 30px ${ACCENT}aa`
                      : showBurst === "lose"
                        ? "0 0 22px rgba(185,28,28,0.6)"
                        : "none",
                }}
              >
                {roundResult}
              </motion.div>
            ) : message ? (
              <motion.div
                key={message}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                className="rounded-full bg-black/40 px-4 py-1 text-xs font-semibold uppercase tracking-widest text-white/70"
              >
                {message}
              </motion.div>
            ) : null}
          </AnimatePresence>

          {/* win burst particles */}
          <AnimatePresence>
            {showBurst === "win" && <WinBurst key="burst" />}
          </AnimatePresence>
        </div>

        {/* PLAYER ROW(S) */}
        <div className="relative z-10 mt-2 flex flex-wrap items-start justify-center gap-4">
          {phase === "betting" ? (
            <div className="flex h-[120px] items-center justify-center text-white/40">
              <span className="text-sm uppercase tracking-widest">Place your bet</span>
            </div>
          ) : (
            hands.map((h, i) => {
              const t = blackjackTotal(h.cards);
              const isActive = i === activeIdx && phase === "player";
              return (
                <motion.div
                  key={h.id}
                  layout
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  className={`flex flex-col items-center gap-2 rounded-2xl p-2 transition-colors ${
                    isActive ? "bg-white/5" : ""
                  }`}
                  style={
                    isActive
                      ? { boxShadow: `0 0 0 2px ${ACCENT}, 0 0 24px ${ACCENT}55` }
                      : undefined
                  }
                >
                  <HandHeader
                    label={hands.length > 1 ? `Hand ${i + 1}` : "You"}
                    total={t.total}
                    soft={t.soft}
                    bust={t.total > 21}
                    outcome={h.outcome}
                  />
                  <CardRow>
                    <AnimatePresence>
                      {h.cards.map((c, ci) => (
                        <DealtCard key={c.id} card={c} index={ci} from="bottom" />
                      ))}
                    </AnimatePresence>
                  </CardRow>
                  {/* hand bet chip stack */}
                  <BetStack amount={h.bet} doubled={h.doubled} />
                </motion.div>
              );
            })
          )}
        </div>
      </div>

      {/* CONTROL DECK */}
      <div className="glass rounded-2xl p-3 sm:p-4">
        {/* Betting phase */}
        {phase === "betting" && (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-center gap-2 sm:gap-3">
              {CHIPS.map((v) => (
                <Chip
                  key={v}
                  value={v}
                  size={50}
                  onClick={
                    v > wallet.balance
                      ? undefined
                      : () => {
                          sfx.chip();
                          setBet((b) => Math.min(wallet.balance, b + v));
                        }
                  }
                />
              ))}
            </div>
            <div className="flex flex-wrap items-center justify-center gap-2">
              <Button size="sm" variant="ghost" data-testid="bet-clear" onClick={() => setBet(0)}>
                Clear
              </Button>
              <Button
                size="sm"
                variant="ghost"
                data-testid="bet-half"
                onClick={() => setBet((b) => Math.max(0, Math.floor(b / 2)))}
              >
                ½
              </Button>
              <Button
                size="sm"
                variant="ghost"
                data-testid="bet-double"
                onClick={() => setBet((b) => Math.min(wallet.balance, b * 2))}
              >
                2×
              </Button>
              <Button
                size="sm"
                variant="ghost"
                data-testid="bet-max"
                onClick={() => setBet(wallet.balance)}
              >
                Max
              </Button>

              <motion.div
                key={bet}
                initial={{ scale: 0.92 }}
                animate={{ scale: 1 }}
                className="ml-1 min-w-[120px] rounded-xl border px-4 py-2 text-center"
                style={{ borderColor: `${ACCENT}55`, background: "rgba(0,0,0,0.4)" }}
              >
                <div className="text-[9px] uppercase tracking-widest text-white/40">Bet</div>
                <div className="gold-text text-lg font-bold tabular-nums">
                  {formatChips(bet)}
                </div>
              </motion.div>

              <Button
                size="lg"
                variant="gold"
                data-testid="play-btn"
                disabled={!canAfford}
                onClick={startRound}
              >
                Deal
              </Button>
            </div>
            {!canAfford && bet > 0 && (
              <p className="text-center text-xs text-red-300/80">
                {bet > wallet.balance ? "Bet exceeds balance." : "Minimum bet is 5."}
              </p>
            )}
          </div>
        )}

        {/* Dealing phase */}
        {phase === "dealing" && (
          <div className="flex items-center justify-center py-3 text-sm uppercase tracking-widest text-white/50">
            Dealing…
          </div>
        )}

        {/* Insurance phase */}
        {phase === "insurance" && (
          <div className="flex flex-col items-center gap-3 py-1">
            <p className="text-sm font-semibold text-white/80">
              Dealer shows an Ace — take insurance for{" "}
              <span style={{ color: ACCENT }}>{formatChips(Math.floor(bet / 2))}</span>? (pays 2:1)
            </p>
            <div className="flex gap-3">
              <Button
                variant="gold"
                data-testid="insurance-yes"
                onClick={() => finishInsurance(true)}
                disabled={Math.floor(bet / 2) > wallet.balance}
              >
                Take Insurance
              </Button>
              <Button variant="ghost" data-testid="insurance-no" onClick={() => finishInsurance(false)}>
                No Insurance
              </Button>
            </div>
          </div>
        )}

        {/* Player action phase */}
        {phase === "player" && (
          <div className="flex flex-wrap items-center justify-center gap-2 sm:gap-3">
            <Button size="lg" variant="gold" data-testid="play-btn" disabled={!canHit} onClick={hit}>
              Hit
            </Button>
            <Button size="lg" variant="felt" data-testid="stand-btn" disabled={!canStand} onClick={stand}>
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

        {/* Dealer / settle phases */}
        {phase === "dealer" && (
          <div className="flex items-center justify-center py-3 text-sm uppercase tracking-widest text-white/50">
            Dealer drawing…
          </div>
        )}

        {phase === "settle" && (
          <div className="flex flex-col items-center gap-2">
            {roundNet !== null && (
              <div
                className="text-sm font-bold tabular-nums"
                style={{ color: roundNet > 0 ? ACCENT : roundNet < 0 ? "#f87171" : "#cbd5e1" }}
              >
                {roundNet === 0 ? "Even" : formatDelta(roundNet)}
              </div>
            )}
            <Button size="lg" variant="gold" data-testid="play-btn" onClick={newRound}>
              New Round
            </Button>
          </div>
        )}
      </div>

      {/* PAYTABLE / ODDS */}
      <div className="glass grid grid-cols-2 gap-x-6 gap-y-1 rounded-2xl p-4 text-xs sm:grid-cols-4">
        <PayRow label="Blackjack" value="3 : 2" accent />
        <PayRow label="Win" value="1 : 1" />
        <PayRow label="Insurance" value="2 : 1" />
        <PayRow label="Push" value="Bet back" />
        <PayRow label="Dealer" value="Stands on 17" />
        <PayRow label="Shoe" value={`${DECKS} decks`} />
        <PayRow label="Double" value="First 2 only" />
        <PayRow label="Split" value="Equal rank" />
      </div>
    </div>
  );
}

// ===========================================================================
// Presentational helpers
// ===========================================================================

function HandHeader({
  label,
  total,
  soft,
  bust,
  partial,
  outcome,
}: {
  label: string;
  total: number | null;
  soft?: boolean;
  bust?: boolean;
  partial?: boolean;
  outcome?: HandOutcome;
}) {
  const color = bust ? "#f87171" : outcome === "win" || outcome === "blackjack" ? "#facc15" : "#fff";
  return (
    <div className="flex items-center gap-2">
      <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-white/50">
        {label}
      </span>
      {total !== null && (
        <motion.span
          key={`${total}-${soft}`}
          initial={{ scale: 0.7, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          className="grid min-w-[34px] place-items-center rounded-full bg-black/50 px-2 py-0.5 text-xs font-extrabold tabular-nums"
          style={{ color }}
        >
          {total}
          {soft && total !== 21 ? "↕" : ""}
          {partial ? "+" : ""}
        </motion.span>
      )}
      {bust && (
        <span className="rounded bg-red-600/80 px-1.5 py-0.5 text-[9px] font-bold uppercase text-white">
          Bust
        </span>
      )}
      {outcome === "blackjack" && (
        <span
          className="rounded px-1.5 py-0.5 text-[9px] font-bold uppercase text-black"
          style={{ background: ACCENT }}
        >
          BJ
        </span>
      )}
      {outcome === "push" && (
        <span className="rounded bg-white/20 px-1.5 py-0.5 text-[9px] font-bold uppercase text-white">
          Push
        </span>
      )}
    </div>
  );
}

function CardRow({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-[92px] items-center justify-center gap-1.5">{children}</div>
  );
}

function CardSlot() {
  return (
    <div
      className="rounded-[9px] border border-dashed border-white/10"
      style={{ width: 66, height: 92 }}
    />
  );
}

function DealtCard({
  card,
  faceDown,
  index,
  from,
}: {
  card: Card;
  faceDown?: boolean;
  index: number;
  from: "top" | "bottom";
}) {
  const dir = from === "top" ? -1 : 1;
  return (
    <motion.div
      layout
      initial={{
        x: 220,
        y: dir * -160,
        rotate: 18,
        opacity: 0,
        scale: 0.8,
      }}
      animate={{ x: 0, y: 0, rotate: 0, opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.8, transition: { duration: 0.15 } }}
      transition={{
        type: "spring",
        stiffness: 260,
        damping: 22,
        delay: index * 0.02,
      }}
      style={{ marginLeft: index > 0 ? -14 : 0, zIndex: index }}
    >
      <PlayingCard card={card} faceDown={faceDown} size="md" />
    </motion.div>
  );
}

function BetStack({ amount, doubled }: { amount: number; doubled: boolean }) {
  return (
    <motion.div
      initial={{ y: 14, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      className="flex items-center gap-1.5"
    >
      <Chip value={Math.min(amount, 1000)} size={26} showValue={false} />
      <span className="text-xs font-bold tabular-nums text-white/80">
        {formatChips(amount)}
        {doubled && <span style={{ color: ACCENT }}> ×2</span>}
      </span>
    </motion.div>
  );
}

function PayRow({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="flex items-center justify-between border-b border-white/5 py-0.5">
      <span className="text-white/50">{label}</span>
      <span className="font-bold tabular-nums" style={{ color: accent ? ACCENT : "#e9eef5" }}>
        {value}
      </span>
    </div>
  );
}

function WinBurst() {
  const particles = Array.from({ length: 14 });
  return (
    <div className="pointer-events-none absolute inset-0 grid place-items-center">
      {particles.map((_, i) => {
        const angle = (i / particles.length) * Math.PI * 2;
        const dist = 70 + (i % 3) * 22;
        return (
          <motion.span
            key={i}
            initial={{ x: 0, y: 0, opacity: 1, scale: 1 }}
            animate={{
              x: Math.cos(angle) * dist,
              y: Math.sin(angle) * dist,
              opacity: 0,
              scale: 0.4,
            }}
            transition={{ duration: 0.9, ease: "easeOut" }}
            className="absolute h-2 w-2 rounded-full"
            style={{
              background: i % 2 === 0 ? ACCENT : "#fff4c2",
              boxShadow: `0 0 8px ${ACCENT}`,
            }}
          />
        );
      })}
    </div>
  );
}
