"use client";

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  AnimatePresence,
  motion,
} from "framer-motion";
import { useWallet } from "@/lib/wallet";
import { weightedPick, shuffle, pick } from "@/lib/rng";
import { formatChips, formatMultiplier, formatDelta } from "@/lib/format";
import { sfx } from "@/lib/sound";
import { Button } from "@/components/ui/Button";
import { BetControls } from "@/components/BetControls";
import { CountingNumber } from "@/components/CountingNumber";

/* ================================================================== *
 * Neon Royale — Scratch Cards
 * Accent: #f5d060
 *
 * Buy a card for your bet. The 3×3 grid of prize symbols is PRE-ROLLED
 * the instant you buy, so the outcome is fixed (no edge-chasing). Match
 * three of the same symbol to win that symbol's prize multiplier of the
 * stake — win(prizeMultiplier * bet) where the multiplier INCLUDES the
 * stake. No triple = no win.
 *
 * Reveal it however you like: drag across each foil panel to scratch it
 * off (real <canvas> erasing), tap a panel to flip it, or hit REVEAL ALL.
 * ================================================================== */

const ACCENT = "#f5d060";
const MIN_BET = 1;
const GRID = 9; // 3×3

/* ---- Themes ------------------------------------------------------- *
 * Each theme is a self-contained scratch ticket with its own prize
 * symbols and weighted distribution. Weights drive how often each
 * symbol is the WINNING triple AND how often a card loses. Tuned so the
 * theoretical RTP sits a little under 1 (a healthy house edge) — see
 * the RTP assertion comment below each table.
 * ------------------------------------------------------------------ */

interface Prize {
  key: string;
  glyph: string;
  label: string;
  color: string;
  /** Payout multiplier of the stake when you match three. Includes stake. */
  mult: number;
  /** Relative weight that THIS symbol is the winning triple on a card. */
  weight: number;
}

interface Theme {
  id: string;
  name: string;
  tagline: string;
  /** Card face gradient. */
  bg: string;
  /** Foil overlay gradient (the bit you scratch off). */
  foil: string;
  accent: string;
  prizes: Prize[];
  /** Relative weight of a LOSING card (no triple). Bigger = harder. */
  loseWeight: number;
}

/*
 * RTP for a theme = Σ(prize.mult * prize.weight) / (loseWeight + Σ prize.weight).
 * Each table below is balanced to ~0.90–0.93.
 */
