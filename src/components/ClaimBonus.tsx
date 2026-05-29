"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { apiClaim, apiClaimStatus } from "@/lib/auth-client";
import { useWallet } from "@/lib/wallet";
import { sfx } from "@/lib/sound";

function formatCountdown(ms: number): string {
  if (ms <= 0) return "now";
  const totalSec = Math.ceil(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

export function ClaimBonus() {
  const { username, topUp } = useWallet();
  const [eligible, setEligible] = useState(false);
  const [nextClaimAt, setNextClaimAt] = useState<number | null>(null);
  const [timeLeft, setTimeLeft] = useState(0);
  const [claiming, setClaiming] = useState(false);
  const [flash, setFlash] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Fetch status whenever the user logs in
  useEffect(() => {
    if (!username) {
      setEligible(false);
      setNextClaimAt(null);
      return;
    }
    apiClaimStatus().then((status) => {
      if (!status) return;
      setEligible(status.eligible);
      setNextClaimAt(status.nextClaimAt);
    });
  }, [username]);

  // Countdown tick
  useEffect(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    if (!nextClaimAt) return;

    function tick() {
      const left = nextClaimAt! - Date.now();
      if (left <= 0) {
        setEligible(true);
        setNextClaimAt(null);
        setTimeLeft(0);
        if (timerRef.current) clearInterval(timerRef.current);
      } else {
        setTimeLeft(left);
      }
    }

    tick();
    timerRef.current = setInterval(tick, 1000);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [nextClaimAt]);

  const handleClaim = useCallback(async () => {
    if (claiming || !eligible) return;
    setClaiming(true);
    try {
      const result = await apiClaim();
      if (result) {
        topUp(result.claimed);
        setEligible(false);
        setNextClaimAt(result.nextClaimAt);
        setFlash(true);
        sfx.jackpot();
        setTimeout(() => setFlash(false), 1500);
      }
    } finally {
      setClaiming(false);
    }
  }, [claiming, eligible, topUp]);

  if (!username) return null;

  return (
    <AnimatePresence mode="wait">
      {eligible ? (
        <motion.button
          key="claim"
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: flash ? 1.08 : 1 }}
          exit={{ opacity: 0, scale: 0.9 }}
          transition={{ duration: 0.25 }}
          onClick={handleClaim}
          disabled={claiming}
          className="relative overflow-hidden rounded-2xl border border-gold/40 bg-gradient-to-b from-gold-light/20 to-gold-dark/10 px-5 py-3 text-left transition-all hover:border-gold/70 hover:from-gold-light/30 disabled:cursor-not-allowed disabled:opacity-60"
          style={{ boxShadow: "0 0 24px rgba(212,175,55,0.25)" }}
        >
          <span className="pointer-events-none absolute inset-0 rounded-2xl bg-gradient-to-r from-gold/0 via-gold/10 to-gold/0 opacity-0 transition-opacity hover:opacity-100" />
          <div className="text-[10px] uppercase tracking-widest text-gold/60">Daily Bonus</div>
          <div className="gold-text text-lg font-black">
            {claiming ? "Claiming…" : "Claim +1,000 ⬡"}
          </div>
        </motion.button>
      ) : nextClaimAt ? (
        <motion.div
          key="countdown"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="rounded-2xl border border-white/10 bg-black/30 px-5 py-3 text-left"
        >
          <div className="text-[10px] uppercase tracking-widest text-white/40">Next Bonus</div>
          <div className="text-lg font-black tabular-nums text-white/70">
            {formatCountdown(timeLeft)}
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
