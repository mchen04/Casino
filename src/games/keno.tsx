"use client";

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useWallet } from "@/lib/wallet";
import { shuffle } from "@/lib/rng";
import { formatChips, formatDelta, formatMultiplier } from "@/lib/format";
import { sfx } from "@/lib/sound";
import { Button } from "@/components/ui/Button";
import { Chip } from "@/components/ui/Chip";
import { CountingNumber } from "@/components/CountingNumber";
import { CollapsiblePanel } from "@/components/CollapsiblePanel";
import { sleep } from "@/lib/async";

// ---------------------------------------------------------------------------
// KENO — 80-number grid, pick 1-10 spots, draw 20 balls, count hits.
//
// Money model (via useWallet only):
//   - bet(stake) deducts up front; abort the round if it returns false.
//   - The paytable maps (spots, hits) -> a GROSS multiplier that already
//     includes the stake. So a payout of x means win(stake * x).
//       x === 0  -> credit nothing (loss)
//       x === 1  -> win(stake)      (push / money back)
//       x  >  1  -> win(stake * x)  (profit)
//   - Top pick-10 / hit-10 pays 1000× for a jackpot moment.
//
// All randomness is a single Fisher-Yates shuffle of 1..80; the first 20 are
// the drawn balls. Independent and unbiased; the edge lives in the paytable.
// ---------------------------------------------------------------------------

const ACCENT = "#22e1ff";
const ACCENT_DEEP = "#0e7490";
const TOTAL_NUMBERS = 80;
const DRAW_COUNT = 20;
const MAX_SPOTS = 10;
const MIN_BET = 5;
const CHIPS = [5, 25, 100, 500, 1000];

type Phase = "betting" | "drawing" | "resolved";

// ---------------------------------------------------------------------------
// Paytable. PAYTABLE[spots][hits] = gross multiplier (includes stake).
// Index 0 of each row is "hits === 0". Entries of 0 are losses; 1 is a push.
// Re-tuned so EVERY pick count returns ~90-92% (exact hypergeometric RTP,
// computed from P(s,h)=C(s,h)C(80-s,20-h)/C(80,20)). The previous table only
// paid ~92% on pick-2 and as little as 32% on pick-10 — most rows were a
// 45-68% house edge. The pick-10/hit-10 1000x jackpot is preserved.
// ---------------------------------------------------------------------------
const PAYTABLE: Record<number, number[]> = {
  1: [0, 3.6],
  2: [0, 1, 9],
  3: [0, 0, 3.6, 29],
  4: [0, 0, 1.7, 8.3, 66],
  5: [0, 0, 0, 4.8, 29, 240],
  6: [0, 0, 0, 2.6, 11, 63, 530],
  7: [0, 0, 0, 2, 4, 24, 160, 805],
  8: [0, 0, 0, 0, 4.1, 17, 83, 415, 1245],
  9: [0, 0, 0, 0, 2.2, 8.7, 44, 175, 760, 1740],
  10: [0, 0, 0, 0, 0, 5.7, 28, 140, 425, 1415, 1000],
};

function payoutMultiplier(spots: number, hits: number): number {
  const row = PAYTABLE[spots];
  if (!row) return 0;
  return row[hits] ?? 0;
}

/** Best possible payout for a pick count (max table entry). */
function topMultiplier(spots: number): number {
  const row = PAYTABLE[spots];
  if (!row) return 0;
  return row.reduce((m, v) => Math.max(m, v), 0);
}

// ---------------------------------------------------------------------------
// A single grid cell. State communicated via props so framer-motion can react.
// ---------------------------------------------------------------------------
interface CellProps {
  n: number;
  picked: boolean;
  drawn: boolean;
  hit: boolean;
  flashing: boolean;
  disabled: boolean;
  onToggle: (n: number) => void;
}

