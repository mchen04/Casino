import { NextRequest, NextResponse } from "next/server";
import { resolveSession } from "@/lib/auth";
import { getSpec, GameError } from "@/lib/server/engine";
import { rng } from "@/lib/server/rng";
import { settleBet, recordStats, toCents } from "@/lib/server/wallet";
import "@/lib/server/games"; // side-effect: populate the registry

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The ONE entrypoint for stateless wagers. Server owns the outcome and payout;
 * the client supplies only { game, bet, params }. There is no field by which a
 * client can assert a balance, an outcome, or a payout.
 */
export async function POST(req: NextRequest) {
  try {
    const auth = req.headers.get("authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const username = await resolveSession(token);
    if (!username) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json().catch(() => null);
    const spec = body && typeof body.game === "string" ? getSpec(body.game) : undefined;
    if (!spec) return NextResponse.json({ error: "Unknown game" }, { status: 400 });

    const bet = body.bet;
    if (
      typeof bet !== "number" ||
      !Number.isInteger(bet) ||
      bet < spec.minBet ||
      bet > spec.maxBet
    ) {
      return NextResponse.json({ error: "Invalid bet" }, { status: 400 });
    }

    let result;
    try {
      const params = spec.validate(body.params);
      result = spec.resolve(bet, params, rng);
    } catch (e) {
      if (e instanceof GameError) return NextResponse.json({ error: e.message }, { status: 400 });
      throw e;
    }

    // Defence in depth: a resolver must never return a non-finite/negative payout.
    if (!Number.isFinite(result.payout) || result.payout < 0) {
      return NextResponse.json({ error: "Internal error" }, { status: 500 });
    }

    const settle = await settleBet(username, toCents(bet), toCents(result.payout));
    if (!settle.ok) {
      return NextResponse.json(
        { error: settle.reason === "insufficient" ? "Insufficient balance" : "Wallet not initialised" },
        { status: settle.reason === "insufficient" ? 400 : 409 },
      );
    }

    await recordStats(username, settle.balance, {
      wagered: bet,
      returned: result.payout,
      biggestWin: result.payout,
    });

    return NextResponse.json({
      ok: true,
      outcome: result.outcome,
      bet,
      payout: result.payout,
      balance: settle.balance,
    });
  } catch {
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
