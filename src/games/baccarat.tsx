"use client";

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useWallet } from "@/lib/wallet";
import { makeShoe, type Card, type Rank } from "@/lib/cards";
import { formatChips, formatDelta } from "@/lib/format";
import { sfx } from "@/lib/sound";
import { Button } from "@/components/ui/Button";
import { Chip } from "@/components/ui/Chip";
import { PlayingCard } from "@/components/PlayingCard";

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------
const ACCENT = "#c0392b"; // ruby red — Banker's colour
const PLAYER_BLUE = "#2e86de";
const TIE_GREEN = "#1abc9c";

// ---------------------------------------------------------------------------
// Baccarat maths — Punto Banco
// ---------------------------------------------------------------------------

/** Baccarat point value of a single card. A=1, 2-9 face, 10/J/Q/K = 0. */
function baccaratValue(rank: Rank): number {
  if (rank === "A") return 1;
  if (rank === "10" || rank === "J" || rank === "Q" || rank === "K") return 0;
  return parseInt(rank, 10);
}

/** Hand total = sum of card values mod 10. */
function handTotal(cards: Card[]): number {
  let t = 0;
  for (const c of cards) t += baccaratValue(c.rank);
  return t % 10;
}

type Outcome = "player" | "banker" | "tie";

interface Resolution {
  playerCards: Card[];
  bankerCards: Card[];
  playerTotal: number;
  bankerTotal: number;
  outcome: Outcome;
  playerPair: boolean;
  bankerPair: boolean;
  natural: boolean;
}

/**
 * Deal a full coup applying the official drawing rules and return the final
 * hands + result. Pure given the shoe slice it consumes.
 */
function dealCoup(shoe: Card[]): Resolution {
  // Shoe is consumed front-to-back: P, B, P, B, then draws.
  let i = 0;
  const next = () => shoe[i++];

  const playerCards: Card[] = [next(), next()];
  const bankerCards: Card[] = [next(), next()];

  const playerPair = playerCards[0].rank === playerCards[1].rank;
  const bankerPair = bankerCards[0].rank === bankerCards[1].rank;

  let pTotal = handTotal(playerCards);
  let bTotal = handTotal(bankerCards);

  const playerNatural = pTotal >= 8;
  const bankerNatural = bTotal >= 8;
  const natural = playerNatural || bankerNatural;

  // Naturals: both stand.
  if (!natural) {
    let playerThirdValue: number | null = null;

    // Player rule: draws on 0-5, stands on 6-7.
    if (pTotal <= 5) {
      const third = next();
      playerCards.push(third);
      playerThirdValue = baccaratValue(third.rank);
      pTotal = handTotal(playerCards);
    }

    // Banker rule.
    let bankerDraws = false;
    if (playerThirdValue === null) {
      // Player stood: banker draws on 0-5, stands 6-7.
      bankerDraws = bTotal <= 5;
    } else {
      const p = playerThirdValue;
      switch (bTotal) {
        case 0:
        case 1:
        case 2:
          bankerDraws = true;
          break;
        case 3:
          bankerDraws = p !== 8;
          break;
        case 4:
          bankerDraws = p >= 2 && p <= 7;
          break;
        case 5:
          bankerDraws = p >= 4 && p <= 7;
          break;
        case 6:
          bankerDraws = p === 6 || p === 7;
          break;
        default: // 7
          bankerDraws = false;
      }
    }

    if (bankerDraws) {
      bankerCards.push(next());
      bTotal = handTotal(bankerCards);
    }
  }

  const outcome: Outcome =
    pTotal > bTotal ? "player" : bTotal > pTotal ? "banker" : "tie";

  return {
    playerCards,
    bankerCards,
    playerTotal: pTotal,
    bankerTotal: bTotal,
    outcome,
    playerPair,
    bankerPair,
    natural,
  };
}

// ---------------------------------------------------------------------------
// Bet spots
// ---------------------------------------------------------------------------

type SpotId = "player" | "banker" | "tie" | "ppair" | "bpair";

interface SpotDef {
  id: SpotId;
  label: string;
  sub: string;
  payout: string; // display
  color: string;
}