const THEMES: Theme[] = [
  {
    id: "gold",
    name: "Gold Rush",
    tagline: "Strike it rich in the mine",
    bg: "linear-gradient(150deg, #3a2c08 0%, #1a1403 60%, #0c0a02 100%)",
    foil: "linear-gradient(135deg, #cda23b 0%, #f5d060 38%, #fff4c2 50%, #f5d060 62%, #b9892a 100%)",
    accent: "#f5d060",
    loseWeight: 3150,
    prizes: [
      { key: "coin", glyph: "🪙", label: "Coin", color: "#f5d060", mult: 2, weight: 760 },
      { key: "pick", glyph: "⛏️", label: "Pickaxe", color: "#cda23b", mult: 4, weight: 290 },
      { key: "nugget", glyph: "💰", label: "Gold Bag", color: "#ffd166", mult: 10, weight: 62 },
      { key: "bar", glyph: "🧈", label: "Gold Bar", color: "#ffe9a8", mult: 30, weight: 12 },
      { key: "crown", glyph: "👑", label: "King's Crown", color: "#fff4c2", mult: 250, weight: 1 },
    ],
    // RTP ≈ 0.915 (house edge ~8.5%), win chance ~26%.
  },
  {
    id: "sevens",
    name: "Lucky Sevens",
    tagline: "Old-school fruit machine luck",
    bg: "linear-gradient(150deg, #2a0a12 0%, #160409 60%, #0a0204 100%)",
    foil: "linear-gradient(135deg, #b13a3a 0%, #ff5d73 40%, #ffd1d8 50%, #ff5d73 60%, #8a1f2c 100%)",
    accent: "#ff5d73",
    loseWeight: 3450,
    prizes: [
      { key: "cherry", glyph: "🍒", label: "Cherry", color: "#ff5d73", mult: 2, weight: 740 },
      { key: "bell", glyph: "🔔", label: "Bell", color: "#ffd166", mult: 5, weight: 255 },
      { key: "bar", glyph: "🅱️", label: "BAR", color: "#22e1ff", mult: 12, weight: 52 },
      { key: "seven", glyph: "7️⃣", label: "Lucky 7", color: "#ff4da6", mult: 40, weight: 9 },
      { key: "diamond7", glyph: "💎", label: "Triple 7s", color: "#fff", mult: 300, weight: 1 },
    ],
    // RTP ≈ 0.896 (house edge ~10.4%), win chance ~23%.
  },
  {
    id: "neon",
    name: "Neon Diamonds",
    tagline: "Chase the electric jackpot",
    bg: "linear-gradient(150deg, #07182a 0%, #050b16 60%, #02060c 100%)",
    foil: "linear-gradient(135deg, #1773a8 0%, #22e1ff 40%, #d6fbff 50%, #22e1ff 60%, #0e5e86 100%)",
    accent: "#22e1ff",
    loseWeight: 3650,
    prizes: [
      { key: "star", glyph: "⭐", label: "Star", color: "#ffe14d", mult: 2, weight: 760 },
      { key: "bolt", glyph: "⚡", label: "Bolt", color: "#22e1ff", mult: 5, weight: 260 },
      { key: "gem", glyph: "🔷", label: "Sapphire", color: "#7cd4ff", mult: 15, weight: 44 },
      { key: "ring", glyph: "💍", label: "Diamond Ring", color: "#fff", mult: 60, weight: 7 },
      { key: "trophy", glyph: "🏆", label: "Royale Jackpot", color: "#fff4c2", mult: 400, weight: 1 },
    ],
    // RTP ≈ 0.911 (house edge ~8.9%), win chance ~23%.
  },
];

/* ---- Outcome pre-roll -------------------------------------------- *
 * On purchase we lock in the card. A WINNING card places three of one
 * symbol at random positions; the other six are random non-triple fill.
 * A LOSING card guarantees no symbol appears three times anywhere.
 * ------------------------------------------------------------------ */

interface CardOutcome {
  /** The 9 symbol keys, grid order (row-major). */
  cells: string[];
  /** The winning prize, or null for a losing card. */
  prize: Prize | null;
  /** The three winning cell indices (sorted), or [] for a loser. */
  winCells: number[];
}

/** Fill the non-winning cells so that NO symbol reaches a count of 3. */
function fillNoTriple(
  theme: Theme,
  fixed: Map<number, string>,
  count: number,
): string[] {
  const keys = theme.prizes.map((p) => p.key);
  const cells: string[] = new Array(GRID).fill("");
  const tally = new Map<string, number>();
  for (const [idx, k] of fixed) {
    cells[idx] = k;
    tally.set(k, (tally.get(k) ?? 0) + 1);
  }
  const open: number[] = [];
  for (let i = 0; i < count; i++) if (!fixed.has(i)) open.push(i);

  for (const idx of shuffle(open)) {
    // candidate symbols that won't reach 3 of a kind
    const cand = keys.filter((k) => (tally.get(k) ?? 0) < 2);
    const pool = cand.length > 0 ? cand : keys;
    // pick() is safe here: pool is always non-empty (theme always has prizes)
    const choice = pick(pool) ?? pool[0];
    cells[idx] = choice;
    tally.set(choice, (tally.get(choice) ?? 0) + 1);
  }
  return cells;
}

function rollCard(theme: Theme): CardOutcome {
  // Decide win/lose + which symbol wins, weighted.
  const options: (Prize | null)[] = [null, ...theme.prizes];
  const weights = [theme.loseWeight, ...theme.prizes.map((p) => p.weight)];
  const prize = weightedPick(options, weights);

  if (!prize) {
    // Losing card: no triple anywhere.
    return { cells: fillNoTriple(theme, new Map(), GRID), prize: null, winCells: [] };
  }

  // Winning card: drop three of `prize` at random positions, then fill rest.
  const positions = shuffle(Array.from({ length: GRID }, (_, i) => i)).slice(0, 3);
  const fixed = new Map<number, string>();
  for (const p of positions) fixed.set(p, prize.key);
  const cells = fillNoTriple(theme, fixed, GRID);
  return { cells, prize, winCells: positions.slice().sort((a, b) => a - b) };
}

