"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useWallet } from "@/lib/wallet";
import { type Card, makeShoe, rankValue } from "@/lib/cards";
import { formatChips, formatDelta } from "@/lib/format";
import { sfx } from "@/lib/sound";
import { Button } from "@/components/ui/Button";
import { PlayingCard } from "@/components/PlayingCard";
import { BetControls } from "@/components/BetControls";
import { CountingNumber } from "@/components/CountingNumber";
import { CollapsiblePanel } from "@/components/CollapsiblePanel";
import { Celebration } from "@/components/Celebration";
import { sleep } from "@/lib/async";

// ---------------------------------------------------------------------------
// Casino War — single bet, highest card wins. On a tie: surrender for half, or
// GO TO WAR (match the bet, burn 3, deal one more each).
//
//  Money model (gross via win(), which already includes the returned stake):
//   - Straight win  : win(stake * 2)                        net +stake
//   - Straight loss : credit nothing                        net -stake
//   - Surrender     : win(stake / 2)                        net -stake/2
//   - War win        : original PUSHES + war bet pays 1:1
//                      win(stake)  +  win(warStake * 2)      net +stake
//   - War TIE bonus : war bet PUSHES + original pays 2:1 bonus
//                      win(warStake) + win(stake * 3)        net +2*stake
//   - War loss       : lose BOTH the original and the war bet, credit nothing
//                                                            net -2*stake
// ---------------------------------------------------------------------------

const ACCENT = "#c0392b";
const ACCENT_LIGHT = "#e74c3c";
const MIN_BET = 5;
const CHIPS = [5, 25, 100, 500, 1000];

type Phase = "betting" | "dealing" | "tie" | "war" | "resolved";

type Outcome =
  | "win"
  | "lose"
  | "surrender"
  | "war-win"
  | "war-tie"
  | "war-lose";

interface ResultInfo {
  outcome: Outcome;
  /** Net change to the balance for the whole round (negative = loss). */
  net: number;
  label: string;
  good: boolean;
}

