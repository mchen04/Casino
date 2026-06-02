import { type RoundGame, RoundStep, GameError } from "../engine";
import { intIn, assert } from "../../engine";
import { evaluateBest, makeDeck, HandCategory, rankValue, type Card } from "../../../cards";

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
// Bot heuristic — strength in [0,1] from made hand + draw equity (postflop) or
// a preflop hand score.
// ---------------------------------------------------------------------------
function preflopStrength(hole: Card[]): number {
  const v = hole.map((c) => rankValue(c.rank));
  const hi = Math.max(v[0], v[1]);
  const lo = Math.min(v[0], v[1]);
  const pair = hole[0].rank === hole[1].rank;
  const suited = hole[0].suit === hole[1].suit;
  const gap = hi - lo;
  if (pair) return Math.min(0.5 + (hi - 2) / 24, 0.97); // 22→0.5 … AA→0.97
  let s = (hi + lo) / 28;
  if (suited) s += 0.08;
  if (gap === 1) s += 0.06;
  else if (gap === 2) s += 0.03;
  else if (gap === 3) s += 0.015;
  if (hi >= 13) s += 0.05; // a high card to make top pair
  return Math.max(0.05, Math.min(0.92, s));
}
/** Count flush / open-ended-straight draws to add semibluff equity. */
function drawBonus(hole: Card[], board: Card[]): number {
  const cards = [...hole, ...board];
  let bonus = 0;
  // Flush draw: 4 to a suit.
  const bySuit: Record<string, number> = {};
  for (const c of cards) bySuit[c.suit] = (bySuit[c.suit] ?? 0) + 1;
  if (Object.values(bySuit).some((n) => n === 4)) bonus += 0.18;
  // Straight draw: 4 distinct ranks inside a 5-wide window (incl. wheel).
  const set = new Set(cards.map((c) => rankValue(c.rank)));
  if (set.has(14)) set.add(1); // wheel
  let straightDraw = false;
  for (let lo = 1; lo <= 10; lo++) {
    let inWin = 0;
    for (let k = 0; k < 5; k++) if (set.has(lo + k)) inWin++;
    if (inWin === 4) straightDraw = true;
  }
  if (straightDraw) bonus += 0.14;
  return bonus;
}
function botStrength(hole: Card[], board: Card[]): number {
  if (board.length < 3) return preflopStrength(hole);
  const ev = evaluateBest([...hole, ...board]);
  const base: Record<HandCategory, number> = {
    [HandCategory.HighCard]: 0.16,
    [HandCategory.Pair]: 0.42,
    [HandCategory.TwoPair]: 0.63,
    [HandCategory.ThreeOfAKind]: 0.75,
    [HandCategory.Straight]: 0.84,
    [HandCategory.Flush]: 0.9,
    [HandCategory.FullHouse]: 0.95,
    [HandCategory.FourOfAKind]: 0.99,
    [HandCategory.StraightFlush]: 0.997,
    [HandCategory.RoyalFlush]: 1,
  };
  const top = (ev.tiebreak[0] ?? 2) / 14;
  let s = base[ev.category] + top * 0.04;
  if (ev.category <= HandCategory.Pair) s = Math.min(0.8, s + drawBonus(hole, board)); // semibluff equity
  return Math.max(0.05, Math.min(1, s));
}

// A small deterministic-ish randomizer for the bot, seeded off the rng.
function botActFor(s: THState, rng: { float(): number }): { kind: "fold" | "check" | "call" | "raise"; to?: number } {
  const board = s.board.slice(0, s.revealCount);
  const strength = botStrength(s.botHole, board);
  const toCall = s.playerStreetBet - s.botStreetBet;
  const maxBet = s.botStack;
  const bluff = rng.float() < 0.1;
  const potNow = s.pot;

  if (toCall <= 0) {
    const wantBet = strength > 0.55 || bluff;
    if (wantBet && maxBet > 0) {
      const potSize = Math.max(BB, potNow);
      let amt = strength > 0.85 ? potSize : strength > 0.65 ? Math.round(potSize * 0.6) : Math.round(potSize * 0.45);
      amt = Math.max(BB, Math.min(amt, maxBet));
      return { kind: "raise", to: s.botStreetBet + amt };
    }
    return { kind: "check" };
  }

  const potOdds = toCall / (potNow + toCall);
  if (strength < 0.3 + potOdds * 0.15 && !bluff) return { kind: "fold" };
  // Raise strong hands / occasional semibluff.
  if ((strength > 0.78 || (bluff && strength > 0.45)) && maxBet > Math.min(toCall, maxBet)) {
    const potSize = Math.max(BB, potNow + toCall);
    const raiseAmt = strength > 0.9 ? potSize : Math.round(potSize * 0.6);
    let to = s.playerStreetBet + Math.max(BB, raiseAmt);
    to = Math.min(to, s.botStreetBet + maxBet); // cap at all-in
    if (to > s.playerStreetBet) return { kind: "raise", to };
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
