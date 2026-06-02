import { NextRequest, NextResponse } from "next/server";
import { resolveSession } from "@/lib/auth";
import { rng } from "@/lib/server/rng";
import { getRoundGame, GameError } from "@/lib/server/round/engine";
import { newRoundId, saveRound, loadRound, settleRound, type StoredRound } from "@/lib/server/round/store";
import { settleBet, debit, credit, getBalance, recordStats, toCents } from "@/lib/server/wallet";
import "@/lib/server/round/games"; // side-effect: register stateful games

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The ONE entrypoint for STATEFUL wagers (blackjack, pokers, hi-lo, mines, …).
 * The server owns the hidden round state; the client sends only a start request
 * or a decision + roundId. Bets are debited atomically on start (and on raises);
 * payouts are credited via an atomic, idempotent settle that consumes the round
 * key — so a replayed/concurrent settle can never double-credit.
 */
export async function POST(req: NextRequest) {
  try {
    const auth = req.headers.get("authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const username = await resolveSession(token);
    if (!username) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") return NextResponse.json({ error: "Bad request" }, { status: 400 });

    if (body.op === "start") return await handleStart(username, body);
    if (body.op === "act") return await handleAct(username, body);
    return NextResponse.json({ error: "Unknown op" }, { status: 400 });
  } catch (e) {
    if (e instanceof GameError) return NextResponse.json({ error: e.message }, { status: 400 });
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

async function handleStart(username: string, body: Record<string, unknown>) {
  const game = typeof body.game === "string" ? getRoundGame(body.game) : undefined;
  if (!game) return NextResponse.json({ error: "Unknown game" }, { status: 400 });

  const bet = body.bet;
  if (typeof bet !== "number" || !Number.isInteger(bet) || bet < game.minBet || bet > game.maxBet) {
    return NextResponse.json({ error: "Invalid bet" }, { status: 400 });
  }

  let step;
  try {
    const params = game.validate(body.params);
    step = game.start(bet, params, rng);
  } catch (e) {
    if (e instanceof GameError) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }

  if (!Number.isFinite(step.payout) || step.payout < 0) {
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }

  const extraDebit = Math.max(0, step.debit ?? 0);

  if (step.done) {
    // Resolves at the deal — settle the base bet + payout atomically.
    const settle = await settleBet(username, toCents(bet), toCents(step.payout));
    if (!settle.ok) {
      return NextResponse.json(
        { error: settle.reason === "insufficient" ? "Insufficient balance" : "Wallet not initialised" },
        { status: settle.reason === "insufficient" ? 400 : 409 },
      );
    }
    await recordStats(username, settle.balance, { wagered: bet, returned: step.payout, biggestWin: step.payout });
    return NextResponse.json({ done: true, publicView: step.publicView, balance: settle.balance, bet, payout: step.payout });
  }

  // Multi-step: debit the base bet (+ any start-time raise) and persist the round.
  const d = await debit(username, toCents(bet) + toCents(extraDebit));
  if (!d.ok) {
    return NextResponse.json(
      { error: d.reason === "insufficient" ? "Insufficient balance" : "Wallet not initialised" },
      { status: d.reason === "insufficient" ? 400 : 409 },
    );
  }
  const id = newRoundId();
  const round: StoredRound & { wageredCents: number } = {
    game: game.slug,
    username,
    betCents: toCents(bet),
    wageredCents: toCents(bet) + toCents(extraDebit),
    state: step.state,
    createdAt: Date.now(),
  };
  await saveRound(id, round);
  return NextResponse.json({ roundId: id, done: false, publicView: step.publicView, actions: step.actions, balance: d.balance });
}

async function handleAct(username: string, body: Record<string, unknown>) {
  const roundId = typeof body.roundId === "string" ? body.roundId : null;
  const action = typeof body.action === "string" ? body.action : null;
  if (!roundId || !action) return NextResponse.json({ error: "Bad request" }, { status: 400 });

  const round = (await loadRound(roundId)) as (StoredRound & { wageredCents?: number }) | null;
  if (!round || round.username !== username) {
    return NextResponse.json({ error: "Round not found" }, { status: 404 });
  }
  const game = getRoundGame(round.game);
  if (!game) return NextResponse.json({ error: "Unknown game" }, { status: 400 });

  let step;
  try {
    step = game.act(round.state, round.betCents / 100, action, body.payload, rng);
  } catch (e) {
    if (e instanceof GameError) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }

  if (!Number.isFinite(step.payout) || step.payout < 0) {
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }

  let wageredCents = round.wageredCents ?? round.betCents;
  let returnedCents = round.returnedCents ?? 0;

  // A raise (double / war / ante raise / a craps bet placement) debits extra
  // before the round advances.
  const extraDebit = Math.max(0, step.debit ?? 0);
  if (extraDebit > 0) {
    const d = await debit(username, toCents(extraDebit));
    if (!d.ok) return NextResponse.json({ error: "Insufficient balance" }, { status: 400 });
    wageredCents += toCents(extraDebit);
  }

  if (step.done) {
    const { settled, balance } = await settleRound(roundId, username, toCents(step.payout));
    if (!settled) return NextResponse.json({ error: "Round already settled" }, { status: 409 });
    await recordStats(username, balance, {
      // Include any chips already credited mid-round (e.g. craps per-roll wins).
      wagered: wageredCents / 100,
      returned: (returnedCents + toCents(step.payout)) / 100,
      biggestWin: step.payout,
    });
    return NextResponse.json({ done: true, publicView: step.publicView, balance, payout: step.payout });
  }

  // A mid-round CREDIT (craps roll win / place-bet take-down) pays the
  // authoritative balance atomically without ending the round.
  const midCredit = Math.max(0, step.credit ?? 0);
  if (midCredit > 0) {
    await credit(username, toCents(midCredit));
    returnedCents += toCents(midCredit);
  }

  await saveRound(roundId, { ...round, state: step.state, wageredCents, returnedCents });
  const balance = await getBalance(username);
  return NextResponse.json({ roundId, done: false, publicView: step.publicView, actions: step.actions, balance });
}
