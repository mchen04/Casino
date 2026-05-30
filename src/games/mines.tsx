"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useWallet } from "@/lib/wallet";
import { shuffle, clamp } from "@/lib/rng";
import { formatChips, formatDelta, formatMultiplier } from "@/lib/format";
import { sfx } from "@/lib/sound";
import { Button } from "@/components/ui/Button";
import { Chip } from "@/components/ui/Chip";
import { CountingNumber } from "@/components/CountingNumber";
import { CollapsiblePanel } from "@/components/CollapsiblePanel";
import { Celebration } from "@/components/Celebration";
import { sleep } from "@/lib/async";

// ---------------------------------------------------------------------------
// MINES — a 5×5 grid (25 tiles). Player sets a bet and the number of mines
// (1–24), then starts a round (the stake is deducted up front). Mines are
// hidden at random positions. The player clicks tiles to reveal them:
//   - GEM  → safe, the running multiplier grows.
//   - MINE → the round ends, the whole board is revealed, the stake is lost.
//
// Multiplier after revealing k gems (safe picks):
//   raw(k) = Π_{i=0..k-1} (25 - i) / (25 - mines - i)
//   payout multiplier = raw(k) * (1 - HOUSE_EDGE)
// This is the inverse of the probability of surviving k safe picks, with a
// small house edge applied. CASH OUT (after ≥1 gem) pays win(stake * mult),
// where mult already includes the stake.
//
// Money flows EXCLUSIVELY through useWallet():
//   - bet(stake) deducts the stake at round start (abort if it returns false).
//   - win(stake * mult) credits the gross return on cash-out.
//   - Hitting a mine credits nothing (the stake is already lost).
// ---------------------------------------------------------------------------

const ACCENT = "#8aff80";
const ACCENT_DEEP = "#3fbf52";
const GRID = 5;
const TILES = GRID * GRID; // 25
const HOUSE_EDGE = 0.01;
const MIN_BET = 5;
const MAX_MINES = 24;
const MIN_MINES = 1;
const DEFAULT_BET = 50;
const DEFAULT_MINES = 3;
const CHIPS = [5, 25, 100, 500, 1000];
const MINE_PRESETS = [1, 3, 5, 10, 24];

type Phase = "betting" | "playing" | "busted" | "cashed";
type TileKind = "gem" | "mine";

/**
 * Multiplier (INCLUDING the stake) after `safe` successful gem picks with a
 * given mine count. safe=0 returns 1 (no win yet). House edge baked in.
 */
function multiplierFor(mines: number, safe: number): number {
  if (safe <= 0) return 1;
  // Can't pick more gems than exist; clamp so the formula never divides by
  // zero or goes negative on a perfect clear / out-of-range query.
  const maxSafe = TILES - mines;
  const picks = Math.min(safe, maxSafe);
  let raw = 1;
  for (let i = 0; i < picks; i++) {
    raw *= (TILES - i) / (TILES - mines - i);
  }
  return raw * (1 - HOUSE_EDGE);
}

