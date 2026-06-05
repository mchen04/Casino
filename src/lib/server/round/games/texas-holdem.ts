import { type RoundGame, RoundStep, GameError } from "../engine";
import { intIn, assert } from "../../engine";
import { evaluateBest, makeDeck, type Card } from "../../../cards";

// Server-authoritative heads-up Texas Hold'em (you vs ONE bot, no rake).
//   Buy in for a stack; the server deals (deck committed), posts blinds, runs the
//   bot with a strong heuristic (preflop ranges, made-hand + DRAW equity, pot
//   odds, sized bets, light bluffs), reveals the streets and resolves showdowns.
//   The bot's hole cards never appear in publicView until showdown, so the client
//   can't see them or forge a result. Money model: the buy-in is debited at the
//   deal; the player's FINAL stack (chips behind + anything won, with uncalled
//   bets refunded) is credited atomically when the hand ends. Heads-up has no
//   side pots, so chips are exactly conserved.

const SB = 25;
const BB = 50;

type Street = "preflop" | "flop" | "turn" | "river";
type Seat = "player" | "bot";

interface THState {
  deck: Card[]; // undealt remainder
  playerHole: Card[];
  botHole: Card[];
  board: Card[]; // 5 committed; revealCount controls visibility
  revealCount: number;
  street: Street;
  buyIn: number;
  playerStack: number; // chips behind
  botStack: number;
  pot: number;
  playerCommitted: number; // into the pot this hand
  botCommitted: number;
  playerStreetBet: number;
  botStreetBet: number;
  buttonIsPlayer: boolean; // button posts SB + acts first preflop
  toAct: Seat;
  playerActed: boolean;
  botActed: boolean;
  ended: boolean;
  foldedBy?: Seat | null;
}

const STREET_REVEAL: Record<Street, number> = { preflop: 0, flop: 3, turn: 4, river: 5 };
const NEXT_STREET: Record<Street, Street | null> = { preflop: "flop", flop: "turn", turn: "river", river: null };

// ---------------------------------------------------------------------------
// Bot strategy — estimate real heads-up equity against an unknown player range
// and compare it to pot odds. The bot deliberately ignores s.playerHole and
// unrevealed s.board cards, even though the server state has them committed.
// ---------------------------------------------------------------------------
const EXACT_EQUITY_LIMIT = 90_000;
const EQUITY_SAMPLES = 2_400;

function withoutKnownCards(cards: Card[], known: Card[]): Card[] {
  const knownIds = new Set(known.map((c) => c.id));
  return cards.filter((c) => !knownIds.has(c.id));
}

function comboCount(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  if (k === 0 || k === n) return 1;
  let out = 1;
  for (let i = 1; i <= k; i++) out = (out * (n - k + i)) / i;
  return out;
}

function scoreShowdown(
  botHole: Card[],
  oppHole: Card[],
  visibleBoard: Card[],
  futureBoard: Card[],
): 0 | 0.5 | 1 {
  const board = [...visibleBoard, ...futureBoard];
  const bot = evaluateBest([...botHole, ...board]);
  const opp = evaluateBest([...oppHole, ...board]);
  if (bot.score > opp.score) return 1;
  if (bot.score < opp.score) return 0;
  return 0.5;
}

function enumerateRunouts(
  pool: Card[],
  needed: number,
  visit: (runout: Card[]) => void,
  start = 0,
  runout: Card[] = [],
): void {
  if (runout.length === needed) {
    visit(runout);
    return;
  }
  for (let i = start; i <= pool.length - (needed - runout.length); i++) {
    runout.push(pool[i]);
    enumerateRunouts(pool, needed, visit, i + 1, runout);
    runout.pop();
  }
}

function exactEquity(botHole: Card[], visibleBoard: Card[], unseen: Card[]): number {
  const futureNeeded = 5 - visibleBoard.length;
  let equity = 0;
  let trials = 0;

  for (let i = 0; i < unseen.length - 1; i++) {
    for (let j = i + 1; j < unseen.length; j++) {
      const oppHole = [unseen[i], unseen[j]];
      const runoutPool = unseen.filter((_, idx) => idx !== i && idx !== j);
      enumerateRunouts(runoutPool, futureNeeded, (futureBoard) => {
        equity += scoreShowdown(botHole, oppHole, visibleBoard, futureBoard);
        trials++;
      });
    }
  }

  return trials > 0 ? equity / trials : 0.5;
}

