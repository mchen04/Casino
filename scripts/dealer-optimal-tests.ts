/**
 * Deterministic verification for dealer/house-play card games.
 *
 * This complements scripts/mc-round.ts: Monte Carlo verifies aggregate edge, but
 * these checks pin the actual drawing rules, house-way choices, and strategy
 * thresholds to exact expected-value calculations or published casino rules.
 *
 *   npm run test:dealer
 */
import { dealCoup } from "../src/lib/baccarat";
import {
  evaluate3,
  evaluate5,
  HandCategory,
  makeDeck,
  rankValue,
  ThreeCardCategory,
  type Card,
  type Rank,
  type Suit,
} from "../src/lib/cards";
import { houseWay, evalFive, evalLow } from "../src/lib/paiGow";
import { blackjackGame } from "../src/lib/server/round/games/blackjack";
import { spanish21Game } from "../src/lib/server/round/games/spanish-21";
import { teenPattiGame } from "../src/lib/server/round/games/teen-patti";
import { ultimateTexasGame } from "../src/lib/server/round/games/ultimate-texas";
import type { Rng } from "../src/lib/server/rngCore";

const BET = 100;
const SUIT: Suit = "spades";

function assert(cond: boolean, message: string): void {
  if (!cond) throw new Error(message);
}

function assertClose(actual: number, expected: number, tol: number, message: string): void {
  if (Math.abs(actual - expected) > tol) {
    throw new Error(`${message}: got ${actual}, expected ${expected} +/- ${tol}`);
  }
}

function card(rank: Rank, suit: Suit = SUIT, deck = 0): Card {
  return { rank, suit, id: `${rank}${suit[0].toUpperCase()}#${deck}` };
}

function deckCard(rank: Rank, suit: Suit): Card {
  const found = makeDeck(1).find((c) => c.rank === rank && c.suit === suit);
  if (!found) throw new Error(`missing card ${rank} ${suit}`);
  return found;
}

function key(c: Card): string {
  return c.id;
}

function withoutCards(deck: Card[], used: Card[]): Card[] {
  const usedKeys = new Set(used.map(key));
  return deck.filter((c) => !usedKeys.has(key(c)));
}

function combos<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  const cur: T[] = [];
  const rec = (start: number) => {
    if (cur.length === n) {
      out.push(cur.slice());
      return;
    }
    for (let i = start; i <= arr.length - (n - cur.length); i++) {
      cur.push(arr[i]);
      rec(i + 1);
      cur.pop();
    }
  };
  rec(0);
  return out;
}

function fixedDeckRng(deck: Card[]): Rng {
  return {
    float: () => 0.5,
    range: (min, max) => (min + max) / 2,
    int: (min, max) => Math.floor((min + max) / 2),
    pick: (arr) => arr[0],
    shuffle: <T,>() => deck.slice() as unknown as T[],
    chance: (p) => p >= 0.5,
    weighted: (items) => items[0],
  };
}

function riggedDeck(front: Card[], decks: number, spanish = false): Card[] {
  const used = new Set(front.map(key));
  const base = makeDeck(decks).filter((c) => (!spanish || c.rank !== "10") && !used.has(key(c)));
  return [...front, ...base];
}

function ratioForRedDogSpread(spread: number): number {
  if (spread === 1) return 5;
  if (spread === 2) return 4;
  if (spread === 3) return 2;
  return 1;
}

function redDogRaiseIncrementEv(spread: number): number {
  const pWin = (spread * 4) / 50;
  return pWin * ratioForRedDogSpread(spread) - (1 - pWin);
}

function casinoWarDecisionValueAfterTie(tiedRank: Rank): number {
  const ranks = makeDeck(1).filter((c) => c.suit === "spades").map((c) => c.rank);
  const counts = new Map<number, number>();
  for (const rank of ranks) counts.set(rankValue(rank), 24);
  counts.set(rankValue(tiedRank), 22);

  let gross = 0;
  let ordered = 0;
  for (const [pRank, pCount] of counts) {
    for (const [dRank, dCountRaw] of counts) {
      const dCount = dRank === pRank ? dCountRaw - 1 : dCountRaw;
      const ways = pCount * dCount;
      ordered += ways;
      if (pRank > dRank) gross += ways * 3;
      else if (pRank === dRank) gross += ways * 4;
    }
  }
  assert(ordered === 310 * 309, "casino-war ordered war-card count");
  return gross / ordered - 1; // subtract the matched war wager.
}

