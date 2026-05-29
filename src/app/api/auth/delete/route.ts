import { NextRequest, NextResponse } from "next/server";
import { kv, USER_KEY, SESSION_KEY, LEADERBOARD_KEY } from "@/lib/kv";
import { resolveSession } from "@/lib/auth";

export async function DELETE(req: NextRequest) {
  const token = req.headers.get("authorization")?.replace("Bearer ", "");
  if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const username = await resolveSession(token);
  if (!username) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  await Promise.all([
    kv.del(USER_KEY(username)),
    kv.zrem(LEADERBOARD_KEY, username.toLowerCase()),
    kv.del(SESSION_KEY(token)),
  ]);

  return NextResponse.json({ ok: true });
}
