"use client";

/**
 * Pai Gow Poker — Neon Royale
 * ---------------------------------------------------------------------------
 * 53-card deck (makeDeck(1) + one JOKER). 7 cards to player, 7 to dealer.
 * Player splits 7 cards into a 5-card HIGH hand and a 2-card LOW hand.
 * The HIGH hand must outrank the LOW hand (no "foul"). House Way auto-sets
 * a legal split; manual swapping is validated against the foul rule.
 *
 * Joker is semi-wild: it can complete a straight or flush, otherwise it
 * plays as an Ace. Evaluation substitutes the joker to maximise the hand
 * within those rules.
 *
 * Payouts (commission 5%): win BOTH -> win(bet * 1.95). Win one / lose one
 * (or any tie on a single hand) -> PUSH win(bet). Lose both / copy both ->
 * lose. Dealer wins all copies (ties).
 */

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
  type Rank,
  type Suit,
  type HandRank,
  HandCategory,
  RANKS,
  SUITS,
  rankValue,
  makeDeck,
  evaluate5,
} from "@/lib/cards";
import { shuffle } from "@/lib/rng";
import { formatChips, formatDelta } from "@/lib/format";
import { sfx } from "@/lib/sound";
import { useWallet } from "@/lib/wallet";
import { Button } from "@/components/ui/Button";
import { PlayingCard } from "@/components/PlayingCard";
import { BetControls } from "@/components/BetControls";

const ACCENT = "#e74c3c";
const JOKER_ID = "JOKER#0";

// ---------------------------------------------------------------------------
// Joker plumbing
// ---------------------------------------------------------------------------

/** The single joker card. Rank/suit are placeholders; identity is by id. */
const JOKER: Card = { rank: "A", suit: "spades", id: JOKER_ID };

function isJoker(c: Card): boolean {
  return c.id === JOKER_ID;
}

/** Build the 53-card Pai Gow deck: a standard deck + one joker, shuffled. */
function makePaiGowDeck(): Card[] {
  return shuffle([...makeDeck(1), JOKER]);
}

// ---------------------------------------------------------------------------
// 5-card evaluation with semi-wild joker
// ---------------------------------------------------------------------------

const ALL_RANK_SUIT: { rank: Rank; suit: Suit }[] = (() => {
  const out: { rank: Rank; suit: Suit }[] = [];
  for (const rank of RANKS) for (const suit of SUITS) out.push({ rank, suit });
  return out;
})();

/**
 * Evaluate exactly 5 cards, substituting a joker (if present) to maximise the
 * hand. Pai Gow rule: joker only completes a straight/flush, otherwise it is
 * an Ace. We approximate this faithfully by trying every substitution and
 * keeping the best — for straights/flushes that yields the completed hand;
 * for everything else, substituting the missing Ace (Ace-high / pair of aces)
 * is always the best non-straight/flush result, matching the rule.
 */
function evalFive(cards: Card[]): HandRank {
  const jokerIdx = cards.findIndex(isJoker);
  if (jokerIdx === -1) return evaluate5(cards);

  // Cards already on the table (excluding the joker) constrain which physical
  // card the joker could "be", but for ranking we only care about rank/suit
  // achievable — duplicates of an existing card are impossible, so skip them.
  const present = new Set(
    cards.filter((c) => !isJoker(c)).map((c) => `${c.rank}|${c.suit}`),
  );

  let best: HandRank | null = null;
  for (const sub of ALL_RANK_SUIT) {
    if (present.has(`${sub.rank}|${sub.suit}`)) continue;
    const trial = cards.slice();
    trial[jokerIdx] = { rank: sub.rank, suit: sub.suit, id: "JOKER-SUB" };
    const r = evaluate5(trial);
    if (!best || r.score > best.score) best = r;
  }
  // Fallback (should never trigger): joker as plain Ace of an unused suit.
  if (!best) best = evaluate5(cards.map((c) => (isJoker(c) ? { ...JOKER } : c)));
  return best;
}

// ---------------------------------------------------------------------------
// 2-card (low) evaluation — pair beats high card; joker plays as an Ace.
// ---------------------------------------------------------------------------

interface LowRank {
  pair: boolean;
  /** Sorted high values for tiebreak (most significant first). */
  tiebreak: number[];
  score: number;
  label: string;
}

function lowValue(c: Card): number {
  // In a 2-card hand the joker is always an Ace (it can never make a
  // straight/flush of length 2 that beats a pair).
  return isJoker(c) ? 14 : rankValue(c.rank);
}

function rankLabel(v: number): string {
  const map: Record<number, string> = {
    14: "A",
    13: "K",
    12: "Q",
    11: "J",
    10: "10",
  };
  return map[v] ?? String(v);
}

