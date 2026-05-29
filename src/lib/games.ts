import type { ComponentType } from "react";

export type GameCategory =
  | "Cards"
  | "Table"
  | "Slots"
  | "Wheel"
  | "Dice"
  | "Modern"
  | "Lottery";

export interface GameMeta {
  slug: string;
  name: string;
  category: GameCategory;
  /** One-line description for the lobby card. */
  blurb: string;
  /** Hex accent color used for glow/borders. */
  accent: string;
  /** Emoji icon. */
  emoji: string;
  players: "single" | "multi";
  tags?: string[];
  /** Dynamic import of the game module; default export is the component. */
  load: () => Promise<{ default: ComponentType }>;
}

export const CATEGORY_ORDER: GameCategory[] = [
  "Cards",
  "Table",
  "Slots",
  "Wheel",
  "Dice",
  "Modern",
  "Lottery",
];

// NOTE: import() paths MUST be string literals so the bundler can code-split.
export const GAMES: GameMeta[] = [
  // ---------------- Cards ----------------
  {
    slug: "blackjack",
    name: "Blackjack",
    category: "Cards",
    blurb: "Beat the dealer to 21 without busting.",
    accent: "#d4af37",
    emoji: "🃏",
    players: "single",
    tags: ["classic", "21"],
    load: () => import("@/games/blackjack"),
  },
  {
    slug: "spanish-21",
    name: "Spanish 21",
    category: "Cards",
    blurb: "Blackjack with no tens and bonus payouts.",
    accent: "#e0b341",
    emoji: "🇪🇸",
    players: "single",
    load: () => import("@/games/spanish-21"),
  },
  {
    slug: "baccarat",
    name: "Baccarat",
    category: "Cards",
    blurb: "Bet Player, Banker, or Tie — closest to 9 wins.",
    accent: "#c0392b",
    emoji: "🎴",
    players: "single",
    tags: ["classic"],
    load: () => import("@/games/baccarat"),
  },
  {
    slug: "video-poker",
    name: "Video Poker",
    category: "Cards",
    blurb: "Jacks or Better — hold, draw, and chase the royal.",
    accent: "#22e1ff",
    emoji: "🎰",
    players: "single",
    load: () => import("@/games/video-poker"),
  },
  {
    slug: "texas-holdem",
    name: "Texas Hold'em",
    category: "Cards",
    blurb: "Heads-up no-limit poker against the house bots.",
    accent: "#2ecc71",
    emoji: "♠️",
    players: "multi",
    tags: ["poker", "bots"],
    load: () => import("@/games/texas-holdem"),
  },
  {
    slug: "ultimate-texas",
    name: "Ultimate Texas Hold'em",
    category: "Cards",
    blurb: "Hold'em vs the dealer with escalating raises.",
    accent: "#27ae60",
    emoji: "🤠",
    players: "single",
    load: () => import("@/games/ultimate-texas"),
  },
  {
    slug: "three-card-poker",
    name: "Three Card Poker",
    category: "Cards",
    blurb: "Three cards, Pair Plus, and an Ante bonus.",
    accent: "#9b59b6",
    emoji: "3️⃣",
    players: "single",
    load: () => import("@/games/three-card-poker"),
  },
  {
    slug: "caribbean-stud",
    name: "Caribbean Stud",
    category: "Cards",
    blurb: "Stud poker vs the dealer with a progressive feel.",
    accent: "#1abc9c",
    emoji: "🏝️",
    players: "single",
    load: () => import("@/games/caribbean-stud"),
  },
  {
    slug: "let-it-ride",
    name: "Let It Ride",
    category: "Cards",
    blurb: "Pull back or let your bets ride for a big hand.",
    accent: "#e67e22",
    emoji: "🎢",
    players: "single",
    load: () => import("@/games/let-it-ride"),
  },
  {
    slug: "pai-gow-poker",
    name: "Pai Gow Poker",
    category: "Cards",
    blurb: "Split 7 cards into a high and low hand.",
    accent: "#e74c3c",
    emoji: "🀄",
    players: "single",
    load: () => import("@/games/pai-gow-poker"),
  },
  {
    slug: "casino-war",
    name: "Casino War",
    category: "Cards",
    blurb: "Highest card wins — go to war on a tie.",
    accent: "#c0392b",
    emoji: "⚔️",
    players: "single",
    load: () => import("@/games/casino-war"),
  },
  {
    slug: "red-dog",
    name: "Red Dog",
    category: "Cards",
    blurb: "Will the third card fall between the first two?",
    accent: "#d35400",
    emoji: "🐕",
    players: "single",
    load: () => import("@/games/red-dog"),
  },
  {
    slug: "dragon-tiger",
    name: "Dragon Tiger",
    category: "Cards",
    blurb: "One card each — Dragon or Tiger takes it.",
    accent: "#f39c12",
    emoji: "🐉",
    players: "single",
    load: () => import("@/games/dragon-tiger"),
  },
  {
    slug: "andar-bahar",
    name: "Andar Bahar",
    category: "Cards",
    blurb: "Pick a side and wait for the matching card.",
    accent: "#16a085",
    emoji: "🪔",
    players: "single",
    load: () => import("@/games/andar-bahar"),
  },
  {
    slug: "teen-patti",
    name: "Teen Patti",
    category: "Cards",
    blurb: "Indian three-card poker against the dealer.",
    accent: "#e84393",
    emoji: "🪷",
    players: "single",
    load: () => import("@/games/teen-patti"),
  },
  {
    slug: "hi-lo",
    name: "Hi-Lo",
    category: "Cards",
    blurb: "Call higher or lower and ride the streak.",
    accent: "#00cec9",
    emoji: "🔼",
    players: "single",
    load: () => import("@/games/hi-lo"),
  },

  // ---------------- Table ----------------
  {
    slug: "roulette",
    name: "Roulette",
    category: "Table",
    blurb: "Spin the wheel — European & American modes.",
    accent: "#e3342f",
    emoji: "🎡",
    players: "single",
    tags: ["classic"],
    load: () => import("@/games/roulette"),
  },
  {
    slug: "craps",
    name: "Craps",
    category: "Table",
    blurb: "Roll the bones — Pass, Don't Pass, and more.",
    accent: "#e67e22",
    emoji: "🎲",
    players: "single",
    load: () => import("@/games/craps"),
  },
  {
    slug: "sic-bo",
    name: "Sic Bo",
    category: "Table",
    blurb: "Three dice, dozens of bets — big or small.",
    accent: "#fd79a8",
    emoji: "🎲",
    players: "single",
    load: () => import("@/games/sic-bo"),
  },

  // ---------------- Wheel ----------------
  {
    slug: "money-wheel",
    name: "Money Wheel",
    category: "Wheel",
    blurb: "Big Six wheel of fortune — bet a segment.",
    accent: "#f5d060",
    emoji: "💫",
    players: "single",
    load: () => import("@/games/money-wheel"),
  },
  {
    slug: "coin-flip",
    name: "Coin Flip",
    category: "Wheel",
    blurb: "Heads or tails — the simplest 50/50.",
    accent: "#bdc3c7",
    emoji: "🪙",
    players: "single",
    load: () => import("@/games/coin-flip"),
  },

  // ---------------- Slots ----------------
  {
    slug: "slots-classic",
    name: "Lucky Sevens",
    category: "Slots",
    blurb: "Classic 3-reel slot with bars, bells & 7s.",
    accent: "#e74c3c",
    emoji: "7️⃣",
    players: "single",
    load: () => import("@/games/slots-classic"),
  },
  {
    slug: "slots-fruit",
    name: "Fruit Frenzy",
    category: "Slots",
    blurb: "5-reel fruit slot with scatter free spins.",
    accent: "#2ecc71",
    emoji: "🍒",
    players: "single",
    load: () => import("@/games/slots-fruit"),
  },
  {
    slug: "slots-egypt",
    name: "Pharaoh's Fortune",
    category: "Slots",
    blurb: "Egyptian 5-reel with wilds and big lines.",
    accent: "#f1c40f",
    emoji: "🔺",
    players: "single",
    load: () => import("@/games/slots-egypt"),
  },
  {
    slug: "slots-megaways",
    name: "Neon Megaways",
    category: "Slots",
    blurb: "Cascading reels with mounting multipliers.",
    accent: "#a855f7",
    emoji: "🌈",
    players: "single",
    load: () => import("@/games/slots-megaways"),
  },

  // ---------------- Dice / Modern ----------------
  {
    slug: "dice",
    name: "Dice",
    category: "Dice",
    blurb: "Roll over/under your target multiplier.",
    accent: "#22e1ff",
    emoji: "🎯",
    players: "single",
    load: () => import("@/games/dice"),
  },
  {
    slug: "limbo",
    name: "Limbo",
    category: "Modern",
    blurb: "Pick a target — how high will it go?",
    accent: "#8aff80",
    emoji: "📈",
    players: "single",
    load: () => import("@/games/limbo"),
  },
  {
    slug: "crash",
    name: "Crash",
    category: "Modern",
    blurb: "Cash out before the rocket explodes.",
    accent: "#ff2bd1",
    emoji: "🚀",
    players: "single",
    tags: ["crypto-style"],
    load: () => import("@/games/crash"),
  },
  {
    slug: "plinko",
    name: "Plinko",
    category: "Modern",
    blurb: "Drop the ball through the pegs for a multiplier.",
    accent: "#22e1ff",
    emoji: "🔺",
    players: "single",
    load: () => import("@/games/plinko"),
  },
  {
    slug: "mines",
    name: "Mines",
    category: "Modern",
    blurb: "Reveal gems, avoid the bombs, cash out.",
    accent: "#8aff80",
    emoji: "💎",
    players: "single",
    load: () => import("@/games/mines"),
  },
  {
    slug: "keno",
    name: "Keno",
    category: "Lottery",
    blurb: "Pick your numbers and watch the draw.",
    accent: "#22e1ff",
    emoji: "🔢",
    players: "single",
    load: () => import("@/games/keno"),
  },
  {
    slug: "scratch",
    name: "Scratch Cards",
    category: "Lottery",
    blurb: "Scratch to reveal matching prizes.",
    accent: "#f5d060",
    emoji: "🎟️",
    players: "single",
    load: () => import("@/games/scratch"),
  },
  {
    slug: "bingo",
    name: "Bingo",
    category: "Lottery",
    blurb: "Daub your card and race to a line.",
    accent: "#fd79a8",
    emoji: "🎱",
    players: "single",
    load: () => import("@/games/bingo"),
  },
];