/* ---- Sparkle burst (for winning matched panels) ------------------ */

function Sparkles({ color }: { color: string }) {
  const bits = useMemo(
    () =>
      Array.from({ length: 9 }, () => ({
        a: Math.random() * Math.PI * 2,
        d: 26 + Math.random() * 26,
        s: 0.3 + Math.random() * 0.7,
        delay: Math.random() * 0.18,
      })),
    [],
  );
  return (
    <div className="pointer-events-none absolute inset-0 grid place-items-center">
      {bits.map((b, i) => (
        <motion.span
          key={i}
          className="absolute"
          initial={{ x: 0, y: 0, opacity: 0, scale: 0 }}
          animate={{
            x: Math.cos(b.a) * b.d,
            y: Math.sin(b.a) * b.d,
            opacity: [0, 1, 0],
            scale: [0, b.s, 0],
          }}
          transition={{ duration: 0.8, delay: b.delay, ease: "easeOut" }}
          style={{ color, fontSize: 14, textShadow: `0 0 8px ${color}` }}
        >
          ✦
        </motion.span>
      ))}
    </div>
  );
}

/* ---- A single scratch panel -------------------------------------- *
 * Real <canvas> foil overlay. Dragging (or moving while pressed) erases
 * the foil with destination-out compositing. When ~58% is cleared we
 * auto-reveal the rest with a flip. Tapping also reveals (click-to-flip
 * fallback that works on every device + for keyboard users).
 * ------------------------------------------------------------------ */

interface PanelProps {
  symKey: string;
  theme: Theme;
  index: number;
  revealed: boolean;
  isWinCell: boolean;
  showWin: boolean;
  scratchEnabled: boolean;
  onReveal: (index: number) => void;
  dealDelay: number;
}

