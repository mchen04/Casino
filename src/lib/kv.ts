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

export const USER_KEY = (u: string) => `user:${u.toLowerCase()}`;
export const SESSION_KEY = (t: string) => `session:${t}`;
export const LEADERBOARD_KEY = "leaderboard";
export const SESSION_TTL = 60 * 60 * 24 * 7; // 7 days
