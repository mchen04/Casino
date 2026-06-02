import { kv, BAL_KEY, CLAIM_KEY, USER_KEY, LEADERBOARD_KEY, isOnLeaderboard, type UserRecord } from "@/lib/kv";

/**
 * Server-authoritative wallet.
 *
 * The balance is the ONLY security-critical value. It lives in its own key as an
 * INTEGER number of cents and is mutated exclusively through atomic Lua scripts,
 * so two concurrent requests can never double-spend or be coerced into minting
 * chips. The client never sends a balance or a payout — it only chooses a bet
 * and game parameters; the server decides the outcome and the payout.
 */

export const toCents = (chips: number): number => Math.round(chips * 100);
export const toChips = (cents: number): number => Math.round(cents) / 100;

// Atomic "place a bet and apply its payout" in a single round-trip.
// Returns {status, balance}: 1 = ok, -1 = insufficient funds, -2 = uninitialised.
const SETTLE = `
local cur = redis.call('GET', KEYS[1])
if cur == false then return {-2, 0} end
cur = tonumber(cur)
local bet = tonumber(ARGV[1])
local payout = tonumber(ARGV[2])
if cur < bet then return {-1, cur} end
local nxt = cur - bet + payout
redis.call('SET', KEYS[1], nxt)
return {1, nxt}
`;

// Atomic debit (e.g. ante at the start of a multi-step round, or a double/split).
const DEBIT = `
local cur = redis.call('GET', KEYS[1])
if cur == false then return {-2, 0} end
cur = tonumber(cur)
local amt = tonumber(ARGV[1])
if cur < amt then return {-1, cur} end
local nxt = cur - amt
redis.call('SET', KEYS[1], nxt)
return {1, nxt}
`;

// Atomic credit (e.g. settling a multi-step round's winnings). Never fails.
const CREDIT = `
local cur = redis.call('GET', KEYS[1])
if cur == false then cur = 0 else cur = tonumber(cur) end
local nxt = cur + tonumber(ARGV[1])
redis.call('SET', KEYS[1], nxt)
return nxt
`;

// Atomic time-gated bonus claim across the claim-timestamp key (KEYS[1]) and the
// balance key (KEYS[2]). Enforces one claim per interval AND credits the
// authoritative balance in a single atomic step (no TOCTOU, no wrong-key bug).
// ARGV: now(ms), interval(ms), amount(cents). Returns {status, nextClaimAt, balCents}.
const CLAIM = `
local last = tonumber(redis.call('GET', KEYS[1]) or '0')
local now = tonumber(ARGV[1])
local interval = tonumber(ARGV[2])
local bal = redis.call('GET', KEYS[2])
if bal == false then bal = 0 else bal = tonumber(bal) end
if now < last + interval then
  return {0, last + interval, bal}
end
redis.call('SET', KEYS[1], now)
bal = bal + tonumber(ARGV[3])
redis.call('SET', KEYS[2], bal)
return {1, now + interval, bal}
`;

export interface SettleResult {
  ok: boolean;
  reason?: "insufficient" | "uninitialised";
  /** New balance in chips. */
  balance: number;
}

async function evalNum2(script: string, key: string, args: (number | string)[]): Promise<[number, number]> {
  const res = (await kv.eval(script, [key], args.map(String))) as [number, number];
  return [Number(res[0]), Number(res[1])];
}

/** Place `betCents` and apply `payoutCents` atomically. */
export async function settleBet(
  username: string,
  betCents: number,
  payoutCents: number,
): Promise<SettleResult> {
  const [status, balCents] = await evalNum2(SETTLE, BAL_KEY(username), [betCents, payoutCents]);
  if (status === 1) return { ok: true, balance: toChips(balCents) };
  if (status === -1) return { ok: false, reason: "insufficient", balance: toChips(balCents) };
  return { ok: false, reason: "uninitialised", balance: 0 };
}

/** Atomically debit `amountCents` (for multi-step rounds). */
export async function debit(username: string, amountCents: number): Promise<SettleResult> {
  const [status, balCents] = await evalNum2(DEBIT, BAL_KEY(username), [amountCents]);
  if (status === 1) return { ok: true, balance: toChips(balCents) };
  if (status === -1) return { ok: false, reason: "insufficient", balance: toChips(balCents) };
  return { ok: false, reason: "uninitialised", balance: 0 };
}

/** Atomically credit `amountCents` (for multi-step round settlement). */
export async function credit(username: string, amountCents: number): Promise<number> {
  const next = (await kv.eval(CREDIT, [BAL_KEY(username)], [String(amountCents)])) as number;
  return toChips(Number(next));
}

/** Atomically claim the time-gated bonus and credit the authoritative balance. */
export async function claimBonus(
  username: string,
  amountChips: number,
  intervalMs: number,
  nowMs: number,
): Promise<{ claimed: boolean; nextClaimAt: number; balance: number }> {
  const res = (await kv.eval(
    CLAIM,
    [CLAIM_KEY(username), BAL_KEY(username)],
    [String(nowMs), String(intervalMs), String(toCents(amountChips))],
  )) as [number, number, number];
  return {
    claimed: Number(res[0]) === 1,
    nextClaimAt: Number(res[1]),
    balance: toChips(Number(res[2])),
  };
}

/** Read the last-claim timestamp (ms); 0 if never claimed. */
export async function getLastClaim(username: string): Promise<number> {
  const raw = await kv.get<number | string>(CLAIM_KEY(username));
  return raw === null || raw === undefined ? 0 : Number(raw);
}

/** Read the authoritative balance in chips (NaN if uninitialised). */
export async function getBalance(username: string): Promise<number> {
  const raw = await kv.get<number | string>(BAL_KEY(username));
  if (raw === null || raw === undefined) return NaN;
  return toChips(Number(raw));
}

/** Initialise a balance key (used by register / migration). */
export async function initBalance(username: string, chips: number, onlyIfAbsent = false): Promise<void> {
  await kv.set(BAL_KEY(username), toCents(chips), onlyIfAbsent ? { nx: true } : undefined);
}

/**
 * Persist denormalised stats + leaderboard score AFTER an authoritative balance
 * change. These are display-only; balance is the source of truth. Stats races
 * are cosmetic, never financial.
 */
export async function recordStats(
  username: string,
  balanceChips: number,
  deltas: { wagered: number; returned: number; biggestWin: number },
): Promise<void> {
  const existing = await kv.get<UserRecord>(USER_KEY(username));
  if (!existing) return;
  const updated: UserRecord = {
    ...existing,
    balance: balanceChips,
    totalWagered: existing.totalWagered + deltas.wagered,
    totalReturned: Math.round((existing.totalReturned + deltas.returned) * 100) / 100,
    rounds: existing.rounds + 1,
    biggestWin: Math.max(existing.biggestWin, deltas.biggestWin),
  };
  await kv.set(USER_KEY(username), updated);
  if (isOnLeaderboard(updated)) {
    await kv.zadd(LEADERBOARD_KEY, { score: balanceChips, member: username.toLowerCase() });
  } else {
    await kv.zrem(LEADERBOARD_KEY, username.toLowerCase());
  }
}