const Cell = React.memo(function Cell({
  n,
  picked,
  drawn,
  hit,
  flashing,
  disabled,
  onToggle,
}: CellProps) {
  // Visual layering:
  //   picked (not yet drawn) -> cyan ring fill
  //   drawn (not picked)     -> muted gold dot
  //   hit (picked + drawn)   -> bright burst
  const base =
    "relative grid aspect-square place-items-center rounded-lg text-[11px] font-bold tabular-nums sm:text-sm select-none";

  let bg = "bg-white/[0.04] text-white/70 border border-white/10";
  if (picked && !drawn) {
    bg = "text-ink border";
  } else if (hit) {
    bg = "text-ink border";
  } else if (drawn) {
    bg = "bg-gold/15 text-gold border border-gold/40";
  }

  return (
    <motion.button
      type="button"
      disabled={disabled}
      onClick={() => onToggle(n)}
      className={`${base} ${bg} ${
        disabled ? "cursor-default" : "cursor-pointer hover:border-white/30"
      }`}
      style={
        picked && !drawn
          ? {
              background: `linear-gradient(160deg, ${ACCENT}, ${ACCENT_DEEP})`,
              borderColor: ACCENT,
              boxShadow: `0 0 10px ${ACCENT}66`,
            }
          : hit
            ? {
                background: `radial-gradient(circle at 50% 35%, #ffffff, ${ACCENT})`,
                borderColor: "#ffffff",
                boxShadow: `0 0 16px ${ACCENT}, 0 0 4px #fff`,
              }
            : undefined
      }
      whileHover={disabled ? undefined : { scale: 1.06 }}
      whileTap={disabled ? undefined : { scale: 0.9 }}
      animate={
        flashing
          ? {
              scale: [1, 1.35, 1],
              rotate: [0, -6, 6, 0],
            }
          : { scale: 1, rotate: 0 }
      }
      transition={{ duration: 0.5, ease: "easeOut" }}
      aria-label={`Number ${n}${picked ? ", picked" : ""}${
        hit ? ", hit" : drawn ? ", drawn" : ""
      }`}
    >
      {n}
      <AnimatePresence>
        {hit && (
          <motion.span
            key="hitring"
            className="pointer-events-none absolute inset-0 rounded-lg"
            initial={{ opacity: 0.9, scale: 0.6 }}
            animate={{ opacity: 0, scale: 1.9 }}
            transition={{ duration: 0.7, ease: "easeOut" }}
            style={{ border: `2px solid #ffffff` }}
          />
        )}
      </AnimatePresence>
    </motion.button>
  );
});

