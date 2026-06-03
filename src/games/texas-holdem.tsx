"use client";

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  type Card,
  evaluateBest,
  HandCategory,
} from "@/lib/cards";
import { clamp } from "@/lib/rng";
import { formatChips, formatDelta } from "@/lib/format";
import { sleep } from "@/lib/async";
import { sfx } from "@/lib/sound";
import { useWallet } from "@/lib/wallet";
import { usePlayRound } from "@/lib/playRound";
import { Button } from "@/components/ui/Button";
import { Chip } from "@/components/ui/Chip";
import { PlayingCard } from "@/components/PlayingCard";
import { CollapsiblePanel } from "@/components/CollapsiblePanel";
import { Celebration } from "@/components/Celebration";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ACCENT = "#2ecc71";
const SB = 25; // small blind
const BB = 50; // big blind

type Street = "preflop" | "flop" | "turn" | "river";
type Actor = "player" | "bot";
type Phase =
  | "idle" // between hands, can change buy-in
  | "dealing" // animating the deal
  | "player" // waiting on player action
  | "bot" // server is resolving the bot / a street is animating
  | "showdown" // both hands revealed, resolving
  | "done"; // hand resolved, banner up

interface LogEntry {
  id: number;
  who: Actor | "system";
  text: string;
}

let LOG_ID = 1;

