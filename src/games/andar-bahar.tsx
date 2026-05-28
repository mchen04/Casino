"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useWallet } from "@/lib/wallet";
import { makeShoe, type Card, SUIT_SYMBOL, SUIT_COLOR } from "@/lib/cards";
import { sfx } from "@/lib/sound";
import { formatChips, formatDelta } from "@/lib/format";
import { PlayingCard } from "@/components/PlayingCard";
import { Button } from "@/components/ui/Button";
import { Chip } from "@/components/ui/Chip";

/* ----------------------------------------------------------------------------
 * Andar Bahar — the classic Indian card game.
 *
 * Flow:
 *  - A single 52-card shoe is shuffled each round (makeShoe(1)).
 *  - One "JOKER" / game card is drawn and shown.
 *  - The player bets a single side: ANDAR (left) or BAHAR (right).
 *  - Cards are dealt alternately to the two sides. By convention the FIRST
 *    card goes to the side opposite the joker's colour: black joker -> Andar
 *    deals first; red joker -> Bahar deals first.
 *  - Dealing continues until a dealt card MATCHES the joker's RANK. The side
 *    that card lands on WINS.
 *
 * Payouts (account for the first-card edge):
 *  - The side that DEALS FIRST has the statistical edge, so it pays LESS:
 *      starting side  -> 0.9 : 1  ->  win(bet * 1.9)
 *      other side     -> 1   : 1  ->  win(bet * 2)
 *  This is the standard Goa-style payout. The UI shows the live odds for the
 *  side that starts this round so the rule is unmistakable.
 * ------------------------------------------------------------------------- */

type Side = "andar" | "bahar";
type Phase = "betting" | "dealing" | "resolved";

interface DealtCard {
  card: Card;
  side: Side;
  /** Sequence index across the whole layout (0-based). */
  seq: number;
  /** True for the final matching card. */
  isMatch: boolean;
}

interface Outcome {
  winner: Side;
  joker: Card;
  startSide: Side;
  cards: number;
}

const CHIP_DENOMS = [5, 25, 100, 500, 1000];
const MIN_BET = 5;
const DEFAULT_BET = 25;

/* Festive Indian gold-and-teal palette. */
const ACCENT = "#16a085"; // game accent (teal)
const ANDAR_COLOR = "#16a085"; // teal
const ANDAR_DEEP = "#0b5e4d";
const BAHAR_COLOR = "#e0a008"; // marigold gold
const BAHAR_DEEP = "#8a5a05";
const GOLD = "#f5d060";

/** Pace of dealing — gets a touch faster as the pile grows so long runs stay fun. */
function dealDelay(index: number): number {
  return Math.max(150, 340 - index * 9);
}

function sideColor(side: Side): string {
  return side === "andar" ? ANDAR_COLOR : BAHAR_COLOR;
}
function sideDeep(side: Side): string {
  return side === "andar" ? ANDAR_DEEP : BAHAR_DEEP;
}
function rankLabel(card: Card): string {
  return `${card.rank}${SUIT_SYMBOL[card.suit]}`;
}

/* ----------------------------------------------------------------------------
 * Animated count-up number.
 * ------------------------------------------------------------------------- */