// ---------------------------------------------------------------------------
// A drawn ball that pops into the "drawn order" tray.
// ---------------------------------------------------------------------------
function Ball({ n, hit, index }: { n: number; hit: boolean; index: number }) {
  return (
    <motion.div
      initial={{ scale: 0, rotate: -180, y: -30 }}
      animate={{ scale: 1, rotate: 0, y: 0 }}
      transition={{ type: "spring", stiffness: 360, damping: 16 }}
      className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-[11px] font-bold tabular-nums sm:h-8 sm:w-8 sm:text-xs"
      style={{
        background: hit
          ? `radial-gradient(circle at 50% 30%, #ffffff, ${ACCENT})`
          : "radial-gradient(circle at 50% 30%, #5b6470, #2a2f38)",
        color: hit ? "#06222b" : "#cfd6df",
        boxShadow: hit
          ? `0 0 12px ${ACCENT}, 0 2px 5px rgba(0,0,0,0.6)`
          : "0 2px 5px rgba(0,0,0,0.6)",
        border: hit ? "1px solid #fff" : "1px solid rgba(255,255,255,0.15)",
      }}
      aria-label={`Drawn ball ${index + 1}: ${n}${hit ? " (hit)" : ""}`}
    >
      {n}
    </motion.div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------
export default function Keno() {
  const wallet = useWallet();
  const { balance, bet: placeBet, win, ready } = wallet;

  const [bet, setBet] = useState(25);
  const [phase, setPhase] = useState<Phase>("betting");
  const [picks, setPicks] = useState<Set<number>>(new Set());

  // Drawn-number bookkeeping during the animated reveal.
  const [drawn, setDrawn] = useState<number[]>([]); // in draw order, revealed so far
  const [flashing, setFlashing] = useState<number | null>(null);

  // Resolution state.
  const [stake, setStake] = useState(0);
  const [hits, setHits] = useState(0);
  const [payout, setPayout] = useState(0); // gross credited
  const [multiplier, setMultiplier] = useState(0);
  const [delta, setDelta] = useState(0); // net change shown to player
  const [showBurst, setShowBurst] = useState(false);

  const runRef = useRef(0); // cancels stale async draws

  const drawnSet = useMemo(() => new Set(drawn), [drawn]);
  const picksArr = useMemo(() => Array.from(picks).sort((a, b) => a - b), [picks]);
  const spots = picks.size;

  // Hits found so far among the revealed balls (live tally during the draw).
  const liveHits = useMemo(() => {
    let c = 0;
    for (const d of drawn) if (picks.has(d)) c++;
    return c;
  }, [drawn, picks]);

  const canAfford = bet >= MIN_BET && bet <= balance;
  const canDraw = phase === "betting" && spots >= 1 && canAfford;

  const cleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => () => cleanupRef.current?.(), []);

  // ---- bet adjusters -------------------------------------------------------
  const adjustBet = useCallback(
    (next: number) => {
      if (phase !== "betting") return;
      const ceiling = Math.max(MIN_BET, balance);
      const clamped = Math.min(ceiling, Math.max(0, Math.floor(next)));
      setBet(clamped);
    },
    [phase, balance],
  );

  const addChip = useCallback(
    (v: number) => {
      if (phase !== "betting") return;
      sfx.chip();
      adjustBet(bet + v);
    },
    [phase, bet, adjustBet],
  );

  // ---- pick management -----------------------------------------------------
  const toggle = useCallback(
    (n: number) => {
      if (phase !== "betting") return;
      setPicks((prev) => {
        const next = new Set(prev);
        if (next.has(n)) {
          next.delete(n);
          sfx.tick();
        } else {
          if (next.size >= MAX_SPOTS) {
            sfx.lose();
            return prev;
          }
          next.add(n);
          sfx.chip();
        }
        return next;
      });
    },
    [phase],
  );

  const clearPicks = useCallback(() => {
    if (phase !== "betting") return;
    sfx.click();
    setPicks(new Set());
  }, [phase]);

  const quickPick = useCallback(() => {
    if (phase !== "betting") return;
    sfx.chip();
    setPicks((prev) => {
      // Fill up to MAX_SPOTS if empty, otherwise keep current count but
      // re-randomise to a fresh set of the same size.
      const count = prev.size === 0 ? MAX_SPOTS : prev.size;
      const all = shuffle(
        Array.from({ length: TOTAL_NUMBERS }, (_, i) => i + 1),
      );
      return new Set(all.slice(0, count));
    });
  }, [phase]);

  // ---- the round -----------------------------------------------------------
  const startDraw = useCallback(async () => {
    if (!ready || phase !== "betting") return;
    if (spots < 1) return;
    const amount = Math.floor(bet);
    if (amount < MIN_BET || amount > balance) return;
    if (!placeBet(amount)) return; // unaffordable -> abort

    // reset round result state
    const myRun = ++runRef.current;
    setStake(amount);
    setDrawn([]);
    setFlashing(null);
    setHits(0);
    setPayout(0);
    setMultiplier(0);
    setDelta(0);
    setShowBurst(false);
    setPhase("drawing");

    // Single fair draw: shuffle 1..80, take first 20.
    const pool = shuffle(Array.from({ length: TOTAL_NUMBERS }, (_, i) => i + 1));
    const balls = pool.slice(0, DRAW_COUNT);

    let cancelled = false;
    cleanupRef.current = () => {
      cancelled = true;
    };

    // Reveal balls one by one.
    for (let i = 0; i < balls.length; i++) {
      if (cancelled || runRef.current !== myRun) return;
      // pacing: a touch slower at the start, faster toward the end
      await sleep(i < 6 ? 240 : i < 14 ? 180 : 130);
      if (cancelled || runRef.current !== myRun) return;
      const n = balls[i];
      const isHit = picks.has(n);
      if (isHit) {
        setFlashing(n);
        sfx.card();
        sfx.tick();
      } else {
        sfx.tick();
      }
      setDrawn((d) => [...d, n]);
      // clear the flash after the cell animation
      if (isHit) {
        setTimeout(() => {
          setFlashing((f) => (f === n ? null : f));
        }, 480);
      }
    }

    if (cancelled || runRef.current !== myRun) return;
    await sleep(360);
    if (cancelled || runRef.current !== myRun) return;

    // Resolve.
    const finalHits = balls.reduce((c, n) => (picks.has(n) ? c + 1 : c), 0);
    const mult = payoutMultiplier(spots, finalHits);
    const gross = Math.round(amount * mult);

    setHits(finalHits);
    setMultiplier(mult);
    setPayout(gross);
    setDelta(gross - amount);
    setFlashing(null);

    if (gross > 0) win(gross);

    if (mult >= 100) {
      setShowBurst(true);
      sfx.jackpot();
    } else if (mult > 1) {
      setShowBurst(true);
      sfx.win();
    } else if (mult === 1) {
      sfx.thud();
    } else {
      sfx.lose();
    }

    setPhase("resolved");
  }, [ready, phase, spots, bet, balance, placeBet, picks, win]);

  const newRound = useCallback(() => {
    runRef.current++;
    cleanupRef.current?.();
    sfx.click();
    setPhase("betting");
    setDrawn([]);
    setFlashing(null);
    setHits(0);
    setPayout(0);
    setMultiplier(0);
    setDelta(0);
    setShowBurst(false);
  }, []);

  // ---- derived display -----------------------------------------------------
  const resultText = useMemo(() => {
    if (phase !== "resolved") return "";
    if (spots === 0) return "";
    if (multiplier >= 100) return `JACKPOT! ${hits} hits · ${formatMultiplier(multiplier)}`;
    if (multiplier > 1) return `Win! ${hits} of ${spots} hit · ${formatMultiplier(multiplier)}`;
    if (multiplier === 1) return `Push — ${hits} hits, stake returned`;
    return `No win — ${hits} of ${spots} hit`;
  }, [phase, multiplier, hits, spots]);

  const resultTone: "win" | "jackpot" | "push" | "loss" =
    multiplier >= 100
      ? "jackpot"
      : multiplier > 1
        ? "win"
        : multiplier === 1
          ? "push"
          : "loss";

  // Active paytable rows for the current pick count (or 10 if none picked yet).
  const tableSpots = spots >= 1 ? spots : MAX_SPOTS;
  const tableRows = useMemo(() => {
    const row = PAYTABLE[tableSpots] ?? [];
    const out: { hits: number; mult: number }[] = [];
    for (let h = 0; h < row.length; h++) {
      if (row[h] > 0) out.push({ hits: h, mult: row[h] });
    }
    return out.reverse(); // biggest payout first
  }, [tableSpots]);

  const disabledGrid = phase !== "betting";

  return (
    <div className="mx-auto w-full max-w-5xl">
      <div className="felt relative overflow-hidden rounded-3xl p-3 shadow-felt sm:p-6">
        {/* ambient glow */}
        <div
          className="pointer-events-none absolute -top-24 left-1/2 h-64 w-[28rem] -translate-x-1/2 rounded-full opacity-30 blur-3xl"
          style={{ background: ACCENT }}
        />

        {/* ---- header ---- */}
        <div className="relative mb-3 flex flex-wrap items-center justify-between gap-2 sm:mb-4 sm:gap-3">
          <div>
            <h2
              className="font-display text-2xl font-bold tracking-wide sm:text-3xl"
              style={{ color: ACCENT, textShadow: `0 0 18px ${ACCENT}55` }}
            >
              Keno
            </h2>
            <p className="text-xs text-white/50">
              Pick 1–{MAX_SPOTS} · {DRAW_COUNT} balls drawn from 1–{TOTAL_NUMBERS}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Stat label="Spots" value={String(spots)} />
            <Stat
              label="Hits"
              value={`${phase === "betting" ? 0 : liveHits}/${Math.max(spots, 0)}`}
              accent
            />
            <Stat label="Top Pay" value={formatMultiplier(topMultiplier(tableSpots))} />
          </div>
        </div>

        <div className="relative grid gap-2 sm:gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
          {/* ---- left: grid + drawn tray ---- */}
          <div className="min-w-0">
            <div className="glass rounded-2xl p-3 sm:p-4">
              <div className="mx-auto grid grid-cols-10 gap-1.5 [@media(max-height:600px)]:max-w-[340px] sm:gap-2">
                {Array.from({ length: TOTAL_NUMBERS }, (_, i) => i + 1).map((n) => {
                  const isPicked = picks.has(n);
                  const isDrawn = drawnSet.has(n);
                  return (
                    <Cell
                      key={n}
                      n={n}
                      picked={isPicked}
                      drawn={isDrawn}
                      hit={isPicked && isDrawn}
                      flashing={flashing === n}
                      disabled={disabledGrid}
                      onToggle={toggle}
                    />
                  );
                })}
              </div>
            </div>

            {/* drawn-order tray */}
            <div className="glass mt-2 rounded-2xl p-3 sm:mt-3">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-[10px] uppercase tracking-widest text-white/40">
                  Drawn Order
                </span>
                <span className="text-[10px] tabular-nums text-white/40">
                  {drawn.length}/{DRAW_COUNT}
                </span>
              </div>
              <div className="flex min-h-[2rem] flex-wrap gap-1.5">
                <AnimatePresence>
                  {drawn.map((n, i) => (
                    <Ball key={`${n}-${i}`} n={n} hit={picks.has(n)} index={i} />
                  ))}
                </AnimatePresence>
                {drawn.length === 0 && (
                  <span className="self-center text-xs text-white/30">
                    Press DRAW to release the balls…
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* ---- right: paytable + result ---- */}
          <div className="flex flex-col gap-2 sm:gap-3">
            {/* result banner */}
            <div className="glass min-h-[4rem] rounded-2xl p-3 sm:min-h-[5.5rem]">
              <AnimatePresence mode="wait">
                {phase === "resolved" ? (
                  <motion.div
                    key="result"
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                    className="text-center"
                  >
                    <div
                      data-testid="round-result"
                      className="text-sm font-bold"
                      style={{
                        color:
                          resultTone === "loss"
                            ? "#fca5a5"
                            : resultTone === "push"
                              ? "#e9d5a0"
                              : ACCENT,
                        textShadow:
                          resultTone === "jackpot"
                            ? `0 0 16px ${ACCENT}`
                            : undefined,
                      }}
                    >
                      {resultText}
                    </div>
                    {delta > 0 ? (
                      // Genuine win: show gross credited and net profit
                      <div className="mt-1 text-lg font-bold tabular-nums text-emerald-300">
                        +<CountingNumber value={payout} /> chips
                      </div>
                    ) : delta === 0 && payout > 0 ? (
                      // Push: stake returned, net zero — neutral display
                      <div className="mt-1 text-lg font-bold tabular-nums text-yellow-200">
                        <CountingNumber value={payout} /> chips returned
                      </div>
                    ) : (
                      // Loss: show the net as a negative
                      <div className="mt-1 text-lg font-bold tabular-nums text-red-300">
                        {formatDelta(delta)} chips
                      </div>
                    )}
                    {delta > 0 && (
                      <div className="text-[11px] text-white/45">
                        net {formatDelta(delta)}
                      </div>
                    )}
                  </motion.div>
                ) : (
                  <motion.div
                    key="status"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="grid h-full place-items-center text-center"
                  >
                    {phase === "drawing" ? (
                      <div>
                        <div
                          className="text-sm font-bold"
                          style={{ color: ACCENT }}
                        >
                          Drawing… {drawn.length}/{DRAW_COUNT}
                        </div>
                        <div className="mt-1 text-2xl font-bold tabular-nums text-white">
                          {liveHits}{" "}
                          <span className="text-sm font-normal text-white/40">
                            hit{liveHits === 1 ? "" : "s"}
                          </span>
                        </div>
                      </div>
                    ) : (
                      <div className="text-xs text-white/50">
                        {spots === 0
                          ? "Pick 1–10 numbers to play"
                          : `${spots} spot${spots === 1 ? "" : "s"} selected — set your bet and DRAW`}
                      </div>
                    )}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            {/* paytable */}
            <CollapsiblePanel
              title="Paytable"
              accent={ACCENT}
              className="flex-1"
              summary={<>Pick {tableSpots}</>}
            >
              <div className="mb-2 flex items-center justify-end">
                <span
                  className="rounded-full px-2 py-0.5 text-[10px] font-bold"
                  style={{ background: `${ACCENT}22`, color: ACCENT }}
                >
                  Pick {tableSpots}
                </span>
              </div>
              <div className="space-y-1">
                <div className="grid grid-cols-[1fr_auto_auto] gap-2 px-2 text-[9px] uppercase tracking-widest text-white/30">
                  <span>Hits</span>
                  <span className="text-right">Pays</span>
                  <span className="text-right">Win</span>
                </div>
                {tableRows.map((r) => {
                  const isCurrent = phase === "resolved" && r.hits === hits;
                  return (
                    <motion.div
                      key={r.hits}
                      animate={
                        isCurrent
                          ? { scale: [1, 1.05, 1] }
                          : { scale: 1 }
                      }
                      transition={{ duration: 0.5 }}
                      className="grid grid-cols-[1fr_auto_auto] items-center gap-2 rounded-lg px-2 py-1 text-xs tabular-nums"
                      style={
                        isCurrent
                          ? {
                              background: `${ACCENT}22`,
                              boxShadow: `0 0 0 1px ${ACCENT}66`,
                            }
                          : { background: "rgba(255,255,255,0.03)" }
                      }
                    >
                      <span className="font-semibold text-white/80">
                        {r.hits} / {tableSpots}
                      </span>
                      <span
                        className="text-right font-bold"
                        style={{ color: r.mult > 1 ? ACCENT : "#e9d5a0" }}
                      >
                        {formatMultiplier(r.mult)}
                      </span>
                      <span className="text-right text-white/50">
                        {formatChips(Math.round(Math.max(bet, MIN_BET) * r.mult))}
                      </span>
                    </motion.div>
                  );
                })}
              </div>
              <p className="mt-2 text-[10px] leading-snug text-white/30">
                Payouts include your stake. 1.00× returns your bet (push).
              </p>
            </CollapsiblePanel>
          </div>
        </div>

        {/* ---- bottom: bet + actions ---- */}
        <div className="relative mt-2 glass rounded-2xl p-3 sm:mt-4 sm:p-4">
          <div className="flex flex-wrap items-center justify-center gap-2 sm:gap-3">
            {CHIPS.map((v) => (
              <Chip
                key={v}
                value={v}
                size={48}
                onClick={
                  phase !== "betting" || v > balance ? undefined : () => addChip(v)
                }
              />
            ))}
          </div>

          <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
            <Button
              size="sm"
              variant="ghost"
              disabled={phase !== "betting"}
              onClick={() => adjustBet(0)}
              data-testid="bet-clear"
            >
              Clear Bet
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={phase !== "betting"}
              onClick={() => adjustBet(Math.floor(bet / 2))}
              data-testid="bet-half"
            >
              ½
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={phase !== "betting"}
              onClick={() => adjustBet(bet * 2)}
              data-testid="bet-double"
            >
              2×
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={phase !== "betting"}
              onClick={() => adjustBet(balance)}
              data-testid="bet-max"
            >
              Max
            </Button>

            <motion.div
              key={bet}
              initial={{ scale: 0.9 }}
              animate={{ scale: 1 }}
              className="ml-1 min-w-[110px] rounded-xl border border-gold/30 bg-black/40 px-4 py-2 text-center"
            >
              <div className="text-[9px] uppercase tracking-widest text-white/40">
                Bet
              </div>
              <div className="gold-text text-lg font-bold tabular-nums">
                {formatChips(bet)}
              </div>
            </motion.div>
          </div>

          {/* pick controls + primary action */}
          <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
            <Button
              size="md"
              variant="neon"
              disabled={phase !== "betting"}
              onClick={quickPick}
              data-testid="quick-pick"
            >
              Quick Pick
            </Button>
            <Button
              size="md"
              variant="ghost"
              disabled={phase !== "betting" || spots === 0}
              onClick={clearPicks}
              data-testid="clear-picks"
            >
              Clear Picks
            </Button>

            {phase === "resolved" ? (
              <Button
                size="lg"
                variant="gold"
                onClick={newRound}
                data-testid="play-btn"
              >
                New Round
              </Button>
            ) : (
              <Button
                size="lg"
                variant="gold"
                disabled={!canDraw}
                onClick={startDraw}
                data-testid="play-btn"
              >
                {phase === "drawing" ? "Drawing…" : "Draw"}
              </Button>
            )}
          </div>

          {/* affordability / pick hints */}
          <div className="mt-2 text-center text-[11px] text-white/40">
            {phase === "betting" && spots === 0 && "Select at least one number."}
            {phase === "betting" &&
              spots >= 1 &&
              bet < MIN_BET &&
              `Minimum bet is ${MIN_BET} chips.`}
            {phase === "betting" &&
              spots >= 1 &&
              bet >= MIN_BET &&
              bet > balance &&
              "Bet exceeds your balance."}
            {phase === "betting" &&
              spots >= 1 &&
              canAfford &&
              `Balance ${formatChips(balance)} chips`}
          </div>
        </div>

        {/* ---- win burst overlay ---- */}
        <AnimatePresence>
          {showBurst && phase === "resolved" && multiplier > 1 && (
            <motion.div
              key="burst"
              className="pointer-events-none absolute inset-0 z-20 grid place-items-center"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
            >
              {Array.from({ length: multiplier >= 100 ? 28 : 16 }).map((_, i) => {
                const angle = (i / (multiplier >= 100 ? 28 : 16)) * Math.PI * 2;
                const dist = 140 + (i % 3) * 40;
                return (
                  <motion.span
                    key={i}
                    className="absolute text-xl"
                    initial={{ x: 0, y: 0, opacity: 1, scale: 0.4 }}
                    animate={{
                      x: Math.cos(angle) * dist,
                      y: Math.sin(angle) * dist,
                      opacity: 0,
                      scale: 1.2,
                      rotate: 360,
                    }}
                    transition={{ duration: 1.1, ease: "easeOut" }}
                    style={{ color: i % 2 ? ACCENT : "#f5d060" }}
                  >
                    {i % 3 === 0 ? "★" : i % 3 === 1 ? "✦" : "●"}
                  </motion.span>
                );
              })}
              <motion.div
                initial={{ scale: 0.4, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.6, opacity: 0 }}
                transition={{ type: "spring", stiffness: 260, damping: 14 }}
                className="rounded-2xl px-6 py-3 text-center font-display text-3xl font-bold"
                style={{
                  color: "#06222b",
                  background: `linear-gradient(160deg, #ffffff, ${ACCENT})`,
                  boxShadow: `0 0 40px ${ACCENT}`,
                }}
              >
                {multiplier >= 100 ? "JACKPOT" : "WIN"}
                <div className="text-base font-semibold">
                  {formatMultiplier(multiplier)}
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Small stat pill used in the header.
// ---------------------------------------------------------------------------
function Stat({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div className="rounded-xl border border-white/10 bg-black/30 px-3 py-1.5 text-center">
      <div className="text-[9px] uppercase tracking-widest text-white/40">
        {label}
      </div>
      <div
        className="text-sm font-bold tabular-nums"
        style={{ color: accent ? ACCENT : "#fff" }}
      >
        {value}
      </div>
    </div>
  );
}
