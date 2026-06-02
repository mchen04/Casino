import { NextRequest, NextResponse } from "next/server";
import { kv, USER_KEY, LEADERBOARD_KEY, isOnLeaderboard, type UserRecord } from "@/lib/kv";
import { resolveSession } from "@/lib/auth";
import { rescueGrant } from "@/lib/server/wallet";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A bailout fires only when the player is broke (below this many chips)… */
const RESCUE_FLOOR = 100;
/** …and lifts them by exactly this many chips. */
const RESCUE_GRANT = 5_000;

function extractToken(req: NextRequest): string | null {
  const auth = req.headers.get("authorization") ?? "";
  return auth.startsWith("Bearer ") ? auth.slice(7) : null;
}

// POST /api/rescue — atomically credit the bankruptcy bailout, broke players only.
// Server-authoritative: the client cannot choose the amount or bypass the floor.
export async function POST(req: NextRequest) {
  try {
    const token = extractToken(req);
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const username = await resolveSession(token);
    if (!username) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { granted, balance } = await rescueGrant(username, RESCUE_FLOOR, RESCUE_GRANT);
    if (!granted) {
      // Solvent — nothing to bail out. Return the authoritative balance so the
      // client can re-sync its display instead of showing a phantom top-up.
      return NextResponse.json({ error: "Not eligible", balance }, { status: 409 });
    }

    // Mirror the authoritative balance into the display record + leaderboard and
    // bump the reset counter (display-only; the balance key is the source of truth).
    let resets = 0;
    const user = await kv.get<UserRecord>(USER_KEY(username));
    if (user) {
      resets = (user.resets ?? 0) + 1;
      const updated: UserRecord = { ...user, balance, resets };
      const member = username.toLowerCase();
      const pipe = kv.pipeline(); // record + leaderboard in one round-trip
      pipe.set(USER_KEY(username), updated);
      if (isOnLeaderboard(updated)) pipe.zadd(LEADERBOARD_KEY, { score: balance, member });
      else pipe.zrem(LEADERBOARD_KEY, member);
      await pipe.exec();
    }

    return NextResponse.json({ balance, granted: RESCUE_GRANT, resets });
  } catch {
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