function dealerQualifiesThreeCard(cards: Card[]): boolean {
  const r = evaluate3(cards);
  return r.category > ThreeCardCategory.HighCard || Math.max(...cards.map((c) => rankValue(c.rank))) >= 12;
}

function threeCardPlayGross(player: Card[], dealer: Card[]): number {
  const pRank = evaluate3(player);
  const dRank = evaluate3(dealer);
  const anteBonus: Partial<Record<ThreeCardCategory, number>> = {
    [ThreeCardCategory.StraightFlush]: 5,
    [ThreeCardCategory.ThreeOfAKind]: 4,
    [ThreeCardCategory.Straight]: 1,
  };
  let gross = anteBonus[pRank.category] ?? 0;
  if (!dealerQualifiesThreeCard(dealer)) return gross + 3;
  const cmp = pRank.score - dRank.score;
  if (cmp > 0) return gross + 4;
  if (cmp === 0) return gross + 2;
  return gross;
}

function threeCardPlayEv(player: Card[]): number {
  const rest = withoutCards(makeDeck(1), player);
  let gross = 0;
  let n = 0;
  for (const dealer of combos(rest, 3)) {
    gross += threeCardPlayGross(player, dealer);
    n++;
  }
  return gross / n;
}

function caribbeanDealerQualifies(hand: Card[]): boolean {
  if (evaluate5(hand).category > HandCategory.HighCard) return true;
  const vals = new Set(hand.map((c) => rankValue(c.rank)));
  return vals.has(14) && vals.has(13);
}

function caribbeanRaiseMultiplier(cat: HandCategory): number {
  const table: Partial<Record<HandCategory, number>> = {
    [HandCategory.RoyalFlush]: 100,
    [HandCategory.StraightFlush]: 50,
    [HandCategory.FourOfAKind]: 20,
    [HandCategory.FullHouse]: 7,
    [HandCategory.Flush]: 5,
    [HandCategory.Straight]: 4,
    [HandCategory.ThreeOfAKind]: 3,
    [HandCategory.TwoPair]: 2,
    [HandCategory.Pair]: 1,
  };
  return table[cat] ?? 1;
}

function caribbeanRaiseDecisionEv(player: Card[], dealerUp: Card): number {
  const pEval = evaluate5(player);
  const rest = withoutCards(makeDeck(1), [...player, dealerUp]);
  let future = 0;
  let n = 0;
  for (const hole of combos(rest, 4)) {
    const dealer = [dealerUp, ...hole];
    const dEval = evaluate5(dealer);
    let gross = 0;
    if (!caribbeanDealerQualifies(dealer)) {
      gross = 4;
    } else {
      const cmp = pEval.score - dEval.score;
      if (cmp > 0) gross = 4 + 2 * caribbeanRaiseMultiplier(pEval.category);
      else if (cmp === 0) gross = 3;
    }
    future += gross - 2; // raising costs two more units at the decision.
    n++;
  }
  return future / n;
}

function caribbeanWizardRaise(player: Card[], dealerUp: Card): boolean {
  if (evaluate5(player).category > HandCategory.HighCard) return true;
  const vals = player.map((c) => rankValue(c.rank)).sort((a, b) => b - a);
  if (!vals.includes(14) || !vals.includes(13)) return false;
  const up = rankValue(dealerUp.rank);
  if (up <= 12 && vals.includes(up)) return true;
  if ((up === 14 || up === 13) && vals[2] >= 11) return true;
  return vals.includes(12) && !vals.includes(up) && up < vals[3];
}

function letItRideMultiplier(cards: Card[]): number {
  const rank = evaluate5(cards);
  if (rank.category === HandCategory.Pair) return (rank.tiebreak[0] ?? 0) >= 10 ? 1 : 0;
  if (rank.category === HandCategory.HighCard) return 0;
  const table: Partial<Record<HandCategory, number>> = {
    [HandCategory.RoyalFlush]: 1000,
    [HandCategory.StraightFlush]: 200,
    [HandCategory.FourOfAKind]: 50,
    [HandCategory.FullHouse]: 11,
    [HandCategory.Flush]: 8,
    [HandCategory.Straight]: 5,
    [HandCategory.ThreeOfAKind]: 3,
    [HandCategory.TwoPair]: 2,
  };
  return table[rank.category] ?? 0;
}

