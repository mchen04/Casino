import { NextRequest, NextResponse } from "next/server";
import { kv, USER_KEY, LEADERBOARD_KEY, type UserRecord } from "@/lib/kv";
import { resolveSession } from "@/lib/auth";

const CLAIM_AMOUNT = 1_000;
const CLAIM_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

function extractToken(req: NextRequest): string | null {
  const auth = req.headers.get("authorization") ?? "";
  return auth.startsWith("Bearer ") ? auth.slice(7) : null;
}

// GET /api/claim — returns eligibility + next claim time
export async function GET(req: NextRequest) {
  try {
    const token = extractToken(req);
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const username = await resolveSession(token);
    if (!username) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const user = await kv.get<UserRecord>(USER_KEY(username));
    if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

    const now = Date.now();
    const lastClaim = user.lastClaim ?? 0;
    const nextClaimAt = lastClaim + CLAIM_INTERVAL_MS;
    const eligible = now >= nextClaimAt;

    return NextResponse.json({ eligible, nextClaimAt: eligible ? null : nextClaimAt });
  } catch {
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

// POST /api/claim — perform the claim
export async function POST(req: NextRequest) {
  try {
    const token = extractToken(req);
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const username = await resolveSession(token);
    if (!username) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const user = await kv.get<UserRecord>(USER_KEY(username));
    if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

    const now = Date.now();
    const lastClaim = user.lastClaim ?? 0;
    const nextClaimAt = lastClaim + CLAIM_INTERVAL_MS;

    if (now < nextClaimAt) {
      return NextResponse.json(
        { error: "Too soon", nextClaimAt },
        { status: 429 },
      );
    }

    const newBalance = user.balance + CLAIM_AMOUNT;
    const updated: UserRecord = { ...user, balance: newBalance, lastClaim: now };

    await kv.set(USER_KEY(username), updated);
    await kv.zadd(LEADERBOARD_KEY, { score: newBalance, member: username.toLowerCase() });

    return NextResponse.json({
      balance: newBalance,
      claimed: CLAIM_AMOUNT,
      nextClaimAt: now + CLAIM_INTERVAL_MS,
    });
  } catch {
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
