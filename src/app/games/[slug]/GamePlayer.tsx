"use client";

import React, { useMemo } from "react";
import dynamic from "next/dynamic";
import { motion } from "framer-motion";
import { getGame } from "@/lib/games";
import { GameShell } from "@/components/GameShell";

function Loading({ accent }: { accent: string }) {
  return (
    <div className="grid min-h-[50vh] place-items-center">
      <div className="flex flex-col items-center gap-4">
        <motion.div
          className="h-14 w-14 rounded-full border-4 border-white/10"
          style={{ borderTopColor: accent }}
          animate={{ rotate: 360 }}
          transition={{ repeat: Infinity, duration: 0.9, ease: "linear" }}
        />
        <p className="text-sm text-white/50">Dealing you in…</p>
      </div>
    </div>
  );
}

export function GamePlayer({ slug }: { slug: string }) {
  const meta = getGame(slug);

  const Game = useMemo(() => {
    if (!meta) return null;
    return dynamic(meta.load, {
      ssr: false,
      loading: () => <Loading accent={meta.accent} />,
    });
  }, [meta]);

  if (!meta || !Game) {
    return (
      <GameShell title="Unknown Game">
        <div className="grid min-h-[40vh] place-items-center text-white/60">
          That game doesn’t exist yet.
        </div>
      </GameShell>
    );
  }

  return (
    <GameShell title={meta.name} subtitle={meta.blurb} accent={meta.accent}>
      <Game />
    </GameShell>
  );
}
