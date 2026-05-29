"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { useWallet } from "@/lib/wallet";
import { apiLeaderboard } from "@/lib/auth-client";
import { formatChips } from "@/lib/format";
import type { LeaderboardEntry } from "@/lib/kv";

const MEDALS = ["🥇", "🥈", "🥉"];

export default function LeaderboardPage() {
  const wallet = useWallet();
  const [entries, setEntries] = useState<LeaderboardEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiLeaderboard(50).then((data) => {
      setEntries(data);
      setLoading(false);
    });
  }, []);

  return (
    <div className="mx-auto max-w-2xl px-4 py-10">
      {/* Header */}
      <div className="mb-8 flex items-center gap-4">
        <Link
          href="/"
          className="group inline-flex items-center gap-2 rounded-lg px-2 py-1 text-sm text-white/70 transition hover:text-gold"
        >
          <span className="text-lg transition group-hover:-translate-x-0.5">←</span>
          <span>Lobby</span>
        </Link>
        <div>
          <h1 className="gold-text font-display text-3xl font-black tracking-tight">
            Leaderboard
          </h1>
          <p className="text-sm text-white/40">Ranked by current balance</p>
        </div>
      </div>

      {/* Table */}
      <div className="overflow-hidden rounded-2xl border border-white/10 bg-ink-panel/80">
        {loading ? (
          <div className="space-y-px p-1">
            {[...Array(5)].map((_, i) => (
              <div
                key={i}
                className="h-14 animate-pulse rounded-xl bg-white/5"
              />
            ))}
          </div>
        ) : entries.length === 0 ? (
          <p className="py-16 text-center text-white/40">No players yet.</p>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-b border-white/10 text-[10px] uppercase tracking-widest text-white/30">
                <th className="px-5 py-3 text-left">Rank</th>
                <th className="px-5 py-3 text-left">Player</th>
                <th className="px-5 py-3 text-right">Balance</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => {
                const isMe =
                  wallet.username?.toLowerCase() === entry.username.toLowerCase();
                return (
                  <tr
                    key={entry.username}
                    className={`border-b border-white/5 transition last:border-0 ${
                      isMe ? "bg-gold/5" : "hover:bg-white/5"
                    }`}
                  >
                    <td className="px-5 py-4 text-lg">
                      {entry.rank <= 3
                        ? MEDALS[entry.rank - 1]
                        : <span className="text-sm text-white/40">#{entry.rank}</span>}
                    </td>
                    <td className="px-5 py-4">
                      <span
                        className={`font-semibold ${isMe ? "gold-text" : "text-white"}`}
                      >
                        {entry.username}
                      </span>
                      {isMe && (
                        <span className="ml-2 text-[10px] uppercase tracking-widest text-gold/60">
                          you
                        </span>
                      )}
                    </td>
                    <td className="px-5 py-4 text-right font-bold tabular-nums text-white">
                      {formatChips(entry.balance)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
