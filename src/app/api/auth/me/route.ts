import { NextRequest, NextResponse } from "next/server";
import { kv, USER_KEY, type UserRecord } from "@/lib/kv";
import { resolveSession } from "@/lib/auth";

export async function GET(req: NextRequest) {
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

    const user = await kv.get<UserRecord>(USER_KEY(username));
    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const { passwordHash: _, ...publicUser } = user;
    return NextResponse.json({ user: publicUser });
  } catch {
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
