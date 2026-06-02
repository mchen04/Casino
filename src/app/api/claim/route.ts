import { NextRequest, NextResponse } from "next/server";
import { kv, USER_KEY, LEADERBOARD_KEY, isOnLeaderboard, type UserRecord } from "@/lib/kv";
import { resolveSession } from "@/lib/auth";
import { claimBonus, getLastClaim } from "@/lib/server/wallet";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CLAIM_AMOUNT = 1_000;
const CLAIM_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

function extractToken(req: NextRequest): string | null {
  const auth = req.headers.get("authorization") ?? "";
  return auth.startsWith("Bearer ") ? auth.slice(7) : null;
}

// GET /api/claim — eligibility + next claim time
export async function GET(req: NextRequest) {
  try {
    const token = extractToken(req);
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const username = await resolveSession(token);
    if (!username) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const lastClaim = await getLastClaim(username);
    const nextClaimAt = lastClaim + CLAIM_INTERVAL_MS;
    const eligible = Date.now() >= nextClaimAt;
    return NextResponse.json({ eligible, nextClaimAt: eligible ? null : nextClaimAt });
  } catch {
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

// POST /api/claim — atomically credit the authoritative balance, once per window.
export async function POST(req: NextRequest) {
  try {
    const token = extractToken(req);
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const username = await resolveSession(token);
    if (!username) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { claimed, nextClaimAt, balance } = await claimBonus(
      username,
      CLAIM_AMOUNT,
      CLAIM_INTERVAL_MS,
      Date.now(),
    );

    if (!claimed) {
      return NextResponse.json({ error: "Too soon", nextClaimAt }, { status: 429 });
    }

    // Mirror the authoritative balance into the display record + leaderboard.
    const user = await kv.get<UserRecord>(USER_KEY(username));
    if (user) {
      const updated: UserRecord = { ...user, balance, lastClaim: Date.now() };
      await kv.set(USER_KEY(username), updated);
      if (isOnLeaderboard(updated)) {
        await kv.zadd(LEADERBOARD_KEY, { score: balance, member: username.toLowerCase() });
      } else {
        await kv.zrem(LEADERBOARD_KEY, username.toLowerCase());
      }
    }

    return NextResponse.json({ balance, claimed: CLAIM_AMOUNT, nextClaimAt });
  } catch {
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
