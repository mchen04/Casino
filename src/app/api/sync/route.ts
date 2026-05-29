import { NextRequest, NextResponse } from "next/server";
import { kv, USER_KEY, LEADERBOARD_KEY, type UserRecord } from "@/lib/kv";
import { resolveSession } from "@/lib/auth";

export async function POST(req: NextRequest) {
  try {
    const auth = req.headers.get("authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;

    if (!token) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const username = await resolveSession(token);
    if (!username) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { balance, totalWagered, totalReturned, rounds, biggestWin, resets } = await req.json();

    // Validate all fields are non-negative numbers
    const fields = { balance, totalWagered, totalReturned, rounds, biggestWin, resets };
    for (const [key, val] of Object.entries(fields)) {
      if (typeof val !== "number" || !Number.isFinite(val) || val < 0) {
        return NextResponse.json({ error: `Invalid field: ${key}` }, { status: 400 });
      }
    }

    const existing = await kv.get<UserRecord>(USER_KEY(username));
    if (!existing) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const user: UserRecord = { ...existing, balance, totalWagered, totalReturned, rounds, biggestWin, resets };
    await kv.set(USER_KEY(username), user);
    await kv.zadd(LEADERBOARD_KEY, { score: balance, member: username.toLowerCase() });

    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
