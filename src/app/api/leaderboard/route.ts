import { NextRequest, NextResponse } from "next/server";
import { kv, LEADERBOARD_KEY, type LeaderboardEntry } from "@/lib/kv";

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const limit = Math.min(parseInt(searchParams.get("limit") ?? "50", 10), 100);

    // zrange with rev:true returns members from highest to lowest score
    const results = await kv.zrange<string[]>(LEADERBOARD_KEY, 0, limit - 1, {
      rev: true,
      withScores: true,
    });

    // Results come back as [member, score, member, score, ...]
    const entries: LeaderboardEntry[] = [];
    for (let i = 0; i < results.length; i += 2) {
      entries.push({
        rank: entries.length + 1,
        username: results[i],
        balance: Number(results[i + 1]),
      });
    }

    return NextResponse.json({ entries });
  } catch {
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