const SPOTS: SpotDef[] = [
  { id: "player", label: "PLAYER", sub: "Punto", payout: "1 : 1", color: PLAYER_BLUE },
  { id: "tie", label: "TIE", sub: "Égalité", payout: "8 : 1", color: TIE_GREEN },
  { id: "banker", label: "BANKER", sub: "Banco · 5% comm.", payout: "0.95 : 1", color: ACCENT },
  { id: "ppair", label: "P · PAIR", sub: "Player pair", payout: "11 : 1", color: PLAYER_BLUE },
  { id: "bpair", label: "B · PAIR", sub: "Banker pair", payout: "11 : 1", color: ACCENT },
];

const CHIP_VALUES = [5, 25, 100, 500, 1000];

type Bets = Record<SpotId, number>;
const EMPTY_BETS: Bets = { player: 0, banker: 0, tie: 0, ppair: 0, bpair: 0 };

interface RoadEntry {
  outcome: Outcome;
  playerPair: boolean;
  bankerPair: boolean;
  natural: boolean;
}

type Phase = "betting" | "dealing" | "resolved";

// Payout helpers — returns the GROSS credit for a winning/pushing spot.
// (win() already floors, but we floor explicitly for clarity on the banker commission.)
function grossFor(spot: SpotId, stake: number, res: Resolution): number {
  switch (spot) {
    case "player":
      if (res.outcome === "player") return stake * 2;
      if (res.outcome === "tie") return stake; // push
      return 0;
    case "banker":
      if (res.outcome === "banker") return Math.floor(stake * 1.95);
      if (res.outcome === "tie") return stake; // push
      return 0;
    case "tie":
      return res.outcome === "tie" ? stake * 9 : 0;
    case "ppair":
      return res.playerPair ? stake * 12 : 0;
    case "bpair":
      return res.bankerPair ? stake * 12 : 0;
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function Baccarat() {
  const wallet = useWallet();

  const [phase, setPhase] = useState<Phase>("betting");
  const [chip, setChip] = useState<number>(25);
  const [bets, setBets] = useState<Bets>({ ...EMPTY_BETS });
  const [lastBets, setLastBets] = useState<Bets | null>(null);

  // Cards revealed so far (progressive reveal during dealing).
  const [playerShown, setPlayerShown] = useState<Card[]>([]);
  const [bankerShown, setBankerShown] = useState<Card[]>([]);
  const [reveal, setReveal] = useState(false); // flip cards face up

  const [result, setResult] = useState<Resolution | null>(null);
  const [delta, setDelta] = useState<number | null>(null);
  const [winningSpots, setWinningSpots] = useState<Set<SpotId>>(new Set());
  const [road, setRoad] = useState<RoadEntry[]>([]);
  const [coupNo, setCoupNo] = useState(1);

  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const clearTimers = useCallback(() => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
  }, []);
  const later = useCallback((fn: () => void, ms: number) => {
    const id = setTimeout(fn, ms);
    timers.current.push(id);
  }, []);

  // resolve() is defined below; deal() reaches it through this ref so there is
  // no forward-reference / stale-closure coupling between the two callbacks.
  const resolveRef = useRef<(res: Resolution) => void>(() => {});

  useEffect(() => () => clearTimers(), [clearTimers]);

  const totalStaked = useMemo(
    () => SPOTS.reduce((s, sp) => s + bets[sp.id], 0),
    [bets],
  );

  const canAfford = chip <= wallet.balance - totalStaked;

  // --- Betting interactions ---------------------------------------------
  const placeOnSpot = useCallback(
    (id: SpotId) => {
      if (phase !== "betting") return;
      if (chip > wallet.balance - totalStaked) {
        // not enough free balance for another chip of this size
        sfx.lose();
        return;
      }
      sfx.chip();
      setBets((b) => ({ ...b, [id]: b[id] + chip }));
    },
    [phase, chip, wallet.balance, totalStaked],
  );

  const clearSpot = useCallback(
    (id: SpotId) => {
      if (phase !== "betting") return;
      setBets((b) => {
        if (b[id] === 0) return b;
        sfx.click();
        return { ...b, [id]: 0 };
      });
    },
    [phase],
  );

  const clearAll = useCallback(() => {
    if (phase !== "betting" || totalStaked === 0) return;
    sfx.click();
    setBets({ ...EMPTY_BETS });
  }, [phase, totalStaked]);

  const rebet = useCallback(() => {
    if (phase !== "betting" || !lastBets) return;
    const need = SPOTS.reduce((s, sp) => s + lastBets[sp.id], 0);
    if (need > wallet.balance) {
      sfx.lose();
      return;
    }
    sfx.chip();
    setBets({ ...lastBets });
  }, [phase, lastBets, wallet.balance]);

  // --- Deal --------------------------------------------------------------
  const deal = useCallback(() => {
    if (phase !== "betting") return;
    if (totalStaked <= 0) return;

    // Deduct the whole stake up front.
    if (!wallet.bet(totalStaked)) {
      sfx.lose();
      return;
    }

    clearTimers();
    setLastBets({ ...bets });
    setResult(null);
    setDelta(null);
    setWinningSpots(new Set());
    setPlayerShown([]);
    setBankerShown([]);
    setReveal(false);
    setPhase("dealing");

    const shoe = makeShoe(8);
    const res = dealCoup(shoe);
    setResult(res);

    const { playerCards, bankerCards } = res;

    // Progressive deal: alternate P,B,P,B then third cards, face-down first.
    const dealOrder: { side: "p" | "b"; idx: number }[] = [];
    for (let r = 0; r < 2; r++) {
      dealOrder.push({ side: "p", idx: r });
      dealOrder.push({ side: "b", idx: r });
    }
    // third cards (player first if present, then banker)
    if (playerCards.length > 2) dealOrder.push({ side: "p", idx: 2 });
    if (bankerCards.length > 2) dealOrder.push({ side: "b", idx: 2 });

    const STEP = 360;
    dealOrder.forEach((step, k) => {
      later(() => {
        sfx.card();
        if (step.side === "p") {
          setPlayerShown(playerCards.slice(0, step.idx + 1));
        } else {
          setBankerShown(bankerCards.slice(0, step.idx + 1));
        }
      }, k * STEP);
    });

    const afterDeal = dealOrder.length * STEP + 200;

    // Flip everything face up.
    later(() => {
      sfx.card();
      setReveal(true);
    }, afterDeal);

    // Resolve & pay.
    later(() => {
      resolveRef.current(res);
    }, afterDeal + 700);
  }, [phase, totalStaked, bets, wallet, clearTimers, later]);

  const resolve = useCallback(
    (res: Resolution) => {
      let gross = 0;
      const winners = new Set<SpotId>();
      for (const sp of SPOTS) {
        const stake = bets[sp.id];
        if (stake <= 0) continue;
        const g = grossFor(sp.id, stake, res);
        if (g > 0) {
          gross += g;
          // mark as a "winning"/returned spot (push counts as returned, not a true win)
          if (
            (sp.id === "player" && res.outcome === "player") ||
            (sp.id === "banker" && res.outcome === "banker") ||
            (sp.id === "tie" && res.outcome === "tie") ||
            (sp.id === "ppair" && res.playerPair) ||
            (sp.id === "bpair" && res.bankerPair)
          ) {
            winners.add(sp.id);
          }
        }
      }

      if (gross > 0) wallet.win(gross);

      const net = gross - totalStaked;
      setDelta(net);
      setWinningSpots(winners);
      setRoad((r) =>
        [
          {
            outcome: res.outcome,
            playerPair: res.playerPair,
            bankerPair: res.bankerPair,
            natural: res.natural,
          },
          ...r,
        ].slice(0, 60),
      );
      setCoupNo((n) => n + 1);
      setPhase("resolved");

      if (net > 0) {
        if (net >= totalStaked * 4) sfx.jackpot();
        else sfx.win();
      } else if (net < 0) {
        sfx.lose();
      } else {
        sfx.thud(); // full push
      }
    },
    [bets, totalStaked, wallet],
  );

  // Keep the ref pointed at the latest resolve closure.
  useEffect(() => {
    resolveRef.current = resolve;
  }, [resolve]);

  const nextCoup = useCallback(() => {
    clearTimers();
    setPhase("betting");
    setResult(null);
    setDelta(null);
    setWinningSpots(new Set());
    setPlayerShown([]);
    setBankerShown([]);
    setReveal(false);
    // Clear the table for the next coup; the player can hit Re-bet to restore
    // the previous layout (stored in lastBets).
    setBets({ ...EMPTY_BETS });
  }, [clearTimers]);

  // Road counters
  const counts = useMemo(() => {
    let p = 0,
      b = 0,
      t = 0;
    for (const e of road) {
      if (e.outcome === "player") p++;
      else if (e.outcome === "banker") b++;
      else t++;
    }
    return { p, b, t };
  }, [road]);

  const betting = phase === "betting";
  const resolved = phase === "resolved";

  const resultText = result
    ? result.outcome === "player"
      ? `PLAYER WINS · ${result.playerTotal}`
      : result.outcome === "banker"
        ? `BANKER WINS · ${result.bankerTotal}`
        : `TIE · ${result.playerTotal}`
    : "";

  // ---------------------------------------------------------------------
  return (
    <div className="mx-auto w-full max-w-6xl">
      <div className="grid gap-4 lg:grid-cols-[1fr_300px]">
        {/* ============================ TABLE ============================ */}
        <div
          className="felt relative overflow-hidden rounded-3xl border border-emerald-300/15 p-4 sm:p-6"
          style={{ minHeight: 460 }}
        >
          {/* accent corner glow */}
          <div
            className="pointer-events-none absolute -right-24 -top-24 h-64 w-64 rounded-full opacity-30 blur-3xl"
            style={{ background: ACCENT }}
          />
          <div
            className="pointer-events-none absolute -bottom-24 -left-24 h-64 w-64 rounded-full opacity-25 blur-3xl"
            style={{ background: PLAYER_BLUE }}
          />

          {/* Header row */}
          <div className="relative mb-3 flex items-center justify-between">
            <div className="font-display text-sm tracking-[0.3em] text-emerald-100/70">
              PUNTO&nbsp;BANCO
            </div>
            <div className="rounded-full border border-white/10 bg-black/30 px-3 py-1 text-[11px] text-white/60">
              Coup #{coupNo}
            </div>
          </div>

          {/* Hands */}
          <div className="relative grid grid-cols-2 gap-3 sm:gap-6">
            <HandPanel
              title="PLAYER"
              color={PLAYER_BLUE}
              cards={playerShown}
              faceDown={!reveal}
              total={reveal && result ? result.playerTotal : null}
              isWinner={resolved && result?.outcome === "player"}
              pair={resolved && !!result?.playerPair}
            />
            <HandPanel
              title="BANKER"
              color={ACCENT}
              cards={bankerShown}
              faceDown={!reveal}
              total={reveal && result ? result.bankerTotal : null}
              isWinner={resolved && result?.outcome === "banker"}
              pair={resolved && !!result?.bankerPair}
            />
          </div>

          {/* VS / status orb */}
          <div className="pointer-events-none absolute left-1/2 top-[44%] z-10 -translate-x-1/2 -translate-y-1/2">
            <AnimatePresence>
              {!resolved && phase !== "betting" && (
                <motion.div
                  initial={{ scale: 0, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  exit={{ scale: 0, opacity: 0 }}
                  className="grid h-12 w-12 place-items-center rounded-full border border-white/20 bg-black/50 font-display text-xs text-white/80 backdrop-blur"
                >
                  VS
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {/* Result banner */}
          <div className="relative mt-5 grid h-16 place-items-center">
            <AnimatePresence mode="wait">
              {resolved && result ? (
                <motion.div
                  key="res"
                  data-testid="round-result"
                  initial={{ scale: 0.6, opacity: 0, y: 10 }}
                  animate={{ scale: 1, opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  transition={{ type: "spring", stiffness: 280, damping: 18 }}
                  className="flex flex-col items-center"
                >
                  <div
                    className="rounded-full px-6 py-2 font-display text-lg font-bold tracking-wider sm:text-xl"
                    style={{
                      color: "#fff",
                      background:
                        result.outcome === "player"
                          ? `linear-gradient(180deg, ${PLAYER_BLUE}, #1b4f8a)`
                          : result.outcome === "banker"
                            ? `linear-gradient(180deg, ${ACCENT}, #7d2018)`
                            : `linear-gradient(180deg, ${TIE_GREEN}, #0e6e5a)`,
                      boxShadow: `0 0 26px ${
                        result.outcome === "player"
                          ? PLAYER_BLUE
                          : result.outcome === "banker"
                            ? ACCENT
                            : TIE_GREEN
                      }aa`,
                    }}
                  >
                    {resultText}
                    {result.natural && (
                      <span className="ml-2 text-xs font-semibold text-white/85">
                        NATURAL
                      </span>
                    )}
                  </div>
                  {delta !== null && (
                    <motion.div
                      initial={{ opacity: 0, y: 6 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: 0.15 }}
                      className="mt-1 font-display text-base font-bold tabular-nums"
                      style={{
                        color:
                          delta > 0 ? "#4ade80" : delta < 0 ? "#f87171" : "#e2e8f0",
                      }}
                    >
                      {delta === 0 ? "PUSH" : formatDelta(delta)}
                    </motion.div>
                  )}
                </motion.div>
              ) : phase === "betting" ? (
                <motion.div
                  key="prompt"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="text-center text-xs text-emerald-100/55"
                >
                  Place chips on the spots below, then deal.
                </motion.div>
              ) : (
                <motion.div
                  key="dealing"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="font-display text-sm tracking-[0.3em] text-white/70"
                >
                  DEALING…
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {/* Win burst overlay */}
          <AnimatePresence>
            {resolved && delta !== null && delta > 0 && (
              <WinBurst key={coupNo} big={delta >= totalStaked * 4} />
            )}
          </AnimatePresence>
        </div>

        {/* ============================ SIDEBAR ============================ */}
        <div className="flex flex-col gap-4">
          {/* Bead road / scoreboard */}
          <div className="glass rounded-2xl p-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[11px] uppercase tracking-widest text-white/45">
                Bead Road
              </span>
              <div className="flex items-center gap-2 text-[11px] tabular-nums">
                <Tally color={PLAYER_BLUE} label="P" n={counts.p} />
                <Tally color={ACCENT} label="B" n={counts.b} />
                <Tally color={TIE_GREEN} label="T" n={counts.t} />
              </div>
            </div>
            <BeadRoad road={road} />
          </div>

          {/* Paytable */}
          <div className="glass rounded-2xl p-3">
            <div className="mb-2 text-[11px] uppercase tracking-widest text-white/45">
              Paytable
            </div>
            <ul className="space-y-1.5 text-[12px]">
              <PayRow color={PLAYER_BLUE} name="Player" odds="1 : 1" />
              <PayRow color={ACCENT} name="Banker (5% comm.)" odds="0.95 : 1" />
              <PayRow color={TIE_GREEN} name="Tie" odds="8 : 1" />
              <PayRow color={PLAYER_BLUE} name="Player Pair" odds="11 : 1" />
              <PayRow color={ACCENT} name="Banker Pair" odds="11 : 1" />
            </ul>
            <p className="mt-2 text-[10px] leading-relaxed text-white/35">
              On a Tie, Player/Banker wagers push (refunded). Naturals (8 or 9)
              stand; third-card draws follow the standard tableau.
            </p>
          </div>
        </div>
      </div>

      {/* ============================ BET LAYOUT ============================ */}
      <div className="mt-4 grid gap-3 sm:grid-cols-5">
        {SPOTS.map((sp) => (
          <BetSpot
            key={sp.id}
            def={sp}
            amount={bets[sp.id]}
            disabled={!betting}
            isWinner={winningSpots.has(sp.id)}
            resolved={resolved}
            onPlace={() => placeOnSpot(sp.id)}
            onClear={() => clearSpot(sp.id)}
          />
        ))}
      </div>

      {/* ============================ CONTROLS ============================ */}
      <div className="glass mt-4 rounded-2xl p-3 sm:p-4">
        <div className="flex flex-wrap items-center justify-center gap-3">
          {/* chip denominations */}
          <div className="flex flex-wrap items-center justify-center gap-2">
            {CHIP_VALUES.map((v) => (
              <div key={v} className="relative">
                <Chip
                  value={v}
                  size={52}
                  selected={chip === v}
                  onClick={
                    betting
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

          <div className="mx-1 h-10 w-px bg-white/10" />

          {/* readout */}
          <div className="rounded-xl border border-gold/30 bg-black/40 px-4 py-2 text-center">
            <div className="text-[9px] uppercase tracking-widest text-white/40">
              Total Bet
            </div>
            <motion.div
              key={totalStaked}
              initial={{ scale: 0.9 }}
              animate={{ scale: 1 }}
              className="gold-text text-lg font-bold tabular-nums"
            >
              {formatChips(totalStaked)}
            </motion.div>
          </div>

          {/* actions */}
          <div className="flex flex-wrap items-center justify-center gap-2">
            <Button
              size="sm"
              variant="ghost"
              data-testid="clear-bets"
              disabled={!betting || totalStaked === 0}
              onClick={clearAll}
            >
              Clear
            </Button>
            <Button
              size="sm"
              variant="ghost"
              data-testid="rebet-btn"
              disabled={!betting || !lastBets}
              onClick={rebet}
            >
              Re-bet
            </Button>

            {!resolved ? (
              <Button
                size="lg"
                variant="danger"
                data-testid="play-btn"
                disabled={!betting || totalStaked === 0 || totalStaked > wallet.balance}
                onClick={deal}
              >
                {phase === "dealing" ? "Dealing…" : "Deal"}
              </Button>
            ) : (
              <Button
                size="lg"
                variant="gold"
                data-testid="play-btn"
                onClick={nextCoup}
              >
                New Coup
              </Button>
            )}
          </div>
        </div>

        {!canAfford && betting && (
          <div className="mt-2 text-center text-[11px] text-red-300/80">
            Selected chip exceeds your balance — pick a smaller chip.
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function HandPanel({
  title,
  color,
  cards,
  faceDown,
  total,
  isWinner,
  pair,
}: {
  title: string;
  color: string;
  cards: Card[];
  faceDown: boolean;
  total: number | null;
  isWinner: boolean;
  pair: boolean;
}) {
  return (
    <motion.div
      animate={
        isWinner
          ? { boxShadow: `0 0 0 2px ${color}, 0 0 30px ${color}aa` }
          : { boxShadow: "0 0 0 1px rgba(255,255,255,0.06)" }
      }
      transition={{ duration: 0.4 }}
      className="relative rounded-2xl bg-black/25 p-3"
    >
      <div className="mb-2 flex items-center justify-between">
        <span
          className="font-display text-sm font-bold tracking-widest"
          style={{ color, textShadow: `0 0 14px ${color}88` }}
        >
          {title}
        </span>
        <AnimatePresence>
          {total !== null && (
            <motion.span
              key={total}
              initial={{ scale: 0.4, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ type: "spring", stiffness: 320, damping: 16 }}
              className="grid h-8 w-8 place-items-center rounded-full font-display text-base font-bold tabular-nums"
              style={{
                color: "#fff",
                background: `${color}33`,
                border: `1px solid ${color}`,
              }}
            >
              {total}
            </motion.span>
          )}
        </AnimatePresence>
      </div>

      <div className="flex min-h-[96px] flex-wrap items-center gap-1.5">
        <AnimatePresence>
          {cards.map((c, idx) => (
            <motion.div
              key={c.id}
              initial={{ x: 120, y: -60, opacity: 0, rotate: -14 }}
              animate={{ x: 0, y: 0, opacity: 1, rotate: idx === 2 ? 8 : 0 }}
              transition={{ type: "spring", stiffness: 260, damping: 22 }}
            >
              <PlayingCard
                card={c}
                faceDown={faceDown}
                size="md"
                highlight={isWinner && !faceDown}
              />
            </motion.div>
          ))}
        </AnimatePresence>
        {cards.length === 0 && (
          <div className="grid h-[92px] w-full place-items-center text-[11px] text-white/25">
            —
          </div>
        )}
      </div>

      <AnimatePresence>
        {pair && (
          <motion.div
            initial={{ scale: 0, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0, opacity: 0 }}
            className="absolute -right-1 -top-2 rounded-full px-2 py-0.5 text-[9px] font-bold text-white"
            style={{ background: color, boxShadow: `0 0 12px ${color}` }}
          >
            PAIR
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

function BetSpot({
  def,
  amount,
  disabled,
  isWinner,
  resolved,
  onPlace,
  onClear,
}: {
  def: SpotDef;
  amount: number;
  disabled: boolean;
  isWinner: boolean;
  resolved: boolean;
  onPlace: () => void;
  onClear: () => void;
}) {
  const active = amount > 0;
  const dim = resolved && active && !isWinner;
  return (
    <motion.button
      type="button"
      data-testid={`bet-${def.id}`}
      onClick={onPlace}
      onContextMenu={(e) => {
        e.preventDefault();
        onClear();
      }}
      disabled={disabled}
      whileHover={!disabled ? { y: -2 } : undefined}
      whileTap={!disabled ? { scale: 0.97 } : undefined}
      animate={
        isWinner
          ? { boxShadow: `0 0 0 2px ${def.color}, 0 0 26px ${def.color}` }
          : { boxShadow: "0 0 0 1px rgba(255,255,255,0.08)" }
      }
      className="relative flex flex-col items-center justify-center rounded-2xl px-3 py-4 text-center transition-colors disabled:cursor-not-allowed"
      style={{
        background: active
          ? `linear-gradient(180deg, ${def.color}33, ${def.color}11)`
          : "linear-gradient(180deg, rgba(255,255,255,0.05), rgba(255,255,255,0.02))",
        opacity: dim ? 0.45 : 1,
        cursor: disabled ? "not-allowed" : "pointer",
      }}
    >
      <span
        className="font-display text-sm font-bold tracking-wider"
        style={{ color: def.color, textShadow: `0 0 12px ${def.color}66` }}
      >
        {def.label}
      </span>
      <span className="mt-0.5 text-[10px] text-white/45">{def.sub}</span>
      <span
        className="mt-1 rounded-full px-2 py-0.5 text-[10px] font-semibold"
        style={{ background: `${def.color}22`, color: "#fff" }}
      >
        {def.payout}
      </span>

      {/* stacked chip indicator */}
      <div className="mt-2 grid h-12 place-items-center">
        <AnimatePresence>
          {active && (
            <motion.div
              key="chip"
              initial={{ scale: 0, y: -24, opacity: 0 }}
              animate={{ scale: 1, y: 0, opacity: 1 }}
              exit={{ scale: 0, opacity: 0 }}
              transition={{ type: "spring", stiffness: 360, damping: 20 }}
              className="flex flex-col items-center"
            >
              <Chip value={Math.min(amount, 5000)} size={38} showValue={false} />
              <span className="mt-1 font-display text-sm font-bold tabular-nums text-white">
                {formatChips(amount)}
              </span>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {isWinner && (
        <motion.span
          initial={{ scale: 0 }}
          animate={{ scale: 1 }}
          className="absolute -right-1 -top-1 grid h-6 w-6 place-items-center rounded-full text-xs"
          style={{ background: def.color, boxShadow: `0 0 12px ${def.color}` }}
        >
          ✓
        </motion.span>
      )}
    </motion.button>
  );
}

function Tally({ color, label, n }: { color: string; label: string; n: number }) {
  return (
    <span className="flex items-center gap-1">
      <span
        className="grid h-4 w-4 place-items-center rounded-full text-[9px] font-bold text-white"
        style={{ background: color }}
      >
        {label}
      </span>
      <span className="text-white/70">{n}</span>
    </span>
  );
}

const ROAD_COLORS: Record<Outcome, string> = {
  player: PLAYER_BLUE,
  banker: ACCENT,
  tie: TIE_GREEN,
};
const ROAD_LETTER: Record<Outcome, string> = {
  player: "P",
  banker: "B",
  tie: "T",
};

function BeadRoad({ road }: { road: RoadEntry[] }) {
  // Column-major grid like a real bead plate: 6 rows, fill top→bottom.
  const ROWS = 6;
  const recent = road.slice(0, 36); // newest first
  const ordered = [...recent].reverse(); // oldest first for natural fill
  const cols = Math.max(6, Math.ceil(ordered.length / ROWS));
  const cells: (RoadEntry | null)[] = [];
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < ROWS; r++) {
      const i = c * ROWS + r;
      cells.push(ordered[i] ?? null);
    }
  }

  return (
    <div
      className="no-scrollbar overflow-x-auto rounded-lg bg-black/30 p-1.5"
      style={{ direction: "ltr" }}
    >
      <div
        className="grid grid-flow-col gap-1"
        style={{ gridTemplateRows: `repeat(${ROWS}, 18px)` }}
      >
        {cells.map((e, i) => (
          <div key={i} className="grid h-[18px] w-[18px] place-items-center">
            {e ? (
              <motion.div
                initial={{ scale: 0 }}
                animate={{ scale: 1 }}
                className="relative grid h-[16px] w-[16px] place-items-center rounded-full text-[8px] font-bold text-white"
                style={{
                  background: ROAD_COLORS[e.outcome],
                  boxShadow: `0 0 6px ${ROAD_COLORS[e.outcome]}99`,
                }}
                title={`${ROAD_LETTER[e.outcome]}${e.natural ? " · Natural" : ""}`}
              >
                {ROAD_LETTER[e.outcome]}
                {(e.playerPair || e.bankerPair) && (
                  <span
                    className="absolute -bottom-0.5 -right-0.5 h-1.5 w-1.5 rounded-full"
                    style={{
                      background: e.playerPair ? PLAYER_BLUE : ACCENT,
                      outline: "1px solid #fff",
                    }}
                  />
                )}
              </motion.div>
            ) : (
              <div className="h-[14px] w-[14px] rounded-full bg-white/5" />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function PayRow({ color, name, odds }: { color: string; name: string; odds: string }) {
  return (
    <li className="flex items-center justify-between">
      <span className="flex items-center gap-2 text-white/75">
        <span
          className="h-2.5 w-2.5 rounded-full"
          style={{ background: color, boxShadow: `0 0 8px ${color}` }}
        />
        {name}
      </span>
      <span className="font-semibold tabular-nums text-white/90">{odds}</span>
    </li>
  );
}

function WinBurst({ big }: { big: boolean }) {
  const count = big ? 26 : 16;
  const pieces = useMemo(
    () =>
      Array.from({ length: count }, (_, i) => ({
        id: i,
        angle: (i / count) * Math.PI * 2,
        dist: 90 + Math.random() * (big ? 180 : 110),
        size: 6 + Math.random() * 8,
        color: [ACCENT, PLAYER_BLUE, TIE_GREEN, "#f5d060"][i % 4],
        delay: Math.random() * 0.1,
      })),
    [count, big],
  );

  return (
    <div className="pointer-events-none absolute inset-0 z-20 grid place-items-center overflow-hidden">
      {pieces.map((p) => (
        <motion.span
          key={p.id}
          initial={{ x: 0, y: 0, opacity: 1, scale: 1 }}
          animate={{
            x: Math.cos(p.angle) * p.dist,
            y: Math.sin(p.angle) * p.dist + 40,
            opacity: 0,
            scale: 0.4,
            rotate: 360,
          }}
          transition={{ duration: big ? 1.2 : 0.9, delay: p.delay, ease: "easeOut" }}
          className="absolute rounded-sm"
          style={{ width: p.size, height: p.size * 1.4, background: p.color }}
        />
      ))}
      {big && (
        <motion.div
          initial={{ scale: 0.4, opacity: 0 }}
          animate={{ scale: [0.4, 1.15, 1], opacity: [0, 1, 1] }}
          transition={{ duration: 0.6 }}
          className="font-display text-3xl font-black tracking-wider gold-text"
          style={{ textShadow: "0 0 30px rgba(245,208,96,0.8)" }}
        >
          BIG WIN!
        </motion.div>
      )}
    </div>
  );
}
