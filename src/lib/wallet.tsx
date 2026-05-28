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

const STORAGE_KEY = "neon-royale-wallet-v1";
const STARTING_BALANCE = 10_000;

export interface WalletState {
  /** Current chip balance. */
  balance: number;
  /** Total chips wagered this profile (lifetime, persisted). */
  totalWagered: number;
  /** Total chips returned from wins (lifetime, persisted). */
  totalReturned: number;
  /** Number of bets resolved. */
  rounds: number;
  /** Biggest single payout seen. */
  biggestWin: number;
}

export interface Wallet extends WalletState {
  /**
   * Attempt to place a bet of `amount` chips. Deducts immediately.
   * Returns true if there were sufficient funds, false otherwise (no deduction).
   */
  bet: (amount: number) => boolean;
  /**
   * Credit a gross payout to the balance. For an even-money win on a 100 bet,
   * call win(200) (stake back + 100 profit). For a push, win(stake). For a
   * loss, do nothing (or win(0)).
   */
  win: (amount: number) => void;
  /** Add free chips when broke (rescue). */
  topUp: (amount?: number) => void;
  /** Reset to the starting balance and clear stats. */
  reset: () => void;
  /** True once the persisted value has been read on the client (avoids hydration mismatch). */
  ready: boolean;
}

const defaultState: WalletState = {
  balance: STARTING_BALANCE,
  totalWagered: 0,
  totalReturned: 0,
  rounds: 0,
  biggestWin: 0,
};

const WalletContext = createContext<Wallet | null>(null);

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<WalletState>(defaultState);
  const [ready, setReady] = useState(false);
  const loaded = useRef(false);

  // Load persisted state once on the client.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<WalletState>;
        setState((s) => ({ ...s, ...parsed }));
      }
    } catch {
      /* ignore corrupt storage */
    }
    loaded.current = true;
    setReady(true);
  }, []);

  // Persist on change (after initial load).
  useEffect(() => {
    if (!loaded.current) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      /* storage full / unavailable */
    }
  }, [state]);

  const bet = useCallback((amount: number): boolean => {
    const amt = Math.floor(amount);
    if (!Number.isFinite(amt) || amt <= 0) return false;
    let ok = false;
    setState((s) => {
      if (s.balance < amt) return s;
      ok = true;
      return {
        ...s,
        balance: s.balance - amt,
        totalWagered: s.totalWagered + amt,
        rounds: s.rounds + 1,
      };
    });
    return ok;
  }, []);

  const win = useCallback((amount: number) => {
    const amt = Math.max(0, Math.floor(amount));
    if (amt <= 0) return;
    setState((s) => ({
      ...s,
      balance: s.balance + amt,
      totalReturned: s.totalReturned + amt,
      biggestWin: Math.max(s.biggestWin, amt),
    }));
  }, []);

  const topUp = useCallback((amount = STARTING_BALANCE) => {
    setState((s) => ({ ...s, balance: s.balance + Math.max(0, Math.floor(amount)) }));
  }, []);

  const reset = useCallback(() => {
    setState({ ...defaultState });
  }, []);

  const value = useMemo<Wallet>(
    () => ({ ...state, bet, win, topUp, reset, ready }),
    [state, bet, win, topUp, reset, ready],
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