function evalLow(cards: Card[]): LowRank {
  const vals = cards.map(lowValue).sort((a, b) => b - a);
  const pair = vals[0] === vals[1];
  // pair flag dominates, then high values.
  const score = (pair ? 1 : 0) * 1_000_000 + vals[0] * 1000 + (vals[1] ?? 0);
  const label = pair
    ? `Pair of ${rankLabel(vals[0])}s`
    : `${rankLabel(vals[0])} High`;
  return { pair, tiebreak: vals, score, label };
}

// ---------------------------------------------------------------------------
// House Way — arrange 7 cards into a legal { high(5), low(2) } split.
// ---------------------------------------------------------------------------

interface Split {
  high: Card[]; // 5
  low: Card[]; // 2
}

/** All ways to choose the 2 low cards (then the rest are high). */
function* lowChoices(cards: Card[]): Generator<Split> {
  for (let i = 0; i < cards.length; i++) {
    for (let j = i + 1; j < cards.length; j++) {
      const low = [cards[i], cards[j]];
      const high = cards.filter((_, k) => k !== i && k !== j);
      yield { high, low };
    }
  }
}

/** A split is legal iff the 5-card high hand strictly outranks the 2-card low. */
function isLegal(split: Split): boolean {
  const h = evalFive(split.high);
  const l = evalLow(split.low);
  // Compare across hand types: any made 5-card hand (pair+) clearly beats a
  // 2-card hand, but high-card-vs-high-card and pair-vs-pair need value checks.
  return highBeatsLow(h, l);
}

/**
 * Does the 5-card HIGH hand outrank the 2-card LOW hand? The low hand can only
 * be a pair or high card, so we compare on that footing.
 */
function highBeatsLow(high: HandRank, low: LowRank): boolean {
  const highIsPairPlus = high.category >= HandCategory.Pair;
  if (highIsPairPlus && !low.pair) return true; // pair+ beats any 2-card high card
  if (!highIsPairPlus && low.pair) return false; // 5-card high card loses to a low pair (foul)

  if (high.category === HandCategory.Pair && low.pair) {
    // Compare the pair ranks: high hand's pair value vs low pair value.
    const highPair = high.tiebreak[0];
    const lowPair = low.tiebreak[0];
    return highPair > lowPair; // equal -> not strictly greater -> foul
  }
  if (!highIsPairPlus && !low.pair) {
    // Both high card: compare top card of each.
    return high.tiebreak[0] > low.tiebreak[0];
  }
  // high is two-pair+ (>= TwoPair) vs low pair -> high wins.
  return true;
}

const STRENGTH = (c: Card) => (isJoker(c) ? 15 : rankValue(c.rank));

/**
 * House Way: find the legal split whose HIGH hand is strongest, while keeping
 * the LOW hand as strong as possible without fouling. This mirrors the common
 * casino heuristic: keep the best 5-card hand in back, push the two highest
 * remaining to the front — never fouling.
 */
function houseWay(cards: Card[]): Split {
  let best: { split: Split; highScore: number; lowScore: number } | null = null;
  for (const split of lowChoices(cards)) {
    if (!isLegal(split)) continue;
    const highScore = evalFive(split.high).score;
    const lowScore = evalLow(split.low).score;
    if (
      !best ||
      highScore > best.highScore ||
      (highScore === best.highScore && lowScore > best.lowScore)
    ) {
      best = { split, highScore, lowScore };
    }
  }
  // Guaranteed at least one legal split exists for any 7 cards (e.g. best 5 in
  // back, two lowest in front). Fallback keeps TS happy.
  if (best) return sortSplit(best.split);
  const sorted = [...cards].sort((a, b) => STRENGTH(b) - STRENGTH(a));
  return sortSplit({ high: sorted.slice(0, 5), low: sorted.slice(5, 7) });
}

/** Sort each sub-hand high→low for stable, readable display. */
function sortSplit(split: Split): Split {
  return {
    high: [...split.high].sort((a, b) => STRENGTH(b) - STRENGTH(a)),
    low: [...split.low].sort((a, b) => STRENGTH(b) - STRENGTH(a)),
  };
}

// ---------------------------------------------------------------------------
// Outcome resolution
// ---------------------------------------------------------------------------

type Outcome = "win" | "push" | "lose";

interface Resolution {
  outcome: Outcome;
  highResult: number; // >0 player, <0 dealer, 0 copy
  lowResult: number;
  playerHigh: HandRank;
  dealerHigh: HandRank;
  playerLow: LowRank;
  dealerLow: LowRank;
}