// ---------------------------------------------------------------------------
// Server publicView shapes (the server is the single source of truth). The bot's
// hole cards are absent until the hand ends.
// ---------------------------------------------------------------------------
interface TexasView {
  playerHole: Card[];
  board: Card[]; // 0/3/4/5 cards
  street: Street;
  pot: number;
  playerStack: number;
  botStack: number;
  playerStreetBet: number;
  botStreetBet: number;
  toCall: number; // chips the PLAYER must call
  buttonIsPlayer: boolean;
  toAct: Actor;
  actions?: string[];
  botMoves?: string[];
  // present only on done:
  outcome?: "win" | "lose" | "push";
  reason?: string;
  botHole?: Card[];
  revealCount?: number;
  botFinal?: number;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function TexasHoldem() {
  const wallet = useWallet();
  // The server owns the deck, the bot, the pot, all stacks, whose turn it is and
  // the result. The client only routes decisions through /api/round and animates
  // the cards / chips the server deals back. No wallet.bet/win here — the
  // playRound hook applies the authoritative balance itself.
  const { start: roundStart, act: roundAct } = usePlayRound();
  const roundIdRef = useRef<string | null>(null);
  // Generation token: bumped on every new hand / unmount so stale async (a slow
  // reveal animation, an in-flight act) can't write to a hand that moved on.
  const genRef = useRef(0);
  // Serialize server calls so a double-tap can't fire two overlapping actions.
  const acting = useRef(false);

  // Drop stale async on unmount.
  useEffect(
    () => () => {
      genRef.current++;
    },
    [],
  );

  // ---- view state (all fed from publicView) -------------------------------
  const [phase, setPhase] = useState<Phase>("idle");
  const [buyIn, setBuyIn] = useState(1000);
  const [street, setStreet] = useState<Street>("preflop");
  const [playerHole, setPlayerHole] = useState<Card[]>([]);
  const [botHole, setBotHole] = useState<Card[]>([]);
  const [board, setBoard] = useState<Card[]>([]); // up to 5, only the revealed ones
  const [revealBoard, setRevealBoard] = useState(0);
  const [botRevealed, setBotRevealed] = useState(false);
  const [playerStack, setPlayerStack] = useState(0);
  const [botStack, setBotStack] = useState(0);
  const [pot, setPot] = useState(0);
  const [playerStreetBet, setPlayerStreetBet] = useState(0);
  const [botStreetBet, setBotStreetBet] = useState(0);
  const [toCall, setToCall] = useState(0);
  const [buttonIsPlayer, setButtonIsPlayer] = useState(true);
  const [legalActions, setLegalActions] = useState<string[]>([]);
  const [log, setLog] = useState<LogEntry[]>([]);

  // result
  const [resultText, setResultText] = useState("");
  const [resultKind, setResultKind] = useState<"win" | "lose" | "push" | null>(null);
  const [netDelta, setNetDelta] = useState(0);
  const [winningIds, setWinningIds] = useState<string[]>([]);
  const [bestPlayerCat, setBestPlayerCat] = useState<HandCategory | null>(null);

  const [errorMsg, setErrorMsg] = useState("");
  const [handNo, setHandNo] = useState(0);

  const [raiseTo, setRaiseTo] = useState(BB * 2);
  const [chipBursts, setChipBursts] = useState<{ id: number; from: Actor }[]>([]);
  const burstId = useRef(0);

  const pushLog = useCallback((who: Actor | "system", text: string) => {
    setLog((l) => [...l, { id: LOG_ID++, who, text }].slice(-7));
  }, []);

  const flyChips = useCallback((from: Actor) => {
    const id = burstId.current++;
    setChipBursts((b) => [...b, { id, from }]);
    setTimeout(() => setChipBursts((b) => b.filter((x) => x.id !== id)), 700);
  }, []);

  // Mirror the live betting fields of a publicView into the local render state.
  // Does NOT touch the revealed board count (the reveal animation owns that) or
  // the player's hole (set once at the deal).
  const syncBetting = useCallback((pv: TexasView) => {
    setStreet(pv.street);
    setPot(pv.pot);
    setPlayerStack(pv.playerStack);
    setBotStack(pv.botStack);
    setPlayerStreetBet(pv.playerStreetBet);
    setBotStreetBet(pv.botStreetBet);
    setToCall(pv.toCall);
    setButtonIsPlayer(pv.buttonIsPlayer);
  }, []);

  // -----------------------------------------------------------------------
  // Resolve a finished hand — reveal the bot + full board, show the result.
  // The server already credited the authoritative balance via the hook; this is
  // purely visual. `bet` is this hand's buy-in so we can show the net.
  // -----------------------------------------------------------------------
  const resolveHand = useCallback(
    async (gen: number, pv: TexasView, payout: number, bet: number, settle: () => void) => {
      const fullBoard = (pv.board ?? []) as Card[];
      const bHole = (pv.botHole ?? []) as Card[];
      const outcome = pv.outcome ?? "push";
      const reason = pv.reason ?? "";
      const net = payout - bet;

      setPhase("showdown");
      syncBetting(pv);

      try {
      // Reveal any remaining board cards one at a time, then the bot's hole.
      let shown = revealBoardRef.current;
      while (shown < fullBoard.length) {
        shown++;
        setBoard(fullBoard.slice(0, shown));
        setRevealBoard(shown);
        sfx.card();
        await sleep(320);
        if (gen !== genRef.current) return;
      }
      await sleep(160);
      if (gen !== genRef.current) return;

      setBotHole(bHole);
      setBotRevealed(true);
      sfx.card();
      await sleep(480);
      if (gen !== genRef.current) return;

      // Highlight the winning five-card hand (pure read of revealed public cards).
      let ids: string[] = [];
      let pCat: HandCategory | null = null;
      if (outcome === "win" && bHole.length === 0) {
        // bot folded — no showdown; highlight the player's hole.
        ids = playerHoleRef.current.map((c) => c.id);
      } else if (fullBoard.length === 5 && bHole.length === 2) {
        const pEval = evaluateBest([...playerHoleRef.current, ...fullBoard]);
        const bEval = evaluateBest([...bHole, ...fullBoard]);
        pCat = pEval.category;
        if (outcome === "win") ids = pEval.best.map((c) => c.id);
        else if (outcome === "lose") ids = bEval.best.map((c) => c.id);
        else ids = [...pEval.best.map((c) => c.id), ...bEval.best.map((c) => c.id)];
      }
      setWinningIds(ids);
      setBestPlayerCat(pCat);

      // Banner + sound.
      let text: string;
      if (outcome === "win") {
        text = reason === "fold" ? "Bot folds — you win the pot!" : `You win with ${reason}!`;
        if (pCat != null && pCat >= HandCategory.Flush) sfx.jackpot();
        else sfx.win();
      } else if (outcome === "lose") {
        text = reason === "fold" ? "You folded — bot takes the pot" : `Bot wins with ${reason}`;
        sfx.lose();
      } else {
        text = `Split pot — both have ${reason}`;
        sfx.thud();
      }
      setResultKind(outcome);
      setResultText(text);
      setNetDelta(net);
      setLegalActions([]);
      pushLog("system", `${text} Net ${formatDelta(net)}.`);
      setPhase("done");
      } finally {
        // Reveal complete (or cut short by an unmount) — credit the withheld
        // payout. settle() is idempotent and the wallet provider outlives this
        // view, so the win is always booked even if the reveal is interrupted.
        settle();
      }
    },
    [syncBetting, pushLog],
  );

  // refs the async reveal reads without re-binding the callback every render.
  const revealBoardRef = useRef(0);
  revealBoardRef.current = revealBoard;
  const playerHoleRef = useRef<Card[]>([]);
  playerHoleRef.current = playerHole;

  // -----------------------------------------------------------------------
  // Apply a (possibly non-terminal) server step: animate any new board cards,
  // surface the bot's moves, then either hand control to the player or resolve.
  // -----------------------------------------------------------------------
  const applyStep = useCallback(
    async (
      gen: number,
      res: { done?: boolean; publicView: Record<string, unknown>; payout?: number; settle: () => void },
      bet: number,
    ) => {
      const pv = res.publicView as unknown as TexasView;
      const botMoves = pv.botMoves ?? [];

      // Animate any board cards the server opened since the last view.
      const nextBoard = (pv.board ?? []) as Card[];
      const prevCount = revealBoardRef.current;
      if (nextBoard.length > prevCount && !res.done) {
        setPhase("bot");
        let shown = prevCount;
        while (shown < nextBoard.length) {
          shown++;
          setBoard(nextBoard.slice(0, shown));
          setRevealBoard(shown);
          sfx.card();
          await sleep(320);
          if (gen !== genRef.current) return;
        }
      }

      // Narrate the bot's moves into the feed, with a chip burst on bets/calls.
      for (const m of botMoves) {
        pushLog("bot", m);
        if (/call|raise|all-in/i.test(m)) {
          sfx.chip();
          flyChips("bot");
        } else {
          sfx.click();
        }
      }
      if (gen !== genRef.current) return;

      if (res.done) {
        await resolveHand(gen, pv, res.payout ?? 0, bet, res.settle);
        return;
      }

      // Player's turn with a live decision.
      syncBetting(pv);
      setLegalActions(pv.actions ?? []);
      setPhase("player");
    },
    [pushLog, flyChips, resolveHand, syncBetting],
  );

  // keep the latest buy-in we dealt with so resolve/act can compute the net.
  const handBuyInRef = useRef(0);

  // -----------------------------------------------------------------------
  // Deal a fresh hand (server-authoritative).
  // -----------------------------------------------------------------------
  const startHand = useCallback(async () => {
    if (phase !== "idle" && phase !== "done") return;
    if (acting.current) return;
    // Gate the whole stack against the live balance; floor to the small blind.
    const bet = Math.max(2 * BB, Math.floor(Math.min(buyIn, wallet.balance) / SB) * SB);
    if (!wallet.ready || wallet.balance < bet) {
      setErrorMsg("Not enough chips to buy in for this hand.");
      return;
    }

    acting.current = true;
    const gen = ++genRef.current;
    let res;
    try {
      res = await roundStart("texas-holdem", bet, {}, { defer: true }); // server debits the stack; win withheld until reveal
    } catch (err) {
      acting.current = false;
      if (gen !== genRef.current) return;
      setErrorMsg(err instanceof Error ? err.message : "Couldn't deal the hand.");
      return;
    }
    if (gen !== genRef.current) {
      acting.current = false;
      return;
    }
    roundIdRef.current = res.roundId ?? null;
    handBuyInRef.current = bet;

    const pv = res.publicView as unknown as TexasView;

    // reset visuals
    setErrorMsg("");
    setHandNo((n) => n + 1);
    setBotHole([]);
    setBotRevealed(false);
    setBoard([]);
    setRevealBoard(0);
    revealBoardRef.current = 0;
    setWinningIds([]);
    setBestPlayerCat(null);
    setResultKind(null);
    setResultText("");
    setNetDelta(0);
    setChipBursts([]);
    setLog([
      {
        id: LOG_ID++,
        who: "system",
        text: `Hand #${handNo + 1} — ${pv.buttonIsPlayer ? "you are" : "bot is"} on the button`,
      },
    ]);
    setPlayerHole(pv.playerHole ?? []);
    playerHoleRef.current = pv.playerHole ?? [];
    setPhase("dealing");
    syncBetting(pv);
    setLegalActions(pv.actions ?? []);

    // staged deal: hole cards, then blinds chip-burst.
    sfx.card();
    await sleep(160);
    if (gen !== genRef.current) {
      acting.current = false;
      return;
    }
    sfx.card();
    await sleep(220);
    if (gen !== genRef.current) {
      acting.current = false;
      return;
    }
    pushLog("system", `Blinds posted: SB ${SB} / BB ${BB}`);
    flyChips("player");
    flyChips("bot");
    sfx.chip();
    await sleep(240);
    acting.current = false;
    if (gen !== genRef.current) return;

    // The server already ran the bot until the player's turn (or hand end).
    await applyStep(gen, res, bet);
  }, [phase, buyIn, wallet.balance, wallet.ready, roundStart, applyStep, syncBetting, pushLog, flyChips, handNo]);

  // -----------------------------------------------------------------------
  // Player actions — route a decision through the server.
  // -----------------------------------------------------------------------
  const playerActive = phase === "player";

  const sendAction = useCallback(
    async (action: "fold" | "check" | "call" | "raise", payload?: unknown) => {
      const rid = roundIdRef.current;
      if (!rid || acting.current) return;
      if (!legalActions.includes(action)) return;
      acting.current = true;
      const gen = genRef.current;
      const bet = handBuyInRef.current;

      // chip-burst + sound for chips going in.
      if (action === "call" || action === "raise") {
        sfx.chip();
        flyChips("player");
      } else {
        sfx.click();
      }
      // Hand control to the server; lock the controls until it responds.
      setPhase("bot");
      setLegalActions([]);
      setErrorMsg("");

      let res;
      try {
        res = await roundAct(rid, action, payload, { defer: true });
      } catch (err) {
        acting.current = false;
        if (gen !== genRef.current) return;
        // surface the GameError and hand control back to the player.
        setErrorMsg(err instanceof Error ? err.message : "That move isn't allowed.");
        sfx.lose();
        setPhase("player");
        setLegalActions(legalActionsRef.current);
        return;
      }
      acting.current = false;
      if (gen !== genRef.current) return;
      await applyStep(gen, res, bet);
    },
    [roundAct, applyStep, flyChips, legalActions],
  );

  // remember the last legal actions so a rejected move can restore the controls.
  const legalActionsRef = useRef<string[]>([]);
  legalActionsRef.current = legalActions;

  const onFold = useCallback(() => {
    if (!playerActive) return;
    void sendAction("fold");
  }, [playerActive, sendAction]);

  const playerCanCheck = legalActions.includes("check");

  const onCheckCall = useCallback(() => {
    if (!playerActive) return;
    void sendAction(playerCanCheck ? "check" : "call");
  }, [playerActive, playerCanCheck, sendAction]);

  // Raise bounds (the server validates min-raise / all-in; these keep the slider
  // sending a legal `to`). Min legal "raise to": a full min-raise over the bet to
  // call (BB increment), capped at the player's all-in.
  const maxRaiseTo = playerStreetBet + playerStack; // all-in ceiling
  const minRaiseTo = useMemo(() => {
    // facing a bet: at least toCall + BB more; opening: BB.
    const base = botStreetBet > 0 ? botStreetBet + Math.max(BB, botStreetBet - playerStreetBet) : Math.max(playerStreetBet, BB) + BB;
    return Math.min(base, maxRaiseTo);
  }, [botStreetBet, playerStreetBet, maxRaiseTo]);

  const canRaise = legalActions.includes("raise");

  const onRaise = useCallback(() => {
    if (!playerActive || !canRaise) return;
    const target = clamp(raiseTo, minRaiseTo, maxRaiseTo);
    if (target <= playerStreetBet) return;
    void sendAction("raise", { to: target });
  }, [playerActive, canRaise, raiseTo, minRaiseTo, maxRaiseTo, playerStreetBet, sendAction]);

  // Keep the raise slider within legal bounds as the round changes.
  useEffect(() => {
    if (!playerActive) return;
    setRaiseTo((r) => clamp(r, minRaiseTo, Math.max(minRaiseTo, maxRaiseTo)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playerActive, minRaiseTo, maxRaiseTo]);

  const potSizeRaise = clamp(
    botStreetBet + Math.max(BB, pot),
    minRaiseTo,
    maxRaiseTo,
  );
  const halfPotRaise = clamp(
    botStreetBet + Math.max(BB, Math.round(pot / 2)),
    minRaiseTo,
    maxRaiseTo,
  );

  // Display the current best made hand for the player as cards come out (pure
  // read of the visible public cards — no money, no engine logic).
  const playerHandLabel = useMemo(() => {
    if (playerHole.length < 2) return "";
    const known = [...playerHole, ...board.slice(0, revealBoard)];
    if (known.length < 5) return "";
    return evaluateBest(known).name;
  }, [playerHole, board, revealBoard]);

  const idle = phase === "idle" || phase === "done";
  const lowBalance = wallet.ready && wallet.balance < 2 * BB;

  // ---- Win celebration (visual only; pure reads of resolved state) --------
  const playerWon = phase === "done" && resultKind === "win";
  const cat = bestPlayerCat;
  const premiumHand = cat != null && cat >= HandCategory.Straight;
  const celebrate = playerWon && (netDelta >= BB * 3 || premiumHand);
  const celebrateTier: "win" | "big" | "jackpot" =
    (cat != null && cat >= HandCategory.StraightFlush) ||
    cat === HandCategory.FourOfAKind ||
    netDelta >= BB * 20
      ? "jackpot"
      : (cat != null && cat >= HandCategory.Flush) || netDelta >= BB * 8
        ? "big"
        : "win";

  // ---- Buy-in chip presets -------------------------------------------------
  const buyInPresets = [250, 500, 1000, 2000];

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------
  return (
    <div className="mx-auto w-full max-w-4xl">
      <div
        className="felt relative overflow-hidden rounded-3xl border border-emerald-300/15 p-4 shadow-felt sm:p-6 [@media(max-height:600px)]:p-2"
        style={{
          background:
            "radial-gradient(120% 90% at 50% -10%, rgba(46,204,113,0.18), transparent 55%), radial-gradient(100% 100% at 50% 120%, rgba(0,0,0,0.45), transparent 60%)",
        }}
      >
        {/* subtle table felt grid */}
        <div className="bg-grid pointer-events-none absolute inset-0 opacity-[0.06]" />

        {/* ===== Top: bot ===== */}
        <Seat
          name="House Bot"
          active={phase === "bot"}
          isButton={!buttonIsPlayer}
          stack={botStack}
          streetBet={botStreetBet}
          accent="#e74c3c"
        >
          <div className="flex gap-2">
            <PlayingCard
              card={botHole[0] ?? null}
              faceDown={!botRevealed}
              size="md"
              highlight={
                botRevealed &&
                botHole[0] != null &&
                winningIds.includes(botHole[0].id)
              }
            />
            <PlayingCard
              card={botHole[1] ?? null}
              faceDown={!botRevealed}
              size="md"
              highlight={
                botRevealed &&
                botHole[1] != null &&
                winningIds.includes(botHole[1].id)
              }
            />
          </div>
        </Seat>

        {/* ===== Pot + board ===== */}
        <div className="relative my-2 flex flex-col items-center gap-2 sm:my-3 sm:gap-3 [@media(max-height:600px)]:my-1.5 [@media(max-height:600px)]:gap-1.5">
          {/* Pot readout */}
          <motion.div
            key={pot}
            initial={{ scale: 0.85, opacity: 0.6 }}
            animate={{ scale: 1, opacity: 1 }}
            className="flex items-center gap-2 rounded-full border border-gold/30 bg-black/45 px-4 py-1.5 backdrop-blur"
          >
            <span className="text-[10px] uppercase tracking-widest text-white/45">
              Pot
            </span>
            <span className="gold-text text-lg font-bold tabular-nums">
              {formatChips(pot)}
            </span>
          </motion.div>

          {/* Chip flight bursts */}
          <AnimatePresence>
            {chipBursts.map((b) => (
              <motion.div
                key={b.id}
                className="pointer-events-none absolute left-1/2 top-1/2 z-20"
                initial={{
                  x: 0,
                  y: b.from === "bot" ? -120 : 120,
                  scale: 0.6,
                  opacity: 0,
                }}
                animate={{ x: 0, y: 0, scale: 1, opacity: 1 }}
                exit={{ scale: 0.4, opacity: 0 }}
                transition={{ duration: 0.5, ease: "easeOut" }}
              >
                <Chip value={25} size={34} />
              </motion.div>
            ))}
          </AnimatePresence>

          {/* Board */}
          <div className="flex min-h-[96px] items-center justify-center gap-1.5 sm:gap-2 [@media(max-height:600px)]:min-h-[72px]">
            {[0, 1, 2, 3, 4].map((i) => {
              const card = board[i] ?? null;
              const shown = i < revealBoard && card != null;
              const isWin = shown && card != null && winningIds.includes(card.id);
              return (
                <AnimatePresence key={i} mode="popLayout">
                  {shown ? (
                    <motion.div
                      key={`c-${card!.id}`}
                      initial={{ y: -42, opacity: 0, rotateZ: -12, scale: 0.8 }}
                      animate={{ y: 0, opacity: 1, rotateZ: 0, scale: 1 }}
                      transition={{
                        type: "spring",
                        stiffness: 320,
                        damping: 22,
                        delay: (i % 3) * 0.08,
                      }}
                    >
                      <PlayingCard card={card} size="md" highlight={isWin} />
                    </motion.div>
                  ) : (
                    <div
                      key={`ph-${i}`}
                      className="rounded-[9px] border border-dashed border-white/12"
                      style={{ width: 66, height: 92 }}
                    />
                  )}
                </AnimatePresence>
              );
            })}
          </div>

          {/* Street label */}
          <div className="text-[10px] uppercase tracking-[0.3em] text-white/35">
            {phase === "idle" ? "Place your buy-in" : street}
          </div>
        </div>

        {/* ===== Bottom: player ===== */}
        <Seat
          name="You"
          active={playerActive}
          isButton={buttonIsPlayer}
          stack={playerStack}
          streetBet={playerStreetBet}
          accent={ACCENT}
          handLabel={playerHandLabel}
        >
          <div className="flex gap-2">
            <PlayingCard
              card={playerHole[0] ?? null}
              faceDown={playerHole.length === 0}
              size="lg"
              highlight={
                playerHole[0] != null && winningIds.includes(playerHole[0].id)
              }
            />
            <PlayingCard
              card={playerHole[1] ?? null}
              faceDown={playerHole.length === 0}
              size="lg"
              highlight={
                playerHole[1] != null && winningIds.includes(playerHole[1].id)
              }
            />
          </div>
        </Seat>

        {/* ===== Result banner ===== */}
        <AnimatePresence>
          {phase === "done" && resultKind && (
            <motion.div
              className="pointer-events-none absolute inset-0 z-30 grid place-items-center"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
            >
              {/* Win burst rays */}
              {resultKind === "win" && (
                <motion.div
                  className="absolute"
                  initial={{ scale: 0.2, opacity: 0.9 }}
                  animate={{ scale: 2.4, opacity: 0 }}
                  transition={{ duration: 0.9, ease: "easeOut" }}
                  style={{
                    width: 240,
                    height: 240,
                    borderRadius: "9999px",
                    background: `radial-gradient(circle, ${ACCENT}66 0%, transparent 70%)`,
                  }}
                />
              )}
              <motion.div
                data-testid="round-result"
                initial={{ scale: 0.7, y: 14, opacity: 0 }}
                animate={{ scale: 1, y: 0, opacity: 1 }}
                transition={{ type: "spring", stiffness: 300, damping: 18 }}
                className="rounded-2xl border px-6 py-4 text-center backdrop-blur-md"
                style={{
                  borderColor:
                    resultKind === "win"
                      ? ACCENT
                      : resultKind === "push"
                        ? "#d4af37"
                        : "#e74c3c",
                  background: "rgba(0,0,0,0.6)",
                  boxShadow:
                    resultKind === "win"
                      ? `0 0 40px ${ACCENT}88`
                      : resultKind === "push"
                        ? "0 0 30px rgba(212,175,55,0.5)"
                        : "0 0 30px rgba(231,76,60,0.5)",
                }}
              >
                <div
                  className="font-display text-xl font-bold sm:text-2xl"
                  style={{
                    color:
                      resultKind === "win"
                        ? ACCENT
                        : resultKind === "push"
                          ? "#f5d060"
                          : "#ff6b6b",
                  }}
                >
                  {resultText}
                </div>
                <div
                  className="mt-1 text-sm font-bold tabular-nums"
                  style={{ color: netDelta >= 0 ? ACCENT : "#ff6b6b" }}
                >
                  {netDelta === 0 ? "Pot returned" : `${formatDelta(netDelta)} chips`}
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Win celebration overlay (z-30, pointer-events:none, reduced-motion safe) */}
        <Celebration
          show={celebrate}
          seed={netDelta}
          tier={celebrateTier}
          colors={["#2ecc71", "#ffd24a", "#22e1ff", "#ffffff"]}
        />
      </div>

      {/* ===== Controls ===== */}
      <div className="mt-2 grid gap-2 sm:mt-4 sm:gap-3 lg:grid-cols-[1fr_auto]">
        {/* Action / buy-in panel */}
        <div className="glass rounded-2xl p-4">
          {idle ? (
            <div className="flex flex-col gap-3">
              <div className="text-center text-[11px] uppercase tracking-widest text-white/45">
                Buy-in for the hand
              </div>
              <div className="flex flex-wrap items-center justify-center gap-3">
                {buyInPresets.map((v) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => {
                      sfx.chip();
                      setBuyIn(v);
                    }}
                    className="flex flex-col items-center gap-1"
                    data-testid={`buyin-${v}`}
                  >
                    <Chip value={v} size={52} selected={buyIn === v} />
                  </button>
                ))}
              </div>
              <div className="flex items-center justify-center gap-3">
                <span className="text-xs text-white/50">Buy-in</span>
                <span className="gold-text text-lg font-bold tabular-nums">
                  {formatChips(buyIn)}
                </span>
              </div>
              <Button
                variant="gold"
                size="lg"
                block
                data-testid="play-btn"
                disabled={lowBalance}
                onClick={startHand}
              >
                {lowBalance ? "Top up to play" : "Deal Hand ♠"}
              </Button>
              {lowBalance && (
                <div className="text-center text-xs text-ruby">
                  Balance below the minimum buy-in — use the top-up in the header.
                </div>
              )}
              {errorMsg && !lowBalance && (
                <div className="text-center text-xs text-ruby">{errorMsg}</div>
              )}
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {/* status line */}
              <div className="flex items-center justify-between text-xs text-white/55">
                <span>
                  {playerActive
                    ? toCall > 0
                      ? `To call: ${formatChips(toCall)}`
                      : "Action on you"
                    : phase === "bot"
                      ? "Bot is thinking…"
                      : phase === "showdown"
                        ? "Showdown!"
                        : "Dealing…"}
                </span>
                <span className="tabular-nums">Pot {formatChips(pot)}</span>
              </div>

              {errorMsg && (
                <div className="text-center text-[11px] text-ruby">{errorMsg}</div>
              )}

              {/* action buttons */}
              <div className="grid grid-cols-3 gap-2">
                <Button
                  variant="danger"
                  size="lg"
                  data-testid="fold-btn"
                  disabled={!playerActive || !legalActions.includes("fold")}
                  onClick={onFold}
                >
                  Fold
                </Button>
                <Button
                  variant="felt"
                  size="lg"
                  data-testid="call-btn"
                  disabled={!playerActive || (!playerCanCheck && !legalActions.includes("call"))}
                  onClick={onCheckCall}
                >
                  {playerCanCheck ? "Check" : `Call ${formatChips(toCall)}`}
                </Button>
                <Button
                  variant="neon"
                  size="lg"
                  data-testid="raise-btn"
                  disabled={!playerActive || !canRaise}
                  onClick={onRaise}
                >
                  {botStreetBet > 0 ? "Raise" : "Bet"}
                </Button>
              </div>

              {/* raise sizing */}
              <div
                className={`rounded-xl border border-white/10 bg-black/30 p-3 transition ${
                  playerActive && canRaise ? "opacity-100" : "opacity-40"
                }`}
              >
                <div className="flex items-center justify-between text-[11px] text-white/50">
                  <span>Raise to</span>
                  <span className="gold-text font-bold tabular-nums">
                    {formatChips(clamp(raiseTo, minRaiseTo, Math.max(minRaiseTo, maxRaiseTo)))}
                  </span>
                </div>
                <input
                  type="range"
                  min={minRaiseTo}
                  max={Math.max(minRaiseTo, maxRaiseTo)}
                  step={SB}
                  value={clamp(raiseTo, minRaiseTo, Math.max(minRaiseTo, maxRaiseTo))}
                  disabled={!playerActive || !canRaise}
                  onChange={(e) => setRaiseTo(parseInt(e.target.value, 10))}
                  data-testid="raise-slider"
                  className="mt-2 w-full accent-emerald-400"
                  style={{ accentColor: ACCENT }}
                />
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <SizeBtn
                    label="Min"
                    disabled={!playerActive || !canRaise}
                    onClick={() => setRaiseTo(minRaiseTo)}
                  />
                  <SizeBtn
                    label="½ Pot"
                    disabled={!playerActive || !canRaise}
                    onClick={() => setRaiseTo(halfPotRaise)}
                  />
                  <SizeBtn
                    label="Pot"
                    disabled={!playerActive || !canRaise}
                    onClick={() => setRaiseTo(potSizeRaise)}
                  />
                  <SizeBtn
                    label="All-in"
                    disabled={!playerActive || !canRaise}
                    onClick={() => setRaiseTo(maxRaiseTo)}
                  />
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Info / hand ranks panel */}
        <CollapsiblePanel
          title="Action Log & Hand Ranks"
          accent={ACCENT}
          summary={<>blinds {SB}/{BB}</>}
          className="w-full lg:w-72"
        >
         <div className="flex w-full flex-col gap-3">
          <div className="text-[11px] uppercase tracking-widest text-white/45">
            Action Log
          </div>
          <div className="flex min-h-[88px] flex-col gap-1 text-xs">
            <AnimatePresence initial={false}>
              {log.map((e) => (
                <motion.div
                  key={e.id}
                  initial={{ opacity: 0, x: -8 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0 }}
                  className={
                    e.who === "player"
                      ? "text-emerald-300"
                      : e.who === "bot"
                        ? "text-red-300"
                        : "text-white/45"
                  }
                >
                  {e.who === "player" ? "▸ " : e.who === "bot" ? "◂ " : "· "}
                  {e.text}
                </motion.div>
              ))}
            </AnimatePresence>
          </div>

          <div className="border-t border-white/10 pt-2 text-[11px] uppercase tracking-widest text-white/45">
            Hand Ranks
          </div>
          <ol className="space-y-0.5 text-[11px] text-white/55">
            {[
              "Royal Flush",
              "Straight Flush",
              "Four of a Kind",
              "Full House",
              "Flush",
              "Straight",
              "Three of a Kind",
              "Two Pair",
              "Pair",
              "High Card",
            ].map((n) => (
              <li key={n} className="flex justify-between">
                <span>{n}</span>
              </li>
            ))}
          </ol>
          <div className="border-t border-white/10 pt-2 text-[10px] leading-relaxed text-white/40">
            Heads-up no-limit. Blinds {SB}/{BB}. Button is random each hand. Best
            five-card hand wins; ties split the pot.
          </div>
         </div>
        </CollapsiblePanel>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function SizeBtn({
  label,
  onClick,
  disabled,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={() => {
        if (disabled) return;
        sfx.click();
        onClick();
      }}
      disabled={disabled}
      className="rounded-lg border border-white/12 bg-white/5 px-2.5 py-1 text-[11px] font-semibold text-white/70 transition hover:bg-white/10 disabled:opacity-40"
    >
      {label}
    </button>
  );
}

function Seat({
  name,
  active,
  isButton,
  stack,
  streetBet,
  accent,
  handLabel,
  children,
}: {
  name: string;
  active: boolean;
  isButton: boolean;
  stack: number;
  streetBet: number;
  accent: string;
  handLabel?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-center gap-3 sm:gap-5">
      {/* name plate */}
      <motion.div
        animate={{
          boxShadow: active
            ? `0 0 0 2px ${accent}, 0 0 22px ${accent}88`
            : "0 0 0 1px rgba(255,255,255,0.08)",
        }}
        transition={{ duration: 0.3 }}
        className="flex min-w-[112px] flex-col items-start gap-0.5 rounded-xl bg-black/40 px-3 py-2 backdrop-blur"
      >
        <div className="flex items-center gap-1.5">
          <span
            className="text-sm font-bold"
            style={{ color: accent, textShadow: `0 0 10px ${accent}66` }}
          >
            {name}
          </span>
          {isButton && (
            <span
              className="grid h-4 w-4 place-items-center rounded-full bg-white text-[9px] font-black text-black"
              title="Dealer button"
            >
              D
            </span>
          )}
        </div>
        <div className="text-[10px] uppercase tracking-wider text-white/40">
          Stack
        </div>
        <div className="text-xs font-bold tabular-nums text-white/80">
          {formatChips(stack)}
        </div>
        {streetBet > 0 && (
          <motion.div
            key={streetBet}
            initial={{ scale: 0.8, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="mt-0.5 rounded-full border border-gold/40 bg-black/50 px-2 py-0.5 text-[10px] font-bold tabular-nums text-gold"
          >
            bet {formatChips(streetBet)}
          </motion.div>
        )}
        {handLabel && (
          <div className="mt-0.5 text-[10px] font-semibold text-emerald-300/80">
            {handLabel}
          </div>
        )}
      </motion.div>

      {/* cards */}
      <motion.div
        animate={{ scale: active ? 1.02 : 1 }}
        transition={{ duration: 0.25 }}
      >
        {children}
      </motion.div>
    </div>
  );
}
