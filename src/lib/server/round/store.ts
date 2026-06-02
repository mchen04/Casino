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
  /** Total credited mid-round so far in cents (e.g. craps per-roll wins) — stats only. */
  returnedCents?: number;
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

/**
 * Persist a round. On the START path it creates the key; on an ACT update pass
 * `onlyIfExists` so a round that was just settled-and-deleted by a racing final
 * act can NEVER be resurrected (a plain SET would recreate the deleted key and
 * defeat settleRound's consume-on-credit idempotency).
 */
export async function saveRound(id: string, round: StoredRound, onlyIfExists = false): Promise<void> {
  await kv.set(ROUND_KEY(id), round, onlyIfExists ? { ex: ROUND_TTL, xx: true } : { ex: ROUND_TTL });
}

/**
 * Serialize concurrent acts on ONE round. A non-blocking NX lock with a short
 * TTL: the first act on a round holds it; a concurrent/retried act fails to
 * acquire and is rejected (409) rather than load-modify-saving the same state in
 * parallel — which is what would otherwise let two simultaneous craps rolls (or
 * a blackjack hit+stand) each credit the balance off one stored bet. The TTL
 * keeps a crashed request from deadlocking the round.
 */
const LOCK_TTL = 15; // seconds
export async function acquireRoundLock(id: string): Promise<boolean> {
  const res = await kv.set(`${ROUND_KEY(id)}:lock`, "1", { nx: true, ex: LOCK_TTL });
  return res === "OK";
}
export async function releaseRoundLock(id: string): Promise<void> {
  await kv.del(`${ROUND_KEY(id)}:lock`);
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