export default function CasinoWar() {
  const wallet = useWallet();
  const { balance, bet: placeBet, win, ready } = wallet;

  const [bet, setBet] = useState(25);
  const [phase, setPhase] = useState<Phase>("betting");

  const [playerCard, setPlayerCard] = useState<Card | null>(null);
  const [dealerCard, setDealerCard] = useState<Card | null>(null);
  const [playerWar, setPlayerWar] = useState<Card | null>(null);
  const [dealerWar, setDealerWar] = useState<Card | null>(null);
  const [burned, setBurned] = useState<Card[]>([]);

  const [playerDown, setPlayerDown] = useState(true);
  const [dealerDown, setDealerDown] = useState(true);
  const [playerWarDown, setPlayerWarDown] = useState(true);
  const [dealerWarDown, setDealerWarDown] = useState(true);

  const [warStake, setWarStake] = useState(0);
  const [result, setResult] = useState<ResultInfo | null>(null);
  const [showWarBanner, setShowWarBanner] = useState(false);
  const [burst, setBurst] = useState(0);

  // The shoe persists across rounds; reshuffle when it runs low.
  const shoeRef = useRef<Card[]>([]);
  const ensureShoe = useCallback((need: number) => {
    if (shoeRef.current.length < need) shoeRef.current = makeShoe(6);
  }, []);
  const draw = useCallback((): Card => {
    ensureShoe(1);
    const card = shoeRef.current.pop();
    // ensureShoe guarantees at least 1 card; this branch is a safety guard.
    if (!card) {
      shoeRef.current = makeShoe(6);
      return shoeRef.current.pop()!;
    }
    return card;
  }, [ensureShoe]);

  // Ref-based mutex: prevents double-invocation of async handlers on rapid clicks.
  const resolvingRef = useRef(false);

  // Tracks whether the component is still mounted, so async handlers can bail
  // out of state updates after an await once the component has unmounted.
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  // Keep bet within affordable bounds while idle.
  useEffect(() => {
    if (phase !== "betting") return;
    if (bet > balance) setBet(Math.max(0, balance));
  }, [balance, bet, phase]);

  // busy covers any async phase so controls are locked while resolving
  const busy = phase === "dealing" || phase === "war";
  const canBet = phase === "betting";
  const affordable = bet >= MIN_BET && bet <= balance;

  const resetTable = useCallback(() => {
    setPlayerCard(null);
    setDealerCard(null);
    setPlayerWar(null);
    setDealerWar(null);
    setBurned([]);
    setPlayerDown(true);
    setDealerDown(true);
    setPlayerWarDown(true);
    setDealerWarDown(true);
    setWarStake(0);
    setResult(null);
    setShowWarBanner(false);
  }, []);

  const finish = useCallback(
    (info: ResultInfo) => {
      setResult(info);
      setPhase("resolved");
      if (info.outcome === "war-win" || info.outcome === "war-tie") {
        sfx.jackpot();
        setBurst((b) => b + 1);
      } else if (info.good) {
        sfx.win();
        setBurst((b) => b + 1);
      } else if (info.outcome === "surrender") {
        sfx.thud();
      } else {
        sfx.lose();
      }
    },
    [],
  );

  // ---- The opening deal --------------------------------------------------
  const deal = useCallback(async () => {
    if (!canBet || !affordable) return;
    if (resolvingRef.current) return; // guard against rapid-click race
    resolvingRef.current = true;
    if (!placeBet(bet)) { resolvingRef.current = false; return; } // unaffordable — abort
    resetTable();
    setPhase("dealing");

    const p = draw();
    const d = draw();

    // Player card slides in face down then flips.
    setPlayerCard(p);
    sfx.card();
    await sleep(280);
    if (!mountedRef.current) return;
    setPlayerDown(false);
    sfx.card();
    await sleep(360);
    if (!mountedRef.current) return;

    setDealerCard(d);
    sfx.card();
    await sleep(280);
    if (!mountedRef.current) return;
    setDealerDown(false);
    sfx.card();
    await sleep(420);

    const pv = rankValue(p.rank);
    const dv = rankValue(d.rank);

    if (pv > dv) {
      // Settle money first so the win lands even if we have unmounted.
      win(bet * 2);
      if (!mountedRef.current) return;
      finish({ outcome: "win", net: bet, label: "You Win!", good: true });
    } else if (pv < dv) {
      if (!mountedRef.current) return;
      finish({ outcome: "lose", net: -bet, label: "Dealer Wins", good: false });
    } else {
      // TIE — player must choose surrender or war.
      if (!mountedRef.current) return;
      sfx.thud();
      setPhase("tie");
    }
    // Release the mutex regardless of outcome (tie path unlocks for war/surrender).
    resolvingRef.current = false;
  }, [canBet, affordable, placeBet, bet, resetTable, draw, win, finish]);

  // ---- Surrender ---------------------------------------------------------
  const surrender = useCallback(() => {
    if (phase !== "tie") return;
    if (resolvingRef.current) return; // guard against rapid-click
    resolvingRef.current = true;
    const refund = bet / 2; // forfeit exactly half the bet
    if (refund > 0) win(refund);
    finish({
      outcome: "surrender",
      net: refund - bet,
      label: "Surrendered",
      good: false,
    });
    resolvingRef.current = false;
  }, [phase, bet, win, finish]);

  // ---- Go to War ---------------------------------------------------------
  const goToWar = useCallback(async () => {
    if (phase !== "tie") return;
    if (resolvingRef.current) return; // guard against rapid-click race
    resolvingRef.current = true;
    if (!placeBet(bet)) { resolvingRef.current = false; return; } // can't afford the raise
    setWarStake(bet);
    setPhase("war");

    // Dramatic banner.
    setShowWarBanner(true);
    sfx.jackpot();
    await sleep(950);
    if (!mountedRef.current) return;
    setShowWarBanner(false);

    // Burn three cards.
    const b: Card[] = [];
    for (let i = 0; i < 3; i++) {
      const c = draw();
      b.push(c);
      setBurned([...b]);
      sfx.card();
      await sleep(180);
      if (!mountedRef.current) return;
    }
    await sleep(180);
    if (!mountedRef.current) return;

    // Deal one more to each.
    const pw = draw();
    const dw = draw();

    setPlayerWar(pw);
    sfx.card();
    await sleep(300);
    if (!mountedRef.current) return;
    setPlayerWarDown(false);
    sfx.card();
    await sleep(360);
    if (!mountedRef.current) return;

    setDealerWar(dw);
    sfx.card();
    await sleep(300);
    if (!mountedRef.current) return;
    setDealerWarDown(false);
    sfx.card();
    await sleep(460);
    if (!mountedRef.current) return;

    const pv = rankValue(pw.rank);
    const dv = rankValue(dw.rank);

    if (pv > dv) {
      // War win: original pushes, war bet pays 1:1.
      win(bet); // push original stake
      win(bet * 2); // war bet: stake back + 1:1 profit
      finish({ outcome: "war-win", net: bet, label: "War Won!", good: true });
    } else if (pv === dv) {
      // Tie on the war: war bet pushes, original pays a 2:1 bonus.
      win(bet); // push war stake
      win(bet * 3); // 2:1 bonus on original (stake + 2× profit)
      finish({
        outcome: "war-tie",
        net: bet * 2,
        label: "War Tie — 2:1 Bonus!",
        good: true,
      });
    } else {
      // Lose both stakes.
      finish({
        outcome: "war-lose",
        net: -(bet * 2),
        label: "War Lost",
        good: false,
      });
    }
    resolvingRef.current = false;
  }, [phase, bet, placeBet, draw, win, finish]);

  const newRound = useCallback(() => {
    resolvingRef.current = false; // ensure mutex is clear for the next round
    resetTable();
    setPhase("betting");
  }, [resetTable]);

  // ---- Derived display ---------------------------------------------------
  const totalAtRisk = bet + warStake;
  const pv = playerCard ? rankValue(playerCard.rank) : 0;
  const dv = dealerCard ? rankValue(dealerCard.rank) : 0;
  const pwv = playerWar ? rankValue(playerWar.rank) : 0;
  const dwv = dealerWar ? rankValue(dealerWar.rank) : 0;

  const inWar = phase === "war" || (phase === "resolved" && warStake > 0);
  const compareCards = inWar ? [pwv, dwv] : [pv, dv];
  const showdownReady =
    phase === "resolved" || (phase === "war" && !!playerWar && !!dealerWar);

  const playerHighlight =
    !!result && result.good && (inWar ? !playerWarDown : !playerDown);
  const dealerHighlight =
    !!result && !result.good && result.outcome !== "surrender";

  // ---- Celebration trigger -----------------------------------------------
  // Fire only on the dramatic moments: winning a post-tie war (incl. the 2:1
  // war-tie bonus), or any win whose gross return is >= ~3x the total wagered.
  // Ordinary 1:1 wins, surrenders, and losses stay quiet.
  const wagered = bet + warStake;
  const payout = result && result.good ? result.net + wagered : 0;
  const isWarWin =
    result?.outcome === "war-win" || result?.outcome === "war-tie";
  const celebrate =
    !!result && result.good && (isWarWin || (wagered > 0 && payout >= wagered * 3));
  const celebrationTier = isWarWin ? "big" : "win";

  return (
    <div className="mx-auto w-full max-w-4xl select-none px-2 py-2 sm:px-4 sm:py-3">
      {/* ===== Felt surface ===== */}
      <div
        className="felt relative overflow-hidden rounded-3xl border p-3 sm:p-7 [@media(max-height:600px)]:p-3"
        style={{
          borderColor: "rgba(192,57,43,0.45)",
          boxShadow:
            "0 20px 60px rgba(0,0,0,0.55), inset 0 0 90px rgba(0,0,0,0.4)",
        }}
      >
        {/* accent glow corners */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-60"
          style={{
            background: `radial-gradient(60% 40% at 50% -5%, ${ACCENT}33, transparent 70%)`,
          }}
        />

        {/* Header */}
        <div className="relative z-10 mb-2 flex items-center justify-between gap-3 sm:mb-4 [@media(max-height:600px)]:mb-2">
          <div className="flex items-center gap-2">
            <span className="text-2xl">⚔️</span>
            <div>
              <h2
                className="font-display text-xl font-bold leading-none sm:text-2xl"
                style={{ color: ACCENT_LIGHT, textShadow: `0 0 18px ${ACCENT}88` }}
              >
                Casino War
              </h2>
              <p className="text-[10px] uppercase tracking-[0.25em] text-white/40">
                High card takes all
              </p>
            </div>
          </div>
          <div className="rounded-xl border border-white/10 bg-black/40 px-3 py-1.5 text-right">
            <div className="text-[9px] uppercase tracking-widest text-white/40">
              Balance
            </div>
            <div className="gold-text text-base font-bold tabular-nums sm:text-lg">
              {ready ? <CountingNumber value={balance} /> : "—"}
            </div>
          </div>
        </div>

        {/* ===== Battle table ===== */}
        <div className="relative z-10 grid grid-cols-2 gap-2 sm:gap-6 [@media(max-height:600px)]:gap-2">
          {/* Player side */}
          <Seat
            title="You"
            color={ACCENT_LIGHT}
            main={playerCard}
            mainDown={playerDown}
            war={playerWar}
            warDown={playerWarDown}
            highlight={playerHighlight}
            value={inWar ? pwv : pv}
            showValue={showdownReady}
            align="start"
          />
          {/* Dealer side */}
          <Seat
            title="Dealer"
            color="#cbd5e1"
            main={dealerCard}
            mainDown={dealerDown}
            war={dealerWar}
            warDown={dealerWarDown}
            highlight={dealerHighlight}
            value={inWar ? dwv : dv}
            showValue={showdownReady}
            align="end"
          />

          {/* center VS / burn pile */}
          <div className="pointer-events-none absolute inset-x-0 top-[64px] flex flex-col items-center sm:top-[80px]">
            <motion.div
              animate={
                showdownReady
                  ? { scale: [1, 1.25, 1], opacity: 1 }
                  : { scale: 1, opacity: 0.85 }
              }
              transition={{ duration: 0.5 }}
              className="font-display text-lg font-black"
              style={{ color: "#fff", textShadow: "0 2px 10px rgba(0,0,0,0.7)" }}
            >
              {showdownReady
                ? compareCards[0] === compareCards[1]
                  ? "="
                  : compareCards[0] > compareCards[1]
                    ? "◀"
                    : "▶"
                : "VS"}
            </motion.div>
          </div>
        </div>

        {/* Burn pile (during/after war) */}
        <AnimatePresence>
          {burned.length > 0 && (
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="relative z-10 mt-4 flex items-center justify-center gap-2"
            >
              <span className="text-[10px] uppercase tracking-widest text-white/40">
                Burned
              </span>
              <div className="flex">
                {burned.map((c, i) => (
                  <motion.div
                    key={c.id}
                    initial={{ x: -20, opacity: 0, rotate: -8 }}
                    animate={{ x: 0, opacity: 1, rotate: (i - 1) * 6 }}
                    style={{ marginLeft: i === 0 ? 0 : -18 }}
                  >
                    <PlayingCard card={c} faceDown size="xs" />
                  </motion.div>
                ))}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* ===== Result banner ===== */}
        <div className="relative z-10 mt-3 min-h-[48px] sm:mt-5 sm:min-h-[64px] [@media(max-height:600px)]:mt-2 [@media(max-height:600px)]:min-h-[44px]">
          <AnimatePresence mode="wait">
            {phase === "tie" && (
              <motion.div
                key="tie-prompt"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                className="grid place-items-center"
              >
                <div
                  className="rounded-xl border px-4 py-2 text-center"
                  style={{
                    borderColor: `${ACCENT}66`,
                    background: `${ACCENT}1a`,
                  }}
                >
                  <div
                    className="font-display text-lg font-black"
                    style={{ color: ACCENT_LIGHT }}
                  >
                    IT&apos;S A TIE
                  </div>
                  <div className="text-xs text-white/70">
                    Surrender for half, or match {formatChips(bet)} and go to war
                  </div>
                </div>
              </motion.div>
            )}

            {result && (
              <motion.div
                key={result.outcome}
                data-testid="round-result"
                initial={{ opacity: 0, scale: 0.85, y: 10 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.9 }}
                transition={{ type: "spring", stiffness: 320, damping: 18 }}
                className="grid place-items-center text-center"
              >
                <div
                  className="font-display text-2xl font-black tracking-wide sm:text-3xl"
                  style={{
                    color: result.good ? "#f5d060" : "#cbd5e1",
                    textShadow: result.good
                      ? "0 0 22px rgba(245,208,96,0.7)"
                      : "0 2px 8px rgba(0,0,0,0.6)",
                  }}
                >
                  {result.label}
                </div>
                <div
                  className="mt-0.5 text-sm font-bold tabular-nums"
                  style={{ color: result.net >= 0 ? "#7CFC8A" : ACCENT_LIGHT }}
                >
                  {formatDelta(result.net)} chips
                </div>
              </motion.div>
            )}

            {phase === "betting" && !result && (
              <motion.div
                key="idle"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="grid place-items-center text-center text-sm text-white/45"
              >
                Place your bet and deal the cards.
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* ===== Action area ===== */}
        <div className="relative z-10 mt-2 sm:mt-4 [@media(max-height:600px)]:mt-2">
          {phase === "tie" ? (
            <div className="flex flex-wrap items-center justify-center gap-3">
              <Button
                variant="ghost"
                size="lg"
                data-testid="surrender-btn"
                onClick={surrender}
              >
                🏳️ Surrender (−{formatChips(bet / 2)})
              </Button>
              <Button
                variant="danger"
                size="lg"
                data-testid="war-btn"
                disabled={bet > balance}
                onClick={goToWar}
              >
                ⚔️ Go to War (+{formatChips(bet)})
              </Button>
            </div>
          ) : phase === "resolved" ? (
            <div className="flex items-center justify-center">
              <Button
                variant="gold"
                size="lg"
                data-testid="play-btn"
                onClick={newRound}
              >
                Deal Again
              </Button>
            </div>
          ) : (
            <div className="flex flex-col items-stretch gap-3">
              <BetControls
                bet={bet}
                setBet={setBet}
                balance={balance}
                min={MIN_BET}
                chips={CHIPS}
                disabled={!canBet}
              />
              <div className="flex items-center justify-center">
                <Button
                  variant="gold"
                  size="lg"
                  data-testid="play-btn"
                  disabled={busy || !affordable}
                  onClick={deal}
                >
                  {phase === "war" ? "War…" : busy ? "Dealing…" : `Deal — ${formatChips(bet)}`}
                </Button>
              </div>
            </div>
          )}
        </div>

        {/* at-risk readout while in a hand */}
        <AnimatePresence>
          {(phase === "tie" || phase === "war" || phase === "dealing") && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="relative z-10 mt-3 text-center text-[11px] uppercase tracking-widest text-white/40"
            >
              At risk:{" "}
              <span className="font-bold text-white/70">
                {formatChips(totalAtRisk)}
              </span>
              {warStake > 0 && (
                <span className="ml-1 text-white/40">
                  ({formatChips(bet)} + {formatChips(warStake)} war)
                </span>
              )}
            </motion.div>
          )}
        </AnimatePresence>

        {/* ===== WAR! banner overlay ===== */}
        <AnimatePresence>
          {showWarBanner && (
            <motion.div
              key="war-banner"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 z-30 grid place-items-center"
              style={{ background: "rgba(0,0,0,0.45)", backdropFilter: "blur(2px)" }}
            >
              <motion.div
                initial={{ scale: 0.2, rotate: -12, opacity: 0 }}
                animate={{
                  scale: [0.2, 1.25, 1],
                  rotate: [-12, 4, 0],
                  opacity: 1,
                }}
                transition={{ duration: 0.7, ease: [0.2, 0.8, 0.2, 1] }}
                className="font-display text-6xl font-black tracking-tight sm:text-8xl"
                style={{
                  color: ACCENT_LIGHT,
                  textShadow: `0 0 30px ${ACCENT}, 0 0 60px ${ACCENT}, 0 4px 0 #000`,
                  WebkitTextStroke: "2px rgba(0,0,0,0.4)",
                }}
              >
                WAR!
              </motion.div>
              {/* shockwave rings */}
              {[0, 1, 2].map((i) => (
                <motion.span
                  key={i}
                  className="absolute rounded-full"
                  initial={{ width: 40, height: 40, opacity: 0.6 }}
                  animate={{ width: 520, height: 520, opacity: 0 }}
                  transition={{ duration: 0.9, delay: i * 0.12, ease: "easeOut" }}
                  style={{ border: `3px solid ${ACCENT_LIGHT}` }}
                />
              ))}
            </motion.div>
          )}
        </AnimatePresence>

        {/* ===== Win burst ===== */}
        <AnimatePresence>
          {burst > 0 && result?.good && (
            <WinBurst key={burst} accent={ACCENT_LIGHT} />
          )}
        </AnimatePresence>

        {/* ===== Big-moment celebration (war wins / 3x+ returns only) ===== */}
        <Celebration
          show={celebrate}
          seed={payout}
          tier={celebrationTier}
          colors={["#c0392b", "#ffd24a", "#22e1ff", "#ffffff"]}
        />
      </div>

      {/* ===== Paytable ===== */}
      <div className="mt-2 sm:mt-4">
        <CollapsiblePanel
          title="Paytable & Rules"
          accent={ACCENT_LIGHT}
          summary={<>War tie 2:1</>}
        >
          <div className="grid grid-cols-1 gap-1.5 text-xs sm:grid-cols-2">
            <PayRow label="Higher card wins" value="1 : 1" />
            <PayRow label="Tie → War win" value="Even (raise) + push" />
            <PayRow label="Tie → War tie" value="2 : 1 bonus" hot accent={ACCENT_LIGHT} />
            <PayRow label="Tie → Surrender" value="Lose half" muted />
            <PayRow label="Tie → War loss" value="Lose both bets" muted />
            <PayRow label="Aces are high" value="A ▸ K ▸ … ▸ 2" />
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-white/40">
            One card to you, one to the dealer. Highest rank wins even money. On a
            tie you may surrender half your bet, or go to war: match your bet, burn
            three cards, and draw again. Win the war and your raise pays 1:1 while
            the original bet pushes. Tie the war for a 2:1 bonus. Lose and both
            bets are gone. Played from a six-deck shoe.
          </p>
        </CollapsiblePanel>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

interface SeatProps {
  title: string;
  color: string;
  main: Card | null;
  mainDown: boolean;
  war: Card | null;
  warDown: boolean;
  highlight: boolean;
  value: number;
  showValue: boolean;
  align: "start" | "end";
}

function Seat({
  title,
  color,
  main,
  mainDown,
  war,
  warDown,
  highlight,
  value,
  showValue,
  align,
}: SeatProps) {
  const fromX = align === "start" ? -120 : 120;
  return (
    <div
      className={`flex flex-col gap-2 ${
        align === "end" ? "items-end" : "items-start"
      }`}
    >
      <div
        className="font-display text-xs font-bold uppercase tracking-[0.2em]"
        style={{ color }}
      >
        {title}
      </div>

      <div
        className="flex min-h-[100px] items-center gap-2 sm:min-h-[126px] [@media(max-height:600px)]:min-h-[88px]"
        style={{ flexDirection: align === "end" ? "row-reverse" : "row" }}
      >
        <AnimatePresence>
          {main && (
            <motion.div
              key={main.id}
              initial={{ x: fromX, y: -60, opacity: 0, rotate: align === "start" ? -18 : 18 }}
              animate={{ x: 0, y: 0, opacity: 1, rotate: 0 }}
              transition={{ type: "spring", stiffness: 260, damping: 22 }}
            >
              <PlayingCard
                card={main}
                faceDown={mainDown}
                size="lg"
                highlight={highlight && !war}
              />
            </motion.div>
          )}
        </AnimatePresence>

        <AnimatePresence>
          {war && (
            <motion.div
              key={war.id}
              initial={{ x: fromX, y: -50, opacity: 0, rotate: align === "start" ? -16 : 16 }}
              animate={{ x: 0, y: 0, opacity: 1, rotate: 0 }}
              transition={{ type: "spring", stiffness: 260, damping: 22 }}
            >
              <PlayingCard
                card={war}
                faceDown={warDown}
                size="lg"
                highlight={highlight}
              />
            </motion.div>
          )}
        </AnimatePresence>

        {!main && (
          <div
            className="grid place-items-center rounded-xl border border-dashed border-white/15 text-white/20"
            style={{ width: 88, height: 123 }}
          >
            <span className="text-2xl">🂠</span>
          </div>
        )}
      </div>

      <AnimatePresence>
        {showValue && (war ? war : main) && (
          <motion.div
            initial={{ opacity: 0, scale: 0.6 }}
            animate={{ opacity: 1, scale: 1 }}
            className="rounded-full border border-white/10 bg-black/40 px-2.5 py-0.5 text-[11px] font-bold tabular-nums"
            style={{ color }}
          >
            {rankName(value)} ({value})
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function rankName(v: number): string {
  switch (v) {
    case 14:
      return "Ace";
    case 13:
      return "King";
    case 12:
      return "Queen";
    case 11:
      return "Jack";
    default:
      return String(v);
  }
}

function PayRow({
  label,
  value,
  hot,
  muted,
  accent,
}: {
  label: string;
  value: string;
  hot?: boolean;
  muted?: boolean;
  accent?: string;
}) {
  return (
    <div
      className="flex items-center justify-between rounded-lg border border-white/5 bg-black/25 px-3 py-1.5"
      style={hot && accent ? { borderColor: `${accent}55`, background: `${accent}14` } : undefined}
    >
      <span className={muted ? "text-white/45" : "text-white/75"}>{label}</span>
      <span
        className="font-bold tabular-nums"
        style={{ color: hot && accent ? accent : muted ? "#9aa3af" : "#f5d060" }}
      >
        {value}
      </span>
    </div>
  );
}

// Confetti-ish win burst.
function WinBurst({ accent }: { accent: string }) {
  const bits = useMemo(
    () =>
      Array.from({ length: 22 }).map((_, i) => ({
        id: i,
        angle: (i / 22) * Math.PI * 2,
        dist: 120 + Math.random() * 160,
        size: 6 + Math.random() * 8,
        color: i % 3 === 0 ? "#f5d060" : i % 3 === 1 ? accent : "#ffffff",
        delay: Math.random() * 0.08,
      })),
    [accent],
  );
  return (
    <div className="pointer-events-none absolute inset-0 z-20 grid place-items-center">
      {bits.map((b) => (
        <motion.span
          key={b.id}
          className="absolute rounded-sm"
          initial={{ x: 0, y: 0, opacity: 1, scale: 1 }}
          animate={{
            x: Math.cos(b.angle) * b.dist,
            y: Math.sin(b.angle) * b.dist,
            opacity: 0,
            scale: 0.4,
            rotate: 360,
          }}
          transition={{ duration: 1, delay: b.delay, ease: "easeOut" }}
          style={{ width: b.size, height: b.size, background: b.color }}
        />
      ))}
    </div>
  );
}