function sampledEquity(
  botHole: Card[],
  visibleBoard: Card[],
  unseen: Card[],
  rng: { float(): number },
): number {
  const futureNeeded = 5 - visibleBoard.length;
  let equity = 0;

  for (let trial = 0; trial < EQUITY_SAMPLES; trial++) {
    const pool = unseen.slice();
    const draw = (count: number): Card[] => {
      const out: Card[] = [];
      for (let i = 0; i < count; i++) {
        const idx = Math.floor(rng.float() * pool.length);
        out.push(pool.splice(idx, 1)[0]);
      }
      return out;
    };
    const oppHole = draw(2);
    const futureBoard = draw(futureNeeded);
    equity += scoreShowdown(botHole, oppHole, visibleBoard, futureBoard);
  }

  return equity / EQUITY_SAMPLES;
}

function botEquity(
  botHole: Card[],
  visibleBoard: Card[],
  rng: { float(): number },
): number {
  const unseen = withoutKnownCards(makeDeck(1), [...botHole, ...visibleBoard]);
  const futureNeeded = 5 - visibleBoard.length;
  const exactTrials = comboCount(unseen.length, 2) * comboCount(unseen.length - 2, futureNeeded);
  const equity =
    exactTrials > 0 && exactTrials <= EXACT_EQUITY_LIMIT
      ? exactEquity(botHole, visibleBoard, unseen)
      : sampledEquity(botHole, visibleBoard, unseen, rng);
  return Math.max(0, Math.min(1, equity));
}

function legalRaiseTarget(s: THState, desiredTo: number): number | null {
  const myBet = s.botStreetBet;
  const oppBet = s.playerStreetBet;
  const maxTo = myBet + s.botStack;
  if (maxTo <= oppBet) return null;

  const minTo =
    oppBet > myBet
      ? oppBet + Math.max(BB, oppBet - myBet)
      : Math.max(oppBet, myBet) + BB;
  const rounded = Math.ceil(desiredTo / SB) * SB;
  const target = Math.min(Math.max(rounded, minTo), maxTo);
  return target > oppBet ? target : null;
}

function sizedRaiseTo(s: THState, equity: number, toCall: number, bluff = false): number | null {
  const potAfterCall = s.pot + Math.max(0, toCall);
  const effectiveStack = Math.min(s.botStack, s.playerStack);
  const spr = effectiveStack / Math.max(BB, potAfterCall);
  const fraction =
    equity >= 0.84 ? 1
    : equity >= 0.72 ? 0.75
    : equity >= 0.62 ? 0.55
    : bluff ? 0.45
    : 0.5;

  if (equity >= 0.88 && spr <= 1.25) return legalRaiseTarget(s, s.botStreetBet + s.botStack);
  return legalRaiseTarget(s, s.playerStreetBet + Math.max(BB, Math.round(potAfterCall * fraction)));
}

// A small deterministic-ish randomizer for the bot, seeded off the rng.
function botActFor(s: THState, rng: { float(): number }): { kind: "fold" | "check" | "call" | "raise"; to?: number } {
  const board = s.board.slice(0, s.revealCount);
  const equity = botEquity(s.botHole, board, rng);
  const toCall = s.playerStreetBet - s.botStreetBet;
  const potAfterCall = s.pot + Math.max(0, toCall);
  const streetAggression = board.length === 5 ? 0.04 : board.length === 0 ? 0.08 : 0.1;

  if (toCall <= 0) {
    const valueBet = equity >= (board.length === 0 ? 0.58 : 0.56);
    const semiBluff = equity >= 0.42 && rng.float() < streetAggression;
    if ((valueBet || semiBluff) && s.botStack > 0) {
      const to = sizedRaiseTo(s, equity, 0, semiBluff && !valueBet);
      if (to != null) return { kind: "raise", to };
    }
    return { kind: "check" };
  }

  const potOdds = toCall / Math.max(1, potAfterCall);
  const callEdge = equity - potOdds;
  if (callEdge < -0.025) return { kind: "fold" };

  const valueRaise = equity >= Math.max(0.62, potOdds + 0.18);
  const semiBluffRaise =
    board.length < 5 &&
    equity >= Math.max(0.44, potOdds + 0.06) &&
    rng.float() < streetAggression;
  if (valueRaise || semiBluffRaise) {
    const to = sizedRaiseTo(s, equity, toCall, semiBluffRaise && !valueRaise);
    if (to != null) return { kind: "raise", to };
  }

  return { kind: "call" };
}

// ---------------------------------------------------------------------------
// Betting engine
// ---------------------------------------------------------------------------
function roundClosed(s: THState): boolean {
  const level = s.playerStreetBet === s.botStreetBet;
  if (s.playerStack === 0 && s.botStreetBet >= s.playerStreetBet && s.playerActed) return true;
  if (s.botStack === 0 && s.playerStreetBet >= s.botStreetBet && s.botActed) return true;
  if (level && (s.playerStack === 0 || s.botStack === 0) && s.playerActed && s.botActed) return true;
  return level && s.playerActed && s.botActed;
}

