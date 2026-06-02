import { NextRequest, NextResponse } from "next/server";
import { kv, USER_KEY, type UserRecord } from "@/lib/kv";
import { verifyPassword, hashPassword, createSession } from "@/lib/auth";
import { getBalance, initBalance } from "@/lib/server/wallet";

// Pre-hashed dummy to prevent timing attacks when username doesn't exist
const DUMMY_HASH = await hashPassword("__dummy_password_never_matches__");

export async function POST(req: NextRequest) {
  try {
    const { username, password } = await req.json();

    if (typeof username !== "string" || typeof password !== "string") {
      return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    }

    const user = await kv.get<UserRecord>(USER_KEY(username));

    // Always run verifyPassword to prevent timing attacks
    const hashToCheck = user?.passwordHash ?? DUMMY_HASH;
    const valid = await verifyPassword(password, hashToCheck);

    if (!user || !valid) {
      return NextResponse.json({ error: "Invalid username or password" }, { status: 401 });
    }

    const token = await createSession(user.username);

    // Lazy one-time migration: seed the authoritative balance key from the
    // legacy record if it doesn't exist yet (nx, so concurrent logins are safe).
    let balance = await getBalance(user.username);
    if (Number.isNaN(balance)) {
      await initBalance(user.username, user.balance, true);
      balance = user.balance;
    }

    const { passwordHash: _, ...publicUser } = user;
    return NextResponse.json({ token, user: { ...publicUser, balance } });
  } catch {
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
