"use client";

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  apiMe,
  apiSync,
  apiPlay,
  apiRescue,
  apiLogin,
  apiRegister,
  apiDeleteAccount,
  clearToken,
  type SyncPayload,
  type PlayResult,
} from "./auth-client";

const STARTING_BALANCE = 10_000;
/** Guest-wallet bailout grant. Logged-in grants are decided server-side (/api/rescue). */
const RESCUE_GRANT = 5_000;
/**
 * Safety net for the in-flight bet guard: if a game never settles a deferred bet
 * (e.g. it unmounts mid-reveal), auto-clear the flag after this long so the
 * bankruptcy bailout button can never be hidden forever. Comfortably longer than
 * any reveal animation.
 */
const BET_GUARD_MS = 20_000;
/** Backstop for a bought-bonus / free-spin sequence, which can run many spins. */
const BONUS_GUARD_MS = 300_000;

// Layout effect on the client (so the guard flips before paint — no flash),
// plain effect on the server (avoids React's useLayoutEffect-during-SSR warning).
const useIsoLayoutEffect =
  typeof window !== "undefined" ? useLayoutEffect : useEffect;
const storageKey = (username: string | null) =>
  username ? `neon-royale-wallet-${username}` : "neon-royale-wallet-guest";

/**
 * Round to the cent (2 decimals). Chips are tracked at cent precision so that
 * fair payouts (e.g. a 1.95× banker win or a 0.99/p dice multiplier) credit the
 * EXACT return at any stake — integer truncation at small bets used to distort
 * the house edge in both directions (player-favorable rounding-up exploits and
 * house-favorable shaving). Bets remain whole chips; only winnings carry cents.
 */
const round2 = (n: number): number => Math.round(n * 100) / 100;

export interface WalletState {
  balance: number;
  totalWagered: number;
  totalReturned: number;
  rounds: number;
  biggestWin: number;
  resets: number;
}

export interface Wallet extends WalletState {
  bet: (amount: number) => boolean;
  win: (amount: number) => void;
  /**
   * Server-authoritative play (logged-in users). Sends only {game, bet, params};
   * the server decides the outcome + payout and returns the authoritative balance.
   * Throws on rejection (insufficient funds / invalid). Guests should use bet()/win().
   */
  play: (game: string, amount: number, params: unknown) => Promise<PlayResult>;
  /**
   * Apply the authoritative balance returned by a /api/round step. Mid-round
   * steps pass only the balance; on settle, pass the wagered/returned deltas so
   * display stats + leaderboard stay in sync.
   */
  applyServerBalance: (
    balance: number,
    deltas?: { wagered?: number; returned?: number; biggestWin?: number; settled?: boolean },
  ) => void;
  /** True when a server-authoritative wallet is active (i.e. logged in). */
  serverAuthoritative: boolean;
  /**
   * True while one or more bets are mid-reveal — debited, but with the payout not
   * yet credited (deferred settlement). The header uses this to suppress the
   * bankruptcy bailout button so it never flashes in on a transient sub-threshold
   * dip during a spin/flip/deal animation.
   */
  betting: boolean;
  /**
   * Mark a bet in-flight for the duration of a reveal animation OR an open
   * multi-step round. Returns a `done` callback to invoke once the result has
   * been shown / the round has resolved; a safety timer (default `BET_GUARD_MS`,
   * overridable for long-lived round guards) also clears the flag if `done` is
   * never called (e.g. the game unmounts). Wired into the shared play hooks, not
   * called by games.
   */
  beginBet: (safetyMs?: number) => () => void;
  topUp: (amount?: number) => void;
  /**
   * Bankruptcy bailout. For logged-in users this is server-authoritative — the
   * server grants chips only when the account is broke and returns the real
   * balance. For guests it tops up the local (localStorage) wallet. Replaces the
   * old client-only top-up that the server-authoritative wallet silently ignored.
   */
  rescue: () => Promise<void>;
  reset: () => void;
  ready: boolean;
  username: string | null;
  login: (username: string, password: string) => Promise<void>;
  register: (username: string, password: string) => Promise<void>;
  logout: () => void;
  deleteAccount: () => Promise<void>;
}

const defaultState: WalletState = {
  balance: STARTING_BALANCE,
  totalWagered: 0,
  totalReturned: 0,
  rounds: 0,
  biggestWin: 0,
  resets: 0,
};