function letItRideUnitGross(partial: Card[]): number {
  const rest = withoutCards(makeDeck(1), partial);
  const needed = 5 - partial.length;
  let gross = 0;
  let n = 0;
  for (const drawn of combos(rest, needed)) {
    const mult = letItRideMultiplier([...partial, ...drawn]);
    gross += mult > 0 ? mult + 1 : 0;
    n++;
  }
  return gross / n;
}

function testBaccaratTableau(): void {
  let res = dealCoup([
    card("K"), card("9", "hearts"),
    card("4", "clubs"), card("3", "diamonds"),
    card("2"),
  ]);
  assert(res.natural && res.playerCards.length === 2 && res.bankerCards.length === 2, "baccarat naturals stand");

  res = dealCoup([
    card("3"), card("3", "hearts"),
    card("2", "clubs"), card("2", "diamonds"),
    card("5"),
  ]);
  assert(res.playerCards.length === 2 && res.bankerCards.length === 3, "baccarat banker draws on 0-5 when player stands");

  res = dealCoup([
    card("2"), card("3", "hearts"),
    card("A", "clubs"), card("2", "diamonds"),
    card("8"),
  ]);
  assert(res.playerCards.length === 3 && res.bankerCards.length === 2, "baccarat banker 3 stands against player third-card 8");

  res = dealCoup([
    card("2"), card("3", "hearts"),
    card("2", "clubs"), card("2", "diamonds"),
    card("7"), card("6"),
  ]);
  assert(res.playerCards.length === 3 && res.bankerCards.length === 3, "baccarat banker 4 draws against player third-card 2-7");
}

function testRedDogThreshold(): void {
  for (let spread = 1; spread <= 11; spread++) {
    const ev = redDogRaiseIncrementEv(spread);
    if (spread >= 7) assert(ev > 0, `red-dog spread ${spread} should raise`);
    else assert(ev <= 0, `red-dog spread ${spread} should call`);
  }
}

function testCasinoWarTieDecision(): void {
  const ranks = makeDeck(1).filter((c) => c.suit === "spades").map((c) => c.rank);
  for (const rank of ranks) {
    const warValue = casinoWarDecisionValueAfterTie(rank);
    assert(warValue > 0.5, `casino-war ${rank} tie should go to war, not surrender`);
  }
}

function testThreeCardThreshold(): void {
  const q64 = [
    deckCard("Q", "spades"),
    deckCard("6", "hearts"),
    deckCard("4", "clubs"),
  ];
  const q63 = [
    deckCard("Q", "spades"),
    deckCard("6", "hearts"),
    deckCard("3", "clubs"),
  ];
  assert(threeCardPlayEv(q64) > 1, "three-card Q-6-4 should play");
  assert(threeCardPlayEv(q63) < 1, "three-card Q-6-3 should fold");
}

function testCaribbeanStudDecisionEv(): void {
  const pair = [
    deckCard("9", "spades"), deckCard("9", "hearts"), deckCard("4", "clubs"),
    deckCard("7", "diamonds"), deckCard("2", "clubs"),
  ];
  const belowAk = [
    deckCard("A", "spades"), deckCard("Q", "hearts"), deckCard("J", "clubs"),
    deckCard("9", "diamonds"), deckCard("3", "clubs"),
  ];
  const akMatch = [
    deckCard("A", "spades"), deckCard("K", "hearts"), deckCard("9", "clubs"),
    deckCard("5", "diamonds"), deckCard("2", "clubs"),
  ];
  const weakAk = [
    deckCard("A", "spades"), deckCard("K", "hearts"), deckCard("9", "clubs"),
    deckCard("7", "diamonds"), deckCard("3", "clubs"),
  ];

  assert(caribbeanRaiseDecisionEv(pair, deckCard("3", "diamonds")) > 0, "caribbean pair+ should raise by exact EV");
  assert(caribbeanRaiseDecisionEv(belowAk, deckCard("2", "diamonds")) < 0, "caribbean below A-K should fold by exact EV");
  assert(caribbeanWizardRaise(akMatch, deckCard("5", "clubs")), "caribbean A-K match rule should raise");
  assert(caribbeanRaiseDecisionEv(akMatch, deckCard("5", "clubs")) > 0, "caribbean A-K match should be +EV to raise");
  assert(!caribbeanWizardRaise(weakAk, deckCard("2", "diamonds")), "caribbean weak A-K rule should fold");
  assert(caribbeanRaiseDecisionEv(weakAk, deckCard("2", "diamonds")) < 0, "caribbean weak A-K should be -EV to raise");
}

