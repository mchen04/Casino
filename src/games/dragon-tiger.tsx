"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useWallet } from "@/lib/wallet";
import { makeShoe, type Card, type Rank, SUIT_SYMBOL } from "@/lib/cards";
import { sfx } from "@/lib/sound";
import { formatChips, formatDelta } from "@/lib/format";
import { CountingNumber } from "@/components/CountingNumber";
import { PlayingCard } from "@/components/PlayingCard";
import { Button } from "@/components/ui/Button";
import { Chip } from "@/components/ui/Chip";
import { CollapsiblePanel } from "@/components/CollapsiblePanel";
import { Celebration } from "@/components/Celebration";

/* ----------------------------------------------------------------------------
 * Dragon Tiger — fast Sino-baccarat.
 * One card to Dragon, one to Tiger. Ace is LOW (=1); K is HIGH.
 * Higher card wins its side 1:1 -> win(bet*2).
 * Tie (equal rank) pays 8:1 -> win(bet*9); side bets lose HALF -> win(bet/2).
 * Suit Tie (equal rank AND suit) pays 50:1 -> win(bet*51).
 * Tie / Suit-Tie bets lose entirely on a non-tie.
 * ------------------------------------------------------------------------- */

type BetKey = "dragon" | "tiger" | "tie" | "suitTie";
type Side = "dragon" | "tiger";
type Phase = "betting" | "dealing" | "revealing" | "resolved";

interface Outcome {
  winner: Side | "tie";
  isTie: boolean;
  isSuitTie: boolean;
}

/** Sino-baccarat rank value: Ace LOW (=1) .. K HIGH (=13). */
const DT_VALUE: Record<Rank, number> = {
  A: 1,
  "2": 2,
  "3": 3,
  "4": 4,
  "5": 5,
  "6": 6,
  "7": 7,
  "8": 8,
  "9": 9,
  "10": 10,
  J: 11,
  Q: 12,
  K: 13,
};

const CHIP_DENOMS = [5, 25, 100, 500, 1000];
const MIN_BET = 5;

const PAYTABLE: { key: BetKey; label: string; pays: string; note: string }[] = [
  { key: "dragon", label: "Dragon", pays: "1 : 1", note: "Higher card wins" },
  { key: "tiger", label: "Tiger", pays: "1 : 1", note: "Higher card wins" },
  { key: "tie", label: "Tie", pays: "8 : 1", note: "Equal rank" },
  { key: "suitTie", label: "Suit Tie", pays: "50 : 1", note: "Equal rank + suit" },
];

const DRAGON = "#f39c12"; // accent
const DRAGON_DEEP = "#b8410c";
const TIGER = "#22e1ff";
const TIGER_DEEP = "#0e7490";
const TIE_GOLD = "#f5d060";

function rankLabel(card: Card): string {
  return `${card.rank}${SUIT_SYMBOL[card.suit]}`;
}


