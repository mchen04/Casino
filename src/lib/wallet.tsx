"use client";

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  apiMe,
  apiSync,
  apiLogin,
  apiRegister,
  apiDeleteAccount,
  clearToken,
  type SyncPayload,
} from "./auth-client";

const STARTING_BALANCE = 10_000;
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
  topUp: (amount?: number) => void;
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

  const topUp = useCallback((amount = STARTING_BALANCE) => {
    setState((s) => ({ ...s, balance: round2(s.balance + Math.max(0, Math.floor(amount))) }));
  }, []);

  const reset = useCallback(() => {
    setState((s) => ({ ...s, balance: STARTING_BALANCE, resets: s.resets + 1 }));
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
    () => ({ ...state, bet, win, topUp, reset, ready, username, login, register, logout, deleteAccount }),
    [state, bet, win, topUp, reset, ready, username, login, register, logout, deleteAccount],
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

export { STARTING_BALANCE };
