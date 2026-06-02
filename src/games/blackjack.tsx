"use client";

import React, {
  useCallback,
  useMemo,
  useRef,
  useState,
} from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  type Card,
  blackjackTotal,
} from "@/lib/cards";
import { useWallet } from "@/lib/wallet";
import { usePlayRound } from "@/lib/playRound";
import { formatChips, formatDelta } from "@/lib/format";
import { sleep } from "@/lib/async";
import { sfx } from "@/lib/sound";
import { Button } from "@/components/ui/Button";
import { Chip } from "@/components/ui/Chip";
import { PlayingCard } from "@/components/PlayingCard";
import { Celebration } from "@/components/Celebration";

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

function isBlackjack(cards: Card[]): boolean {
  return cards.length === 2 && blackjackTotal(cards).total === 21;
}

/** Server hand view → the client's PlayerHand shape (display only). */
interface ServerHand {
  cards: Card[];
  bet: number;
  done?: boolean;
  doubled?: boolean;
}
function serverHandsToLocal(serverHands: ServerHand[], outcomes?: HandOutcome[]): PlayerHand[] {
  return serverHands.map((h, i) => ({
    id: i + 1,
    cards: h.cards,
    bet: h.bet,
    done: !!h.done,
    doubled: !!h.doubled,
    isSplitAces: false,
    outcome: outcomes ? outcomes[i] : null,
    payout: 0,
  }));
}