/**
 * As-implemented house edge (%) for each game — the headline / best-bet figure,
 * derived from a full Monte-Carlo + analytic audit of every game's ACTUAL coded
 * payouts and probabilities (not textbook values). Lower is better for players.
 * Slots/keno/teen-patti reflect their repaired economics.
 */
export const HOUSE_EDGE: Record<string, number> = {
  // Cards
  blackjack: 0.4,
  "spanish-21": 0.78,
  baccarat: 1.06,
  "video-poker": 0.46,
  "texas-holdem": 0,
  "ultimate-texas": 2.19,
  "three-card-poker": 3.46,
  "caribbean-stud": 5.22,
  "let-it-ride": 3.51,
  "pai-gow-poker": 3.43,
  "casino-war": 2.33,
  "red-dog": 3.16,
  "dragon-tiger": 3.73,
  "andar-bahar": 2.58,
  "teen-patti": 3.3,
  "hi-lo": 3.0,
  // Table
  roulette: 2.7,
  craps: 1.41,
  "sic-bo": 2.78,
  // Wheel
  "money-wheel": 11.11,
  "coin-flip": 2,
  // Slots
  "slots-classic": 4.8,
  "slots-fruit": 3.2,
  "slots-egypt": 3.2,
  "slots-megaways": 4.2,
  // Dice / Modern
  dice: 1,
  limbo: 1,
  crash: 1,
  plinko: 1,
  mines: 1,
  // Lottery
  keno: 9,
  scratch: 8.54,
  bingo: 10,
};

/** Short qualifier shown next to the edge for games where it needs context. */
export const EDGE_NOTE: Record<string, string> = {
  blackjack: "optimal basic strategy",
  "spanish-21": "optimal strategy",
  baccarat: "Banker bet",
  "video-poker": "max-coin, optimal holds",
  "texas-holdem": "no rake — skill vs bots",
  "ultimate-texas": "on the Ante",
  "caribbean-stud": "on the Ante",
  craps: "Pass line",
  roulette: "European · 5.26% American",
  "sic-bo": "Small/Big · props higher",
  "money-wheel": "best segment · up to 24%",
  keno: "≈ varies 8–10% by picks",
  "hi-lo": "3% per correct guess",
};

export function getGame(slug: string): GameMeta | undefined {
  return GAMES.find((g) => g.slug === slug);
}

/** House edge (%) for a game, or undefined if unknown. */
export function houseEdge(slug: string): number | undefined {
  return HOUSE_EDGE[slug];
}

/** Format a house edge for display, e.g. 2.7 -> "2.70%", 0 -> "0%". */
export function formatHouseEdge(edge: number): string {
  if (edge === 0) return "0%";
  return `${edge.toFixed(2)}%`;
}

export const GAME_COUNT = GAMES.length;
