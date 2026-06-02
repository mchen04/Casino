import { Redis } from "@upstash/redis";

export const kv = new Redis({
  url: process.env.KV_REST_API_URL!,
  token: process.env.KV_REST_API_TOKEN!,
});

export interface UserRecord {
  username: string;
  passwordHash: string;
  balance: number;
  totalWagered: number;
  totalReturned: number;
  rounds: number;
  biggestWin: number;
  resets: number;
  createdAt: number; // unix ms
  lastClaim?: number; // unix ms of last bonus claim
  /**
   * Whether this account appears on the public leaderboard. Defaults to true
   * (undefined is treated as visible for legacy records). The leaderboard
   * sorted set is kept in sync with this flag: visible users are zadd'd, hidden
   * users are zrem'd, so a hidden account never resurfaces on a balance update.
   */
  showOnLeaderboard?: boolean;
}

/** A user is shown on the leaderboard unless explicitly hidden. */
export const isOnLeaderboard = (u: Pick<UserRecord, "showOnLeaderboard">): boolean =>
  u.showOnLeaderboard !== false;

export interface LeaderboardEntry {
  rank: number;
  username: string;
  balance: number;
}

// Optional keyspace prefix. Empty in production; set to e.g. "preview:" on
// preview deploys so a shared Upstash DB stays isolated per environment.
const PREFIX = process.env.KV_PREFIX ?? "";

export const USER_KEY = (u: string) => `${PREFIX}user:${u.toLowerCase()}`;
export const SESSION_KEY = (t: string) => `${PREFIX}session:${t}`;
/** Authoritative balance, stored as an INTEGER number of cents. */
export const BAL_KEY = (u: string) => `${PREFIX}bal:${u.toLowerCase()}`;
/** Server-held round state for multi-step games. */
export const ROUND_KEY = (id: string) => `${PREFIX}round:${id}`;
export const LEADERBOARD_KEY = `${PREFIX}leaderboard`;
export const SESSION_TTL = 60 * 60 * 24 * 7; // 7 days
export const ROUND_TTL = 60 * 60; // 1 hour — abandoned rounds expire