/** Move `amount` of NEW chips for a seat into the pot (capped at the stack). */
function commit(s: THState, seat: Seat, toStreetBet: number): void {
  const cur = seat === "player" ? s.playerStreetBet : s.botStreetBet;
  const stack = seat === "player" ? s.playerStack : s.botStack;
  const add = Math.min(Math.max(0, toStreetBet - cur), stack);
  if (seat === "player") {
    s.playerStack -= add;
    s.playerStreetBet += add;
    s.playerCommitted += add;
  } else {
    s.botStack -= add;
    s.botStreetBet += add;
    s.botCommitted += add;
  }
  s.pot += add;
}

function advanceStreet(s: THState): void {
  const next = NEXT_STREET[s.street];
  if (!next) return;
  s.street = next;
  s.revealCount = STREET_REVEAL[next];
  s.playerStreetBet = 0;
  s.botStreetBet = 0;
  s.playerActed = false;
  s.botActed = false;
  // Postflop the NON-button acts first.
  s.toAct = s.buttonIsPlayer ? "bot" : "player";
}

/** Settle a finished hand → the player's final chip total to credit. */
function settlePayout(s: THState): { payout: number; botFinal: number; outcome: string; reason: string } {
  // Refund any uncalled excess (heads-up: the larger street bet over the smaller).
  // After a fold this lives in *Committed; equalise so the pot is balanced.
  const refundPlayer = Math.max(0, s.playerCommitted - s.botCommitted);
  const refundBot = Math.max(0, s.botCommitted - s.playerCommitted);
  const matchedPlayer = s.playerCommitted - refundPlayer;
  const matchedBot = s.botCommitted - refundBot;
  const pot = matchedPlayer + matchedBot;

  let playerWins: number; // 0 = lose, pot = win, pot/2 = split
  let outcome: string;
  let reason: string;
  if (s.foldedBy === "player") {
    playerWins = 0;
    outcome = "lose";
    reason = "fold";
  } else if (s.foldedBy === "bot") {
    playerWins = pot;
    outcome = "win";
    reason = "fold";
  } else {
    const p = evaluateBest([...s.playerHole, ...s.board]);
    const b = evaluateBest([...s.botHole, ...s.board]);
    if (p.score > b.score) { playerWins = pot; outcome = "win"; reason = p.name; }
    else if (p.score < b.score) { playerWins = 0; outcome = "lose"; reason = b.name; }
    else { playerWins = Math.floor(pot / 2); outcome = "push"; reason = p.name; }
  }
  // Player's final chips = chips behind + uncalled refund + share of the pot.
  // The bot gets the rest of the pot; chips are exactly conserved (no side pots).
  const finalStack = s.playerStack + refundPlayer + playerWins;
  const botFinal = s.botStack + refundBot + (pot - playerWins);
  return { payout: Math.round(finalStack), botFinal: Math.round(botFinal), outcome, reason };
}


function publicView(s: THState, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    playerHole: s.playerHole,
    board: s.board.slice(0, s.revealCount),
    street: s.street,
    pot: s.pot,
    playerStack: s.playerStack,
    botStack: s.botStack,
    playerStreetBet: s.playerStreetBet,
    botStreetBet: s.botStreetBet,
    toCall: Math.max(0, s.botStreetBet - s.playerStreetBet), // chips the PLAYER must call
    buttonIsPlayer: s.buttonIsPlayer,
    toAct: s.toAct,
    ...extra,
  };
}

/** Legal actions for the player right now. */
function playerActions(s: THState): string[] {
  const toCall = s.botStreetBet - s.playerStreetBet;
  const acts: string[] = ["fold"];
  if (toCall <= 0) acts.push("check");
  else acts.push("call");
  if (s.playerStack > Math.max(0, toCall)) acts.push("raise"); // chips left to put in beyond a call
  return acts;
}

/**
 * Drive the hand forward: run bot turns and street advances until it's the
 * player's turn with a live decision, or the hand ends. Returns the RoundStep.
 */
function drive(s: THState, rng: { float(): number }): RoundStep<THState> {
  const botMoves: string[] = []; // narration of what the bot did this drive
  for (let guard = 0; guard < 200; guard++) {
    if (s.foldedBy) return endStep(s, botMoves);

    if (roundClosed(s)) {
      if (s.street === "river" || s.playerStack === 0 || s.botStack === 0) {
        // Showdown (or both all-in → run it out by revealing the board).
        s.revealCount = 5;
        return endStep(s, botMoves);
      }
      advanceStreet(s);
      continue;
    }

    if (s.toAct === "bot") {
      const before = s.botStreetBet;
      const d = botActFor(s, rng);
      applyAction(s, "bot", d.kind, d.to);
      const added = s.botStreetBet - before;
      botMoves.push(
        d.kind === "fold" ? "Bot folds"
        : d.kind === "check" ? "Bot checks"
        : d.kind === "call" ? `Bot calls ${added}`
        : s.botStack === 0 ? `Bot is all-in (${s.botStreetBet})` : `Bot raises to ${s.botStreetBet}`,
      );
      s.toAct = "player"; // hand control back; the loop re-checks for a close
      continue;
    }
    // Player's turn with a live decision.
    return {
      state: s,
      publicView: publicView(s, {
        actions: playerActions(s),
        toCall: s.botStreetBet - s.playerStreetBet,
        botMoves,
      }),
      actions: playerActions(s),
      done: false,
      payout: 0,
    };
  }
  // Safety: never loop forever — force a showdown.
  s.revealCount = 5;
  return endStep(s, botMoves);
}

