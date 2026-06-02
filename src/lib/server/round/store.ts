import crypto from "crypto";
import { kv, ROUND_KEY, BAL_KEY, ROUND_TTL } from "@/lib/kv";

/**
 * Persistence + ATOMIC settlement for stateful rounds (/api/round).
 *
 * A round lives under round:<id> while in progress. Settling it credits the
 * balance and CONSUMES the round key in a single atomic Lua step — so a replayed
 * or concurrent settle can never double-credit: only the first request that
 * finds the key wins; every later one sees it gone.
 */

export interface StoredRound {
  game: string;
  username: string;
  /** Original (base) stake in cents. */
  betCents: number;
  /** Total wagered so far in cents (base + raises) — for display stats only. */
  wageredCents?: number;
  /** Game-specific hidden state (dealer hole cards, deck, raises…). */
  state: unknown;
  createdAt: number;
}

// Credit `amount` to the balance and DELETE the round key, atomically, only if
// the round key still exists. Returns {status, balance}: 1 = settled now,
// 0 = already settled/expired (no credit). Guarantees idempotent settlement.
const SETTLE_ROUND = `
local round = redis.call('GET', KEYS[1])
if round == false then return {0, 0} end
redis.call('DEL', KEYS[1])
local bal = redis.call('GET', KEYS[2])
if bal == false then bal = 0 else bal = tonumber(bal) end
bal = bal + tonumber(ARGV[1])
redis.call('SET', KEYS[2], bal)
return {1, bal}
`;

const toChips = (cents: number) => Math.round(cents) / 100;

export function newRoundId(): string {
  return crypto.randomBytes(18).toString("hex");
}

export async function saveRound(id: string, round: StoredRound): Promise<void> {
  await kv.set(ROUND_KEY(id), round, { ex: ROUND_TTL });
}

export async function loadRound(id: string): Promise<StoredRound | null> {
  const r = await kv.get<StoredRound>(ROUND_KEY(id));
  return r ?? null;
}

/**
 * Atomically credit `payoutCents` and consume the round. Returns the new balance
 * in chips, or null if the round was already settled/expired (no double-credit).
 */
export async function settleRound(
  id: string,
  username: string,
  payoutCents: number,
): Promise<{ settled: boolean; balance: number }> {
  const res = (await kv.eval(
    SETTLE_ROUND,
    [ROUND_KEY(id), BAL_KEY(username)],
    [String(Math.round(payoutCents))],
  )) as [number, number];
  const settled = Number(res[0]) === 1;
  return { settled, balance: toChips(Number(res[1])) };
}

export async function discardRound(id: string): Promise<void> {
  await kv.del(ROUND_KEY(id));
}