const WalletContext = createContext<Wallet | null>(null);

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<WalletState>(defaultState);
  const [ready, setReady] = useState(false);
  const [username, setUsername] = useState<string | null>(null);
  // Count of bets currently mid-reveal (deferred-settlement window). Kept out of
  // WalletState so it's never persisted or synced — it's transient UI state.
  const [activeBets, setActiveBets] = useState(0);
  const loaded = useRef(false);
  // Track the username at the time state was last synced to avoid stale closure issues
  const usernameRef = useRef<string | null>(null);

  // Load persisted state + try to restore auth session on mount
  useEffect(() => {
    async function init() {
      // Try to restore session from server first
      const user = await apiMe();

      if (user) {
        setUsername(user.username);
        usernameRef.current = user.username;
        setState({
          balance: user.balance,
          totalWagered: user.totalWagered,
          totalReturned: user.totalReturned,
          rounds: user.rounds,
          biggestWin: user.biggestWin,
          resets: user.resets ?? 0,
        });
      } else {
        // Guest — load from localStorage
        try {
          const raw = localStorage.getItem(storageKey(null));
          if (raw) {
            const parsed = JSON.parse(raw) as Partial<WalletState>;
            setState((s) => ({ ...s, ...parsed }));
          }
        } catch {
          /* ignore corrupt storage */
        }
      }

      loaded.current = true;
      setReady(true);
    }

    init();
  }, []);

  // Persist to localStorage on every state change (after initial load)
  useEffect(() => {
    if (!loaded.current) return;
    try {
      localStorage.setItem(storageKey(username), JSON.stringify(state));
    } catch {
      /* storage full / unavailable */
    }
  }, [state, username]);

  // Sync to server after every state change when logged in
  useEffect(() => {
    if (!loaded.current) return;
    if (!username) return;
    const payload: SyncPayload = {
      balance: state.balance,
      totalWagered: state.totalWagered,
      totalReturned: state.totalReturned,
      rounds: state.rounds,
      biggestWin: state.biggestWin,
      resets: state.resets,
    };
    // Fire and forget — never block gameplay on network
    apiSync(payload);
  }, [state, username]);

  const bet = useCallback((amount: number): boolean => {
    const amt = Math.floor(amount);
    if (!Number.isFinite(amt) || amt <= 0) return false;
    let ok = false;
    setState((s) => {
      if (s.balance < amt) return s;
      ok = true;
      return {
        ...s,
        balance: round2(s.balance - amt),
        totalWagered: s.totalWagered + amt,
        rounds: s.rounds + 1,
      };
    });
    return ok;
  }, []);

  const win = useCallback((amount: number) => {
    // Credit the EXACT total return rounded to the cent (not floored to a whole
    // chip). This keeps every game's coded house edge intact at any stake.
    const amt = Math.max(0, round2(amount));
    if (amt <= 0) return;
    setState((s) => ({
      ...s,
      balance: round2(s.balance + amt),
      totalReturned: round2(s.totalReturned + amt),
      biggestWin: Math.max(s.biggestWin, amt),
    }));
  }, []);

  /**
   * Server-authoritative one-shot wager (logged-in users). The client sends only
   * { game, bet, params }; the server owns the RNG, the outcome and the payout,
   * and returns the AUTHORITATIVE balance. We mirror that balance verbatim and
   * advance display-only stats — we never compute money locally for a logged-in
   * user. Throws on rejection (insufficient funds / invalid bet / network).
   */
  const play = useCallback(
    async (game: string, amount: number, params: unknown): Promise<PlayResult> => {
      const result = await apiPlay(game, amount, params);
      setState((s) => ({
        ...s,
        balance: result.balance, // authoritative — server is the source of truth
        totalWagered: s.totalWagered + amount,
        totalReturned: round2(s.totalReturned + result.payout),
        rounds: s.rounds + 1,
        biggestWin: Math.max(s.biggestWin, result.payout),
      }));
      return result;
    },
    [],
  );

  const applyServerBalance = useCallback(
    (
      balance: number,
      deltas?: { wagered?: number; returned?: number; biggestWin?: number; settled?: boolean },
    ) => {
      setState((s) => ({
        ...s,
        balance,
        totalWagered: s.totalWagered + (deltas?.wagered ?? 0),
        totalReturned: round2(s.totalReturned + (deltas?.returned ?? 0)),
        rounds: deltas?.settled ? s.rounds + 1 : s.rounds,
        biggestWin: Math.max(s.biggestWin, deltas?.biggestWin ?? 0),
      }));
    },
    [],
  );

  const topUp = useCallback((amount = STARTING_BALANCE) => {
    setState((s) => ({ ...s, balance: round2(s.balance + Math.max(0, Math.floor(amount))) }));
  }, []);

  const rescue = useCallback(async () => {
    if (usernameRef.current) {
      // Logged-in: the SERVER grants the bailout (broke accounts only) and returns
      // the authoritative balance + reset count. We mirror it — never mint chips
      // client-side, since /api/sync deliberately ignores client balance writes.
      const result = await apiRescue();
      if (result) {
        setState((s) => ({ ...s, balance: result.balance, resets: result.resets }));
      }
      return;
    }
    // Guest wallet is client-authoritative (localStorage), so a local top-up is
    // itself the source of truth.
    setState((s) => ({ ...s, balance: round2(s.balance + RESCUE_GRANT), resets: s.resets + 1 }));
  }, []);

  const reset = useCallback(() => {
    setState((s) => ({ ...s, balance: STARTING_BALANCE, resets: s.resets + 1 }));
  }, []);

  const beginBet = useCallback((safetyMs: number = BET_GUARD_MS): (() => void) => {
    setActiveBets((n) => n + 1);
    let done = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      setActiveBets((n) => Math.max(0, n - 1));
    };
    // Self-heal: clear the guard even if the caller never settles (e.g. the game
    // unmounts). Reveal guards use the short default; round guards pass a longer
    // backstop since a player can sit on a decision for a while.
    timer = setTimeout(finish, safetyMs);
    return finish;
  }, []);

  const login = useCallback(async (user: string, password: string) => {
    const result = await apiLogin(user, password);
    if (!result) throw new Error("Login failed");
    setUsername(result.user.username);
    usernameRef.current = result.user.username;
    setState({
      balance: result.user.balance,
      totalWagered: result.user.totalWagered,
      totalReturned: result.user.totalReturned,
      rounds: result.user.rounds,
      biggestWin: result.user.biggestWin,
      resets: result.user.resets ?? 0,
    });
    loaded.current = true;
  }, []);

  const register = useCallback(async (user: string, password: string) => {
    const result = await apiRegister(user, password);
    if (!result) throw new Error("Registration failed");
    setUsername(result.user.username);
    usernameRef.current = result.user.username;
    setState({
      balance: result.user.balance,
      totalWagered: result.user.totalWagered,
      totalReturned: result.user.totalReturned,
      rounds: result.user.rounds,
      biggestWin: result.user.biggestWin,
      resets: result.user.resets ?? 0,
    });
    loaded.current = true;
  }, []);

  const logout = useCallback(() => {
    clearToken();
    setUsername(null);
    usernameRef.current = null;
    // Load guest state from localStorage
    try {
      const raw = localStorage.getItem(storageKey(null));
      if (raw) {
        setState(JSON.parse(raw) as WalletState);
      } else {
        setState({ ...defaultState });
      }
    } catch {
      setState({ ...defaultState });
    }
  }, []);

  const deleteAccount = useCallback(async () => {
    await apiDeleteAccount();
    clearToken();
    setUsername(null);
    usernameRef.current = null;
    setState({ ...defaultState });
  }, []);

  const value = useMemo<Wallet>(
    () => ({
      ...state,
      bet,
      win,
      play,
      applyServerBalance,
      serverAuthoritative: username !== null,
      betting: activeBets > 0,
      beginBet,
      topUp,
      rescue,
      reset,
      ready,
      username,
      login,
      register,
      logout,
      deleteAccount,
    }),
    [state, bet, win, play, applyServerBalance, activeBets, beginBet, topUp, rescue, reset, ready, username, login, register, logout, deleteAccount],
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet(): Wallet {
  const ctx = useContext(WalletContext);
  if (!ctx) {
    throw new Error("useWallet must be used within a <WalletProvider>");
  }
  return ctx;
}

/**
 * Suppress the bankruptcy bailout button while `active` is true. For game flows
 * that move chips OUTSIDE the play hooks — i.e. the slots "buy bonus / free
 * spins" feature, which debits via `wallet.bet()` directly — so the "+5,000"
 * never flashes in during a bought-bonus animation that dipped the balance. Pass
 * a flag that's true for the whole bonus (set in the same render that debits, so
 * the guard engages before paint) and resets when it ends.
 */
export function useBettingGuard(active: boolean): void {
  const { beginBet } = useWallet();
  useIsoLayoutEffect(() => {
    if (!active) return;
    return beginBet(BONUS_GUARD_MS);
  }, [active, beginBet]);
}

export { STARTING_BALANCE };