function testLetItRideDecisionEv(): void {
  assert(
    letItRideUnitGross([
      deckCard("10", "spades"), deckCard("J", "spades"), deckCard("Q", "spades"),
    ]) > 1,
    "let-it-ride three to a royal should ride",
  );
  assert(
    letItRideUnitGross([
      deckCard("9", "spades"), deckCard("9", "hearts"), deckCard("4", "clubs"),
    ]) < 1,
    "let-it-ride low pair should pull first bet",
  );
  assert(
    letItRideUnitGross([
      deckCard("2", "spades"), deckCard("5", "spades"), deckCard("8", "spades"), deckCard("K", "spades"),
    ]) > 1,
    "let-it-ride four to a flush should ride second bet",
  );
  assertClose(
    letItRideUnitGross([
      deckCard("2", "spades"), deckCard("3", "hearts"), deckCard("4", "clubs"), deckCard("5", "diamonds"),
    ]),
    1,
    1e-12,
    "let-it-ride no-high outside straight should be neutral",
  );
}

function testBlackjackDealerS17(): void {
  const deck = riggedDeck([
    card("J", "spades", 0),
    card("A", "hearts", 0),
    card("8", "clubs", 0),
    card("6", "diamonds", 0),
    card("5", "spades", 0),
  ], 6);
  const rng = fixedDeckRng(deck);
  let step = blackjackGame.start(BET, {}, rng);
  assert(step.actions.includes("decline"), "blackjack should offer insurance against ace");
  step = blackjackGame.act(step.state!, BET, "decline", null, rng);
  step = blackjackGame.act(step.state!, BET, "stand", null, rng);
  const dealer = step.publicView.dealer as Card[];
  assert(step.done && dealer.length === 2, "blackjack dealer must stand on soft 17");
  assert(step.payout === BET * 2, "blackjack player 18 should beat dealer soft 17");
}

function testSpanish21DealerAndBonuses(): void {
  let deck = riggedDeck([
    card("J", "spades", 0),
    card("A", "hearts", 0),
    card("8", "clubs", 0),
    card("6", "diamonds", 0),
    card("5", "spades", 0),
  ], 6, true);
  let rng = fixedDeckRng(deck);
  let step = spanish21Game.start(BET, {}, rng);
  step = spanish21Game.act(step.state!, BET, "stand", null, rng);
  let dealer = step.publicView.dealer as Card[];
  assert(step.done && dealer.length === 2, "spanish-21 dealer must stand on soft 17");
  assert(step.payout === BET * 2, "spanish-21 player 18 should beat dealer soft 17");

  deck = riggedDeck([
    card("A", "spades", 0),
    card("A", "hearts", 0),
    card("J", "clubs", 0),
    card("Q", "diamonds", 0),
  ], 6, true);
  rng = fixedDeckRng(deck);
  step = spanish21Game.start(BET, {}, rng);
  assert(step.done && step.payout === BET * 2.5, "spanish-21 player blackjack beats dealer blackjack");
}

function testUltimateTexasDealerScoring(): void {
  let deck = riggedDeck([
    deckCard("Q", "spades"),   // player 1
    deckCard("A", "hearts"),   // dealer 1
    deckCard("3", "clubs"),    // player 2
    deckCard("K", "diamonds"), // dealer 2
    deckCard("2", "spades"),
    deckCard("5", "hearts"),
    deckCard("7", "clubs"),
    deckCard("9", "diamonds"),
    deckCard("J", "spades"),
  ], 1);
  let rng = fixedDeckRng(deck);
  let step = ultimateTexasGame.start(BET, { trips: 0 }, rng);
  step = ultimateTexasGame.act(step.state!, BET, "check", null, rng);
  step = ultimateTexasGame.act(step.state!, BET, "check", null, rng);
  step = ultimateTexasGame.act(step.state!, BET, "bet1x", null, rng);
  assert(step.done && step.payout === BET, "ultimate-texas ante should push when dealer wins without qualifying");

  deck = riggedDeck([
    deckCard("Q", "spades"),   // player 1
    deckCard("A", "hearts"),   // dealer 1
    deckCard("3", "clubs"),    // player 2
    deckCard("A", "diamonds"), // dealer 2
    deckCard("2", "spades"),
    deckCard("5", "hearts"),
    deckCard("7", "clubs"),
    deckCard("9", "diamonds"),
    deckCard("J", "spades"),
  ], 1);
  rng = fixedDeckRng(deck);
  step = ultimateTexasGame.start(BET, { trips: 0 }, rng);
  step = ultimateTexasGame.act(step.state!, BET, "check", null, rng);
  step = ultimateTexasGame.act(step.state!, BET, "check", null, rng);
  step = ultimateTexasGame.act(step.state!, BET, "bet1x", null, rng);
  assert(step.done && step.payout === 0, "ultimate-texas ante should lose when qualified dealer wins");
}