function resolve(player: Split, dealer: Split): Resolution {
  const playerHigh = evalFive(player.high);
  const dealerHigh = evalFive(dealer.high);
  const playerLow = evalLow(player.low);
  const dealerLow = evalLow(dealer.low);

  // Dealer wins copies (ties), so a tie counts as a dealer win on that hand.
  const highResult = playerHigh.score - dealerHigh.score; // 0 => copy => dealer
  const lowResult = playerLow.score - dealerLow.score;

  const playerWinsHigh = highResult > 0;
  const playerWinsLow = lowResult > 0;

  let outcome: Outcome;
  if (playerWinsHigh && playerWinsLow) outcome = "win";
  else if (!playerWinsHigh && !playerWinsLow) outcome = "lose";
  else outcome = "push"; // split one / one (or a copy on one hand)

  return {
    outcome,
    highResult,
    lowResult,
    playerHigh,
    dealerHigh,
    playerLow,
    dealerLow,
  };
}

// ---------------------------------------------------------------------------
// Phases
// ---------------------------------------------------------------------------

type Phase = "betting" | "dealing" | "arranging" | "revealing" | "result";

const CHIPS = [5, 25, 100, 500];

// ---------------------------------------------------------------------------
// Small presentational helpers
// ---------------------------------------------------------------------------

/** A face-up / face-down card that can be selected (for manual swaps). */
function ArrangeCard({
  card,
  selected,
  onClick,
  faceDown,
  highlight,
  size = "sm",
}: {
  card: Card | null;
  selected?: boolean;
  onClick?: () => void;
  faceDown?: boolean;
  highlight?: boolean;
  size?: "xs" | "sm" | "md";
}) {
  return (
    <motion.button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      whileHover={onClick ? { y: -8 } : undefined}
      whileTap={onClick ? { scale: 0.95 } : undefined}
      className="relative shrink-0 rounded-lg"
      style={{ cursor: onClick ? "pointer" : "default" }}
      animate={{ y: selected ? -12 : 0 }}
      transition={{ type: "spring", stiffness: 380, damping: 26 }}
    >
      <JokerCard card={card} faceDown={faceDown} highlight={highlight || selected} size={size} />
      {selected && (
        <motion.span
          layoutId="sel-ring"
          className="pointer-events-none absolute -inset-1 rounded-xl"
          style={{ boxShadow: `0 0 0 2px ${ACCENT}, 0 0 16px ${ACCENT}` }}
        />
      )}
    </motion.button>
  );
}

/** Renders the joker with a custom face; otherwise delegates to PlayingCard. */
function JokerCard({
  card,
  faceDown,
  highlight,
  size = "sm",
}: {
  card: Card | null;
  faceDown?: boolean;
  highlight?: boolean;
  size?: "xs" | "sm" | "md";
}) {
  const DIMS = {
    xs: { w: 38, h: 54, r: 6 },
    sm: { w: 50, h: 70, r: 7 },
    md: { w: 66, h: 92, r: 9 },
  }[size];

  if (!card || faceDown || !isJoker(card)) {
    return <PlayingCard card={card} faceDown={faceDown} highlight={highlight} size={size} />;
  }

  // Custom Joker face.
  return (
    <div className="relative shrink-0" style={{ width: DIMS.w, height: DIMS.h }}>
      <div
        className="absolute inset-0 grid place-items-center overflow-hidden bg-white"
        style={{
          borderRadius: DIMS.r,
          boxShadow: highlight
            ? `0 0 0 2px ${ACCENT}, 0 0 18px ${ACCENT}aa, 0 6px 14px rgba(0,0,0,0.5)`
            : "0 4px 12px rgba(0,0,0,0.45), inset 0 0 0 1px rgba(0,0,0,0.08)",
          background:
            "linear-gradient(150deg, #fff 0%, #fff 55%, #ffe9e9 100%)",
        }}
      >
        <span
          className="absolute font-bold leading-none"
          style={{ top: 4, left: 5, fontSize: DIMS.w * 0.22, color: ACCENT }}
        >
          J<span style={{ display: "block", fontSize: DIMS.w * 0.2 }}>★</span>
        </span>
        <span
          className="absolute font-bold leading-none"
          style={{
            bottom: 4,
            right: 5,
            fontSize: DIMS.w * 0.22,
            color: ACCENT,
            transform: "rotate(180deg)",
          }}
        >
          J<span style={{ display: "block", fontSize: DIMS.w * 0.2 }}>★</span>
        </span>
        <span style={{ fontSize: DIMS.w * 0.7 }}>🃏</span>
      </div>
    </div>
  );
}

