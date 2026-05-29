"use client";

import React, { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useWallet } from "@/lib/wallet";
import { Button } from "@/components/ui/Button";

export default function LoginPage() {
  const wallet = useWallet();
  const router = useRouter();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      if (mode === "login") {
        await wallet.login(username, password);
      } else {
        await wallet.register(username, password);
      }
      router.replace("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="mb-8 text-center">
          <p className="text-xs uppercase tracking-[0.5em] text-gold/70">Welcome to</p>
          <h1 className="gold-text mt-1 font-display text-4xl font-black tracking-tight">
            NEON ROYALE
          </h1>
        </div>

        {/* Card */}
        <div className="rounded-2xl border border-white/10 bg-ink-panel/80 p-8 shadow-2xl backdrop-blur-xl">
          {/* Mode toggle */}
          <div className="mb-6 flex rounded-xl border border-white/10 bg-black/30 p-1">
            {(["login", "register"] as const).map((m) => (
              <button
                key={m}
                onClick={() => {
                  setMode(m);
                  setError(null);
                }}
                className={`flex-1 rounded-lg py-2 text-sm font-semibold capitalize transition ${
                  mode === m
                    ? "bg-gradient-to-b from-gold-light to-gold-dark text-ink shadow-gold"
                    : "text-white/50 hover:text-white"
                }`}
              >
                {m}
              </button>
            ))}
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="mb-1.5 block text-xs uppercase tracking-widest text-white/40">
                Username
              </label>
              <input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="your_name"
                autoComplete="username"
                required
                className="w-full rounded-xl border border-white/10 bg-black/40 px-4 py-2.5 text-sm text-white placeholder:text-white/20 focus:border-gold/50 focus:outline-none"
              />
            </div>

            <div>
              <label className="mb-1.5 block text-xs uppercase tracking-widest text-white/40">
                Password
              </label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                autoComplete={mode === "login" ? "current-password" : "new-password"}
                required
                className="w-full rounded-xl border border-white/10 bg-black/40 px-4 py-2.5 text-sm text-white placeholder:text-white/20 focus:border-gold/50 focus:outline-none"
              />
            </div>

            {error && (
              <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-400">
                {error}
              </p>
            )}

            <Button type="submit" block disabled={loading}>
              {loading ? "…" : mode === "login" ? "Sign In" : "Create Account"}
            </Button>
          </form>
        </div>

        <p className="mt-4 text-center">
          <Link
            href="/"
            className="text-sm text-white/40 transition hover:text-white/70"
          >
            Continue as guest →
          </Link>
        </p>
      </div>
    </div>
  );
}