function testTeenPattiDealerShowdown(): void {
  let deck = riggedDeck([
    deckCard("A", "spades"), deckCard("K", "hearts"), deckCard("Q", "clubs"),
    deckCard("A", "hearts"), deckCard("3", "clubs"), deckCard("2", "diamonds"),
  ], 1);
  let rng = fixedDeckRng(deck);
  let step = teenPattiGame.start(BET, {}, rng);
  step = teenPattiGame.act(step.state!, BET, "play", null, rng);
  assert(step.done && step.payout === 540, "teen-patti A-K-Q sequence should beat A-2-3 and pay sequence bonus after commission");

  deck = riggedDeck([
    deckCard("9", "spades"), deckCard("9", "hearts"), deckCard("4", "clubs"),
    deckCard("9", "diamonds"), deckCard("9", "clubs"), deckCard("4", "diamonds"),
  ], 1);
  rng = fixedDeckRng(deck);
  step = teenPattiGame.start(BET, {}, rng);
  step = teenPattiGame.act(step.state!, BET, "play", null, rng);
  assert(step.done && step.payout === BET * 2, "teen-patti exact dealer/player tie should push both stakes");
}

function testPaiGowHouseWay(): void {
  let split = houseWay([
    deckCard("K", "spades"), deckCard("K", "hearts"), deckCard("K", "clubs"),
    deckCard("Q", "spades"), deckCard("Q", "hearts"), deckCard("A", "clubs"), deckCard("9", "diamonds"),
  ]);
  assert(evalLow(split.low).pair && evalLow(split.low).tiebreak[0] === 12, "pai-gow full house should put pair in front");
  assert(evalFive(split.high).category === HandCategory.ThreeOfAKind, "pai-gow full-house back should keep trips");

  split = houseWay([
    deckCard("A", "spades"), deckCard("A", "hearts"), deckCard("K", "clubs"),
    deckCard("K", "diamonds"), deckCard("Q", "spades"), deckCard("7", "clubs"), deckCard("2", "hearts"),
  ]);
  assert(evalLow(split.low).pair && evalLow(split.low).tiebreak[0] === 13, "pai-gow two pair should keep stronger pair in back");

  split = houseWay([
    deckCard("5", "spades"), deckCard("5", "hearts"), deckCard("A", "clubs"),
    deckCard("K", "diamonds"), deckCard("Q", "spades"), deckCard("J", "clubs"), deckCard("9", "hearts"),
  ]);
  assert(!evalLow(split.low).pair && evalLow(split.low).tiebreak[0] === 14 && evalLow(split.low).tiebreak[1] === 13, "pai-gow one-pair hand should play best low hand");
}

const tests: Array<[string, () => void]> = [
  ["baccarat tableau", testBaccaratTableau],
  ["red-dog threshold", testRedDogThreshold],
  ["casino-war tie decision", testCasinoWarTieDecision],
  ["three-card Q-6-4 threshold", testThreeCardThreshold],
  ["caribbean exact decision EV", testCaribbeanStudDecisionEv],
  ["let-it-ride decision EV", testLetItRideDecisionEv],
  ["blackjack dealer S17", testBlackjackDealerS17],
  ["spanish-21 dealer/blackjack rules", testSpanish21DealerAndBonuses],
  ["ultimate-texas dealer scoring", testUltimateTexasDealerScoring],
  ["teen-patti dealer showdown", testTeenPattiDealerShowdown],
  ["pai-gow house way", testPaiGowHouseWay],
];

for (const [name, fn] of tests) {
  fn();
  console.log(`[PASS] ${name}`);
}