export default function DragonTiger() {
  const wallet = useWallet();
  // Stable wallet function refs (these never change identity — zero-dep useCallbacks).
  const walletBet = wallet.bet;
  const walletWin = wallet.win;

  // Bets keyed by spot. Multiple spots can be active in one round.
  const [bets, setBets] = useState<Record<BetKey, number>>({
    dragon: 0,
    tiger: 0,
    tie: 0,
    suitTie: 0,
  });
  const [chip, setChip] = useState(25);
  const [phase, setPhase] = useState<Phase>("betting");

  const [dragonCard, setDragonCard] = useState<Card | null>(null);
  const [tigerCard, setTigerCard] = useState<Card | null>(null);
  const [dragonDown, setDragonDown] = useState(true);
  const [tigerDown, setTigerDown] = useState(true);

  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [resultText, setResultText] = useState("");
  const [netDelta, setNetDelta] = useState(0);
  const [lastStake, setLastStake] = useState(0);
  const [showBurst, setShowBurst] = useState(false);

  // Streak board of recent winners (most recent first).
  const [history, setHistory] = useState<Outcome[]>([]);

  // A persistent multi-deck shoe; reshuffle when running low.
  const shoe = useRef<Card[]>([]);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  // Guard against rapid double-clicks before React re-renders.
  const isDealing = useRef(false);

  useEffect(() => {
    shoe.current = makeShoe(8);
    return () => {
      timers.current.forEach(clearTimeout);
    };
  }, []);

  const after = useCallback((ms: number, fn: () => void) => {
    const id = setTimeout(fn, ms);
    timers.current.push(id);
  }, []);

  const draw = useCallback((): Card => {
    if (shoe.current.length < 12) shoe.current = makeShoe(8);
    return shoe.current.pop() as Card;
  }, []);

  const totalStake = bets.dragon + bets.tiger + bets.tie + bets.suitTie;
  const canAfford = totalStake > 0 && totalStake <= wallet.balance;
  const isBetting = phase === "betting";

  const addBet = useCallback(
    (key: BetKey) => {
      if (!isBetting) return;
      const next = totalStake + chip;
      if (next > wallet.balance) {
        // Cap at balance: add only what remains.
        const room = wallet.balance - totalStake;
        if (room <= 0) {
          sfx.lose();
          return;
        }
        sfx.chip();
        setBets((b) => ({ ...b, [key]: b[key] + room }));
        return;
      }
      sfx.chip();
      setBets((b) => ({ ...b, [key]: b[key] + chip }));
    },
    [isBetting, totalStake, chip, wallet.balance],
  );

  const clearBets = useCallback(() => {
    if (!isBetting) return;
    sfx.click();
    setBets({ dragon: 0, tiger: 0, tie: 0, suitTie: 0 });
  }, [isBetting]);

  const resolve = useCallback(
    (d: Card, t: Card, stake: number, placed: Record<BetKey, number>) => {
      const dv = DT_VALUE[d.rank];
      const tv = DT_VALUE[t.rank];
      const isTie = dv === tv;
      const isSuitTie = isTie && d.suit === t.suit;
      const winner: Side | "tie" = isTie ? "tie" : dv > tv ? "dragon" : "tiger";
      const result: Outcome = { winner, isTie, isSuitTie };

      // Compute gross returned to the wallet across all spots.
      let gross = 0;
      if (isTie) {
        // Side bets lose HALF -> half the stake is returned.
        gross += Math.floor(placed.dragon / 2);
        gross += Math.floor(placed.tiger / 2);
        gross += placed.tie * 9; // 8:1 + stake
        if (isSuitTie) gross += placed.suitTie * 51; // 50:1 + stake
      } else {
        // Winning side pays 1:1 (stake + equal profit).
        gross += placed[winner] * 2;
        // tie & suitTie bets lose entirely; losing side gets nothing.
      }

      const net = gross - stake;
      if (gross > 0) walletWin(gross);

      setOutcome(result);
      setNetDelta(net);
      setHistory((h) => [result, ...h].slice(0, 24));

      // Headline result text.
      let txt: string;
      if (isSuitTie) txt = `SUIT TIE — ${rankLabel(d)}`;
      else if (isTie) txt = `TIE — ${d.rank} = ${t.rank}`;
      else txt = `${winner === "dragon" ? "DRAGON" : "TIGER"} WINS`;
      if (net > 0) txt += `  ·  +${formatChips(net)}`;
      else if (net < 0) txt += `  ·  ${formatChips(net)}`;
      else txt += `  ·  Push`;
      setResultText(txt);

      // Feedback: did the player win anything net-positive?
      if (net > 0) {
        if (isSuitTie && placed.suitTie > 0) sfx.jackpot();
        else if (net >= stake * 4) sfx.jackpot();
        else sfx.win();
        setShowBurst(true);
        after(1400, () => setShowBurst(false));
      } else if (net < 0) {
        sfx.lose();
      } else {
        sfx.thud();
      }

      isDealing.current = false;
      setPhase("resolved");
    },
    [walletWin, after],
  );

  const deal = useCallback(() => {
    // Guard against rapid double-clicks before React can re-render and update phase.
    if (!isBetting || !canAfford || isDealing.current) return;
    const stake = totalStake;
    if (!walletBet(stake)) {
      sfx.lose();
      return;
    }
    isDealing.current = true;
    const placed = { ...bets };
    setLastStake(stake);
    setNetDelta(0);
    setOutcome(null);
    setResultText("");
    setShowBurst(false);

    const d = draw();
    const t = draw();
    setDragonCard(d);
    setTigerCard(t);
    setDragonDown(true);
    setTigerDown(true);
    setPhase("dealing");
    sfx.card();

    // Cards slide in, then flip simultaneously.
    after(420, () => sfx.card());
    after(620, () => {
      setPhase("revealing");
      sfx.card();
      setDragonDown(false);
      setTigerDown(false);
    });
    // After the flip animation completes, resolve.
    after(1180, () => resolve(d, t, stake, placed));
  }, [isBetting, canAfford, totalStake, walletBet, bets, draw, after, resolve]);

  const newRound = useCallback(() => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
    isDealing.current = false;
    sfx.click();
    setPhase("betting");
    setDragonCard(null);
    setTigerCard(null);
    setDragonDown(true);
    setTigerDown(true);
    setOutcome(null);
    setResultText("");
    setShowBurst(false);
    setNetDelta(0);
    // Keep the same bets so the player can quickly re-bet (rebet behaviour),
    // but clamp to current balance.
    setBets((b) => {
      const tot = b.dragon + b.tiger + b.tie + b.suitTie;
      if (tot <= wallet.balance) return b;
      return { dragon: 0, tiger: 0, tie: 0, suitTie: 0 };
    });
  }, [wallet.balance]);

  // Wins/losses streak counts for the board header.
  const streak = useMemo(() => {
    let d = 0,
      t = 0,
      tie = 0;
    for (const o of history) {
      if (o.winner === "dragon") d++;
      else if (o.winner === "tiger") t++;
      else tie++;
    }
    return { d, t, tie };
  }, [history]);

  const revealed = phase === "revealing" || phase === "resolved";
  const winnerSide = outcome?.winner;

  // Celebration gating (visual only): fire on a notable win — a winning Tie
  // bet (high multiplier) or a total return of >= ~4x the wagered stake.
  const grossReturn = netDelta + lastStake; // net = gross - stake
  const tieWin = phase === "resolved" && netDelta > 0 && (outcome?.isTie ?? false);
  const bigWin = phase === "resolved" && lastStake > 0 && grossReturn >= lastStake * 4;
  const celebrate = phase === "resolved" && netDelta > 0 && (tieWin || bigWin);
  const celebrationTier: "win" | "big" | "jackpot" = tieWin ? "jackpot" : "big";

  return (
    <div className="mx-auto w-full max-w-5xl">
      {/* ---- Headline / streak summary ---- */}
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2 sm:mb-3">
        <div className="flex items-center gap-2">
          <span className="text-2xl">🐉</span>
          <div>
            <div
              className="font-display text-lg font-bold tracking-wide"
              style={{ color: DRAGON, textShadow: `0 0 16px ${DRAGON}66` }}
            >
              Dragon&nbsp;Tiger
            </div>
            <div className="text-[11px] uppercase tracking-widest text-white/40">
              One card. One winner.
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 text-[11px]">
          <StreakPill label="Dragon" count={streak.d} color={DRAGON} />
          <StreakPill label="Tie" count={streak.tie} color={TIE_GOLD} />
          <StreakPill label="Tiger" count={streak.t} color={TIGER} />
        </div>
      </div>

      {/* ---- Table surface ---- */}
      <div className="felt relative overflow-hidden rounded-3xl p-3 sm:p-6 [@media(max-height:600px)]:p-3">
        {/* full-surface win celebration — only fires on notable wins */}
        <Celebration
          show={celebrate}
          seed={grossReturn}
          tier={celebrationTier}
          colors={["#f39c12", "#ffd24a", "#22e1ff", "#ffffff"]}
        />
        {/* ambient glow halves */}
        <div
          className="pointer-events-none absolute inset-y-0 left-0 w-1/2 opacity-40"
          style={{
            background: `radial-gradient(circle at 20% 50%, ${DRAGON}22, transparent 60%)`,
          }}
        />
        <div
          className="pointer-events-none absolute inset-y-0 right-0 w-1/2 opacity-40"
          style={{
            background: `radial-gradient(circle at 80% 50%, ${TIGER}22, transparent 60%)`,
          }}
        />

        {/* ---- Card arena ---- */}
        <div className="relative grid grid-cols-[1fr_auto_1fr] items-center gap-2 sm:gap-6">
          {/* Dragon side */}
          <SideArena
            label="DRAGON"
            emoji="🐉"
            color={DRAGON}
            deep={DRAGON_DEEP}
            card={dragonCard}
            faceDown={dragonDown}
            slideFrom={-90}
            active={revealed && winnerSide === "dragon"}
            dimmed={revealed && winnerSide === "tiger"}
            phase={phase}
          />

          {/* VS center */}
          <div className="flex flex-col items-center justify-center gap-2">
            <motion.div
              animate={
                phase === "dealing" || phase === "revealing"
                  ? { rotate: [0, -8, 8, 0], scale: [1, 1.12, 1] }
                  : { rotate: 0, scale: 1 }
              }
              transition={{ duration: 0.6, repeat: phase === "dealing" ? Infinity : 0 }}
              className="font-display text-2xl font-black text-white/80 sm:text-3xl"
              style={{ textShadow: "0 0 18px rgba(255,255,255,0.35)" }}
            >
              VS
            </motion.div>
            <AnimatePresence>
              {revealed && winnerSide === "tie" && (
                <motion.div
                  initial={{ scale: 0, rotate: -20 }}
                  animate={{ scale: 1, rotate: 0 }}
                  exit={{ scale: 0 }}
                  className="rounded-full px-3 py-1 text-xs font-black"
                  style={{
                    background: TIE_GOLD,
                    color: "#1a1300",
                    boxShadow: `0 0 22px ${TIE_GOLD}`,
                  }}
                >
                  {outcome?.isSuitTie ? "SUIT TIE" : "TIE"}
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {/* Tiger side */}
          <SideArena
            label="TIGER"
            emoji="🐅"
            color={TIGER}
            deep={TIGER_DEEP}
            card={tigerCard}
            faceDown={tigerDown}
            slideFrom={90}
            active={revealed && winnerSide === "tiger"}
            dimmed={revealed && winnerSide === "dragon"}
            phase={phase}
          />
        </div>

        {/* ---- Bet spots ---- */}
        <div className="relative mt-3 grid grid-cols-3 gap-2 sm:mt-5 sm:gap-3">
          <BetSpot
            testid="bet-dragon"
            label="DRAGON"
            emoji="🐉"
            pays="1:1"
            color={DRAGON}
            amount={bets.dragon}
            highlight={revealed && winnerSide === "dragon"}
            faded={revealed && winnerSide !== "dragon"}
            disabled={!isBetting}
            onClick={() => addBet("dragon")}
          />
          <BetSpot
            testid="bet-tie"
            label="TIE"
            emoji="⚖️"
            pays="8:1"
            color={TIE_GOLD}
            amount={bets.tie}
            highlight={revealed && (outcome?.isTie ?? false)}
            faded={revealed && !(outcome?.isTie ?? false)}
            disabled={!isBetting}
            onClick={() => addBet("tie")}
          />
          <BetSpot
            testid="bet-tiger"
            label="TIGER"
            emoji="🐅"
            pays="1:1"
            color={TIGER}
            amount={bets.tiger}
            highlight={revealed && winnerSide === "tiger"}
            faded={revealed && winnerSide !== "tiger"}
            disabled={!isBetting}
            onClick={() => addBet("tiger")}
          />
        </div>

        {/* Suit-tie side bet (full width, smaller) */}
        <div className="relative mt-2">
          <BetSpot
            testid="bet-suit-tie"
            label="SUIT TIE"
            emoji="✨"
            pays="50:1"
            color={TIE_GOLD}
            amount={bets.suitTie}
            highlight={revealed && (outcome?.isSuitTie ?? false)}
            faded={revealed && !(outcome?.isSuitTie ?? false)}
            disabled={!isBetting}
            wide
            onClick={() => addBet("suitTie")}
          />
        </div>

        {/* ---- Result banner ---- */}
        <div className="relative mt-3 min-h-[40px] sm:mt-4 sm:min-h-[44px]">
          <AnimatePresence mode="wait">
            {resultText && (
              <motion.div
                key={resultText}
                data-testid="round-result"
                initial={{ opacity: 0, y: 12, scale: 0.95 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ type: "spring", stiffness: 320, damping: 22 }}
                className="mx-auto w-fit rounded-2xl px-5 py-2 text-center font-display text-lg font-black sm:text-xl"
                style={{
                  color:
                    netDelta > 0 ? "#04130c" : netDelta < 0 ? "#fff" : "#fff",
                  background:
                    netDelta > 0
                      ? "linear-gradient(180deg,#8aff80,#34c759)"
                      : netDelta < 0
                        ? "linear-gradient(180deg,#e3342f,#9a1a17)"
                        : "rgba(255,255,255,0.08)",
                  boxShadow:
                    netDelta > 0
                      ? "0 0 26px rgba(138,255,128,0.55)"
                      : netDelta < 0
                        ? "0 0 22px rgba(227,52,47,0.5)"
                        : "none",
                }}
              >
                {resultText}
              </motion.div>
            )}
            {!resultText && (
              <motion.div
                key="hint"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="text-center text-sm text-white/45"
              >
                {totalStake > 0
                  ? "Place more chips or deal the cards."
                  : "Tap a spot to place your chips."}
              </motion.div>
            )}
          </AnimatePresence>

          {/* Win burst */}
          <AnimatePresence>
            {showBurst && <WinBurst color={winnerSide === "tiger" ? TIGER : DRAGON} />}
          </AnimatePresence>
        </div>
      </div>

      {/* ---- Controls ---- */}
      <div className="mt-3 grid gap-2 sm:mt-4 sm:gap-4 lg:grid-cols-[1.4fr_1fr]">
        {/* Bet + chips + action */}
        <div className="glass rounded-2xl p-4">
          <div className="mb-3 flex items-center justify-between">
            <div className="text-[11px] uppercase tracking-widest text-white/40">
              Chip size
            </div>
            <div className="flex items-center gap-3 text-right">
              <div>
                <div className="text-[10px] uppercase tracking-widest text-white/35">
                  Total bet
                </div>
                <div className="gold-text text-base font-bold tabular-nums">
                  {formatChips(totalStake)}
                </div>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-center gap-2 sm:gap-3">
            {CHIP_DENOMS.map((v) => (
              <div key={v} className="flex flex-col items-center gap-1">
                <Chip
                  value={v}
                  size={52}
                  selected={chip === v}
                  onClick={
                    isBetting
                      ? () => {
                          sfx.click();
                          setChip(v);
                        }
                      : undefined
                  }
                />
              </div>
            ))}
          </div>

          <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              data-testid="clear-bets"
              disabled={!isBetting || totalStake === 0}
              onClick={clearBets}
            >
              Clear
            </Button>

            {phase === "resolved" ? (
              <Button
                variant="gold"
                size="lg"
                data-testid="play-btn"
                onClick={newRound}
              >
                New Round
              </Button>
            ) : (
              <Button
                variant="gold"
                size="lg"
                data-testid="play-btn"
                disabled={!isBetting || !canAfford}
                onClick={deal}
              >
                {totalStake === 0
                  ? "Place a bet"
                  : !canAfford
                    ? "Insufficient chips"
                    : `Deal · ${formatChips(totalStake)}`}
              </Button>
            )}
          </div>

          {/* live stake / payout readouts */}
          <div className="mt-4 grid grid-cols-2 gap-2 text-center">
            <div className="rounded-xl border border-white/10 bg-black/30 px-3 py-2">
              <div className="text-[10px] uppercase tracking-widest text-white/35">
                Last stake
              </div>
              <div className="text-sm font-bold tabular-nums text-white/80">
                <CountingNumber value={lastStake} className="tabular-nums" />
              </div>
            </div>
            <div className="rounded-xl border border-white/10 bg-black/30 px-3 py-2">
              <div className="text-[10px] uppercase tracking-widest text-white/35">
                Last result
              </div>
              <div
                className="text-sm font-bold tabular-nums"
                style={{
                  color:
                    netDelta > 0
                      ? "#8aff80"
                      : netDelta < 0
                        ? "#ff7b73"
                        : "rgba(255,255,255,0.7)",
                }}
              >
                {phase === "resolved" ? formatDelta(netDelta) : "—"}
              </div>
            </div>
          </div>
        </div>

        {/* Paytable */}
        <CollapsiblePanel title="Paytable" accent={DRAGON} summary={<>Tie 8:1 · Suit 50:1</>}>
          <div className="space-y-1.5">
            {PAYTABLE.map((p) => {
              const won =
                phase === "resolved" &&
                outcome &&
                ((p.key === "dragon" && outcome.winner === "dragon") ||
                  (p.key === "tiger" && outcome.winner === "tiger") ||
                  (p.key === "tie" && outcome.isTie) ||
                  (p.key === "suitTie" && outcome.isSuitTie));
              return (
                <div
                  key={p.key}
                  className="flex items-center justify-between rounded-lg px-2.5 py-1.5 text-sm transition-colors"
                  style={{
                    background: won
                      ? "rgba(245,208,96,0.16)"
                      : "rgba(255,255,255,0.03)",
                    boxShadow: won ? "inset 0 0 0 1px rgba(245,208,96,0.5)" : "none",
                  }}
                >
                  <span className="font-semibold text-white/85">{p.label}</span>
                  <span className="flex items-center gap-2">
                    <span className="text-[10px] text-white/40">{p.note}</span>
                    <span className="gold-text font-bold tabular-nums">{p.pays}</span>
                  </span>
                </div>
              );
            })}
          </div>
          <p className="mt-3 text-[10px] leading-relaxed text-white/35">
            Ace is low (1), King high (13). On a Tie, Dragon &amp; Tiger bets lose
            half their stake. Tie &amp; Suit&nbsp;Tie bets lose on any non-tie.
          </p>
        </CollapsiblePanel>
      </div>

      {/* ---- Streak board ---- */}
      <div className="mt-3 sm:mt-4">
        <CollapsiblePanel
          title="Recent results"
          accent={DRAGON}
          summary={<>last {history.length}</>}
        >
        {history.length === 0 ? (
          <div className="py-2 text-center text-sm text-white/30">
            No rounds yet — deal to start the streak board.
          </div>
        ) : (
          <div className="no-scrollbar flex gap-1.5 overflow-x-auto pb-1">
            {history.map((o, i) => {
              const c =
                o.winner === "dragon"
                  ? DRAGON
                  : o.winner === "tiger"
                    ? TIGER
                    : TIE_GOLD;
              const glyph =
                o.winner === "dragon" ? "D" : o.winner === "tiger" ? "T" : "=";
              return (
                <motion.div
                  key={`${i}-${o.winner}`}
                  initial={i === 0 ? { scale: 0, rotate: -30 } : false}
                  animate={{ scale: 1, rotate: 0 }}
                  className="grid h-8 w-8 shrink-0 place-items-center rounded-full font-black"
                  style={{
                    color: o.winner === "tie" ? "#1a1300" : "#04130c",
                    background: c,
                    boxShadow: `0 0 10px ${c}88`,
                    border: o.isSuitTie
                      ? "2px solid #fff"
                      : "1px solid rgba(0,0,0,0.3)",
                  }}
                  title={
                    o.isSuitTie
                      ? "Suit Tie"
                      : o.winner === "tie"
                        ? "Tie"
                        : o.winner === "dragon"
                          ? "Dragon"
                          : "Tiger"
                  }
                >
                  {glyph}
                </motion.div>
              );
            })}
          </div>
        )}
        </CollapsiblePanel>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------------------
 * Sub-components
 * ------------------------------------------------------------------------- */

function StreakPill({
  label,
  count,
  color,
}: {
  label: string;
  count: number;
  color: string;
}) {
  return (
    <div
      className="flex items-center gap-1.5 rounded-full px-2.5 py-1"
      style={{ background: "rgba(255,255,255,0.05)", border: `1px solid ${color}55` }}
    >
      <span
        className="h-2 w-2 rounded-full"
        style={{ background: color, boxShadow: `0 0 8px ${color}` }}
      />
      <span className="text-white/55">{label}</span>
      <span className="font-bold tabular-nums" style={{ color }}>
        {count}
      </span>
    </div>
  );
}

function SideArena({
  label,
  emoji,
  color,
  deep,
  card,
  faceDown,
  slideFrom,
  active,
  dimmed,
  phase,
}: {
  label: string;
  emoji: string;
  color: string;
  deep: string;
  card: Card | null;
  faceDown: boolean;
  slideFrom: number;
  active: boolean;
  dimmed: boolean;
  phase: Phase;
}) {
  const dealing = phase === "dealing" || phase === "revealing";
  return (
    <motion.div
      className="flex flex-col items-center gap-1 sm:gap-2"
      animate={{ opacity: dimmed ? 0.45 : 1, scale: active ? 1.04 : 1 }}
      transition={{ type: "spring", stiffness: 260, damping: 20 }}
    >
      <div
        className="flex items-center gap-2 font-display text-sm font-black tracking-widest sm:text-base"
        style={{ color, textShadow: `0 0 14px ${color}77` }}
      >
        <span className="text-xl">{emoji}</span>
        {label}
      </div>

      <div
        className="relative grid place-items-center rounded-2xl p-2 sm:p-3"
        style={{
          background: `linear-gradient(180deg, ${color}1f, ${deep}14)`,
          boxShadow: active
            ? `0 0 0 2px ${color}, 0 0 34px ${color}aa`
            : `inset 0 0 0 1px ${color}33`,
        }}
      >
        {/* pulsing ring when this side wins */}
        <AnimatePresence>
          {active && (
            <motion.div
              className="pointer-events-none absolute inset-0 rounded-2xl"
              initial={{ opacity: 0.9, scale: 1 }}
              animate={{ opacity: 0, scale: 1.4 }}
              transition={{ duration: 0.9, repeat: Infinity }}
              style={{ border: `2px solid ${color}` }}
            />
          )}
        </AnimatePresence>

        <AnimatePresence mode="popLayout">
          {card ? (
            <motion.div
              key={card.id}
              initial={{ x: slideFrom, y: -40, opacity: 0, rotate: slideFrom > 0 ? 12 : -12 }}
              animate={{
                x: 0,
                y: 0,
                opacity: 1,
                rotate: 0,
                scale: active ? [1, 1.08, 1] : 1,
              }}
              transition={{
                x: { type: "spring", stiffness: 220, damping: 18 },
                y: { type: "spring", stiffness: 220, damping: 18 },
                opacity: { duration: 0.25 },
                scale: { duration: 0.5, delay: active ? 0.1 : 0 },
              }}
            >
              <PlayingCard card={card} faceDown={faceDown} size="lg" highlight={active} />
            </motion.div>
          ) : (
            <motion.div
              key="placeholder"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="grid h-[123px] w-[88px] place-items-center rounded-xl border-2 border-dashed text-3xl"
              style={{ borderColor: `${color}44`, color: `${color}66` }}
            >
              {emoji}
            </motion.div>
          )}
        </AnimatePresence>

        {/* rank readout */}
        <div className="mt-2 h-5 text-center">
          <AnimatePresence>
            {card && !faceDown && (
              <motion.span
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                className="text-xs font-bold tabular-nums"
                style={{ color }}
              >
                {rankLabel(card)} · {DT_VALUE[card.rank]}
              </motion.span>
            )}
          </AnimatePresence>
        </div>
      </div>

      {/* dealing shimmer */}
      <AnimatePresence>
        {dealing && faceDown && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: [0.3, 0.8, 0.3] }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.9, repeat: Infinity }}
            className="text-[10px] uppercase tracking-widest"
            style={{ color }}
          >
            dealing…
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

function BetSpot({
  testid,
  label,
  emoji,
  pays,
  color,
  amount,
  highlight,
  faded,
  disabled,
  onClick,
  wide = false,
}: {
  testid: string;
  label: string;
  emoji: string;
  pays: string;
  color: string;
  amount: number;
  highlight: boolean;
  faded: boolean;
  disabled: boolean;
  onClick: () => void;
  wide?: boolean;
}) {
  return (
    <motion.button
      type="button"
      data-testid={testid}
      onClick={onClick}
      disabled={disabled}
      whileHover={disabled ? undefined : { y: -3, scale: 1.02 }}
      whileTap={disabled ? undefined : { scale: 0.97 }}
      animate={{
        opacity: faded ? 0.4 : 1,
        boxShadow: highlight
          ? `0 0 0 2px ${color}, 0 0 28px ${color}aa`
          : `inset 0 0 0 1px ${color}40`,
      }}
      className={`relative flex items-center justify-center gap-2 rounded-2xl px-3 ${
        wide ? "py-2.5" : "py-4"
      } text-center transition-colors ${
        disabled ? "cursor-not-allowed" : "cursor-pointer"
      }`}
      style={{
        background: `linear-gradient(180deg, ${color}22, rgba(0,0,0,0.25))`,
      }}
    >
      <div className={`flex ${wide ? "flex-row gap-2" : "flex-col"} items-center`}>
        <span className={wide ? "text-lg" : "text-2xl"}>{emoji}</span>
        <span
          className="font-display font-black tracking-widest"
          style={{ color, fontSize: wide ? 13 : 15 }}
        >
          {label}
        </span>
        <span className="text-[10px] font-semibold text-white/45">{pays}</span>
      </div>

      {/* chip stack on the spot */}
      <AnimatePresence>
        {amount > 0 && (
          <motion.div
            key={amount}
            initial={{ scale: 0.4, y: -16, opacity: 0 }}
            animate={{ scale: 1, y: 0, opacity: 1 }}
            exit={{ scale: 0.4, opacity: 0 }}
            transition={{ type: "spring", stiffness: 380, damping: 20 }}
            className="absolute -top-2 -right-2 rounded-full px-2 py-0.5 text-xs font-black tabular-nums"
            style={{
              background: color,
              color: "#0a0a0a",
              boxShadow: `0 0 14px ${color}`,
            }}
          >
            {formatChips(amount)}
          </motion.div>
        )}
      </AnimatePresence>
    </motion.button>
  );
}

function WinBurst({ color }: { color: string }) {
  const sparks = Array.from({ length: 16 });
  return (
    <motion.div
      className="pointer-events-none absolute inset-0 grid place-items-center"
      initial={{ opacity: 1 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
    >
      {sparks.map((_, i) => {
        const angle = (i / sparks.length) * Math.PI * 2;
        const dist = 90 + (i % 3) * 26;
        return (
          <motion.span
            key={i}
            className="absolute h-2 w-2 rounded-full"
            style={{ background: i % 2 ? color : TIE_GOLD }}
            initial={{ x: 0, y: 0, scale: 0, opacity: 1 }}
            animate={{
              x: Math.cos(angle) * dist,
              y: Math.sin(angle) * dist,
              scale: [0, 1.3, 0],
              opacity: [1, 1, 0],
            }}
            transition={{ duration: 1.1, ease: "easeOut" }}
          />
        );
      })}
    </motion.div>
  );
}
