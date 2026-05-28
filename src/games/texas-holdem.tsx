"use client";

import React, {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  type Card,
  makeShoe,
  evaluateBest,
  HandCategory,
} from "@/lib/cards";
import { chance, clamp, randInt } from "@/lib/rng";
import { formatChips, formatDelta } from "@/lib/format";
import { sleep } from "@/lib/async";
import { sfx } from "@/lib/sound";
import { useWallet } from "@/lib/wallet";
import { Button } from "@/components/ui/Button";
import { Chip } from "@/components/ui/Chip";
import { PlayingCard } from "@/components/PlayingCard";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ACCENT = "#2ecc71";
const SB = 25; // small blind
const BB = 50; // big blind
const START_STACK = 2000; // display stack each player starts a hand with

type Street = "preflop" | "flop" | "turn" | "river";
type Actor = "player" | "bot";
type Phase =
  | "idle" // between hands, can change buy-in
  | "dealing" // animating the deal
  | "player" // waiting on player action
  | "bot" // bot is thinking / acting
  | "advance" // animating board card(s) to next street
  | "showdown" // both hands revealed, resolving
  | "done"; // hand resolved, banner up

interface LogEntry {
  id: number;
  who: Actor | "system";
  text: string;
}

// ---------------------------------------------------------------------------
// Engine state — kept in a reducer so the async betting loop reads fresh data.
// Real money: only the human's wallet moves. `committed` tracks chips each
// side has pushed into the pot THIS HAND. In heads-up, reaching showdown means
// both committed equal amounts; uncalled excess on a fold is refunded so the
// pot always balances.
// ---------------------------------------------------------------------------

interface EngineState {
  phase: Phase;
  street: Street;
  buyIn: number; // chips the player risks per hand (their starting stack)
  deck: Card[];
  drawIdx: number;
  playerHole: Card[];
  botHole: Card[];
  board: Card[]; // up to 5
  revealBoard: number; // how many board cards are face-up
  botRevealed: boolean;
  // stacks are DISPLAY-only; real money is the wallet.
  playerStack: number;
  botStack: number;
  pot: number;
  playerCommitted: number; // this hand, total into pot
  botCommitted: number;
  playerStreetBet: number; // amount in front of player THIS street
  botStreetBet: number;
  toAct: Actor;
  buttonIsPlayer: boolean; // who has the dealer button (acts first preflop)
  lastAggressor: Actor | null;
  // a betting round ends when both have acted and bets match
  playerActedThisRound: boolean;
  botActedThisRound: boolean;
  minRaiseTo: number; // the smallest legal "raise to" value
  log: LogEntry[];
  // result
  resultText: string;
  resultKind: "win" | "lose" | "push" | null;
  netDelta: number; // wallet net for this hand
  bestPlayerCat: HandCategory | null;
  bestBotCat: HandCategory | null;
  winningIds: string[]; // card ids to highlight
  handNo: number;
}

type Action =
  | { type: "SET_BUYIN"; value: number }
  | { type: "START_HAND"; deck: Card[]; buttonIsPlayer: boolean; stack: number }
  | { type: "REVEAL_HOLE" }
  | { type: "SET_PHASE"; phase: Phase }
  | {
      type: "POST_BLINDS";
    }
  | {
      type: "APPLY_ACTION";
      actor: Actor;
      kind: "fold" | "check" | "call" | "bet";
      // for bet: `to` is the total street bet this actor moves to
      to?: number;
      logText: string;
    }
  | { type: "OPEN_STREET"; street: Street; revealCount: number; logText: string }
  | { type: "BOT_REVEAL" }
  | {
      type: "RESOLVE";
      resultText: string;
      resultKind: "win" | "lose" | "push";
      netDelta: number;
      bestPlayerCat: HandCategory | null;
      bestBotCat: HandCategory | null;
      winningIds: string[];
      logText: string;
    }
  | { type: "LOG"; who: Actor | "system"; text: string };

let LOG_ID = 1;
function log(state: EngineState, who: Actor | "system", text: string): LogEntry[] {
  const next = [...state.log, { id: LOG_ID++, who, text }];
  return next.slice(-7);
}

function initialState(): EngineState {
  return {
    phase: "idle",
    street: "preflop",
    buyIn: 1000,
    deck: [],
    drawIdx: 0,
    playerHole: [],
    botHole: [],
    board: [],
    revealBoard: 0,
    botRevealed: false,
    playerStack: START_STACK,
    botStack: START_STACK,
    pot: 0,
    playerCommitted: 0,
    botCommitted: 0,
    playerStreetBet: 0,
    botStreetBet: 0,
    toAct: "player",
    buttonIsPlayer: true,
    lastAggressor: null,
    playerActedThisRound: false,
    botActedThisRound: false,
    minRaiseTo: BB,
    log: [],
    resultText: "",
    resultKind: null,
    netDelta: 0,
    bestPlayerCat: null,
    bestBotCat: null,
    winningIds: [],
    handNo: 0,
  };
}