function Panel({
  symKey,
  theme,
  index,
  revealed,
  isWinCell,
  showWin,
  scratchEnabled,
  onReveal,
  dealDelay,
}: PanelProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const drawing = useRef(false);
  const last = useRef<{ x: number; y: number } | null>(null);
  const cleared = useRef(false);
  const prize = theme.prizes.find((p) => p.key === symKey);

  // (Re)paint the foil whenever the panel resets to a covered state.
  const paintFoil = useCallback(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    // offsetWidth/Height give the untransformed layout box, so the foil is
    // crisp even while the deal-in scale animation is mid-flight.
    const w = wrap.offsetWidth || 100;
    const h = wrap.offsetHeight || 100;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.floor(w * dpr));
    canvas.height = Math.max(1, Math.floor(h * dpr));
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalCompositeOperation = "source-over";
    // metallic foil gradient
    const g = ctx.createLinearGradient(0, 0, w, h);
    g.addColorStop(0, theme.accent + "cc");
    g.addColorStop(0.45, "#ffffff");
    g.addColorStop(0.5, "#ffffff");
    g.addColorStop(0.55, theme.accent + "cc");
    g.addColorStop(1, theme.accent + "88");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    // subtle "?" + sheen so it reads as a scratch surface
    ctx.fillStyle = "rgba(0,0,0,0.18)";
    ctx.font = `bold ${Math.floor(h * 0.42)}px serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("?", w / 2, h / 2);
    ctx.fillStyle = "rgba(255,255,255,0.22)";
    ctx.fillRect(0, h * 0.18, w, 2);
    cleared.current = false;
  }, [theme.accent]);

  useEffect(() => {
    if (revealed) return;
    // paint now, then again after layout settles (handles first-mount sizing).
    paintFoil();
    const raf = requestAnimationFrame(() => paintFoil());
    return () => cancelAnimationFrame(raf);
  }, [revealed, paintFoil]);

  // Repaint on resize so the foil keeps covering the panel.
  useEffect(() => {
    if (revealed) return;
    const onResize = () => paintFoil();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [revealed, paintFoil]);

  const erodeAt = useCallback((cx: number, cy: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const rect = canvas.getBoundingClientRect();
    const x = cx - rect.left;
    const y = cy - rect.top;
    const r = Math.max(12, rect.width * 0.16);
    ctx.globalCompositeOperation = "destination-out";
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    if (last.current) {
      // connect strokes so fast drags don't leave gaps
      ctx.lineWidth = r * 2;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(last.current.x - rect.left, last.current.y - rect.top);
      ctx.lineTo(x, y);
      ctx.stroke();
    }
    last.current = { x: cx, y: cy };
  }, []);

  /** Sample alpha to estimate how much foil is gone; reveal past threshold. */
  const checkCleared = useCallback(() => {
    if (cleared.current) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    if (canvas.width === 0 || canvas.height === 0) return;
    const step = 8;
    let clear = 0;
    let total = 0;
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    for (let i = 3; i < data.length; i += 4 * step) {
      total++;
      if (data[i] === 0) clear++;
    }
    if (total > 0 && clear / total > 0.55) {
      cleared.current = true;
      onReveal(index);
    }
  }, [index, onReveal]);

  const handleDown = (e: React.PointerEvent) => {
    if (!scratchEnabled || revealed) return;
    drawing.current = true;
    last.current = null;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    erodeAt(e.clientX, e.clientY);
    if (cleared.current) return;
    sfx.tick();
  };
  const handleMove = (e: React.PointerEvent) => {
    if (!drawing.current || !scratchEnabled || revealed) return;
    erodeAt(e.clientX, e.clientY);
    if (Math.random() < 0.4) sfx.tick();
    checkCleared();
  };
  const handleUp = () => {
    drawing.current = false;
    last.current = null;
    checkCleared();
  };

  return (
    <motion.div
      ref={wrapRef}
      className="relative aspect-square select-none overflow-hidden rounded-2xl"
      initial={{ opacity: 0, scale: 0.4, rotateY: 90 }}
      animate={{ opacity: 1, scale: 1, rotateY: 0 }}
      transition={{
        delay: dealDelay,
        type: "spring",
        stiffness: 320,
        damping: 22,
      }}
      style={{
        background: "linear-gradient(160deg, rgba(255,255,255,0.07), rgba(0,0,0,0.4))",
        border: showWin && isWinCell
          ? `2px solid ${theme.accent}`
          : "1px solid rgba(255,255,255,0.1)",
        boxShadow:
          showWin && isWinCell
            ? `0 0 0 2px ${theme.accent}, 0 0 26px ${theme.accent}bb, inset 0 0 20px ${theme.accent}55`
            : "inset 0 0 14px rgba(0,0,0,0.5)",
        transformStyle: "preserve-3d",
      }}
    >
      {/* faint symbol glow */}
      {prize && (
        <div
          className="pointer-events-none absolute inset-0 opacity-40"
          style={{
            background: `radial-gradient(circle at 50% 45%, ${prize.color}33, transparent 70%)`,
          }}
        />
      )}

      {/* the revealed symbol underneath the foil */}
      <motion.div
        className="absolute inset-0 grid place-items-center"
        animate={
          showWin && isWinCell
            ? { scale: [1, 1.22, 1] }
            : { scale: 1 }
        }
        transition={{ duration: 0.5, repeat: showWin && isWinCell ? Infinity : 0, repeatDelay: 0.6 }}
      >
        <span
          className="leading-none"
          style={{
            fontSize: "clamp(28px, 9vw, 56px)",
            filter:
              showWin && isWinCell
                ? `drop-shadow(0 0 12px ${theme.accent})`
                : revealed
                  ? "none"
                  : "none",
            opacity: revealed ? (showWin && !isWinCell ? 0.35 : 1) : 0,
            transition: "opacity 220ms ease",
          }}
        >
          {prize?.glyph ?? "❔"}
        </span>
      </motion.div>

      {showWin && isWinCell && <Sparkles color={theme.accent} />}

      {/* scratch-off foil canvas — fades + unmounts on reveal */}
      <AnimatePresence>
        {!revealed && (
          <motion.canvas
            ref={canvasRef}
            key="foil"
            className="absolute inset-0 h-full w-full touch-none"
            style={{ cursor: scratchEnabled ? "crosshair" : "default" }}
            initial={{ opacity: 1 }}
            exit={{ opacity: 0, scale: 1.08 }}
            transition={{ duration: 0.3 }}
            onPointerDown={handleDown}
            onPointerMove={handleMove}
            onPointerUp={handleUp}
            onPointerLeave={handleUp}
            onClick={() => {
              // tap-to-reveal fallback (also handles keyboard-less devices)
              if (scratchEnabled && !revealed) {
                sfx.card();
                onReveal(index);
              }
            }}
          />
        )}
      </AnimatePresence>
    </motion.div>
  );
}

/* ================================================================== *
 * Main component
 * ================================================================== */

type Phase = "betting" | "scratching" | "resolved";

export default function ScratchCards() {
  const wallet = useWallet();
  const { balance, ready } = wallet;

  const [bet, setBet] = useState(25);
  const [themeId, setThemeId] = useState<string>(THEMES[0].id);
  const theme = useMemo(
    () => THEMES.find((t) => t.id === themeId) ?? THEMES[0],
    [themeId],
  );

  const [phase, setPhase] = useState<Phase>("betting");
  const [card, setCard] = useState<CardOutcome | null>(null);
  const [revealed, setRevealed] = useState<boolean[]>(() =>
    new Array(GRID).fill(false),
  );
  const [stake, setStake] = useState(0); // locked bet for the active card
  const [roundId, setRoundId] = useState(0); // stable identity per purchased card
  const [showWin, setShowWin] = useState(false);
  const [lastWin, setLastWin] = useState(0);
  const [lastDelta, setLastDelta] = useState(0);
  const [resultText, setResultText] = useState("Pick a theme & buy a card");
  const [burst, setBurst] = useState(false);
  const resolvedRef = useRef(false);
  const buyingRef = useRef(false); // prevents rapid double-buy before state flushes

  const affordable = ready && balance >= Math.max(MIN_BET, bet);
  const allRevealed = phase === "scratching" && revealed.every(Boolean);

  /* ---- Buy a card -------------------------------------------------- */
  const buyCard = useCallback(() => {
    // Guard against rapid double-clicks before React flushes the phase state.
    if (phase === "scratching" || buyingRef.current) return;
    if (bet < MIN_BET) return;
    buyingRef.current = true;
    if (!wallet.bet(bet)) {
      sfx.lose();
      buyingRef.current = false;
      setResultText("Not enough chips for that card");
      return;
    }
    sfx.chip();
    const outcome = rollCard(theme);
    resolvedRef.current = false;
    buyingRef.current = false;
    setStake(bet);
    setRoundId((n) => n + 1);
    setCard(outcome);
    setRevealed(new Array(GRID).fill(false));
    setShowWin(false);
    setBurst(false);
    setLastWin(0);
    setLastDelta(0);
    setResultText("Scratch the panels to reveal your prizes…");
    setPhase("scratching");
  }, [phase, bet, wallet, theme]);

  /* ---- Resolve once everything is revealed ------------------------- */
  const resolve = useCallback(
    (outcome: CardOutcome, s: number) => {
      if (resolvedRef.current) return;
      resolvedRef.current = true;
      setShowWin(true);

      if (outcome.prize) {
        const gross = Math.round(outcome.prize.mult * s);
        wallet.win(gross);
        setLastWin(gross);
        setLastDelta(gross - s);
        setBurst(true);
        if (outcome.prize.mult >= 50) {
          sfx.jackpot();
          setResultText(
            `JACKPOT! Three ${outcome.prize.label} — ${formatMultiplier(
              outcome.prize.mult,
            )} → ${formatChips(gross)}!`,
          );
        } else {
          sfx.win();
          setResultText(
            `WINNER! Three ${outcome.prize.label} — ${formatMultiplier(
              outcome.prize.mult,
            )} → ${formatChips(gross)}`,
          );
        }
        window.setTimeout(() => setBurst(false), 2200);
      } else {
        sfx.lose();
        setLastWin(0);
        setLastDelta(-s);
        setResultText("No match this time — buy another card!");
      }
      setPhase("resolved");
    },
    [wallet],
  );

  /* ---- Reveal a single panel --------------------------------------- */
  const revealPanel = useCallback((index: number) => {
    setRevealed((prev) => {
      if (prev[index]) return prev;
      const next = prev.slice();
      next[index] = true;
      return next;
    });
  }, []);

  /* ---- Reveal all (button) ----------------------------------------- */
  const revealAll = useCallback(() => {
    if (phase !== "scratching") return;
    sfx.card();
    setRevealed(new Array(GRID).fill(true));
  }, [phase]);

  // When all panels are open, settle the round (slight beat for the flips).
  useEffect(() => {
    if (phase !== "scratching" || !card) return;
    if (!revealed.every(Boolean)) return;
    const t = window.setTimeout(() => resolve(card, stake), 360);
    return () => window.clearTimeout(t);
  }, [phase, card, revealed, stake, resolve]);

  const won = phase === "resolved" && lastWin > 0;
  const betLocked = phase === "scratching";

  // Winning cell lookup
  const winSet = useMemo(() => new Set(card?.winCells ?? []), [card]);
  const revealedCount = revealed.filter(Boolean).length;

  return (
    <div className="mx-auto w-full max-w-5xl">
      {/* Header / stats */}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <h2
            className="font-display text-2xl font-bold tracking-wide sm:text-3xl"
            style={{ color: ACCENT, textShadow: `0 0 18px ${ACCENT}80` }}
          >
            Scratch Cards
          </h2>
          <span className="text-xs uppercase tracking-[0.3em] text-white/40">
            Match 3 to win
          </span>
        </div>
        <div className="flex items-center gap-4 text-right">
          <div>
            <div className="text-[10px] uppercase tracking-widest text-white/40">
              Balance
            </div>
            <div className="gold-text text-lg font-bold tabular-nums">
              <CountingNumber value={balance} />
            </div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-widest text-white/40">
              Last Win
            </div>
            <div
              className="text-lg font-bold tabular-nums"
              style={{ color: won ? theme.accent : "rgba(255,255,255,0.55)" }}
            >
              <CountingNumber value={lastWin} />
            </div>
          </div>
        </div>
      </div>

      {/* Theme selector */}
      <div className="mb-3 grid grid-cols-3 gap-2 sm:gap-3">
        {THEMES.map((t) => {
          const active = t.id === themeId;
          return (
            <motion.button
              key={t.id}
              type="button"
              disabled={betLocked}
              data-testid={`theme-${t.id}`}
              onClick={() => {
                if (betLocked) return;
                sfx.click();
                setThemeId(t.id);
              }}
              whileHover={betLocked ? undefined : { y: -2 }}
              whileTap={betLocked ? undefined : { scale: 0.97 }}
              className="relative overflow-hidden rounded-xl px-2 py-2 text-left transition disabled:opacity-50 sm:px-3 sm:py-3"
              style={{
                background: t.bg,
                border: active
                  ? `2px solid ${t.accent}`
                  : "1px solid rgba(255,255,255,0.1)",
                boxShadow: active ? `0 0 18px ${t.accent}66` : "none",
              }}
            >
              <div
                className="text-xs font-bold tracking-wide sm:text-sm"
                style={{ color: t.accent }}
              >
                {t.name}
              </div>
              <div className="mt-0.5 hidden text-[10px] text-white/45 sm:block">
                {t.tagline}
              </div>
              <div className="mt-1 text-[10px] font-semibold text-white/55">
                Top prize {formatMultiplier(t.prizes[t.prizes.length - 1].mult)}
              </div>
              {active && (
                <motion.div
                  layoutId="theme-active"
                  className="pointer-events-none absolute inset-0 rounded-xl"
                  style={{ boxShadow: `inset 0 0 24px ${t.accent}33` }}
                  transition={{ type: "spring", stiffness: 300, damping: 28 }}
                />
              )}
            </motion.button>
          );
        })}
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.55fr_1fr]">
        {/* ---- The ticket --------------------------------------------- */}
        <div
          className="felt relative overflow-hidden rounded-3xl p-4 sm:p-6"
          style={{ boxShadow: `inset 0 0 60px rgba(0,0,0,0.45)` }}
        >
          {/* ticket backdrop tinted by theme */}
          <div
            className="pointer-events-none absolute inset-0 opacity-70"
            style={{ background: theme.bg }}
          />
          <div className="relative">
            {/* ticket header strip */}
            <div className="mb-3 flex items-center justify-between">
              <div
                className="font-display text-base font-bold sm:text-lg"
                style={{ color: theme.accent, textShadow: `0 0 14px ${theme.accent}66` }}
              >
                {theme.name}
              </div>
              <div className="rounded-full border border-white/15 bg-black/30 px-3 py-1 text-[10px] uppercase tracking-widest text-white/60">
                {phase === "betting"
                  ? "Awaiting purchase"
                  : phase === "scratching"
                    ? `Revealed ${revealedCount}/${GRID}`
                    : won
                      ? "Winner"
                      : "No win"}
              </div>
            </div>

            {/* 3×3 grid */}
            <div className="relative">
              <AnimatePresence mode="wait">
                {phase === "betting" || !card ? (
                  <motion.div
                    key="empty"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="grid place-items-center rounded-2xl border border-dashed border-white/15 bg-black/20"
                    style={{ aspectRatio: "1 / 1" }}
                  >
                    <div className="px-6 text-center">
                      <motion.div
                        className="text-5xl sm:text-6xl"
                        animate={{ y: [0, -8, 0], rotate: [-4, 4, -4] }}
                        transition={{ repeat: Infinity, duration: 3, ease: "easeInOut" }}
                      >
                        🎟️
                      </motion.div>
                      <div className="mt-3 text-sm font-semibold text-white/70">
                        Buy a {theme.name} card to play
                      </div>
                      <div className="mt-1 text-xs text-white/40">
                        Scratch or tap panels · match 3 of a symbol to win
                      </div>
                    </div>
                  </motion.div>
                ) : (
                  <motion.div
                    key={`grid-${roundId}`}
                    className="grid grid-cols-3 gap-2 sm:gap-3"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                  >
                    {card.cells.map((symKey, i) => (
                      <Panel
                        key={`${roundId}-${i}`}
                        index={i}
                        symKey={symKey}
                        theme={theme}
                        revealed={revealed[i]}
                        isWinCell={winSet.has(i)}
                        showWin={showWin}
                        scratchEnabled={phase === "scratching"}
                        onReveal={revealPanel}
                        dealDelay={i * 0.05}
                      />
                    ))}
                  </motion.div>
                )}
              </AnimatePresence>

              {/* big win burst overlay */}
              <AnimatePresence>
                {burst && (
                  <motion.div
                    key="burst"
                    className="pointer-events-none absolute inset-0 z-10 grid place-items-center"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                  >
                    <motion.div
                      className="rounded-2xl px-6 py-3 text-center"
                      initial={{ scale: 0.3, rotate: -8, y: 10 }}
                      animate={{ scale: 1, rotate: 0, y: 0 }}
                      transition={{ type: "spring", stiffness: 260, damping: 14 }}
                      style={{
                        background: "rgba(0,0,0,0.55)",
                        border: `2px solid ${theme.accent}`,
                        boxShadow: `0 0 40px ${theme.accent}aa`,
                        backdropFilter: "blur(3px)",
                      }}
                    >
                      <div
                        className="font-display text-2xl font-extrabold sm:text-3xl"
                        style={{ color: theme.accent, textShadow: `0 0 16px ${theme.accent}` }}
                      >
                        + {formatChips(lastWin)}
                      </div>
                      <div className="text-[11px] uppercase tracking-[0.3em] text-white/70">
                        {lastWin >= stake * 50 ? "Mega Win" : "You won"}
                      </div>
                    </motion.div>
                    {/* radial confetti */}
                    {Array.from({ length: 18 }).map((_, i) => {
                      const a = (i / 18) * Math.PI * 2;
                      const dist = 120 + Math.random() * 90;
                      const colors = [theme.accent, "#fff", "#ffd166", theme.prizes[2].color];
                      return (
                        <motion.span
                          key={i}
                          className="absolute h-2 w-2 rounded-sm"
                          style={{ background: colors[i % colors.length] }}
                          initial={{ x: 0, y: 0, opacity: 1, scale: 1 }}
                          animate={{
                            x: Math.cos(a) * dist,
                            y: Math.sin(a) * dist,
                            opacity: 0,
                            scale: 0.4,
                            rotate: 360,
                          }}
                          transition={{ duration: 1.2, ease: "easeOut" }}
                        />
                      );
                    })}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

            {/* result line */}
            <motion.div
              key={resultText}
              data-testid="round-result"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              className="mt-4 min-h-[2.5rem] rounded-xl px-4 py-2 text-center text-sm font-semibold"
              style={{
                background: won
                  ? `${theme.accent}1f`
                  : phase === "resolved"
                    ? "rgba(220,38,38,0.14)"
                    : "rgba(255,255,255,0.05)",
                color: won
                  ? theme.accent
                  : phase === "resolved"
                    ? "#fca5a5"
                    : "rgba(255,255,255,0.7)",
                border: `1px solid ${
                  won ? theme.accent + "66" : "rgba(255,255,255,0.08)"
                }`,
              }}
            >
              {resultText}
              {phase === "resolved" && (
                <span className="ml-2 tabular-nums opacity-80">
                  ({formatDelta(lastDelta)})
                </span>
              )}
            </motion.div>

            {/* actions */}
            <div className="mt-4 flex flex-wrap items-center justify-center gap-3">
              {phase === "scratching" ? (
                <Button
                  data-testid="reveal-all-btn"
                  variant="neon"
                  size="lg"
                  onClick={revealAll}
                  disabled={allRevealed}
                >
                  ✨ Reveal All
                </Button>
              ) : null}
              <Button
                data-testid="play-btn"
                variant="gold"
                size="lg"
                onClick={buyCard}
                disabled={betLocked || !affordable}
              >
                {phase === "resolved" ? "Buy Another" : `Buy Card · ${formatChips(bet)}`}
              </Button>
            </div>
            {!affordable && phase !== "scratching" && (
              <p className="mt-2 text-center text-xs text-red-300/80">
                Not enough chips — lower your bet or top up.
              </p>
            )}
          </div>
        </div>

        {/* ---- Side: bet + paytable ----------------------------------- */}
        <div className="flex flex-col gap-4">
          <BetControls
            bet={bet}
            setBet={setBet}
            balance={balance}
            min={MIN_BET}
            disabled={betLocked}
            chips={[5, 25, 100, 500]}
          />

          {/* Prize legend / paytable */}
          <div className="glass rounded-2xl p-4">
            <div className="mb-2 flex items-center justify-between">
              <h3
                className="font-display text-sm font-bold tracking-wide"
                style={{ color: theme.accent }}
              >
                {theme.name} — Prizes
              </h3>
              <span className="text-[10px] uppercase tracking-widest text-white/40">
                3 of a kind
              </span>
            </div>
            <div className="flex flex-col gap-1.5">
              {theme.prizes
                .slice()
                .sort((a, b) => b.mult - a.mult)
                .map((p) => {
                  const isHit =
                    phase === "resolved" && card?.prize?.key === p.key;
                  return (
                    <motion.div
                      key={p.key}
                      animate={
                        isHit
                          ? { scale: [1, 1.05, 1], backgroundColor: `${theme.accent}26` }
                          : {}
                      }
                      transition={{ duration: 0.5, repeat: isHit ? 2 : 0 }}
                      className="flex items-center justify-between rounded-lg px-2.5 py-1.5"
                      style={{
                        background: isHit ? `${theme.accent}1a` : "rgba(255,255,255,0.04)",
                        border: isHit
                          ? `1px solid ${theme.accent}`
                          : "1px solid rgba(255,255,255,0.06)",
                      }}
                    >
                      <span className="flex items-center gap-2">
                        <span className="text-xl leading-none">{p.glyph}</span>
                        <span className="text-xs text-white/80">{p.label}</span>
                      </span>
                      <span
                        className="text-sm font-bold tabular-nums"
                        style={{ color: p.mult >= 50 ? theme.accent : "#fff" }}
                      >
                        {formatMultiplier(p.mult)}
                      </span>
                    </motion.div>
                  );
                })}
            </div>
            <p className="mt-3 text-[11px] leading-snug text-white/40">
              Reveal all nine panels. Three matching symbols pay that prize ×
              your bet. The card&apos;s outcome is locked the moment you buy it.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