// ---------------------------------------------------------------------------
// SVG GEM — a faceted neon crystal that sparkles in on reveal.
// ---------------------------------------------------------------------------
function Gem() {
  return (
    <svg viewBox="0 0 100 100" className="h-full w-full" style={{ display: "block" }}>
      <defs>
        <linearGradient id="gem-top" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#e8fff0" />
          <stop offset="100%" stopColor={ACCENT} />
        </linearGradient>
        <linearGradient id="gem-bottom" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={ACCENT} />
          <stop offset="100%" stopColor={ACCENT_DEEP} />
        </linearGradient>
      </defs>
      {/* crown */}
      <polygon points="30,32 50,16 70,32 60,40 40,40" fill="url(#gem-top)" />
      <polygon points="30,32 40,40 22,44" fill="#bfffd0" />
      <polygon points="70,32 60,40 78,44" fill="#bfffd0" />
      {/* body */}
      <polygon points="22,44 40,40 60,40 78,44 50,84" fill="url(#gem-bottom)" />
      <polygon points="40,40 60,40 50,84" fill={ACCENT} opacity="0.55" />
      <polygon points="22,44 40,40 50,84" fill="#9affa0" opacity="0.65" />
      {/* glint */}
      <polygon points="34,33 42,30 40,38" fill="#ffffff" opacity="0.85" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// SVG BOMB — round bomb with a lit fuse.
// ---------------------------------------------------------------------------
function Bomb({ lit = false }: { lit?: boolean }) {
  return (
    <svg viewBox="0 0 100 100" className="h-full w-full" style={{ display: "block" }}>
      <defs>
        <radialGradient id="bomb-body" cx="38%" cy="32%" r="70%">
          <stop offset="0%" stopColor="#5a5f6b" />
          <stop offset="55%" stopColor="#2b2f38" />
          <stop offset="100%" stopColor="#0c0e12" />
        </radialGradient>
      </defs>
      <circle cx="48" cy="58" r="30" fill="url(#bomb-body)" />
      <ellipse cx="40" cy="48" rx="9" ry="6" fill="#ffffff" opacity="0.22" />
      {/* cap */}
      <rect x="56" y="22" width="12" height="12" rx="2" fill="#3a3f49" transform="rotate(35 62 28)" />
      {/* fuse */}
      <path
        d="M64 24 Q74 14 70 6"
        fill="none"
        stroke="#caa45a"
        strokeWidth="3"
        strokeLinecap="round"
      />
      {lit && (
        <>
          <circle cx="70" cy="5" r="5" fill="#ffd56b" />
          <circle cx="70" cy="5" r="2.4" fill="#fff" />
        </>
      )}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// A single grid tile. Handles the 3D flip on reveal, gem sparkle and bomb
// explosion via framer-motion.
// ---------------------------------------------------------------------------
interface TileProps {
  index: number;
  kind: TileKind;
  revealed: boolean;
  /** Was this the exact mine the player detonated? */
  detonated: boolean;
  /** A non-picked tile shown only because the round ended (dimmed). */
  exposed: boolean;
  disabled: boolean;
  onPick: (i: number) => void;
}

function Tile({ index, kind, revealed, detonated, exposed, disabled, onPick }: TileProps) {
  const flipped = revealed;
  const isGem = kind === "gem";

  return (
    <div className="relative aspect-square" style={{ perspective: 700 }}>
      <motion.button
        type="button"
        data-testid={`tile-${index}`}
        aria-label={`Tile ${index + 1}`}
        disabled={disabled}
        onClick={() => onPick(index)}
        whileHover={!disabled ? { scale: 1.05 } : undefined}
        whileTap={!disabled ? { scale: 0.93 } : undefined}
        className="absolute inset-0 rounded-xl"
        style={{
          transformStyle: "preserve-3d",
          cursor: disabled ? "default" : "pointer",
        }}
      >
        <motion.div
          className="absolute inset-0"
          style={{ transformStyle: "preserve-3d" }}
          initial={false}
          animate={{ rotateY: flipped ? 180 : 0 }}
          transition={{ duration: 0.42, ease: [0.2, 0.7, 0.2, 1] }}
        >
          {/* FRONT — hidden tile */}
          <div
            className="absolute inset-0 grid place-items-center rounded-xl"
            style={{
              backfaceVisibility: "hidden",
              WebkitBackfaceVisibility: "hidden",
              background:
                "linear-gradient(150deg, rgba(255,255,255,0.10), rgba(255,255,255,0.02))",
              border: "1px solid rgba(255,255,255,0.12)",
              boxShadow:
                "inset 0 1px 0 rgba(255,255,255,0.18), 0 6px 14px rgba(0,0,0,0.45)",
            }}
          >
            <span
              className="text-lg opacity-30"
              style={{ color: ACCENT }}
            >
              ◆
            </span>
          </div>

          {/* BACK — revealed content */}
          <div
            className="absolute inset-0 grid place-items-center overflow-hidden rounded-xl p-[14%]"
            style={{
              backfaceVisibility: "hidden",
              WebkitBackfaceVisibility: "hidden",
              transform: "rotateY(180deg)",
              opacity: exposed ? 0.5 : 1,
              background: isGem
                ? "radial-gradient(circle at 50% 40%, rgba(138,255,128,0.22), rgba(0,0,0,0.35))"
                : detonated
                  ? "radial-gradient(circle at 50% 45%, rgba(255,90,70,0.55), rgba(40,0,0,0.6))"
                  : "radial-gradient(circle at 50% 45%, rgba(255,120,90,0.15), rgba(0,0,0,0.45))",
              border: isGem
                ? `1px solid ${ACCENT}66`
                : detonated
                  ? "1px solid rgba(255,90,70,0.9)"
                  : "1px solid rgba(255,120,90,0.3)",
              boxShadow: isGem
                ? `inset 0 0 14px ${ACCENT}55`
                : detonated
                  ? "inset 0 0 22px rgba(255,90,70,0.7)"
                  : "none",
            }}
          >
            {flipped &&
              (isGem ? (
                <motion.div
                  className="relative h-full w-full"
                  initial={{ scale: 0.3, rotate: -25 }}
                  animate={{ scale: 1, rotate: 0 }}
                  transition={{ type: "spring", stiffness: 320, damping: 14 }}
                >
                  <Gem />
                  {/* sparkle burst */}
                  {!exposed && (
                    <>
                      {[0, 60, 120, 180, 240, 300].map((a) => (
                        <motion.span
                          key={a}
                          className="absolute left-1/2 top-1/2 h-[3px] w-[3px] rounded-full"
                          style={{ background: "#fff", boxShadow: `0 0 6px ${ACCENT}` }}
                          initial={{ x: "-50%", y: "-50%", opacity: 1, scale: 0 }}
                          animate={{
                            x: `calc(-50% + ${Math.cos((a * Math.PI) / 180) * 26}px)`,
                            y: `calc(-50% + ${Math.sin((a * Math.PI) / 180) * 26}px)`,
                            opacity: 0,
                            scale: 1.6,
                          }}
                          transition={{ duration: 0.55, ease: "easeOut" }}
                        />
                      ))}
                    </>
                  )}
                </motion.div>
              ) : (
                <motion.div
                  className="relative h-full w-full"
                  initial={detonated ? { scale: 0.4 } : { scale: 0.6, opacity: 0 }}
                  animate={
                    detonated
                      ? { scale: [0.4, 1.35, 1], rotate: [0, -8, 4, 0] }
                      : { scale: 1, opacity: 1 }
                  }
                  transition={{ duration: detonated ? 0.5 : 0.3 }}
                >
                  <Bomb lit={detonated} />
                  {detonated && (
                    <>
                      {/* explosion flash */}
                      <motion.span
                        className="absolute inset-0 rounded-full"
                        style={{
                          background:
                            "radial-gradient(circle, rgba(255,210,120,0.95), rgba(255,90,40,0.5) 45%, transparent 70%)",
                        }}
                        initial={{ scale: 0, opacity: 0.95 }}
                        animate={{ scale: 2.4, opacity: 0 }}
                        transition={{ duration: 0.6, ease: "easeOut" }}
                      />
                      {/* shrapnel */}
                      {[0, 45, 90, 135, 180, 225, 270, 315].map((a) => (
                        <motion.span
                          key={a}
                          className="absolute left-1/2 top-1/2 h-1 w-1 rounded-full"
                          style={{ background: "#ffd56b" }}
                          initial={{ x: "-50%", y: "-50%", opacity: 1 }}
                          animate={{
                            x: `calc(-50% + ${Math.cos((a * Math.PI) / 180) * 34}px)`,
                            y: `calc(-50% + ${Math.sin((a * Math.PI) / 180) * 34}px)`,
                            opacity: 0,
                          }}
                          transition={{ duration: 0.5, ease: "easeOut" }}
                        />
                      ))}
                    </>
                  )}
                </motion.div>
              ))}
          </div>
        </motion.div>
      </motion.button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// MAIN COMPONENT
// ---------------------------------------------------------------------------
export default function Mines() {
  const wallet = useWallet();
  const { balance, ready } = wallet;

  const [bet, setBet] = useState(DEFAULT_BET);
  const [mines, setMines] = useState(DEFAULT_MINES);
  const [phase, setPhase] = useState<Phase>("betting");

  // Round state. `mineSet` holds the indices that are mines for this round.
  const [mineSet, setMineSet] = useState<Set<number>>(new Set());
  // `revealed` = tiles currently flipped face-up (visual). `picked` = the gems
  // the player actually clicked during play (drives the multiplier and stays
  // stable even after we flip the whole board open at round end).
  const [revealed, setRevealed] = useState<Set<number>>(new Set());
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [detonatedIdx, setDetonatedIdx] = useState<number | null>(null);
  const [stake, setStake] = useState(0);
  const [resolving, setResolving] = useState(false); // brief lock during reveal anim
  // Synchronous re-entrancy guard so a rapid double-click can never resolve a
  // round (cash out / bust) twice before React re-renders.
  const lockRef = useRef(false);
  // Guards async reveal continuations against setState-after-unmount.
  const mountedRef = useRef(true);
  useEffect(() => () => {
    mountedRef.current = false;
  }, []);

  // Result feedback.
  const [result, setResult] = useState<{ won: boolean; amount: number; text: string } | null>(
    null,
  );

  const safeCount = picked.size; // gems the player has banked this round
  const inRound = phase === "playing";
  const maxMinesForGrid = TILES - 1; // must leave at least one gem

  // Derived multipliers.
  const currentMult = useMemo(
    () => multiplierFor(mines, safeCount),
    [mines, safeCount],
  );
  const nextMult = useMemo(
    () => multiplierFor(mines, safeCount + 1),
    [mines, safeCount],
  );
  const cashoutValue = stake * currentMult;

  const affordable = bet >= MIN_BET && bet <= balance;
  const canCashOut = inRound && safeCount > 0 && !resolving;
  const gemsRemaining = TILES - mines - safeCount;

  // -- bet adjusters -------------------------------------------------------
  const clampBet = useCallback(
    (n: number) => clamp(Math.floor(n), MIN_BET, Math.max(MIN_BET, balance)),
    [balance],
  );
  const addChip = (v: number) => {
    if (phase !== "betting") return;
    sfx.chip();
    setBet((b) => clampBet(b + v));
  };
  const setBetSafe = (n: number) => {
    if (phase !== "betting") return;
    setBet(clampBet(n));
  };

  // -- start a round -------------------------------------------------------
  const startRound = useCallback(() => {
    if (phase !== "betting") return;
    if (bet < MIN_BET || bet > balance) return;
    if (!wallet.bet(bet)) return; // deduct stake; abort if unaffordable

    const positions = shuffle(Array.from({ length: TILES }, (_, i) => i)).slice(0, mines);
    lockRef.current = false;
    setMineSet(new Set(positions));
    setRevealed(new Set());
    setPicked(new Set());
    setDetonatedIdx(null);
    setStake(bet);
    setResult(null);
    setPhase("playing");
    sfx.chip();
  }, [phase, bet, balance, mines, wallet]);

  // -- pick a tile ---------------------------------------------------------
  const pickTile = useCallback(
    (i: number) => {
      if (phase !== "playing" || resolving || lockRef.current) return;
      if (revealed.has(i)) return;

      if (mineSet.has(i)) {
        // BOOM — reveal the detonated mine, then the rest of the board.
        lockRef.current = true;
        setResolving(true);
        setDetonatedIdx(i);
        setRevealed((r) => new Set(r).add(i));
        sfx.thud();
        sfx.lose();
        const lost = stake;
        // Reveal whole board shortly after the explosion.
        void (async () => {
          await sleep(420);
          if (!mountedRef.current) return;
          setRevealed(new Set(Array.from({ length: TILES }, (_, k) => k)));
          await sleep(120);
          if (!mountedRef.current) return;
          setPhase("busted");
          setResult({
            won: false,
            amount: -lost,
            text: `Boom! You hit a mine. Lost ${formatChips(lost)}.`,
          });
          setResolving(false);
        })();
        return;
      }

      // Safe gem — flip it and bank it.
      setRevealed((r) => new Set(r).add(i));
      setPicked((p) => new Set(p).add(i));
      sfx.card();

      const newSafe = picked.size + 1;
      // Auto-resolve if every gem has been found (perfect clear).
      if (newSafe >= TILES - mines) {
        lockRef.current = true;
        setResolving(true);
        const mult = multiplierFor(mines, newSafe);
        const gross = stake * mult;
        void (async () => {
          await sleep(360);
          wallet.win(gross); // credit even if the player navigated away mid-reveal
          if (!mountedRef.current) return;
          // expose the (now obvious) mines too
          setRevealed(new Set(Array.from({ length: TILES }, (_, k) => k)));
          setPhase("cashed");
          setResult({
            won: true,
            amount: gross - stake,
            text: `Perfect clear! All gems found — won ${formatChips(gross)}.`,
          });
          sfx.jackpot();
          setResolving(false);
        })();
      } else {
        sfx.tick();
      }
    },
    [phase, resolving, revealed, picked, mineSet, mines, stake, wallet],
  );

  // -- cash out ------------------------------------------------------------
  const cashOut = useCallback(() => {
    if (!canCashOut || lockRef.current) return;
    lockRef.current = true;
    setResolving(true);
    const mult = currentMult;
    const gross = stake * mult;
    wallet.win(gross);
    // Reveal the remaining board so the player sees where the mines were.
    setRevealed(new Set(Array.from({ length: TILES }, (_, k) => k)));
    setPhase("cashed");
    setResult({
      won: true,
      amount: gross - stake,
      text: `Cashed out at ${formatMultiplier(mult)} — won ${formatChips(gross)}.`,
    });
    const big = gross >= stake * 5;
    if (big) sfx.jackpot();
    else sfx.win();
    setResolving(false);
  }, [canCashOut, currentMult, stake, wallet]);

  // -- new round / reset to betting ---------------------------------------
  const newRound = useCallback(() => {
    lockRef.current = false;
    setResolving(false);
    setPhase("betting");
    setMineSet(new Set());
    setRevealed(new Set());
    setPicked(new Set());
    setDetonatedIdx(null);
    setResult(null);
    setStake(0);
    setBet((b) => clampBet(b)); // keep bet within new balance
    sfx.click();
  }, [clampBet]);

  // Keep bet affordable if balance changes while idle.
  useEffect(() => {
    if (phase === "betting" && bet > balance) setBet(clampBet(balance));
  }, [balance, phase, bet, clampBet]);

  const tileKind = (i: number): TileKind => (mineSet.has(i) ? "mine" : "gem");

  const roundOver = phase === "busted" || phase === "cashed";

  // Win-celebration inputs. A win is a successful cash-out / perfect clear
  // (phase "cashed", payout > 0). `won` gates the overlay; the gross payout
  // seeds it so each cash-out re-fires; the realized multiplier sets intensity.
  const cashedWon = phase === "cashed" && result?.won === true;
  const winPayout = cashedWon && result ? result.amount + stake : 0; // gross return
  const winMult = cashedWon && stake > 0 ? winPayout / stake : 0;
  const winTier: "win" | "big" | "jackpot" =
    winMult >= 10 ? "jackpot" : winMult >= 3 ? "big" : "win";

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-2 sm:gap-4">
      {/* ---- Surface ---- */}
      <div
        className="felt relative overflow-hidden rounded-3xl p-3 sm:p-6"
        style={{ boxShadow: `0 0 0 1px ${ACCENT}22, 0 24px 60px rgba(0,0,0,0.5)` }}
      >
        {/* ambient grid glow */}
        <div className="bg-grid pointer-events-none absolute inset-0 opacity-20" />

        {/* win celebration — fires only on a net-positive cash-out, not on bust or break-even */}
        <Celebration
          show={cashedWon && winPayout > stake}
          seed={winPayout}
          tier={winTier}
          colors={["#8aff80", "#22e1ff", "#ffd24a", "#ffffff"]}
        />

        {/* ---- Header: title + live stats ---- */}
        <div className="relative mb-3 flex flex-wrap items-center justify-between gap-2 sm:mb-4 sm:gap-3">
          <div>
            <h2 className="font-display text-2xl font-bold tracking-wide" style={{ color: ACCENT }}>
              Mines
            </h2>
            <p className="text-xs text-white/50">
              Uncover gems, dodge the mines, cash out before you blow.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Stat label="Mult" highlight>
              <CountingNumber value={inRound || roundOver ? currentMult : 1} decimals={2} suffix="×" duration={350} />
            </Stat>
            <Stat label="Cash Out">
              {inRound && safeCount > 0 ? (
                <CountingNumber value={cashoutValue} />
              ) : (
                <span className="opacity-50">—</span>
              )}
            </Stat>
            <Stat label="Balance">
              <CountingNumber value={ready ? balance : 0} />
            </Stat>
          </div>
        </div>

        <div className="relative grid gap-4 lg:grid-cols-[minmax(0,1fr)_260px]">
          {/* ---- Grid + result overlay ---- */}
          <div className="relative">
            <motion.div
              className="mx-auto grid grid-cols-5 gap-2 sm:gap-3 [@media(max-height:600px)]:max-w-[300px]"
              animate={
                phase === "busted"
                  ? { x: [0, -8, 8, -6, 6, 0] }
                  : { x: 0 }
              }
              transition={{ duration: 0.45 }}
            >
              {Array.from({ length: TILES }, (_, i) => (
                <Tile
                  key={i}
                  index={i}
                  kind={tileKind(i)}
                  revealed={revealed.has(i)}
                  detonated={detonatedIdx === i}
                  // Dim tiles auto-flipped at round end (not picked by the
                  // player and not the detonated mine) so real picks pop.
                  exposed={roundOver && !picked.has(i) && detonatedIdx !== i}
                  disabled={phase !== "playing" || resolving || revealed.has(i)}
                  onPick={pickTile}
                />
              ))}
            </motion.div>

            {/* progress strip */}
            <div className="mt-3 flex items-center justify-between text-xs text-white/55">
              <span>
                Gems found:{" "}
                <span style={{ color: ACCENT }} className="font-semibold tabular-nums">
                  {inRound || roundOver ? safeCount : 0}
                </span>
              </span>
              <span>
                Mines:{" "}
                <span className="font-semibold tabular-nums text-red-300">{mines}</span>
                {" · "}Gems left:{" "}
                <span className="font-semibold tabular-nums">
                  {inRound ? gemsRemaining : TILES - mines}
                </span>
              </span>
            </div>

            {/* Result banner */}
            <AnimatePresence>
              {result && roundOver && (
                <motion.div
                  key="result"
                  data-testid="round-result"
                  initial={{ opacity: 0, y: 16, scale: 0.96 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.96 }}
                  transition={{ type: "spring", stiffness: 260, damping: 20 }}
                  className="mt-3 rounded-2xl px-4 py-3 text-center"
                  style={{
                    background: result.won
                      ? `linear-gradient(180deg, ${ACCENT}22, rgba(0,0,0,0.4))`
                      : "linear-gradient(180deg, rgba(220,60,40,0.22), rgba(0,0,0,0.4))",
                    border: result.won
                      ? `1px solid ${ACCENT}88`
                      : "1px solid rgba(220,60,40,0.7)",
                  }}
                >
                  <div
                    className="text-sm font-semibold"
                    style={{ color: result.won ? ACCENT : "#ff8a7a" }}
                  >
                    {result.text}
                  </div>
                  <div
                    className="text-lg font-bold tabular-nums"
                    style={{ color: result.won ? ACCENT : "#ff8a7a" }}
                  >
                    {formatDelta(result.amount)}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* win burst confetti */}
            <AnimatePresence>
              {result?.won && roundOver && (
                <div className="pointer-events-none absolute inset-0 overflow-hidden">
                  {Array.from({ length: 26 }).map((_, i) => {
                    const angle = (i / 26) * Math.PI * 2;
                    const dist = 120 + (i % 5) * 26;
                    return (
                      <motion.span
                        key={i}
                        className="absolute left-1/2 top-1/2 h-2 w-2 rounded-sm"
                        style={{
                          background: i % 2 ? ACCENT : "#f5d060",
                        }}
                        initial={{ x: "-50%", y: "-50%", opacity: 1, scale: 1 }}
                        animate={{
                          x: `calc(-50% + ${Math.cos(angle) * dist}px)`,
                          y: `calc(-50% + ${Math.sin(angle) * dist + 60}px)`,
                          opacity: 0,
                          rotate: 360,
                          scale: 0.4,
                        }}
                        transition={{ duration: 1.1, ease: "easeOut" }}
                      />
                    );
                  })}
                </div>
              )}
            </AnimatePresence>
          </div>

          {/* ---- Side panel: mines selector, controls, odds ---- */}
          <div className="flex flex-col gap-3">
            {/* Mines count selector */}
            <div className="glass rounded-2xl p-3">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-[10px] uppercase tracking-widest text-white/45">
                  Mines
                </span>
                <span
                  className="rounded-md px-2 py-0.5 text-sm font-bold tabular-nums"
                  style={{ background: "rgba(255,255,255,0.06)", color: "#ff8a7a" }}
                >
                  {mines}
                </span>
              </div>
              <input
                type="range"
                min={MIN_MINES}
                max={Math.min(MAX_MINES, maxMinesForGrid)}
                value={mines}
                disabled={phase !== "betting"}
                data-testid="mines-slider"
                onChange={(e) => {
                  sfx.tick();
                  setMines(clamp(parseInt(e.target.value, 10), MIN_MINES, MAX_MINES));
                }}
                className="w-full accent-[#8aff80] disabled:opacity-40"
                aria-label="Number of mines"
              />
              <div className="mt-2 flex flex-wrap gap-1.5">
                {MINE_PRESETS.map((m) => (
                  <button
                    key={m}
                    type="button"
                    data-testid={`mines-${m}`}
                    disabled={phase !== "betting"}
                    onClick={() => {
                      sfx.click();
                      setMines(m);
                    }}
                    className="flex-1 rounded-lg px-1 py-1 text-xs font-semibold transition-colors disabled:opacity-40"
                    style={
                      mines === m
                        ? { background: ACCENT, color: "#062b0a" }
                        : { background: "rgba(255,255,255,0.06)", color: "rgba(255,255,255,0.7)" }
                    }
                  >
                    {m}
                  </button>
                ))}
              </div>
            </div>

            {/* Primary controls */}
            <div className="glass flex flex-col gap-2 rounded-2xl p-3">
              {phase === "betting" && (
                <Button
                  variant="neon"
                  size="lg"
                  block
                  data-testid="play-btn"
                  disabled={!ready || !affordable}
                  onClick={startRound}
                >
                  {affordable ? `Start · ${formatChips(bet)}` : "Insufficient balance"}
                </Button>
              )}

              {inRound && (
                <>
                  <Button
                    variant="gold"
                    size="lg"
                    block
                    data-testid="cashout-btn"
                    disabled={!canCashOut}
                    onClick={cashOut}
                  >
                    {safeCount > 0
                      ? `Cash Out ${formatChips(cashoutValue)}`
                      : "Pick a tile to start"}
                  </Button>
                  <div className="rounded-xl bg-black/30 px-3 py-2 text-center text-xs text-white/55">
                    Next tile pays{" "}
                    <span style={{ color: ACCENT }} className="font-semibold">
                      {formatMultiplier(nextMult)}
                    </span>
                  </div>
                </>
              )}

              {roundOver && (
                <Button
                  variant="neon"
                  size="lg"
                  block
                  data-testid="play-btn"
                  disabled={!ready || !affordable}
                  onClick={newRound}
                >
                  New Round
                </Button>
              )}
            </div>

            {/* Bet panel — only editable while betting */}
            <div className="glass rounded-2xl p-3">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-[10px] uppercase tracking-widest text-white/45">Bet</span>
                <span className="gold-text text-lg font-bold tabular-nums">
                  {formatChips(bet)}
                </span>
              </div>
              <div className="flex flex-wrap items-center justify-center gap-1.5">
                {CHIPS.map((v) => (
                  <Chip
                    key={v}
                    value={v}
                    size={42}
                    onClick={phase === "betting" && v <= balance ? () => addChip(v) : undefined}
                  />
                ))}
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                <Button
                  size="sm"
                  variant="ghost"
                  className="flex-1"
                  data-testid="bet-clear"
                  disabled={phase !== "betting"}
                  onClick={() => setBetSafe(MIN_BET)}
                >
                  Min
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="flex-1"
                  data-testid="bet-half"
                  disabled={phase !== "betting"}
                  onClick={() => setBetSafe(Math.floor(bet / 2))}
                >
                  ½
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="flex-1"
                  data-testid="bet-double"
                  disabled={phase !== "betting"}
                  onClick={() => setBetSafe(bet * 2)}
                >
                  2×
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="flex-1"
                  data-testid="bet-max"
                  disabled={phase !== "betting"}
                  onClick={() => setBetSafe(balance)}
                >
                  Max
                </Button>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ---- Odds / paytable panel ---- */}
      <OddsPanel mines={mines} bet={phase === "betting" ? bet : stake || bet} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Small stat readout pill.
// ---------------------------------------------------------------------------
function Stat({
  label,
  children,
  highlight,
}: {
  label: string;
  children: React.ReactNode;
  highlight?: boolean;
}) {
  return (
    <div
      className="rounded-xl px-3 py-1.5 text-center"
      style={{
        background: "rgba(0,0,0,0.35)",
        border: highlight ? `1px solid ${ACCENT}55` : "1px solid rgba(255,255,255,0.08)",
        minWidth: 78,
      }}
    >
      <div className="text-[9px] uppercase tracking-widest text-white/40">{label}</div>
      <div
        className="text-sm font-bold tabular-nums"
        style={{ color: highlight ? ACCENT : "#fff" }}
      >
        {children}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Odds / paytable panel — shows the multiplier ladder for the current mine
// count, plus the survival probability of the next pick.
// ---------------------------------------------------------------------------
function OddsPanel({ mines, bet }: { mines: number; bet: number }) {
  const maxGems = TILES - mines;
  // Show up to the first ~8 milestones so the panel stays compact.
  const milestones = useMemo(() => {
    const picks = Math.min(maxGems, 8);
    const out: { k: number; mult: number }[] = [];
    for (let k = 1; k <= picks; k++) out.push({ k, mult: multiplierFor(mines, k) });
    return out;
  }, [mines, maxGems]);

  const nextSurvival = ((TILES - mines) / TILES) * 100;

  return (
    <CollapsiblePanel
      title={`Payout Ladder · ${mines} mine${mines === 1 ? "" : "s"}`}
      accent={ACCENT}
      summary={
        <>
          First pick safe{" "}
          <span style={{ color: ACCENT }} className="font-semibold tabular-nums">
            {nextSurvival.toFixed(1)}%
          </span>
        </>
      }
    >
      <div className="mb-2 flex items-center justify-end">
        <span className="text-[11px] text-white/45">
          First pick safe:{" "}
          <span style={{ color: ACCENT }} className="font-semibold tabular-nums">
            {nextSurvival.toFixed(1)}%
          </span>
        </span>
      </div>
      <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
        {milestones.map(({ k, mult }) => (
          <div
            key={k}
            className="flex items-center justify-between rounded-lg px-2.5 py-1.5"
            style={{ background: "rgba(255,255,255,0.05)" }}
          >
            <span className="text-[11px] text-white/50">{k} gem{k === 1 ? "" : "s"}</span>
            <span className="text-xs font-bold tabular-nums" style={{ color: ACCENT }}>
              {formatMultiplier(mult)}
            </span>
          </div>
        ))}
      </div>
      <p className="mt-2 text-[11px] leading-relaxed text-white/40">
        Each safe gem grows your multiplier. Cash out anytime after the first
        gem to bank{" "}
        <span className="text-white/70">bet × multiplier</span>. Hit a mine and
        you lose the stake. House edge {Math.round(HOUSE_EDGE * 100)}%.
        {bet > 0 && (
          <>
            {" "}At {formatChips(bet)} bet, clearing all {maxGems} gems pays{" "}
            <span style={{ color: ACCENT }} className="font-semibold">
              {formatChips(bet * multiplierFor(mines, maxGems))}
            </span>
            .
          </>
        )}
      </p>
    </CollapsiblePanel>
  );
}