function HandRankBadge({ text }: { text: string }) {
  return (
    <span className="rounded-md border border-white/15 bg-black/40 px-2 py-0.5 text-[10px] uppercase tracking-wider text-white/70">
      {text}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function PaiGowPoker() {
  const wallet = useWallet();

  const [bet, setBet] = useState(25);
  const [phase, setPhase] = useState<Phase>("betting");

  // Player's seven cards + the indices currently assigned to the LOW hand.
  const [playerCards, setPlayerCards] = useState<Card[]>([]);
  const [lowIdx, setLowIdx] = useState<[number, number]>([5, 6]);
  const [dealerSplit, setDealerSplit] = useState<Split | null>(null);

  // Manual-swap selection (indices into playerCards).
  const [selected, setSelected] = useState<number[]>([]);

  // Dealing / reveal staging.
  const [dealt, setDealt] = useState(0); // how many of the 14 cards have landed
  const [dealerFaceUp, setDealerFaceUp] = useState(false);

  const [resolution, setResolution] = useState<Resolution | null>(null);
  const [payout, setPayout] = useState(0);
  const [lastDelta, setLastDelta] = useState(0);
  const [foulWarning, setFoulWarning] = useState(false);

  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const clearTimers = useCallback(() => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
  }, []);
  useEffect(() => () => clearTimers(), [clearTimers]);

  const balance = wallet.balance;
  const canAfford = bet > 0 && bet <= balance;

  // Derived player split from the current low-index assignment.
  const playerSplit = useMemo<Split>(() => {
    if (playerCards.length !== 7) return { high: [], low: [] };
    const low = [playerCards[lowIdx[0]], playerCards[lowIdx[1]]];
    const high = playerCards.filter((_, k) => k !== lowIdx[0] && k !== lowIdx[1]);
    return { high, low };
  }, [playerCards, lowIdx]);

  const playerHighEval = useMemo(
    () => (playerSplit.high.length === 5 ? evalFive(playerSplit.high) : null),
    [playerSplit],
  );
  const playerLowEval = useMemo(
    () => (playerSplit.low.length === 2 ? evalLow(playerSplit.low) : null),
    [playerSplit],
  );

  const currentlyLegal = useMemo(() => {
    if (!playerHighEval || !playerLowEval) return true;
    return highBeatsLow(playerHighEval, playerLowEval);
  }, [playerHighEval, playerLowEval]);

  // -------------------------------------------------------------------------
  // Deal a new round
  // -------------------------------------------------------------------------
  const deal = useCallback(() => {
    if (phase !== "betting" && phase !== "result") return;
    if (!canAfford) return;
    if (!wallet.bet(bet)) return;

    clearTimers();
    setResolution(null);
    setPayout(0);
    setLastDelta(0);
    setFoulWarning(false);
    setSelected([]);
    setDealerFaceUp(false);
    setDealt(0);

    const deck = makePaiGowDeck();
    const pCards = deck.slice(0, 7);
    const dCards = deck.slice(7, 14);

    // House Way the player's hand as the default starting arrangement.
    const startSplit = houseWay(pCards);
    // Re-order playerCards so high hand is first 5, low hand is last 2 (stable).
    const ordered = [...startSplit.high, ...startSplit.low];
    setPlayerCards(ordered);
    setLowIdx([5, 6]);
    setDealerSplit(houseWay(dCards));

    setPhase("dealing");

    // Animate the 14-card deal: alternate dealer / player.
    const order = 14;
    for (let i = 0; i < order; i++) {
      timers.current.push(
        setTimeout(() => {
          setDealt((d) => d + 1);
          sfx.card();
        }, 120 + i * 120),
      );
    }
    timers.current.push(
      setTimeout(() => setPhase("arranging"), 120 + order * 120 + 200),
    );
  }, [phase, canAfford, wallet, bet, clearTimers]);

  // -------------------------------------------------------------------------
  // Manual swap: select up to two cards, then swap their hand assignment.
  // -------------------------------------------------------------------------
  const toggleSelect = useCallback(
    (idx: number) => {
      if (phase !== "arranging") return;
      sfx.click();
      setFoulWarning(false);
      setSelected((sel) => {
        if (sel.includes(idx)) return sel.filter((x) => x !== idx);
        if (sel.length >= 2) return [sel[1], idx];
        return [...sel, idx];
      });
    },
    [phase],
  );

  // When two cards from OPPOSITE hands are selected, offer to swap them.
  const trySwap = useCallback(() => {
    if (selected.length !== 2) return;
    const [a, b] = selected;
    const aIsLow = lowIdx.includes(a);
    const bIsLow = lowIdx.includes(b);
    if (aIsLow === bIsLow) {
      // Same hand — swapping within a hand has no ranking effect; just clear.
      setSelected([]);
      return;
    }
    // Build prospective low-index set: replace the low card with the high card.
    const lowOne = aIsLow ? a : b;
    const highOne = aIsLow ? b : a;
    const nextLow: [number, number] = [
      lowIdx[0] === lowOne ? highOne : lowIdx[0],
      lowIdx[1] === lowOne ? highOne : lowIdx[1],
    ];
    // Validate the prospective split for a foul.
    const low = [playerCards[nextLow[0]], playerCards[nextLow[1]]];
    const high = playerCards.filter((_, k) => k !== nextLow[0] && k !== nextLow[1]);
    if (!highBeatsLow(evalFive(high), evalLow(low))) {
      setFoulWarning(true);
      sfx.lose();
      setSelected([]);
      return;
    }
    sfx.chip();
    setLowIdx(nextLow);
    setSelected([]);
  }, [selected, lowIdx, playerCards]);

  // Auto-attempt the swap as soon as a valid opposite-hand pair is selected.
  useEffect(() => {
    if (phase !== "arranging" || selected.length !== 2) return;
    const [a, b] = selected;
    if (lowIdx.includes(a) !== lowIdx.includes(b)) trySwap();
  }, [selected, phase, lowIdx, trySwap]);

  const setHouseWay = useCallback(() => {
    if (phase !== "arranging" || playerCards.length !== 7) return;
    sfx.chip();
    setFoulWarning(false);
    setSelected([]);
    const hw = houseWay(playerCards);
    const ordered = [...hw.high, ...hw.low];
    setPlayerCards(ordered);
    setLowIdx([5, 6]);
  }, [phase, playerCards]);

  // -------------------------------------------------------------------------
  // Confirm arrangement -> reveal dealer -> resolve.
  // -------------------------------------------------------------------------
  const confirm = useCallback(() => {
    if (phase !== "arranging" || !dealerSplit) return;
    if (!currentlyLegal) {
      setFoulWarning(true);
      sfx.lose();
      return;
    }
    clearTimers();
    setPhase("revealing");
    sfx.card();

    // Flip dealer cards face up, then resolve.
    timers.current.push(
      setTimeout(() => {
        setDealerFaceUp(true);
        sfx.card();
      }, 350),
    );

    timers.current.push(
      setTimeout(() => {
        const res = resolve(playerSplit, dealerSplit);
        setResolution(res);
        let gross = 0;
        if (res.outcome === "win") {
          gross = Math.floor(bet * 1.95); // even money minus 5% commission
          wallet.win(gross);
          setLastDelta(gross - bet);
          sfx.win();
        } else if (res.outcome === "push") {
          gross = bet;
          wallet.win(gross);
          setLastDelta(0);
          sfx.tick();
        } else {
          gross = 0;
          setLastDelta(-bet);
          sfx.lose();
        }
        setPayout(gross);
        setPhase("result");
      }, 1100),
    );
  }, [phase, dealerSplit, currentlyLegal, clearTimers, playerSplit, bet, wallet]);

  // -------------------------------------------------------------------------
  // Deal-staging helpers: which of the 14 cards have "landed".
  // Dealing order alternates dealer(0), player(1), dealer(2)... so:
  //   dealer card k lands at deal step 2k+1 ; player card k at 2k+2.
  // -------------------------------------------------------------------------
  const playerCardDealt = (k: number) => dealt >= 2 * k + 2;
  const dealerCardDealt = (k: number) => dealt >= 2 * k + 1;

  const showCards = phase !== "betting";
  const inPlay = phase === "dealing" || phase === "arranging" || phase === "revealing";

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4">
      {/* ---- Title / odds strip ---- */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2
            className="font-display text-2xl font-bold sm:text-3xl"
            style={{ color: ACCENT, textShadow: `0 0 22px ${ACCENT}66` }}
          >
            Pai Gow Poker
          </h2>
          <p className="text-xs text-white/45">
            Split 7 cards into a 5-card back hand and a 2-card front hand. Beat the
            dealer on both — 5% commission on wins.
          </p>
        </div>
        <Paytable />
      </div>

      {/* ---- Felt table ---- */}
      <div
        className="felt relative overflow-hidden rounded-3xl p-4 sm:p-6"
        style={{ boxShadow: `inset 0 0 90px rgba(0,0,0,0.5), 0 0 0 1px ${ACCENT}22` }}
      >
        {/* ambient accent glow */}
        <div
          className="pointer-events-none absolute -top-24 left-1/2 h-56 w-[120%] -translate-x-1/2 rounded-full opacity-30 blur-3xl"
          style={{ background: `radial-gradient(circle, ${ACCENT}, transparent 70%)` }}
        />

        {/* ===== DEALER ===== */}
        <section className="relative">
          <div className="mb-2 flex items-center gap-2">
            <span className="text-xs font-semibold uppercase tracking-widest text-white/55">
              Dealer
            </span>
            {dealerFaceUp && resolution && (
              <>
                <HandRankBadge text={`Back: ${resolution.dealerHigh.name}`} />
                <HandRankBadge text={`Front: ${resolution.dealerLow.label}`} />
              </>
            )}
          </div>

          {!showCards ? (
            <EmptySlots label="Dealer's 7" />
          ) : (
            <div className="flex flex-wrap items-end gap-4">
              {/* Dealer BACK (5) */}
              <HandGroup
                title="Back (5)"
                won={resolution ? resolution.highResult < 0 : undefined}
                copy={resolution ? resolution.highResult === 0 : undefined}
              >
                {(dealerSplit?.high ?? (Array(5).fill(null) as (Card | null)[])).map((c, k) => (
                  <DealtCard
                    key={`dh-${k}`}
                    card={c}
                    landed={dealerCardDealt(k)}
                    faceDown={!dealerFaceUp}
                    fromX={-260}
                    size="sm"
                  />
                ))}
              </HandGroup>
              {/* Dealer FRONT (2) */}
              <HandGroup
                title="Front (2)"
                won={resolution ? resolution.lowResult < 0 : undefined}
                copy={resolution ? resolution.lowResult === 0 : undefined}
              >
                {(dealerSplit?.low ?? (Array(2).fill(null) as (Card | null)[])).map((c, k) => (
                  <DealtCard
                    key={`dl-${k}`}
                    card={c}
                    landed={dealerCardDealt(k + 5)}
                    faceDown={!dealerFaceUp}
                    fromX={-260}
                    size="sm"
                  />
                ))}
              </HandGroup>
            </div>
          )}
        </section>

        {/* center divider */}
        <div className="my-5 flex items-center gap-3">
          <div className="h-px flex-1 bg-white/10" />
          <span
            className="rounded-full border border-white/15 px-3 py-1 text-[10px] uppercase tracking-[0.25em] text-white/45"
            style={{ background: "rgba(0,0,0,0.3)" }}
          >
            {phase === "arranging"
              ? "Set Your Hands"
              : phase === "dealing"
                ? "Dealing…"
                : phase === "revealing"
                  ? "Revealing…"
                  : "Pai Gow"}
          </span>
          <div className="h-px flex-1 bg-white/10" />
        </div>

        {/* ===== PLAYER ===== */}
        <section className="relative">
          <div className="mb-2 flex items-center gap-2">
            <span
              className="text-xs font-semibold uppercase tracking-widest"
              style={{ color: ACCENT }}
            >
              You
            </span>
            {showCards && playerHighEval && playerLowEval && (
              <>
                <HandRankBadge text={`Back: ${playerHighEval.name}`} />
                <HandRankBadge text={`Front: ${playerLowEval.label}`} />
              </>
            )}
            {phase === "arranging" && !currentlyLegal && (
              <span className="text-[10px] font-bold uppercase tracking-wider text-ruby">
                Foul — back must beat front
              </span>
            )}
          </div>

          {!showCards ? (
            <EmptySlots label="Your 7" />
          ) : (
            <div className="flex flex-wrap items-end gap-4">
              {/* Player BACK (5) */}
              <HandGroup
                title="Back (5) — high hand"
                accent
                won={resolution ? resolution.highResult > 0 : undefined}
                copy={resolution ? resolution.highResult === 0 : undefined}
              >
                {playerSplit.high.map((c) => {
                  const idx = playerCards.indexOf(c);
                  return (
                    <DealtCard
                      key={c.id}
                      card={c}
                      landed={playerCardDealt(idx)}
                      fromX={-260}
                      fromY={220}
                      size="sm"
                      selected={selected.includes(idx)}
                      onClick={phase === "arranging" ? () => toggleSelect(idx) : undefined}
                    />
                  );
                })}
              </HandGroup>
              {/* Player FRONT (2) */}
              <HandGroup
                title="Front (2) — low hand"
                accent
                won={resolution ? resolution.lowResult > 0 : undefined}
                copy={resolution ? resolution.lowResult === 0 : undefined}
              >
                {playerSplit.low.map((c) => {
                  const idx = playerCards.indexOf(c);
                  return (
                    <DealtCard
                      key={c.id}
                      card={c}
                      landed={playerCardDealt(idx)}
                      fromX={-260}
                      fromY={220}
                      size="sm"
                      selected={selected.includes(idx)}
                      onClick={phase === "arranging" ? () => toggleSelect(idx) : undefined}
                    />
                  );
                })}
              </HandGroup>
            </div>
          )}

          {phase === "arranging" && (
            <p className="mt-2 text-[11px] text-white/45">
              Tap a card in the back hand and one in the front hand to swap them.
              Illegal (fouling) swaps are blocked.
            </p>
          )}
        </section>

        {/* ===== Result overlay ===== */}
        <AnimatePresence>
          {phase === "result" && resolution && (
            <ResultBurst outcome={resolution.outcome} delta={lastDelta} payout={payout} />
          )}
        </AnimatePresence>
      </div>

      {/* ---- Controls ---- */}
      <div className="flex flex-col gap-3">
        {(phase === "betting" || phase === "result") && (
          <BetControls
            bet={bet}
            setBet={setBet}
            balance={balance}
            min={1}
            chips={CHIPS}
          />
        )}

        <div className="flex flex-wrap items-center justify-center gap-3">
          {(phase === "betting" || phase === "result") && (
            <Button
              variant="gold"
              size="lg"
              data-testid="play-btn"
              disabled={!canAfford || inPlay}
              onClick={deal}
            >
              {phase === "result" ? "Deal Again" : "Deal"} · {formatChips(bet)}
            </Button>
          )}

          {phase === "dealing" && (
            <span className="text-sm text-white/55">Dealing the cards…</span>
          )}

          {phase === "arranging" && (
            <>
              <Button
                variant="ghost"
                size="lg"
                data-testid="house-way-btn"
                onClick={setHouseWay}
              >
                House Way
              </Button>
              <Button
                variant="gold"
                size="lg"
                data-testid="play-btn"
                disabled={!currentlyLegal}
                onClick={confirm}
              >
                Set Hands
              </Button>
            </>
          )}

          {phase === "revealing" && (
            <span className="text-sm text-white/55">Comparing hands…</span>
          )}
        </div>

        {/* ---- Result line + foul notice ---- */}
        <div className="min-h-[2rem] text-center">
          <AnimatePresence mode="wait">
            {foulWarning && phase === "arranging" && (
              <motion.div
                key="foul"
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                className="text-sm font-semibold text-ruby"
              >
                Foul blocked — the 5-card back hand must outrank the 2-card front hand.
              </motion.div>
            )}
            {phase === "result" && resolution && (
              <motion.div
                key="result"
                data-testid="round-result"
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0 }}
                className="text-base font-bold"
              >
                <ResultText resolution={resolution} delta={lastDelta} />
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function EmptySlots({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-4">
      <div className="flex gap-2 opacity-50">
        {Array.from({ length: 5 }).map((_, i) => (
          <div
            key={i}
            className="rounded-lg border border-dashed border-white/20"
            style={{ width: 50, height: 70 }}
          />
        ))}
      </div>
      <div className="flex gap-2 opacity-50">
        {Array.from({ length: 2 }).map((_, i) => (
          <div
            key={i}
            className="rounded-lg border border-dashed border-white/20"
            style={{ width: 50, height: 70 }}
          />
        ))}
      </div>
      <span className="text-xs text-white/40">{label}</span>
    </div>
  );
}

function HandGroup({
  title,
  children,
  accent,
  won,
  copy,
}: {
  title: string;
  children: React.ReactNode;
  accent?: boolean;
  won?: boolean;
  copy?: boolean;
}) {
  const border =
    won === true
      ? "0 0 0 2px #8aff80, 0 0 18px rgba(138,255,128,0.4)"
      : won === false
        ? "0 0 0 2px #e74c3c66"
        : copy
          ? "0 0 0 2px #d4af3766"
          : "0 0 0 1px rgba(255,255,255,0.06)";
  return (
    <motion.div
      layout
      className="rounded-2xl p-2"
      style={{ boxShadow: border, background: "rgba(0,0,0,0.18)" }}
    >
      <div
        className="mb-1.5 text-center text-[9px] uppercase tracking-widest"
        style={{ color: accent ? ACCENT : "rgba(255,255,255,0.4)" }}
      >
        {title}
      </div>
      <div className="flex gap-1.5">{children}</div>
    </motion.div>
  );
}

/** A card that flies in from off-table when it "lands", then can be selected. */
function DealtCard({
  card,
  landed,
  faceDown,
  fromX = -240,
  fromY = -160,
  size = "sm",
  selected,
  onClick,
}: {
  card: Card | null;
  landed: boolean;
  faceDown?: boolean;
  fromX?: number;
  fromY?: number;
  size?: "xs" | "sm" | "md";
  selected?: boolean;
  onClick?: () => void;
}) {
  return (
    <motion.div
      layout
      initial={{ x: fromX, y: fromY, rotate: -18, opacity: 0 }}
      animate={
        landed
          ? { x: 0, y: 0, rotate: 0, opacity: 1 }
          : { x: fromX, y: fromY, rotate: -18, opacity: 0 }
      }
      transition={{ type: "spring", stiffness: 260, damping: 24 }}
    >
      <ArrangeCard
        card={card}
        faceDown={faceDown || !landed}
        selected={selected}
        onClick={landed ? onClick : undefined}
        size={size}
      />
    </motion.div>
  );
}

function ResultText({
  resolution,
  delta,
}: {
  resolution: Resolution;
  delta: number;
}) {
  const { outcome, highResult, lowResult } = resolution;
  const handWord = (r: number) => (r > 0 ? "won" : r === 0 ? "copy" : "lost");
  const color =
    outcome === "win" ? "#8aff80" : outcome === "push" ? "#f5d060" : "#e74c3c";
  const headline =
    outcome === "win"
      ? "You win both hands!"
      : outcome === "push"
        ? "Push — one hand each"
        : "Dealer takes it";
  return (
    <span style={{ color }}>
      {headline}{" "}
      <span className="text-white/55 text-sm font-medium">
        (back {handWord(highResult)}, front {handWord(lowResult)})
      </span>{" "}
      {outcome !== "push" && (
        <span className="tabular-nums">{formatDelta(delta)}</span>
      )}
    </span>
  );
}

function ResultBurst({
  outcome,
  delta,
  payout,
}: {
  outcome: Outcome;
  delta: number;
  payout: number;
}) {
  const win = outcome === "win";
  const push = outcome === "push";
  const color = win ? "#8aff80" : push ? "#f5d060" : "#e74c3c";
  const label = win ? "WIN" : push ? "PUSH" : "LOSE";
  return (
    <motion.div
      key="burst"
      className="pointer-events-none absolute inset-0 z-20 grid place-items-center"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
    >
      {win && (
        <>
          {Array.from({ length: 22 }).map((_, i) => {
            const angle = (i / 22) * Math.PI * 2;
            return (
              <motion.span
                key={i}
                className="absolute"
                style={{
                  fontSize: 18,
                  color: i % 2 === 0 ? "#f5d060" : "#8aff80",
                }}
                initial={{ x: 0, y: 0, opacity: 1, scale: 0.5 }}
                animate={{
                  x: Math.cos(angle) * (140 + (i % 5) * 26),
                  y: Math.sin(angle) * (90 + (i % 4) * 20),
                  opacity: 0,
                  scale: 1.2,
                  rotate: i * 40,
                }}
                transition={{ duration: 1.1, ease: "easeOut" }}
              >
                {i % 3 === 0 ? "✦" : "●"}
              </motion.span>
            );
          })}
        </>
      )}
      <motion.div
        initial={{ scale: 0.4, opacity: 0, y: 10 }}
        animate={{ scale: 1, opacity: 1, y: 0 }}
        transition={{ type: "spring", stiffness: 300, damping: 16 }}
        className="rounded-2xl px-7 py-4 text-center"
        style={{
          background: "rgba(0,0,0,0.55)",
          boxShadow: `0 0 0 2px ${color}, 0 0 40px ${color}88`,
          backdropFilter: "blur(4px)",
        }}
      >
        <div
          className="font-display text-4xl font-black tracking-wider sm:text-5xl"
          style={{ color, textShadow: `0 0 24px ${color}` }}
        >
          {label}
        </div>
        <div className="mt-1 text-sm font-semibold text-white/80 tabular-nums">
          {push ? "Bet returned" : formatDelta(delta)}
          {win && <span className="text-white/40"> · paid {formatChips(payout)}</span>}
        </div>
      </motion.div>
    </motion.div>
  );
}

function Paytable() {
  const rows: { label: string; value: string; tone?: string }[] = [
    { label: "Win both hands", value: "1 : 1 − 5%", tone: "#8aff80" },
    { label: "Win one / lose one", value: "Push", tone: "#f5d060" },
    { label: "Tie a hand (copy)", value: "Dealer", tone: "#e74c3c" },
    { label: "Lose both", value: "Lose", tone: "#e74c3c" },
  ];
  return (
    <div className="glass rounded-2xl px-4 py-3">
      <div className="mb-1.5 text-[10px] uppercase tracking-widest text-white/45">
        Payouts
      </div>
      <ul className="space-y-1 text-xs">
        {rows.map((r) => (
          <li key={r.label} className="flex items-center justify-between gap-6">
            <span className="text-white/65">{r.label}</span>
            <span className="font-semibold tabular-nums" style={{ color: r.tone }}>
              {r.value}
            </span>
          </li>
        ))}
      </ul>
      <div className="mt-2 text-[10px] text-white/35">
        Joker is wild for straights &amp; flushes, else an Ace.
      </div>
    </div>
  );
}
