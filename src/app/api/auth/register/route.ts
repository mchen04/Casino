import { NextRequest, NextResponse } from "next/server";
import { kv, USER_KEY, LEADERBOARD_KEY, type UserRecord } from "@/lib/kv";
import { hashPassword, createSession } from "@/lib/auth";

const STARTING_BALANCE = 10_000;
const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;

export async function POST(req: NextRequest) {
  try {
    const { username, password } = await req.json();

    if (!USERNAME_RE.test(username)) {
      return NextResponse.json(
        { error: "Username must be 3–20 alphanumeric characters or underscores" },
        { status: 400 },
      );
    }
    if (typeof password !== "string" || password.length < 8) {
      return NextResponse.json(
        { error: "Password must be at least 8 characters" },
        { status: 400 },
      );
    }

    const exists = await kv.exists(USER_KEY(username));
    if (exists) {
      return NextResponse.json({ error: "Username already taken" }, { status: 409 });
    }

    const passwordHash = await hashPassword(password);
    const user: UserRecord = {
      username,
      passwordHash,
      balance: STARTING_BALANCE,
      totalWagered: 0,
      totalReturned: 0,
      rounds: 0,
      biggestWin: 0,
      createdAt: Date.now(),
    };

    await kv.set(USER_KEY(username), user);
    await kv.zadd(LEADERBOARD_KEY, { score: STARTING_BALANCE, member: username.toLowerCase() });

    const token = await createSession(username);
    const { passwordHash: _, ...publicUser } = user;

    return NextResponse.json({ token, user: publicUser }, { status: 201 });
  } catch {
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
