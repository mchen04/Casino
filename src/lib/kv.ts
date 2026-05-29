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
  createdAt: number; // unix ms
}

export interface LeaderboardEntry {
  rank: number;
  username: string;
  balance: number;
}

export const USER_KEY = (u: string) => `user:${u.toLowerCase()}`;
export const SESSION_KEY = (t: string) => `session:${t}`;
export const LEADERBOARD_KEY = "leaderboard";
export const SESSION_TTL = 60 * 60 * 24 * 7; // 7 days