function reducer(state: EngineState, action: Action): EngineState {
  switch (action.type) {
    case "SET_BUYIN":
      return { ...state, buyIn: action.value };

    case "START_HAND": {
      const deck = action.deck;
      // deal 2 + 2; community cards follow at indices 4-8 (no explicit burns).
      const playerHole = [deck[0], deck[2]];
      const botHole = [deck[1], deck[3]];
      // Pre-populate all 5 board cards so evaluateBest always has 7 cards at
      // showdown. revealBoard controls how many are *visible* at each street.
      const board = [deck[4], deck[5], deck[6], deck[7], deck[8]] as Card[];
      return {
        ...initialState(),
        buyIn: state.buyIn,
        handNo: state.handNo + 1,
        phase: "dealing",
        deck,
        drawIdx: 9,
        playerHole,
        botHole,
        board,
        playerStack: action.stack,
        botStack: action.stack,
        buttonIsPlayer: action.buttonIsPlayer,
        log: [
          {
            id: LOG_ID++,
            who: "system",
            text: `Hand #${state.handNo + 1} — ${
              action.buttonIsPlayer ? "you are" : "bot is"
            } on the button`,
          },
        ],
      };
    }

    case "POST_BLINDS": {
      // Heads-up: the BUTTON posts the small blind and acts first preflop.
      const btnPlayer = state.buttonIsPlayer;
      const sbActor: Actor = btnPlayer ? "player" : "bot";
      const playerSB = sbActor === "player";
      const playerPost = playerSB ? SB : BB;
      const botPost = playerSB ? BB : SB;
      return {
        ...state,
        playerStack: state.playerStack - playerPost,
        botStack: state.botStack - botPost,
        playerCommitted: playerPost,
        botCommitted: botPost,
        playerStreetBet: playerPost,
        botStreetBet: botPost,
        pot: playerPost + botPost,
        toAct: sbActor, // button (SB) acts first preflop heads-up
        minRaiseTo: BB * 2, // min raise-to over the big blind preflop
        playerActedThisRound: false,
        botActedThisRound: false,
        lastAggressor: null,
        log: log(state, "system", `Blinds posted: SB ${SB} / BB ${BB}`),
      };
    }

    case "APPLY_ACTION": {
      const { actor, kind } = action;
      const isPlayer = actor === "player";
      let {
        playerStack,
        botStack,
        playerCommitted,
        botCommitted,
        playerStreetBet,
        botStreetBet,
        pot,
        minRaiseTo,
        lastAggressor,
        playerActedThisRound,
        botActedThisRound,
      } = state;

      if (kind === "fold") {
        if (isPlayer) playerActedThisRound = true;
        else botActedThisRound = true;
        return {
          ...state,
          playerActedThisRound,
          botActedThisRound,
          log: log(state, actor, action.logText),
        };
      }

      if (kind === "check") {
        if (isPlayer) playerActedThisRound = true;
        else botActedThisRound = true;
        return {
          ...state,
          playerActedThisRound,
          botActedThisRound,
          toAct: isPlayer ? "bot" : "player",
          log: log(state, actor, action.logText),
        };
      }

      if (kind === "call") {
        const target = isPlayer ? botStreetBet : playerStreetBet;
        const own = isPlayer ? playerStreetBet : botStreetBet;
        const stack = isPlayer ? playerStack : botStack;
        const add = Math.min(target - own, stack); // cap by stack (all-in call)
        if (isPlayer) {
          playerStack -= add;
          playerCommitted += add;
          playerStreetBet += add;
          playerActedThisRound = true;
        } else {
          botStack -= add;
          botCommitted += add;
          botStreetBet += add;
          botActedThisRound = true;
        }
        pot += add;
        return {
          ...state,
          playerStack,
          botStack,
          playerCommitted,
          botCommitted,
          playerStreetBet,
          botStreetBet,
          pot,
          toAct: isPlayer ? "bot" : "player",
          log: log(state, actor, action.logText),
        };
      }

      // kind === "bet" (bet or raise): `to` is the total street bet for this actor.
      const to = action.to ?? 0;
      const own = isPlayer ? playerStreetBet : botStreetBet;
      const stack = isPlayer ? playerStack : botStack;
      const add = Math.min(to - own, stack);
      const opp = isPlayer ? botStreetBet : playerStreetBet;
      // raise increment for next legal min-raise
      const raiseInc = Math.max(BB, own + add - opp);
      if (isPlayer) {
        playerStack -= add;
        playerCommitted += add;
        playerStreetBet += add;
        playerActedThisRound = true;
        botActedThisRound = false; // opponent must respond
      } else {
        botStack -= add;
        botCommitted += add;
        botStreetBet += add;
        botActedThisRound = true;
        playerActedThisRound = false;
      }
      pot += add;
      lastAggressor = actor;
      minRaiseTo = (isPlayer ? playerStreetBet : botStreetBet) + raiseInc;
      return {
        ...state,
        playerStack,
        botStack,
        playerCommitted,
        botCommitted,
        playerStreetBet,
        botStreetBet,
        pot,
        minRaiseTo,
        lastAggressor,
        playerActedThisRound,
        botActedThisRound,
        toAct: isPlayer ? "bot" : "player",
        log: log(state, actor, action.logText),
      };
    }

    case "OPEN_STREET": {
      // Post-flop, the player NOT on the button (BB) acts first heads-up.
      const firstActor: Actor = state.buttonIsPlayer ? "bot" : "player";
      return {
        ...state,
        street: action.street,
        revealBoard: action.revealCount,
        playerStreetBet: 0,
        botStreetBet: 0,
        playerActedThisRound: false,
        botActedThisRound: false,
        lastAggressor: null,
        minRaiseTo: BB,
        toAct: firstActor,
        log: log(state, "system", action.logText),
      };
    }

    case "REVEAL_HOLE":
      return { ...state, phase: "player" };

    case "BOT_REVEAL":
      return { ...state, botRevealed: true };

    case "SET_PHASE":
      return { ...state, phase: action.phase };

    case "RESOLVE":
      return {
        ...state,
        phase: "done",
        botRevealed: true,
        resultText: action.resultText,
        resultKind: action.resultKind,
        netDelta: action.netDelta,
        bestPlayerCat: action.bestPlayerCat,
        bestBotCat: action.bestBotCat,
        winningIds: action.winningIds,
        log: log(state, "system", action.logText),
      };

    case "LOG":
      return { ...state, log: log(state, action.who, action.text) };

    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// Bot AI helpers
// ---------------------------------------------------------------------------

/** Rough 0..1 hand-strength estimate from hole (+ board). */
function botStrength(hole: Card[], board: Card[]): number {
  const cards = [...hole, ...board];
  if (cards.length < 5) {
    // Preflop heuristic from the two hole cards.
    const a = hole[0];
    const b = hole[1];
    const rv = (r: Card["rank"]) =>
      r === "A" ? 14 : r === "K" ? 13 : r === "Q" ? 12 : r === "J" ? 11 : r === "10" ? 10 : parseInt(r, 10);
    const hi = Math.max(rv(a.rank), rv(b.rank));
    const lo = Math.min(rv(a.rank), rv(b.rank));
    const pair = a.rank === b.rank;
    const suited = a.suit === b.suit;
    const gap = hi - lo;
    let s = (hi + lo) / 28; // 0..1 from card ranks
    if (pair) s = clamp(0.5 + (hi - 2) / 24, 0.5, 0.97);
    else {
      if (suited) s += 0.08;
      if (gap === 1) s += 0.06;
      else if (gap <= 3) s += 0.02;
      if (hi >= 13) s += 0.05;
    }
    return clamp(s, 0.05, 0.95);
  }
  const ev = evaluateBest(cards);
  // Map hand category to a strength band, refined slightly by top tiebreak.
  const base: Record<HandCategory, number> = {
    [HandCategory.HighCard]: 0.16,
    [HandCategory.Pair]: 0.4,
    [HandCategory.TwoPair]: 0.62,
    [HandCategory.ThreeOfAKind]: 0.74,
    [HandCategory.Straight]: 0.82,
    [HandCategory.Flush]: 0.88,
    [HandCategory.FullHouse]: 0.93,
    [HandCategory.FourOfAKind]: 0.98,
    [HandCategory.StraightFlush]: 0.995,
    [HandCategory.RoyalFlush]: 1,
  };
  const top = (ev.tiebreak[0] ?? 2) / 14;
  return clamp(base[ev.category] + top * 0.05, 0.05, 1);
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function TexasHoldem() {
  const wallet = useWallet();
  const [state, dispatch] = useReducer(reducer, undefined, initialState);
  const stateRef = useRef(state);
  stateRef.current = state;

  // Guards the async drive loop / deal sequence against running after unmount.
  const mountedRef = useRef(true);
  useEffect(() => () => {
    mountedRef.current = false;
  }, []);

  // Track who had the button last so we can alternate.
  const lastButtonPlayer = useRef<boolean | null>(null);

  // Track real chips already pulled from the wallet THIS HAND, so we never
  // double-charge and the net always balances.
  const walletPaidRef = useRef(0);

  const [raiseTo, setRaiseTo] = useState(BB * 2);
  const [chipBursts, setChipBursts] = useState<{ id: number; from: Actor }[]>([]);
  const burstId = useRef(0);

  // ---- helpers tied to current ref state -------------------------------
  const canAfford = (extra: number) => {
    // Charge the player wallet for any NEW chips beyond what we've already pulled.
    const target = stateRef.current.playerCommitted + extra;
    const need = target - walletPaidRef.current;
    if (need <= 0) return true;
    return wallet.balance >= need;
  };

  /** Pull from the wallet to cover the player's committed total up to `committed`. */
  const settleWallet = (committed: number): boolean => {
    const need = committed - walletPaidRef.current;
    if (need <= 0) return true;
    const ok = wallet.bet(need);
    if (ok) walletPaidRef.current += need;
    return ok;
  };

  const flyChips = (from: Actor) => {
    const id = burstId.current++;
    setChipBursts((b) => [...b, { id, from }]);
    setTimeout(() => setChipBursts((b) => b.filter((x) => x.id !== id)), 700);
  };

  // -----------------------------------------------------------------------
  // Hand resolution (fold OR showdown). All real money settles here.
  // -----------------------------------------------------------------------
  const finishHand = useCallback(
    (opts: {
      kind: "fold-player" | "fold-bot" | "showdown";
    }) => {
      const s = stateRef.current;
      const playerIn = s.playerCommitted;
      const botIn = s.botCommitted;
      // The matched pot can't exceed twice the smaller contribution; any
      // excess is uncalled and refunded to the over-committer (keeps it exact).
      const matched = Math.min(playerIn, botIn);
      const playerExcess = playerIn - matched; // refunded to player automatically
      // (botExcess simply never costs the player anything.)

      // Make sure the wallet has been charged for everything the player put in.
      settleWallet(playerIn);

      if (opts.kind === "fold-player") {
        // Player folds: bot takes the matched pot. Player keeps any uncalled excess.
        // Refund player's uncalled excess (if any) back to wallet.
        if (playerExcess > 0) wallet.win(playerExcess);
        const net = -matched; // player loses only the matched chips
        sfx.lose();
        dispatch({
          type: "RESOLVE",
          resultText: "You folded — bot takes the pot",
          resultKind: "lose",
          netDelta: net,
          bestPlayerCat: null,
          bestBotCat: null,
          winningIds: [],
          logText: `You folded. Net ${formatDelta(net)}.`,
        });
        return;
      }

      if (opts.kind === "fold-bot") {
        // Bot folds: player wins the matched pot. Player gets back own matched
        // chips + bot's matched chips, plus any uncalled excess they posted.
        const gross = matched * 2 + playerExcess; // own matched + bot matched + refund excess
        wallet.win(gross);
        const net = matched; // profit = bot's matched contribution
        sfx.win();
        dispatch({
          type: "RESOLVE",
          resultText: "Bot folds — you win the pot!",
          resultKind: "win",
          netDelta: net,
          bestPlayerCat: null,
          bestBotCat: null,
          winningIds: [...s.playerHole.map((c) => c.id)],
          logText: `Bot folds. You win ${formatChips(net)}. Net ${formatDelta(net)}.`,
        });
        return;
      }

      // ---- Showdown ----
      const pEval = evaluateBest([...s.playerHole, ...s.board]);
      const bEval = evaluateBest([...s.botHole, ...s.board]);
      const cmp = pEval.score - bEval.score;
      // At showdown heads-up, contributions are matched, so playerExcess is 0,
      // but we keep the refund logic for safety.
      if (playerExcess > 0) wallet.win(playerExcess);
      const potMatched = matched * 2;

      if (cmp > 0) {
        wallet.win(potMatched);
        const net = matched;
        if (pEval.category >= HandCategory.Flush) sfx.jackpot();
        else sfx.win();
        dispatch({
          type: "RESOLVE",
          resultText: `You win with ${pEval.name}!`,
          resultKind: "win",
          netDelta: net,
          bestPlayerCat: pEval.category,
          bestBotCat: bEval.category,
          winningIds: pEval.best.map((c) => c.id),
          logText: `Showdown: ${pEval.name} beats ${bEval.name}. Net ${formatDelta(net)}.`,
        });
      } else if (cmp < 0) {
        const net = -matched;
        sfx.lose();
        dispatch({
          type: "RESOLVE",
          resultText: `Bot wins with ${bEval.name}`,
          resultKind: "lose",
          netDelta: net,
          bestPlayerCat: pEval.category,
          bestBotCat: bEval.category,
          winningIds: bEval.best.map((c) => c.id),
          logText: `Showdown: ${bEval.name} beats ${pEval.name}. Net ${formatDelta(net)}.`,
        });
      } else {
        // Tie — split the matched pot. Refund player's half (== their matched stake).
        wallet.win(matched);
        sfx.thud();
        dispatch({
          type: "RESOLVE",
          resultText: `Split pot — both have ${pEval.name}`,
          resultKind: "push",
          netDelta: 0,
          bestPlayerCat: pEval.category,
          bestBotCat: bEval.category,
          winningIds: [...pEval.best.map((c) => c.id), ...bEval.best.map((c) => c.id)],
          logText: `Showdown: tie on ${pEval.name}. Pot split.`,
        });
      }
    },
    [wallet],
  );

  // -----------------------------------------------------------------------
  // Bot decision: returns the action it wants to take.
  // -----------------------------------------------------------------------
  const botDecide = useCallback((): {
    kind: "fold" | "check" | "call" | "bet";
    to?: number;
    text: string;
  } => {
    const s = stateRef.current;
    const toCall = s.playerStreetBet - s.botStreetBet;
    const strength = botStrength(s.botHole, s.board.slice(0, s.revealBoard));
    const potOdds = toCall > 0 ? toCall / (s.pot + toCall) : 0;
    const maxBet = s.botStack; // bot can't bet more than it has
    const bluff = chance(0.12);

    // No bet to call: option to check or bet.
    if (toCall <= 0) {
      const wantBet = strength > 0.55 || bluff;
      if (wantBet && maxBet > 0) {
        const potSize = Math.max(BB, s.pot);
        let amt =
          strength > 0.85
            ? potSize
            : strength > 0.65
            ? Math.round(potSize * 0.6)
            : Math.round(potSize * 0.4);
        amt = clamp(amt, BB, maxBet);
        const to = s.botStreetBet + amt;
        return {
          kind: "bet",
          to,
          text: `Bot bets ${formatChips(amt)}`,
        };
      }
      return { kind: "check", text: "Bot checks" };
    }

    // Facing a bet.
    const callable = Math.min(toCall, maxBet);
    // Fold weak hands to meaningful bets.
    if (strength < 0.32 && potOdds > 0.25 && !bluff) {
      return { kind: "fold", text: "Bot folds" };
    }
    // Raise strong hands sometimes.
    if ((strength > 0.78 || (bluff && strength > 0.4)) && maxBet > callable) {
      const potSize = Math.max(BB, s.pot + toCall);
      const raiseAmt =
        strength > 0.9 ? potSize : Math.round(potSize * 0.65);
      // total street bet the bot moves to
      let to = s.playerStreetBet + Math.max(BB, raiseAmt);
      const maxTo = s.botStreetBet + maxBet;
      to = Math.min(to, maxTo);
      if (to > s.playerStreetBet) {
        return {
          kind: "bet",
          to,
          text:
            to >= maxTo
              ? `Bot raises all-in to ${formatChips(to)}`
              : `Bot raises to ${formatChips(to)}`,
        };
      }
    }
    // Otherwise call (medium strength or priced in).
    return {
      kind: "call",
      text: callable >= toCall ? `Bot calls ${formatChips(toCall)}` : `Bot calls all-in`,
    };
  }, []);

  // -----------------------------------------------------------------------
  // Betting round driver. Loops until the round is settled, advancing the
  // street or going to showdown. Heavily guarded against illegal/loop states.
  // -----------------------------------------------------------------------
  const runLoop = useRef(false);

  const isRoundClosed = (s: EngineState): boolean => {
    const betsMatch = s.playerStreetBet === s.botStreetBet;
    const playerAllIn = s.playerStack === 0;
    const botAllIn = s.botStack === 0;
    // If a player is all-in for LESS than the opponent's bet, the opponent's
    // excess is uncalled — the action is over (excess refunded at showdown).
    if (playerAllIn && s.botStreetBet >= s.playerStreetBet && s.playerActedThisRound)
      return true;
    if (botAllIn && s.playerStreetBet >= s.botStreetBet && s.botActedThisRound)
      return true;
    // Both effectively all-in with matched bets.
    if (betsMatch && (playerAllIn || botAllIn)) return true;
    // Normal close: both acted this round and bets are level.
    return betsMatch && s.playerActedThisRound && s.botActedThisRound;
  };

  const allInLockdown = (s: EngineState): boolean =>
    (s.playerStack === 0 || s.botStack === 0) &&
    s.playerStreetBet === s.botStreetBet;

  const advanceStreet = useCallback(async () => {
    const s = stateRef.current;
    if (s.street === "preflop") {
      sfx.card();
      dispatch({
        type: "OPEN_STREET",
        street: "flop",
        revealCount: 3,
        logText: "Flop",
      });
    } else if (s.street === "flop") {
      sfx.card();
      dispatch({
        type: "OPEN_STREET",
        street: "turn",
        revealCount: 4,
        logText: "Turn",
      });
    } else if (s.street === "turn") {
      sfx.card();
      dispatch({
        type: "OPEN_STREET",
        street: "river",
        revealCount: 5,
        logText: "River",
      });
    }
  }, []);

  // The main async game loop. Runs after each state settle when it's the bot's
  // turn or a street needs to advance. Player actions feed in via handlers.
  const drive = useCallback(async () => {
    if (runLoop.current) return;
    runLoop.current = true;
    try {
      // Loop while it is NOT the player's decision point.
      // We re-read stateRef each iteration (reducer dispatch is async, so we
      // await a microtask + small delay to let React commit).
      let guard = 0;
      while (guard++ < 200) {
        await sleep(20);
        if (!mountedRef.current) return;
        const s = stateRef.current;
        if (s.phase === "done" || s.phase === "idle") break;

        // If both effectively all-in & matched, run the board out to showdown.
        if (
          allInLockdown(s) &&
          s.playerActedThisRound &&
          s.botActedThisRound &&
          s.street !== "river"
        ) {
          await sleep(450);
          await advanceStreet();
          continue;
        }

        // Round closed -> advance street or showdown.
        if (isRoundClosed(s)) {
          if (s.street === "river") {
            dispatch({ type: "SET_PHASE", phase: "showdown" });
            await sleep(550);
            dispatch({ type: "BOT_REVEAL" });
            await sleep(650);
            finishHand({ kind: "showdown" });
            break;
          } else {
            dispatch({ type: "SET_PHASE", phase: "advance" });
            await sleep(420);
            await advanceStreet();
            await sleep(260);
            // After opening a street, if either is all-in we keep auto-running.
            const s2 = stateRef.current;
            if (s2.playerStack === 0 || s2.botStack === 0) {
              continue;
            }
            dispatch({
              type: "SET_PHASE",
              phase: stateRef.current.toAct === "player" ? "player" : "bot",
            });
            continue;
          }
        }

        // Whose turn?
        if (s.toAct === "bot") {
          dispatch({ type: "SET_PHASE", phase: "bot" });
          await sleep(randInt(450, 950)); // thinking
          const decision = botDecide();
          if (decision.kind === "fold") {
            dispatch({
              type: "APPLY_ACTION",
              actor: "bot",
              kind: "fold",
              logText: decision.text,
            });
            await sleep(120);
            finishHand({ kind: "fold-bot" });
            break;
          }
          if (decision.kind === "bet" || decision.kind === "call") {
            sfx.chip();
            flyChips("bot");
          } else {
            sfx.click();
          }
          dispatch({
            type: "APPLY_ACTION",
            actor: "bot",
            kind: decision.kind,
            to: decision.to,
            logText: decision.text,
          });
          await sleep(160);
          continue;
        }

        // It's the player's turn — hand control back to the UI.
        dispatch({ type: "SET_PHASE", phase: "player" });
        break;
      }
    } finally {
      runLoop.current = false;
    }
  }, [advanceStreet, botDecide, finishHand]);

  // Kick the driver whenever we enter a state where the bot/board should move.
  useEffect(() => {
    if (
      state.phase === "bot" ||
      state.phase === "advance" ||
      (state.phase === "player" && state.toAct === "bot")
    ) {
      void drive();
    }
  }, [state.phase, state.toAct, drive]);

  // -----------------------------------------------------------------------
  // Start a hand
  // -----------------------------------------------------------------------
  const startHand = useCallback(async () => {
    // Use the ref so rapid double-clicks can't start two concurrent hands.
    const curPhase = stateRef.current.phase;
    if (curPhase !== "idle" && curPhase !== "done") return;
    const buyIn = stateRef.current.buyIn;
    // Sanity: can the player afford the worst case (their full buy-in)?
    if (wallet.balance < BB) {
      return; // shell offers a top-up when low
    }
    // Alternate the button each hand.
    const prev = lastButtonPlayer.current;
    const buttonIsPlayer = prev === null ? true : !prev;
    lastButtonPlayer.current = buttonIsPlayer;

    // The player can never put more into the pot than their wallet holds, so
    // cap the effective buy-in (display stack) to the live balance. The bot's
    // stack mirrors it for visual symmetry. Round down to the small blind.
    const effective = Math.max(BB, Math.floor(Math.min(buyIn, wallet.balance) / SB) * SB);

    walletPaidRef.current = 0;
    setChipBursts([]);
    const deck = makeShoe(1);
    dispatch({ type: "START_HAND", deck, buttonIsPlayer, stack: effective });
    sfx.card();
    await sleep(120);
    if (!mountedRef.current) return;
    sfx.card();
    await sleep(260);
    if (!mountedRef.current) return;

    // Post blinds and pull the player's blind from the wallet.
    dispatch({ type: "POST_BLINDS" });
    await sleep(40);
    if (!mountedRef.current) return;
    const afterBlinds = stateRef.current;
    // Charge the player's blind immediately.
    if (!settleWallet(afterBlinds.playerCommitted)) {
      // Shouldn't happen given the balance check, but guard anyway.
      dispatch({ type: "SET_PHASE", phase: "idle" });
      return;
    }
    flyChips("player");
    flyChips("bot");
    sfx.chip();

    await sleep(260);
    if (!mountedRef.current) return;
    dispatch({ type: "REVEAL_HOLE" });
    // If the bot is first to act preflop (player is BB / not on button), let it move.
    const s = stateRef.current;
    if (s.toAct === "bot") {
      dispatch({ type: "SET_PHASE", phase: "bot" });
    } else {
      dispatch({ type: "SET_PHASE", phase: "player" });
    }
  }, [wallet]);

  // -----------------------------------------------------------------------
  // Player actions
  // -----------------------------------------------------------------------
  const playerCanCheck = state.playerStreetBet >= state.botStreetBet;
  const toCall = Math.max(0, state.botStreetBet - state.playerStreetBet);
  const playerActive = state.phase === "player" && state.toAct === "player";

  const onFold = () => {
    if (!playerActive) return;
    sfx.click();
    dispatch({
      type: "APPLY_ACTION",
      actor: "player",
      kind: "fold",
      logText: "You fold",
    });
    setTimeout(() => finishHand({ kind: "fold-player" }), 120);
  };

  const onCheckCall = () => {
    if (!playerActive) return;
    if (playerCanCheck) {
      sfx.click();
      dispatch({
        type: "APPLY_ACTION",
        actor: "player",
        kind: "check",
        logText: "You check",
      });
      void drive();
      return;
    }
    // Call — charge the wallet for the call amount.
    const callAmt = Math.min(toCall, state.playerStack);
    const newCommitted = state.playerCommitted + callAmt;
    if (!settleWallet(newCommitted)) return; // can't afford -> abort
    sfx.chip();
    flyChips("player");
    dispatch({
      type: "APPLY_ACTION",
      actor: "player",
      kind: "call",
      logText:
        callAmt >= toCall
          ? `You call ${formatChips(toCall)}`
          : "You call all-in",
    });
    void drive();
  };

  const onRaise = () => {
    if (!playerActive) return;
    const minTo = Math.max(state.minRaiseTo, state.botStreetBet + BB);
    const maxTo = state.playerStreetBet + state.playerStack;
    const target = clamp(raiseTo, minTo, maxTo);
    const add = target - state.playerStreetBet;
    if (add <= 0) return;
    const newCommitted = state.playerCommitted + add;
    if (!canAfford(add)) return;
    if (!settleWallet(newCommitted)) return;
    sfx.chip();
    flyChips("player");
    dispatch({
      type: "APPLY_ACTION",
      actor: "player",
      kind: "bet",
      to: target,
      logText:
        target >= maxTo
          ? `You move all-in to ${formatChips(target)}`
          : state.botStreetBet > 0
          ? `You raise to ${formatChips(target)}`
          : `You bet ${formatChips(target)}`,
    });
    void drive();
  };

  // Keep the raise slider within legal bounds as the round changes.
  const minRaiseTo = Math.max(state.minRaiseTo, state.botStreetBet + BB);
  const maxRaiseTo = state.playerStreetBet + state.playerStack;
  useEffect(() => {
    if (!playerActive) return;
    setRaiseTo((r) => clamp(r, minRaiseTo, Math.max(minRaiseTo, maxRaiseTo)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playerActive, minRaiseTo, maxRaiseTo]);

  const potSizeRaise = clamp(
    state.botStreetBet + Math.max(BB, state.pot),
    minRaiseTo,
    maxRaiseTo,
  );
  const halfPotRaise = clamp(
    state.botStreetBet + Math.max(BB, Math.round(state.pot / 2)),
    minRaiseTo,
    maxRaiseTo,
  );

  const canRaise = maxRaiseTo > minRaiseTo - 1 && state.playerStack > 0 && toCall < state.playerStack;

  // Display the current best made hand for the player as cards come out.
  const playerHandLabel = useMemo(() => {
    if (state.playerHole.length < 2) return "";
    const known = [...state.playerHole, ...state.board.slice(0, state.revealBoard)];
    if (known.length < 5) return "";
    return evaluateBest(known).name;
  }, [state.playerHole, state.board, state.revealBoard]);

  const buttonIsPlayer = state.buttonIsPlayer;
  const idle = state.phase === "idle" || state.phase === "done";
  const lowBalance = wallet.ready && wallet.balance < BB;

  // ---- Buy-in chip presets -------------------------------------------------
  const buyInPresets = [250, 500, 1000, 2000];

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------
  return (
    <div className="mx-auto w-full max-w-4xl">
      <div
        className="felt relative overflow-hidden rounded-3xl border border-emerald-300/15 p-4 shadow-felt sm:p-6"
        style={{
          background:
            "radial-gradient(120% 90% at 50% -10%, rgba(46,204,113,0.18), transparent 55%), radial-gradient(100% 100% at 50% 120%, rgba(0,0,0,0.45), transparent 60%)",
        }}
      >
        {/* subtle table felt grid */}
        <div className="bg-grid pointer-events-none absolute inset-0 opacity-[0.06]" />

        {/* ===== Top: bot ===== */}
        <Seat
          name="House Bot"
          active={state.phase === "bot"}
          isButton={!buttonIsPlayer}
          stack={state.botStack}
          streetBet={state.botStreetBet}
          accent="#e74c3c"
        >
          <div className="flex gap-2">
            <PlayingCard
              card={state.botHole[0] ?? null}
              faceDown={!state.botRevealed}
              size="md"
              highlight={
                state.botRevealed &&
                state.botHole[0] != null &&
                state.winningIds.includes(state.botHole[0].id)
              }
            />
            <PlayingCard
              card={state.botHole[1] ?? null}
              faceDown={!state.botRevealed}
              size="md"
              highlight={
                state.botRevealed &&
                state.botHole[1] != null &&
                state.winningIds.includes(state.botHole[1].id)
              }
            />
          </div>
        </Seat>

        {/* ===== Pot + board ===== */}
        <div className="relative my-3 flex flex-col items-center gap-3">
          {/* Pot readout */}
          <motion.div
            key={state.pot}
            initial={{ scale: 0.85, opacity: 0.6 }}
            animate={{ scale: 1, opacity: 1 }}
            className="flex items-center gap-2 rounded-full border border-gold/30 bg-black/45 px-4 py-1.5 backdrop-blur"
          >
            <span className="text-[10px] uppercase tracking-widest text-white/45">
              Pot
            </span>
            <span className="gold-text text-lg font-bold tabular-nums">
              {formatChips(state.pot)}
            </span>
          </motion.div>

          {/* Chip flight bursts */}
          <AnimatePresence>
            {chipBursts.map((b) => (
              <motion.div
                key={b.id}
                className="pointer-events-none absolute left-1/2 top-1/2 z-20"
                initial={{
                  x: 0,
                  y: b.from === "bot" ? -120 : 120,
                  scale: 0.6,
                  opacity: 0,
                }}
                animate={{ x: 0, y: 0, scale: 1, opacity: 1 }}
                exit={{ scale: 0.4, opacity: 0 }}
                transition={{ duration: 0.5, ease: "easeOut" }}
              >
                <Chip value={25} size={34} />
              </motion.div>
            ))}
          </AnimatePresence>

          {/* Board */}
          <div className="flex min-h-[96px] items-center justify-center gap-1.5 sm:gap-2">
            {[0, 1, 2, 3, 4].map((i) => {
              const card = state.board[i] ?? null;
              const shown = i < state.revealBoard && card != null;
              const isWin =
                shown && card != null && state.winningIds.includes(card.id);
              return (
                <AnimatePresence key={i} mode="popLayout">
                  {shown ? (
                    <motion.div
                      key={`c-${card!.id}`}
                      initial={{ y: -42, opacity: 0, rotateZ: -12, scale: 0.8 }}
                      animate={{ y: 0, opacity: 1, rotateZ: 0, scale: 1 }}
                      transition={{
                        type: "spring",
                        stiffness: 320,
                        damping: 22,
                        delay: (i % 3) * 0.08,
                      }}
                    >
                      <PlayingCard card={card} size="md" highlight={isWin} />
                    </motion.div>
                  ) : (
                    <div
                      key={`ph-${i}`}
                      className="rounded-[9px] border border-dashed border-white/12"
                      style={{ width: 66, height: 92 }}
                    />
                  )}
                </AnimatePresence>
              );
            })}
          </div>

          {/* Street label */}
          <div className="text-[10px] uppercase tracking-[0.3em] text-white/35">
            {state.phase === "idle"
              ? "Place your buy-in"
              : state.street}
          </div>
        </div>

        {/* ===== Bottom: player ===== */}
        <Seat
          name="You"
          active={playerActive}
          isButton={buttonIsPlayer}
          stack={state.playerStack}
          streetBet={state.playerStreetBet}
          accent={ACCENT}
          handLabel={playerHandLabel}
        >
          <div className="flex gap-2">
            <PlayingCard
              card={state.playerHole[0] ?? null}
              faceDown={state.playerHole.length === 0}
              size="lg"
              highlight={
                state.playerHole[0] != null &&
                state.winningIds.includes(state.playerHole[0].id)
              }
            />
            <PlayingCard
              card={state.playerHole[1] ?? null}
              faceDown={state.playerHole.length === 0}
              size="lg"
              highlight={
                state.playerHole[1] != null &&
                state.winningIds.includes(state.playerHole[1].id)
              }
            />
          </div>
        </Seat>

        {/* ===== Result banner ===== */}
        <AnimatePresence>
          {state.phase === "done" && state.resultKind && (
            <motion.div
              className="pointer-events-none absolute inset-0 z-30 grid place-items-center"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
            >
              {/* Win burst rays */}
              {state.resultKind === "win" && (
                <motion.div
                  className="absolute"
                  initial={{ scale: 0.2, opacity: 0.9 }}
                  animate={{ scale: 2.4, opacity: 0 }}
                  transition={{ duration: 0.9, ease: "easeOut" }}
                  style={{
                    width: 240,
                    height: 240,
                    borderRadius: "9999px",
                    background: `radial-gradient(circle, ${ACCENT}66 0%, transparent 70%)`,
                  }}
                />
              )}
              <motion.div
                data-testid="round-result"
                initial={{ scale: 0.7, y: 14, opacity: 0 }}
                animate={{ scale: 1, y: 0, opacity: 1 }}
                transition={{ type: "spring", stiffness: 300, damping: 18 }}
                className="rounded-2xl border px-6 py-4 text-center backdrop-blur-md"
                style={{
                  borderColor:
                    state.resultKind === "win"
                      ? ACCENT
                      : state.resultKind === "push"
                      ? "#d4af37"
                      : "#e74c3c",
                  background: "rgba(0,0,0,0.6)",
                  boxShadow:
                    state.resultKind === "win"
                      ? `0 0 40px ${ACCENT}88`
                      : state.resultKind === "push"
                      ? "0 0 30px rgba(212,175,55,0.5)"
                      : "0 0 30px rgba(231,76,60,0.5)",
                }}
              >
                <div
                  className="font-display text-xl font-bold sm:text-2xl"
                  style={{
                    color:
                      state.resultKind === "win"
                        ? ACCENT
                        : state.resultKind === "push"
                        ? "#f5d060"
                        : "#ff6b6b",
                  }}
                >
                  {state.resultText}
                </div>
                <div
                  className="mt-1 text-sm font-bold tabular-nums"
                  style={{
                    color: state.netDelta >= 0 ? ACCENT : "#ff6b6b",
                  }}
                >
                  {state.netDelta === 0
                    ? "Pot returned"
                    : `${formatDelta(state.netDelta)} chips`}
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* ===== Controls ===== */}
      <div className="mt-4 grid gap-3 lg:grid-cols-[1fr_auto]">
        {/* Action / buy-in panel */}
        <div className="glass rounded-2xl p-4">
          {idle ? (
            <div className="flex flex-col gap-3">
              <div className="text-center text-[11px] uppercase tracking-widest text-white/45">
                Buy-in for the hand
              </div>
              <div className="flex flex-wrap items-center justify-center gap-3">
                {buyInPresets.map((v) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => {
                      sfx.chip();
                      dispatch({ type: "SET_BUYIN", value: v });
                    }}
                    className="flex flex-col items-center gap-1"
                    data-testid={`buyin-${v}`}
                  >
                    <Chip value={v} size={52} selected={state.buyIn === v} />
                  </button>
                ))}
              </div>
              <div className="flex items-center justify-center gap-3">
                <span className="text-xs text-white/50">Buy-in</span>
                <span className="gold-text text-lg font-bold tabular-nums">
                  {formatChips(state.buyIn)}
                </span>
              </div>
              <Button
                variant="gold"
                size="lg"
                block
                data-testid="play-btn"
                disabled={lowBalance}
                onClick={startHand}
              >
                {lowBalance ? "Top up to play" : "Deal Hand ♠"}
              </Button>
              {lowBalance && (
                <div className="text-center text-xs text-ruby">
                  Balance below the big blind — use the top-up in the header.
                </div>
              )}
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {/* status line */}
              <div className="flex items-center justify-between text-xs text-white/55">
                <span>
                  {playerActive
                    ? toCall > 0
                      ? `To call: ${formatChips(toCall)}`
                      : "Action on you"
                    : state.phase === "bot"
                    ? "Bot is thinking…"
                    : state.phase === "showdown"
                    ? "Showdown!"
                    : "Dealing…"}
                </span>
                <span className="tabular-nums">Pot {formatChips(state.pot)}</span>
              </div>

              {/* action buttons */}
              <div className="grid grid-cols-3 gap-2">
                <Button
                  variant="danger"
                  size="lg"
                  data-testid="fold-btn"
                  disabled={!playerActive}
                  onClick={onFold}
                >
                  Fold
                </Button>
                <Button
                  variant="felt"
                  size="lg"
                  data-testid="call-btn"
                  disabled={!playerActive}
                  onClick={onCheckCall}
                >
                  {playerCanCheck ? "Check" : `Call ${formatChips(toCall)}`}
                </Button>
                <Button
                  variant="neon"
                  size="lg"
                  data-testid="raise-btn"
                  disabled={!playerActive || !canRaise}
                  onClick={onRaise}
                >
                  {state.botStreetBet > 0 ? "Raise" : "Bet"}
                </Button>
              </div>

              {/* raise sizing */}
              <div
                className={`rounded-xl border border-white/10 bg-black/30 p-3 transition ${
                  playerActive && canRaise ? "opacity-100" : "opacity-40"
                }`}
              >
                <div className="flex items-center justify-between text-[11px] text-white/50">
                  <span>Raise to</span>
                  <span className="gold-text font-bold tabular-nums">
                    {formatChips(clamp(raiseTo, minRaiseTo, Math.max(minRaiseTo, maxRaiseTo)))}
                  </span>
                </div>
                <input
                  type="range"
                  min={minRaiseTo}
                  max={Math.max(minRaiseTo, maxRaiseTo)}
                  step={SB}
                  value={clamp(raiseTo, minRaiseTo, Math.max(minRaiseTo, maxRaiseTo))}
                  disabled={!playerActive || !canRaise}
                  onChange={(e) => setRaiseTo(parseInt(e.target.value, 10))}
                  data-testid="raise-slider"
                  className="mt-2 w-full accent-emerald-400"
                  style={{ accentColor: ACCENT }}
                />
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <SizeBtn
                    label="Min"
                    disabled={!playerActive || !canRaise}
                    onClick={() => setRaiseTo(minRaiseTo)}
                  />
                  <SizeBtn
                    label="½ Pot"
                    disabled={!playerActive || !canRaise}
                    onClick={() => setRaiseTo(halfPotRaise)}
                  />
                  <SizeBtn
                    label="Pot"
                    disabled={!playerActive || !canRaise}
                    onClick={() => setRaiseTo(potSizeRaise)}
                  />
                  <SizeBtn
                    label="All-in"
                    disabled={!playerActive || !canRaise}
                    onClick={() => setRaiseTo(maxRaiseTo)}
                  />
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Info / hand ranks panel */}
        <div className="glass flex w-full flex-col gap-3 rounded-2xl p-4 lg:w-72">
          <div className="text-[11px] uppercase tracking-widest text-white/45">
            Action Log
          </div>
          <div className="flex min-h-[88px] flex-col gap-1 text-xs">
            <AnimatePresence initial={false}>
              {state.log.map((e) => (
                <motion.div
                  key={e.id}
                  initial={{ opacity: 0, x: -8 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0 }}
                  className={
                    e.who === "player"
                      ? "text-emerald-300"
                      : e.who === "bot"
                      ? "text-red-300"
                      : "text-white/45"
                  }
                >
                  {e.who === "player" ? "▸ " : e.who === "bot" ? "◂ " : "· "}
                  {e.text}
                </motion.div>
              ))}
            </AnimatePresence>
          </div>

          <div className="border-t border-white/10 pt-2 text-[11px] uppercase tracking-widest text-white/45">
            Hand Ranks
          </div>
          <ol className="space-y-0.5 text-[11px] text-white/55">
            {[
              "Royal Flush",
              "Straight Flush",
              "Four of a Kind",
              "Full House",
              "Flush",
              "Straight",
              "Three of a Kind",
              "Two Pair",
              "Pair",
              "High Card",
            ].map((n) => (
              <li key={n} className="flex justify-between">
                <span>{n}</span>
              </li>
            ))}
          </ol>
          <div className="border-t border-white/10 pt-2 text-[10px] leading-relaxed text-white/40">
            Heads-up no-limit. Blinds {SB}/{BB}. Button alternates each hand. Best
            five-card hand wins; ties split the pot.
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function SizeBtn({
  label,
  onClick,
  disabled,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={() => {
        if (disabled) return;
        sfx.click();
        onClick();
      }}
      disabled={disabled}
      className="rounded-lg border border-white/12 bg-white/5 px-2.5 py-1 text-[11px] font-semibold text-white/70 transition hover:bg-white/10 disabled:opacity-40"
    >
      {label}
    </button>
  );
}

function Seat({
  name,
  active,
  isButton,
  stack,
  streetBet,
  accent,
  handLabel,
  children,
}: {
  name: string;
  active: boolean;
  isButton: boolean;
  stack: number;
  streetBet: number;
  accent: string;
  handLabel?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-center gap-3 sm:gap-5">
      {/* name plate */}
      <motion.div
        animate={{
          boxShadow: active
            ? `0 0 0 2px ${accent}, 0 0 22px ${accent}88`
            : "0 0 0 1px rgba(255,255,255,0.08)",
        }}
        transition={{ duration: 0.3 }}
        className="flex min-w-[112px] flex-col items-start gap-0.5 rounded-xl bg-black/40 px-3 py-2 backdrop-blur"
      >
        <div className="flex items-center gap-1.5">
          <span
            className="text-sm font-bold"
            style={{ color: accent, textShadow: `0 0 10px ${accent}66` }}
          >
            {name}
          </span>
          {isButton && (
            <span
              className="grid h-4 w-4 place-items-center rounded-full bg-white text-[9px] font-black text-black"
              title="Dealer button"
            >
              D
            </span>
          )}
        </div>
        <div className="text-[10px] uppercase tracking-wider text-white/40">
          Stack
        </div>
        <div className="text-xs font-bold tabular-nums text-white/80">
          {formatChips(stack)}
        </div>
        {streetBet > 0 && (
          <motion.div
            key={streetBet}
            initial={{ scale: 0.8, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="mt-0.5 rounded-full border border-gold/40 bg-black/50 px-2 py-0.5 text-[10px] font-bold tabular-nums text-gold"
          >
            bet {formatChips(streetBet)}
          </motion.div>
        )}
        {handLabel && (
          <div className="mt-0.5 text-[10px] font-semibold text-emerald-300/80">
            {handLabel}
          </div>
        )}
      </motion.div>

      {/* cards */}
      <motion.div
        animate={{ scale: active ? 1.02 : 1 }}
        transition={{ duration: 0.25 }}
      >
        {children}
      </motion.div>
    </div>
  );
}
