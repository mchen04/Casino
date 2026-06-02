import { NextRequest, NextResponse } from "next/server";
import { kv, USER_KEY, type UserRecord } from "@/lib/kv";
import { resolveSession } from "@/lib/auth";
import { getBalance } from "@/lib/server/wallet";

/**
 * DELIBERATELY NON-FINANCIAL.
 *
 * This endpoint used to accept a client-supplied balance and store it verbatim,
 * which let anyone mint unlimited chips. The wallet is now server-authoritative:
 * balance, wagered, returned, rounds and biggest-win are owned by the server and
 * only change through /api/play, /api/round and /api/claim. This route ignores
 * any body and simply returns the authoritative record so legacy clients keep
 * working. It can never set a balance.
 */
export async function POST(req: NextRequest) {
  try {
    const auth = req.headers.get("authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const username = await resolveSession(token);
    if (!username) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const user = await kv.get<UserRecord>(USER_KEY(username));
    if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

    const balance = await getBalance(username);
    const { passwordHash: _ph, ...publicUser } = user;
    return NextResponse.json({
      ok: true,
      user: { ...publicUser, balance: Number.isNaN(balance) ? user.balance : balance },
    });
  } catch {
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