function endStep(s: THState, botMoves: string[] = []): RoundStep<THState> {
  s.ended = true;
  const { payout, botFinal, outcome, reason } = settlePayout(s);
  return {
    publicView: {
      ...publicView(s, { actions: [], outcome, reason, botMoves }),
      botHole: s.botHole, // revealed at the end
      board: s.board,
      revealCount: 5,
      botFinal, // exposed for verification: payout + botFinal === 2 × buyIn
    },
    actions: [],
    done: true,
    payout,
  };
}

function applyAction(s: THState, seat: Seat, kind: string, to?: number): void {
  const myBet = seat === "player" ? s.playerStreetBet : s.botStreetBet;
  const oppBet = seat === "player" ? s.botStreetBet : s.playerStreetBet;
  const stack = seat === "player" ? s.playerStack : s.botStack;
  const toCall = oppBet - myBet;

  if (kind === "fold") {
    s.foldedBy = seat;
    return;
  }
  if (kind === "check") {
    assert(toCall <= 0, "Can't check facing a bet");
  } else if (kind === "call") {
    commit(s, seat, oppBet); // capped at stack (all-in call for less)
  } else if (kind === "raise" || kind === "bet") {
    let target = Math.floor(to ?? 0);
    const maxTo = myBet + stack; // all-in ceiling
    const minTo = oppBet > myBet ? oppBet + Math.max(BB, oppBet - myBet) : Math.max(oppBet, myBet) + BB;
    target = Math.min(target, maxTo);
    // Allow an all-in for less than a full min-raise; otherwise enforce min-raise.
    if (target < minTo && target < maxTo) throw new GameError("Raise too small");
    assert(target > oppBet, "A raise must exceed the current bet");
    commit(s, seat, target);
  } else {
    throw new GameError("Invalid action");
  }
  if (seat === "player") s.playerActed = true;
  else s.botActed = true;
}

export const texasHoldemGame: RoundGame<THState, { buyIn: number }> = {
  slug: "texas-holdem",
  minBet: 2 * BB, // minimum buy-in (debited at the deal as the stack)
  maxBet: 1_000_000,
  validate: (params) => {
    assert(params && typeof params === "object", "Missing params");
    // buyIn is carried as the engine bet; params kept for symmetry/extension.
    return { buyIn: 0 };
  },
  start: (buyIn, _params, rng) => {
    const stack = Math.floor(buyIn);
    const deck = rng.shuffle(makeDeck(1));
    const playerHole = [deck[0], deck[2]];
    const botHole = [deck[1], deck[3]];
    const board = [deck[4], deck[5], deck[6], deck[7], deck[8]];
    const buttonIsPlayer = rng.float() < 0.5;
    const s: THState = {
      deck: deck.slice(9),
      playerHole, botHole, board, revealCount: 0,
      street: "preflop", buyIn: stack,
      playerStack: stack, botStack: stack,
      pot: 0, playerCommitted: 0, botCommitted: 0,
      playerStreetBet: 0, botStreetBet: 0,
      buttonIsPlayer,
      toAct: buttonIsPlayer ? "player" : "bot", // button (SB) acts first preflop
      playerActed: false, botActed: false, ended: false, foldedBy: null,
    };
    // Post blinds: the button posts SB, the other posts BB.
    commit(s, buttonIsPlayer ? "player" : "bot", SB);
    commit(s, buttonIsPlayer ? "bot" : "player", BB);
    return drive(s, rng);
  },
  act: (state, _bet, action, payload, rng) => {
    const s = state as THState;
    if (s.ended || s.foldedBy) throw new GameError("Hand already over");
    if (s.toAct !== "player") throw new GameError("Not your turn");

    const to = (payload as Record<string, unknown>)?.to;
    const target = typeof to === "number" ? intIn(to, 0, s.buyIn * 2, "to") : undefined;
    applyAction(s, "player", action, target);
    s.toAct = "bot"; // hand control to the bot; drive() re-checks for a close first
    return drive(s, rng);
  },
};