function Counter({ value, prefix = "" }: { value: number; prefix?: string }) {
  const [display, setDisplay] = useState(value);
  const raf = useRef<number | null>(null);
  const from = useRef(value);

  useEffect(() => {
    from.current = display;
    const start = performance.now();
    const delta = value - from.current;
    const dur = 520;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / dur);
      const eased = 1 - Math.pow(1 - t, 3);
      setDisplay(Math.round(from.current + delta * eased));
      if (t < 1) raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => {
      if (raf.current) cancelAnimationFrame(raf.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  return (
    <span className="tabular-nums">
      {prefix}
      {formatChips(display)}
    </span>
  );
}

export default function AndarBahar() {
  const wallet = useWallet();

  const [bet, setBet] = useState(DEFAULT_BET);
  const [pick, setPick] = useState<Side>("andar");
  const [chip, setChip] = useState(25);
  const [phase, setPhase] = useState<Phase>("betting");

  const [joker, setJoker] = useState<Card | null>(null);
  const [jokerDown, setJokerDown] = useState(true);
  const [startSide, setStartSide] = useState<Side>("andar");

  const [andar, setAndar] = useState<DealtCard[]>([]);
  const [bahar, setBahar] = useState<DealtCard[]>([]);

  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [resultText, setResultText] = useState("");
  const [netDelta, setNetDelta] = useState(0);
  const [lastStake, setLastStake] = useState(0);
  const [showBurst, setShowBurst] = useState(false);

  const [history, setHistory] = useState<Outcome[]>([]);

  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    return () => {
      timers.current.forEach(clearTimeout);
    };
  }, []);

  const after = useCallback((ms: number, fn: () => void) => {
    const id = setTimeout(fn, ms);
    timers.current.push(id);
  }, []);

  const isBetting = phase === "betting";
  const affordable = bet >= MIN_BET && bet <= wallet.balance;

  // Odds that apply to the player's chosen side THIS round depend on which
  // side deals first (the starting side carries the edge -> pays 0.9:1).
  // During betting we don't know the next joker color, so startSide is the
  // previous round's value (or the default). We only show definitive odds once
  // the joker has been revealed (phase !== "betting").
  const pickStarts = pick === startSide;
  const pickMultiplier = pickStarts ? 1.9 : 2;
  // Conservative "to win" uses 1.9× (worst case for player) during betting
  // so we never over-promise; once dealing starts the actual multiplier is fixed.
  const pickPotential = Math.floor(bet * (isBetting ? 1.9 : pickMultiplier));

  /* ---- Resolve a finished deal: credit wallet, set result text ---- */
  const resolve = useCallback(
    (
      result: Outcome,
      stake: number,
      placedSide: Side,
    ) => {
      const won = result.winner === placedSide;
      // Starting side pays 0.9:1, other side pays 1:1.
      const mult = placedSide === result.startSide ? 1.9 : 2;
      const gross = won ? Math.floor(stake * mult) : 0;
      const net = gross - stake;
      if (gross > 0) wallet.win(gross);

      setOutcome(result);
      setNetDelta(net);
      setHistory((h) => [result, ...h].slice(0, 28));

      const sideName = result.winner === "andar" ? "ANDAR" : "BAHAR";
      let txt = `${sideName} WINS · ${result.cards} card${result.cards === 1 ? "" : "s"}`;
      txt += `  ·  ${formatDelta(net)}`;
      setResultText(txt);

      if (won) {
        sfx.win();
        setShowBurst(true);
        after(1500, () => setShowBurst(false));
      } else {
        sfx.lose();
      }

      setPhase("resolved");
    },
    [wallet, after],
  );

  /* ---- Begin a round: shuffle, draw joker, deal alternately ---- */
  const startRound = useCallback(() => {
    if (!isBetting || !affordable) return;
    const stake = bet;
    if (!wallet.bet(stake)) {
      sfx.lose();
      return;
    }
    const placedSide = pick;

    // Reset table state.
    timers.current.forEach(clearTimeout);
    timers.current = [];
    setLastStake(stake);
    setNetDelta(0);
    setOutcome(null);
    setResultText("");
    setShowBurst(false);
    setAndar([]);
    setBahar([]);

    // Fresh single-deck shoe each round.
    const shoe = makeShoe(1);
    // pop() returns Card | undefined; the deck is always 52 cards so this is safe.
    const j = shoe.pop();
    if (!j) { setPhase("betting"); return; }

    // Convention: black joker -> Andar deals first; red joker -> Bahar first.
    const start: Side = SUIT_COLOR[j.suit] === "black" ? "andar" : "bahar";

    setJoker(j);
    setJokerDown(true);
    setStartSide(start);
    setPhase("dealing");
    sfx.card();

    // Flip the joker face up.
    after(380, () => {
      setJokerDown(false);
      sfx.card();
    });

    // Pre-compute the full deal so animation timing is deterministic.
    const sequence: DealtCard[] = [];
    let side: Side = start;
    let matchSide: Side = start;
    let seq = 0;
    // The remaining 51 cards guarantee a match exists (the other 3 of the rank).
    for (const c of shoe) {
      const isMatch = c.rank === j.rank;
      sequence.push({ card: c, side, seq, isMatch });
      seq++;
      if (isMatch) {
        matchSide = side;
        break;
      }
      side = side === "andar" ? "bahar" : "andar";
    }

    const result: Outcome = {
      winner: matchSide,
      joker: j,
      startSide: start,
      cards: sequence.length,
    };

    // Schedule each card landing on its side.
    let t = 720; // after the joker flip settles
    sequence.forEach((dc, i) => {
      after(t, () => {
        if (dc.isMatch) sfx.thud();
        else sfx.card();
        if (dc.side === "andar") setAndar((prev) => [...prev, dc]);
        else setBahar((prev) => [...prev, dc]);
      });
      t += dealDelay(i);
    });

    // After the final card lands, resolve.
    after(t + 520, () => resolve(result, stake, placedSide));
  }, [isBetting, affordable, bet, pick, wallet, after, resolve]);

  const newRound = useCallback(() => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
    sfx.click();
    setPhase("betting");
    setJoker(null);
    setJokerDown(true);
    setAndar([]);
    setBahar([]);
    setOutcome(null);
    setResultText("");
    setShowBurst(false);
    setNetDelta(0);
    // Clamp the carried-over bet to the current balance.
    setBet((b) => Math.max(MIN_BET, Math.min(b, Math.max(MIN_BET, wallet.balance))));
  }, [wallet.balance]);

  const addChip = useCallback(
    (v: number) => {
      if (!isBetting) return;
      sfx.chip();
      setBet((b) => Math.min(b + v, Math.max(MIN_BET, wallet.balance)));
    },
    [isBetting, wallet.balance],
  );

  const setMax = useCallback(() => {
    if (!isBetting) return;
    sfx.chip();
    setBet(Math.max(MIN_BET, wallet.balance));
  }, [isBetting, wallet.balance]);

  const clearBet = useCallback(() => {
    if (!isBetting) return;
    sfx.click();
    setBet(MIN_BET);
  }, [isBetting]);

  const choosePick = useCallback(
    (s: Side) => {
      if (!isBetting) return;
      sfx.click();
      setPick(s);
    },
    [isBetting],
  );

  // Streak counts for the header.
  const streak = useMemo(() => {
    let a = 0,
      b = 0;
    for (const o of history) {
      if (o.winner === "andar") a++;
      else b++;
    }
    return { a, b };
  }, [history]);

  const resolved = phase === "resolved";
  const winnerSide = outcome?.winner;

  return (
    <div className="mx-auto w-full max-w-5xl">
      {/* ---- Headline / streak summary ---- */}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-2xl">🪔</span>
          <div>
            <div
              className="font-display text-lg font-bold tracking-wide"
              style={{ color: ACCENT, textShadow: `0 0 16px ${ACCENT}66` }}
            >
              Andar&nbsp;Bahar
            </div>
            <div className="text-[11px] uppercase tracking-widest text-white/40">
              Inside or Outside — match the Joker
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 text-[11px]">
          <StreakPill label="Andar" count={streak.a} color={ANDAR_COLOR} />
          <StreakPill label="Bahar" count={streak.b} color={BAHAR_COLOR} />
        </div>
      </div>

      {/* ---- Table surface ---- */}
      <div
        className="felt relative overflow-hidden rounded-3xl p-4 sm:p-6"
        style={{
          boxShadow: `inset 0 0 120px rgba(0,0,0,0.4), 0 0 0 1px ${ACCENT}33`,
        }}
      >
        {/* festive ambient glows + faint mandala */}
        <div
          className="pointer-events-none absolute inset-0 opacity-[0.07]"
          style={{
            backgroundImage:
              "repeating-conic-gradient(from 0deg at 50% 0%, transparent 0deg 10deg, rgba(245,208,96,0.5) 10deg 11deg)",
          }}
        />
        <div
          className="pointer-events-none absolute inset-y-0 left-0 w-1/2 opacity-50"
          style={{ background: `radial-gradient(circle at 18% 60%, ${ANDAR_COLOR}22, transparent 62%)` }}
        />
        <div
          className="pointer-events-none absolute inset-y-0 right-0 w-1/2 opacity-50"
          style={{ background: `radial-gradient(circle at 82% 60%, ${BAHAR_COLOR}22, transparent 62%)` }}
        />

        {/* ---- Joker showcase ---- */}
        <div className="relative flex flex-col items-center">
          <div
            className="mb-1 flex items-center gap-2 font-display text-xs font-black uppercase tracking-[0.3em]"
            style={{ color: GOLD, textShadow: `0 0 12px ${GOLD}55` }}
          >
            ✦ Joker Card ✦
          </div>
          <motion.div
            animate={
              phase === "dealing" && jokerDown
                ? { rotate: [0, -3, 3, 0], scale: [1, 1.04, 1] }
                : { rotate: 0, scale: 1 }
            }
            transition={{ duration: 0.7, repeat: phase === "dealing" && jokerDown ? Infinity : 0 }}
            className="relative grid place-items-center rounded-2xl p-2"
            style={{
              background: `linear-gradient(180deg, ${GOLD}22, rgba(0,0,0,0.25))`,
              boxShadow: joker ? `0 0 0 1px ${GOLD}55, 0 0 30px ${GOLD}33` : "none",
            }}
          >
            <AnimatePresence mode="popLayout">
              {joker ? (
                <motion.div
                  key={joker.id}
                  initial={{ y: -36, opacity: 0, rotate: -8, scale: 0.8 }}
                  animate={{ y: 0, opacity: 1, rotate: 0, scale: 1 }}
                  transition={{ type: "spring", stiffness: 240, damping: 18 }}
                >
                  <PlayingCard card={joker} faceDown={jokerDown} size="lg" highlight={resolved} />
                </motion.div>
              ) : (
                <motion.div
                  key="joker-placeholder"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="grid h-[123px] w-[88px] place-items-center rounded-xl border-2 border-dashed text-3xl"
                  style={{ borderColor: `${GOLD}44`, color: `${GOLD}66` }}
                >
                  🃏
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
          <div className="mt-1.5 h-5 text-center">
            <AnimatePresence>
              {joker && !jokerDown && (
                <motion.span
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="text-xs font-bold"
                  style={{ color: GOLD }}
                >
                  Match the rank <b>{joker.rank}</b> · {rankLabel(joker)} · first deal →{" "}
                  <span style={{ color: sideColor(startSide) }}>
                    {startSide === "andar" ? "ANDAR" : "BAHAR"}
                  </span>
                </motion.span>
              )}
            </AnimatePresence>
          </div>
        </div>

        {/* ---- Two-row arena ---- */}
        <div className="relative mt-3 grid gap-3 sm:grid-cols-2 sm:gap-4">
          <SideRow
            side="andar"
            label="ANDAR"
            sub="Inside"
            color={ANDAR_COLOR}
            deep={ANDAR_DEEP}
            cards={andar}
            starts={startSide === "andar"}
            picked={pick === "andar"}
            isWinner={resolved && winnerSide === "andar"}
            dimmed={resolved && winnerSide === "bahar"}
            multiplier={startSide === "andar" ? 1.9 : 2}
            disabled={!isBetting}
            onPick={() => choosePick("andar")}
          />
          <SideRow
            side="bahar"
            label="BAHAR"
            sub="Outside"
            color={BAHAR_COLOR}
            deep={BAHAR_DEEP}
            cards={bahar}
            starts={startSide === "bahar"}
            picked={pick === "bahar"}
            isWinner={resolved && winnerSide === "bahar"}
            dimmed={resolved && winnerSide === "andar"}
            multiplier={startSide === "bahar" ? 1.9 : 2}
            disabled={!isBetting}
            onPick={() => choosePick("bahar")}
          />
        </div>

        {/* ---- Result banner ---- */}
        <div className="relative mt-4 min-h-[44px]">
          <AnimatePresence mode="wait">
            {resultText ? (
              <motion.div
                key={resultText}
                data-testid="round-result"
                initial={{ opacity: 0, y: 12, scale: 0.95 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ type: "spring", stiffness: 320, damping: 22 }}
                className="mx-auto w-fit rounded-2xl px-5 py-2 text-center font-display text-lg font-black sm:text-xl"
                style={{
                  color: netDelta > 0 ? "#04130c" : "#fff",
                  background:
                    netDelta > 0
                      ? "linear-gradient(180deg,#7df0c8,#16a085)"
                      : "linear-gradient(180deg,#e3342f,#9a1a17)",
                  boxShadow:
                    netDelta > 0
                      ? `0 0 26px ${ACCENT}99`
                      : "0 0 22px rgba(227,52,47,0.5)",
                }}
              >
                {resultText}
              </motion.div>
            ) : (
              <motion.div
                key="hint"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="text-center text-sm text-white/45"
              >
                {phase === "dealing"
                  ? "Dealing… the side that matches the Joker wins."
                  : `Pick a side, set your bet, then deal. You chose ${pick === "andar" ? "ANDAR" : "BAHAR"}.`}
              </motion.div>
            )}
          </AnimatePresence>

          <AnimatePresence>
            {showBurst && <WinBurst color={winnerSide === "bahar" ? BAHAR_COLOR : ANDAR_COLOR} />}
          </AnimatePresence>
        </div>
      </div>

      {/* ---- Controls ---- */}
      <div className="mt-4 grid gap-4 lg:grid-cols-[1.4fr_1fr]">
        {/* Bet + chips + action */}
        <div className="glass rounded-2xl p-4">
          <div className="mb-3 flex items-center justify-between">
            <div className="text-[11px] uppercase tracking-widest text-white/40">Chip size</div>
            <div className="text-right">
              <div className="text-[10px] uppercase tracking-widest text-white/35">Your bet</div>
              <motion.div
                key={bet}
                initial={{ scale: 0.9 }}
                animate={{ scale: 1 }}
                className="gold-text text-base font-bold tabular-nums"
              >
                {formatChips(bet)}
              </motion.div>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-center gap-2 sm:gap-3">
            {CHIP_DENOMS.map((v) => (
              <Chip
                key={v}
                value={v}
                size={52}
                selected={chip === v}
                onClick={
                  isBetting
                    ? () => {
                        sfx.click();
                        setChip(v);
                        addChip(v);
                      }
                    : undefined
                }
              />
            ))}
          </div>

          <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              data-testid="clear-bet"
              disabled={!isBetting || bet <= MIN_BET}
              onClick={clearBet}
            >
              Clear
            </Button>
            <Button
              variant="ghost"
              size="sm"
              data-testid="half-bet"
              disabled={!isBetting}
              onClick={() => {
                sfx.chip();
                setBet((b) => Math.max(MIN_BET, Math.floor(b / 2)));
              }}
            >
              ½
            </Button>
            <Button
              variant="ghost"
              size="sm"
              data-testid="double-bet"
              disabled={!isBetting}
              onClick={() => {
                sfx.chip();
                setBet((b) => Math.min(b * 2, Math.max(MIN_BET, wallet.balance)));
              }}
            >
              2×
            </Button>
            <Button variant="ghost" size="sm" data-testid="max-bet" disabled={!isBetting} onClick={setMax}>
              Max
            </Button>

            {resolved ? (
              <Button variant="gold" size="lg" data-testid="play-btn" onClick={newRound}>
                New Round
              </Button>
            ) : (
              <Button
                variant="gold"
                size="lg"
                data-testid="play-btn"
                disabled={!isBetting || !affordable}
                onClick={startRound}
              >
                {bet < MIN_BET
                  ? "Place a bet"
                  : !affordable
                    ? "Insufficient chips"
                    : `Deal · ${formatChips(bet)}`}
              </Button>
            )}
          </div>

          {/* Side picker */}
          <div className="mt-4 grid grid-cols-2 gap-2">
            <SidePickButton
              testid="pick-andar"
              label="ANDAR"
              sub="Inside"
              color={ANDAR_COLOR}
              picked={pick === "andar"}
              starts={startSide === "andar"}
              oddsKnown={!isBetting}
              disabled={!isBetting}
              onClick={() => choosePick("andar")}
            />
            <SidePickButton
              testid="pick-bahar"
              label="BAHAR"
              sub="Outside"
              color={BAHAR_COLOR}
              picked={pick === "bahar"}
              starts={startSide === "bahar"}
              oddsKnown={!isBetting}
              disabled={!isBetting}
              onClick={() => choosePick("bahar")}
            />
          </div>

          {/* live readouts */}
          <div className="mt-4 grid grid-cols-3 gap-2 text-center">
            <div className="rounded-xl border border-white/10 bg-black/30 px-3 py-2">
              <div className="text-[10px] uppercase tracking-widest text-white/35">Last stake</div>
              <div className="text-sm font-bold tabular-nums text-white/80">
                <Counter value={lastStake} />
              </div>
            </div>
            <div className="rounded-xl border border-white/10 bg-black/30 px-3 py-2">
              <div className="text-[10px] uppercase tracking-widest text-white/35">
                {isBetting ? "Min win" : "To win"}
              </div>
              <div className="text-sm font-bold tabular-nums" style={{ color: GOLD }}>
                {phase !== "resolved" ? formatChips(pickPotential) : "—"}
              </div>
            </div>
            <div className="rounded-xl border border-white/10 bg-black/30 px-3 py-2">
              <div className="text-[10px] uppercase tracking-widest text-white/35">Last result</div>
              <div
                className="text-sm font-bold tabular-nums"
                style={{
                  color: netDelta > 0 ? "#7df0c8" : netDelta < 0 ? "#ff7b73" : "rgba(255,255,255,0.7)",
                }}
              >
                {resolved ? formatDelta(netDelta) : "—"}
              </div>
            </div>
          </div>
        </div>

        {/* Paytable / odds */}
        <div className="glass rounded-2xl p-4">
          <div className="mb-2 text-[11px] uppercase tracking-widest text-white/40">Odds</div>
          <div className="space-y-1.5">
            <OddsRow
              label="First-deal side"
              note="has the edge"
              pays="0.9 : 1"
              color={GOLD}
              won={resolved && winnerSide === outcome?.startSide}
            />
            <OddsRow
              label="Other side"
              note="even money"
              pays="1 : 1"
              color={ACCENT}
              won={resolved && !!outcome && winnerSide !== outcome.startSide}
            />
          </div>
          <p className="mt-3 text-[10px] leading-relaxed text-white/40">
            A Joker is drawn each round. Cards are dealt alternately to{" "}
            <b style={{ color: ANDAR_COLOR }}>Andar</b> and{" "}
            <b style={{ color: BAHAR_COLOR }}>Bahar</b> until one matches the Joker&apos;s rank — that
            side wins. The first deal goes to <b style={{ color: ANDAR_COLOR }}>Andar</b> when the
            Joker is <b>black</b>, otherwise to <b style={{ color: BAHAR_COLOR }}>Bahar</b>. The
            side that deals first carries the edge, so it pays <b style={{ color: GOLD }}>0.9 : 1</b>;
            the other pays <b style={{ color: ACCENT }}>1 : 1</b>.
          </p>
          {isBetting && (
            <div
              className="mt-3 rounded-xl px-3 py-2 text-center text-[11px] font-semibold"
              style={{ background: `${sideColor(pick)}1f`, border: `1px solid ${sideColor(pick)}55` }}
            >
              You bet{" "}
              <b style={{ color: sideColor(pick) }}>{pick === "andar" ? "ANDAR" : "BAHAR"}</b>.{" "}
              Odds revealed when the Joker lands —{" "}
              <b style={{ color: GOLD }}>0.9 : 1</b> if your side deals first, else{" "}
              <b style={{ color: ACCENT }}>1 : 1</b>.
            </div>
          )}
        </div>
      </div>

      {/* ---- Streak board ---- */}
      <div className="glass mt-4 rounded-2xl p-4">
        <div className="mb-2 flex items-center justify-between">
          <div className="text-[11px] uppercase tracking-widest text-white/40">Recent results</div>
          <div className="text-[10px] text-white/35">last {history.length}</div>
        </div>
        {history.length === 0 ? (
          <div className="py-2 text-center text-sm text-white/30">
            No rounds yet — deal to start the streak board.
          </div>
        ) : (
          <div className="no-scrollbar flex gap-1.5 overflow-x-auto pb-1">
            {history.map((o, i) => {
              const c = o.winner === "andar" ? ANDAR_COLOR : BAHAR_COLOR;
              const glyph = o.winner === "andar" ? "A" : "B";
              return (
                <motion.div
                  key={`${history.length - i}-${o.winner}-${o.cards}`}
                  initial={i === 0 ? { scale: 0, rotate: -30 } : false}
                  animate={{ scale: 1, rotate: 0 }}
                  className="grid h-8 w-8 shrink-0 place-items-center rounded-full font-black"
                  style={{
                    color: "#04130c",
                    background: c,
                    boxShadow: `0 0 10px ${c}88`,
                    border: "1px solid rgba(0,0,0,0.3)",
                  }}
                  title={`${o.winner === "andar" ? "Andar" : "Bahar"} · ${o.cards} cards · Joker ${o.joker.rank}`}
                >
                  {glyph}
                </motion.div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------------------
 * Sub-components
 * ------------------------------------------------------------------------- */

function StreakPill({ label, count, color }: { label: string; count: number; color: string }) {
  return (
    <div
      className="flex items-center gap-1.5 rounded-full px-2.5 py-1"
      style={{ background: "rgba(255,255,255,0.05)", border: `1px solid ${color}55` }}
    >
      <span className="h-2 w-2 rounded-full" style={{ background: color, boxShadow: `0 0 8px ${color}` }} />
      <span className="text-white/55">{label}</span>
      <span className="font-bold tabular-nums" style={{ color }}>
        {count}
      </span>
    </div>
  );
}

function SideRow({
  side,
  label,
  sub,
  color,
  deep,
  cards,
  starts,
  picked,
  isWinner,
  dimmed,
  multiplier,
  disabled,
  onPick,
}: {
  side: Side;
  label: string;
  sub: string;
  color: string;
  deep: string;
  cards: DealtCard[];
  starts: boolean;
  picked: boolean;
  isWinner: boolean;
  dimmed: boolean;
  multiplier: number;
  disabled: boolean;
  onPick: () => void;
}) {
  return (
    <motion.div
      animate={{ opacity: dimmed ? 0.5 : 1, scale: isWinner ? 1.01 : 1 }}
      transition={{ type: "spring", stiffness: 260, damping: 20 }}
      className="relative"
    >
      {/* clickable header that selects the side as your bet */}
      <button
        type="button"
        onClick={disabled ? undefined : onPick}
        disabled={disabled}
        className={`relative mb-2 flex w-full items-center justify-between rounded-xl px-3 py-2 text-left transition-colors ${
          disabled ? "cursor-default" : "cursor-pointer"
        }`}
        style={{
          background: `linear-gradient(90deg, ${color}26, rgba(0,0,0,0.2))`,
          boxShadow: picked ? `0 0 0 2px ${color}, 0 0 18px ${color}66` : `inset 0 0 0 1px ${color}33`,
        }}
      >
        <span className="flex items-baseline gap-2">
          <span
            className="font-display text-base font-black tracking-widest"
            style={{ color, textShadow: `0 0 12px ${color}66` }}
          >
            {label}
          </span>
          <span className="text-[10px] uppercase tracking-widest text-white/40">{sub}</span>
        </span>
        <span className="flex items-center gap-2">
          {starts && (
            <span
              className="rounded-full px-2 py-0.5 text-[9px] font-black uppercase tracking-wider"
              style={{ background: `${color}33`, color, border: `1px solid ${color}66` }}
            >
              first deal
            </span>
          )}
          <span
            className="rounded-md px-2 py-0.5 text-[11px] font-bold tabular-nums"
            style={{ background: "rgba(0,0,0,0.3)", color }}
          >
            {multiplier === 1.9 ? "0.9:1" : "1:1"}
          </span>
          {picked && (
            <span className="text-[10px] font-black uppercase tracking-wider" style={{ color }}>
              ✓ your bet
            </span>
          )}
        </span>
      </button>

      {/* card lane */}
      <div
        className="relative min-h-[96px] rounded-2xl p-2.5"
        style={{
          background: `linear-gradient(180deg, ${color}14, ${deep}10)`,
          boxShadow: isWinner ? `0 0 0 2px ${color}, 0 0 30px ${color}88` : `inset 0 0 0 1px ${color}26`,
        }}
      >
        {/* pulsing ring when this side wins */}
        <AnimatePresence>
          {isWinner && (
            <motion.div
              className="pointer-events-none absolute inset-0 rounded-2xl"
              initial={{ opacity: 0.8, scale: 1 }}
              animate={{ opacity: 0, scale: 1.05 }}
              transition={{ duration: 1, repeat: Infinity }}
              style={{ border: `2px solid ${color}` }}
            />
          )}
        </AnimatePresence>

        <div className="no-scrollbar flex flex-wrap gap-1.5">
          {cards.length === 0 && (
            <div
              className="grid h-[70px] w-[50px] place-items-center rounded-lg border-2 border-dashed text-xl"
              style={{ borderColor: `${color}33`, color: `${color}55` }}
            >
              {sub === "Inside" ? "↙" : "↘"}
            </div>
          )}
          <AnimatePresence>
            {cards.map((dc) => (
              <motion.div
                key={dc.card.id}
                initial={{ y: -110, x: side === "andar" ? -30 : 30, opacity: 0, rotate: -16, scale: 0.85 }}
                animate={{
                  y: 0,
                  x: 0,
                  opacity: 1,
                  rotate: 0,
                  scale: dc.isMatch ? [1, 1.14, 1] : 1,
                }}
                transition={{
                  y: { type: "spring", stiffness: 360, damping: 22 },
                  x: { type: "spring", stiffness: 360, damping: 22 },
                  opacity: { duration: 0.15 },
                  scale: { duration: 0.45, delay: dc.isMatch ? 0.1 : 0 },
                }}
                style={{ zIndex: dc.seq }}
              >
                <PlayingCard card={dc.card} size="sm" highlight={dc.isMatch} />
              </motion.div>
            ))}
          </AnimatePresence>
        </div>

        {/* card count badge */}
        <AnimatePresence>
          {cards.length > 0 && (
            <motion.div
              key={cards.length}
              initial={{ scale: 0.5, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              className="absolute -bottom-2 right-2 rounded-full px-2 py-0.5 text-[10px] font-black tabular-nums"
              style={{ background: color, color: "#04130c", boxShadow: `0 0 10px ${color}88` }}
            >
              {cards.length}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </motion.div>
  );
}

function SidePickButton({
  testid,
  label,
  sub,
  color,
  picked,
  starts,
  oddsKnown,
  disabled,
  onClick,
}: {
  testid: string;
  label: string;
  sub: string;
  color: string;
  picked: boolean;
  starts: boolean;
  /** False during the betting phase before the joker is revealed. */
  oddsKnown: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <motion.button
      type="button"
      data-testid={testid}
      onClick={onClick}
      disabled={disabled}
      whileHover={disabled ? undefined : { y: -2, scale: 1.02 }}
      whileTap={disabled ? undefined : { scale: 0.97 }}
      animate={{
        boxShadow: picked ? `0 0 0 2px ${color}, 0 0 22px ${color}88` : `inset 0 0 0 1px ${color}40`,
      }}
      className={`relative flex flex-col items-center gap-0.5 rounded-2xl px-3 py-3 text-center transition-colors ${
        disabled ? "cursor-not-allowed opacity-70" : "cursor-pointer"
      }`}
      style={{ background: `linear-gradient(180deg, ${color}22, rgba(0,0,0,0.25))` }}
    >
      <span className="font-display text-base font-black tracking-widest" style={{ color }}>
        {label}
      </span>
      <span className="text-[10px] uppercase tracking-widest text-white/45">{sub}</span>
      <span className="mt-0.5 text-[11px] font-bold tabular-nums" style={{ color: oddsKnown && starts ? GOLD : ACCENT }}>
        {oddsKnown ? (starts ? "0.9 : 1" : "1 : 1") : "0.9–1 : 1"}
      </span>
      {picked && (
        <span className="absolute -top-2 -right-2 grid h-5 w-5 place-items-center rounded-full text-[11px] font-black"
          style={{ background: color, color: "#04130c", boxShadow: `0 0 12px ${color}` }}>
          ✓
        </span>
      )}
    </motion.button>
  );
}

function OddsRow({
  label,
  note,
  pays,
  color,
  won,
}: {
  label: string;
  note: string;
  pays: string;
  color: string;
  won: boolean;
}) {
  return (
    <div
      className="flex items-center justify-between rounded-lg px-2.5 py-1.5 text-sm transition-colors"
      style={{
        background: won ? `${color}22` : "rgba(255,255,255,0.03)",
        boxShadow: won ? `inset 0 0 0 1px ${color}88` : "none",
      }}
    >
      <span className="font-semibold text-white/85">{label}</span>
      <span className="flex items-center gap-2">
        <span className="text-[10px] text-white/40">{note}</span>
        <span className="font-bold tabular-nums" style={{ color }}>
          {pays}
        </span>
      </span>
    </div>
  );
}

function WinBurst({ color }: { color: string }) {
  const sparks = Array.from({ length: 18 });
  return (
    <motion.div
      className="pointer-events-none absolute inset-0 grid place-items-center"
      initial={{ opacity: 1 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
    >
      {sparks.map((_, i) => {
        const angle = (i / sparks.length) * Math.PI * 2;
        const dist = 90 + (i % 3) * 28;
        return (
          <motion.span
            key={i}
            className="absolute h-2 w-2 rounded-full"
            style={{ background: i % 2 ? color : GOLD }}
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
