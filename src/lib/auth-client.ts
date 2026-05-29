import type { LeaderboardEntry, UserRecord } from "./kv";

const TOKEN_KEY = "neon-royale-token";

export type PublicUser = Omit<UserRecord, "passwordHash">;

export interface AuthResponse {
  token: string;
  user: PublicUser;
}

export interface SyncPayload {
  balance: number;
  totalWagered: number;
  totalReturned: number;
  rounds: number;
  biggestWin: number;
}

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* storage unavailable */
  }
}

export function clearToken(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable */
  }
}

function authHeaders(): HeadersInit {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function apiRegister(
  username: string,
  password: string,
): Promise<AuthResponse | null> {
  try {
    const res = await fetch("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    if (!res.ok) {
      const { error } = await res.json();
      throw new Error(error ?? "Registration failed");
    }
    const data: AuthResponse = await res.json();
    setToken(data.token);
    return data;
  } catch (err) {
    throw err;
  }
}

export async function apiLogin(
  username: string,
  password: string,
): Promise<AuthResponse | null> {
  try {
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    if (!res.ok) {
      const { error } = await res.json();
      throw new Error(error ?? "Login failed");
    }
    const data: AuthResponse = await res.json();
    setToken(data.token);
    return data;
  } catch (err) {
    throw err;
  }
}

export async function apiMe(): Promise<PublicUser | null> {
  try {
    const res = await fetch("/api/auth/me", { headers: authHeaders() });
    if (!res.ok) return null;
    const { user } = await res.json();
    return user as PublicUser;
  } catch {
    return null;
  }
}

export async function apiSync(payload: SyncPayload): Promise<boolean> {
  try {
    const res = await fetch("/api/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify(payload),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export interface ClaimStatus {
  eligible: boolean;
  nextClaimAt: number | null;
}

export interface ClaimResult {
  balance: number;
  claimed: number;
  nextClaimAt: number;
}

export async function apiClaimStatus(): Promise<ClaimStatus | null> {
  try {
    const res = await fetch("/api/claim", { headers: authHeaders() });
    if (!res.ok) return null;
    return res.json() as Promise<ClaimStatus>;
  } catch {
    return null;
  }
}

export async function apiClaim(): Promise<ClaimResult | null> {
  try {
    const res = await fetch("/api/claim", {
      method: "POST",
      headers: authHeaders(),
    });
    if (!res.ok) return null;
    return res.json() as Promise<ClaimResult>;
  } catch {
    return null;
  }
}

export async function apiLeaderboard(limit = 50): Promise<LeaderboardEntry[]> {
  try {
    const res = await fetch(`/api/leaderboard?limit=${limit}`);
    if (!res.ok) return [];
    const { entries } = await res.json();
    return entries as LeaderboardEntry[];
  } catch {
    return [];
  }
}