export default function Blackjack() {
  const wallet = useWallet();
  // The server owns the real 6-deck shoe (one per round). The client only routes
  // decisions through /api/round and animates the cards the server deals back.
  const { start: roundStart, act: roundAct } = usePlayRound();
  const roundIdRef = useRef<string | null>(null);

  // --- cosmetic shoe (visual depth/shuffle indicator only) -------------------
  const [shoeCount, setShoeCount] = useState(DECKS * 52);
  const [shuffling, setShuffling] = useState(false);
  const burnShoe = useCallback((n: number) => {
    setShoeCount((c) => {
      const next = c - n;
      if (next < RESHUFFLE_AT) {
        setShuffling(true);
        setTimeout(() => setShuffling(false), 650);
        return DECKS * 52 - n;
      }
      return Math.max(0, next);
    });
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
  // Premium-win celebration: only naturals (3:2) and big multi-hand returns.
  const [celebration, setCelebration] = useState<{ payout: number; tier: "big" | "jackpot" } | null>(
    null,
  );

  // generation token to abort async sequences if the player resets / re-deals.
  const genRef = useRef(0);

  const canAfford = bet >= 5 && bet <= wallet.balance;

  // ---------------------------------------------------------------------------
  // Settlement display — the server already credited the balance; this only
  // renders the resolved hands, dealer, banner and celebration.
  // ---------------------------------------------------------------------------
  const settleDisplay = useCallback(
    (pv: Record<string, unknown>, payout: number) => {
      const serverHands = (pv.playerHands ?? []) as ServerHand[];
      const outcomes = (pv.outcomes ?? []) as HandOutcome[];
      const dealerCards = (pv.dealer ?? []) as Card[];
      const insBet = (pv.insurance as number) ?? 0;
      const resolved = serverHandsToLocal(serverHands, outcomes);
      const wageredThisRound = serverHands.reduce((s, h) => s + h.bet, 0) + insBet;
      const net = payout - wageredThisRound;

      setHands(resolved);
      setDealer(dealerCards);
      setHoleHidden(false);
      setActiveIdx(-1);
      setPhase("settle");
      setRoundNet(net);

      const wins = resolved.filter((h) => h.outcome === "win" || h.outcome === "blackjack").length;
      const losses = resolved.filter((h) => h.outcome === "lose" || h.outcome === "bust").length;
      const pushes = resolved.filter((h) => h.outcome === "push").length;
      const dealerBJ = isBlackjack(dealerCards);

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

      const isNatural = resolved.length === 1 && resolved[0].outcome === "blackjack";
      if (isNatural) {
        setCelebration({ payout, tier: "big" });
      } else if (net >= wageredThisRound * 1.5) {
        setCelebration({ payout, tier: net >= wageredThisRound * 3 ? "jackpot" : "big" });
      } else {
        setCelebration(null);
      }

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
    [],
  );

  // ---------------------------------------------------------------------------
  // Animate the dealer drawing out, then settle. (Dealer cards come from the
  // server, which has already played the hand to S17.)
  // ---------------------------------------------------------------------------
  const revealDealerAndSettle = useCallback(
    async (gen: number, pv: Record<string, unknown>, payout: number) => {
      const dealerCards = (pv.dealer ?? []) as Card[];
      setActiveIdx(-1);
      setPhase("dealer");
      setHoleHidden(false);
      setHands(serverHandsToLocal((pv.playerHands ?? []) as ServerHand[]));
      // reveal the hole, then draw the rest one at a time
      setDealer(dealerCards.slice(0, 2));
      sfx.card();
      await sleep(560);
      if (gen !== genRef.current) return;
      for (let k = 2; k < dealerCards.length; k++) {
        setDealer(dealerCards.slice(0, k + 1));
        sfx.card();
        await sleep(DEALER_GAP);
        if (gen !== genRef.current) return;
      }
      if (blackjackTotal(dealerCards).total > 21) sfx.thud();
      await sleep(300);
      if (gen !== genRef.current) return;
      settleDisplay(pv, payout);
    },
    [settleDisplay],
  );

  // ---------------------------------------------------------------------------
  // Apply a non-terminal server step (next hand / insurance) or settle.
  // ---------------------------------------------------------------------------
  const applyStep = useCallback(
    async (gen: number, res: { done?: boolean; publicView: Record<string, unknown>; payout?: number }) => {
      const pv = res.publicView;
      if (res.done) {
        await revealDealerAndSettle(gen, pv, res.payout ?? 0);
        return;
      }
      const serverHands = (pv.playerHands ?? []) as ServerHand[];
      setHands(serverHandsToLocal(serverHands));
      setActiveIdx((pv.active as number) ?? 0);
      setPhase("player");
      setMessage(serverHands.length > 1 ? `Playing hand ${((pv.active as number) ?? 0) + 1}.` : "Your move.");
    },
    [revealDealerAndSettle],
  );

  // ---------------------------------------------------------------------------
  // Deal a fresh round (server-authoritative).
  // ---------------------------------------------------------------------------
  const startRound = useCallback(async () => {
    if (phase !== "betting") return;
    if (bet < 5 || bet > wallet.balance) return;

    const gen = ++genRef.current;
    let res;
    try {
      res = await roundStart("blackjack", bet, {}); // server debits the main bet
    } catch {
      return;
    }
    if (gen !== genRef.current) return;
    roundIdRef.current = res.roundId ?? null;

    // reset visuals
    setRoundResult("");
    setRoundNet(null);
    setShowBurst(null);
    setCelebration(null);
    setInsuranceBet(0);
    setMessage("");
    setHoleHidden(true);
    setActiveIdx(0);

    const pv = res.publicView;
    const playerCards = ((pv.playerHands ?? []) as ServerHand[])[0].cards;
    const dealerUp = (pv.dealerUp as Card) ?? ((pv.dealer as Card[]) ?? [])[0];
    burnShoe(4);

    setHands([
      { id: HAND_ID++, cards: [], bet, done: false, doubled: false, isSplitAces: false, outcome: null, payout: 0 },
    ]);
    setDealer([]);
    setPhase("dealing");

    // staged deal: player, dealer-up, player, dealer-hole(face-down)
    await sleep(DEAL_GAP * 0.6);
    if (gen !== genRef.current) return;
    sfx.card();
    setHands((prev) => prev.map((h, i) => (i === 0 ? { ...h, cards: [playerCards[0]] } : h)));
    await sleep(DEAL_GAP);
    if (gen !== genRef.current) return;
    sfx.card();
    setDealer([dealerUp]);
    await sleep(DEAL_GAP);
    if (gen !== genRef.current) return;
    sfx.card();
    setHands((prev) => prev.map((h, i) => (i === 0 ? { ...h, cards: playerCards } : h)));
    await sleep(DEAL_GAP);
    if (gen !== genRef.current) return;
    sfx.card();
    setDealer([dealerUp, playerCards[0]]); // face-down placeholder hole
    await sleep(DEAL_GAP);
    if (gen !== genRef.current) return;

    if (res.done) {
      // Natural (player and/or dealer) — settled at the deal.
      setPhase("dealer");
      setHoleHidden(false);
      setDealer((pv.dealer as Card[]) ?? [dealerUp, playerCards[0]]);
      await sleep(520);
      if (gen !== genRef.current) return;
      settleDisplay(pv, res.payout ?? 0);
      return;
    }

    if (pv.awaitingInsurance) {
      setHands(serverHandsToLocal((pv.playerHands ?? []) as ServerHand[]));
      setPhase("insurance");
      setMessage("Insurance? Dealer shows an Ace.");
      return;
    }

    setHands(serverHandsToLocal((pv.playerHands ?? []) as ServerHand[]));
    setActiveIdx((pv.active as number) ?? 0);
    setPhase("player");
    setMessage("Your move.");
  }, [phase, bet, wallet.balance, roundStart, burnShoe, settleDisplay]);

  // ---------------------------------------------------------------------------
  // Player actions — each routes a decision through the server.
  // ---------------------------------------------------------------------------
  const acting = useRef(false);
  const sendAction = useCallback(
    async (action: string) => {
      const rid = roundIdRef.current;
      if (!rid || acting.current) return;
      acting.current = true;
      const gen = genRef.current;
      try {
        if (action === "double" || action === "split" || action === "insurance") sfx.chip();
        else sfx.click();
        let res;
        try {
          res = await roundAct(rid, action);
        } catch {
          return;
        }
        if (gen !== genRef.current) return;
        if (action === "split") burnShoe(2);
        else if (action === "hit" || action === "double") burnShoe(1);
        if (action === "insurance") setInsuranceBet(Math.floor(bet / 2));
        await applyStep(gen, res);
      } finally {
        acting.current = false;
      }
    },
    [roundAct, applyStep, burnShoe, bet],
  );

  const hit = useCallback(() => {
    if (phase !== "player") return;
    void sendAction("hit");
  }, [phase, sendAction]);

  const stand = useCallback(() => {
    if (phase !== "player") return;
    void sendAction("stand");
  }, [phase, sendAction]);

  const double = useCallback(() => {
    if (phase !== "player") return;
    const hand = hands[activeIdx];
    if (!hand || hand.cards.length !== 2 || wallet.balance < hand.bet) {
      setMessage("Not enough chips to double.");
      return;
    }
    void sendAction("double");
  }, [phase, hands, activeIdx, wallet.balance, sendAction]);

  const split = useCallback(() => {
    if (phase !== "player") return;
    const hand = hands[activeIdx];
    if (!hand || hand.cards.length !== 2 || hand.cards[0].rank !== hand.cards[1].rank) return;
    if (wallet.balance < hand.bet) {
      setMessage("Not enough chips to split.");
      return;
    }
    void sendAction("split");
  }, [phase, hands, activeIdx, wallet.balance, sendAction]);

  const finishInsurance = useCallback(
    (took: boolean) => {
      if (phase !== "insurance") return;
      void sendAction(took ? "insurance" : "decline");
    },
    [phase, sendAction],
  );

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
    setCelebration(null);
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
        {/* Premium-win celebration overlay (naturals & big multi-hand returns). */}
        <Celebration
          show={celebration !== null}
          seed={celebration?.payout ?? 0}
          tier={celebration?.tier ?? "big"}
          colors={["#d4af37", "#ffd24a", "#22e1ff", "#ffffff"]}
        />

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
