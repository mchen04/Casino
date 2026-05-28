"use client";

import React from "react";
import { motion } from "framer-motion";
import { type Card, SUIT_SYMBOL, SUIT_COLOR } from "@/lib/cards";

type Size = "xs" | "sm" | "md" | "lg";

const DIMS: Record<Size, { w: number; h: number; r: number; corner: number; center: number }> = {
  xs: { w: 38, h: 54, r: 6, corner: 11, center: 20 },
  sm: { w: 50, h: 70, r: 7, corner: 13, center: 26 },
  md: { w: 66, h: 92, r: 9, corner: 16, center: 34 },
  lg: { w: 88, h: 123, r: 11, corner: 20, center: 46 },
};

interface PlayingCardProps {
  card?: Card | null;
  faceDown?: boolean;
  size?: Size;
  className?: string;
  /** Optional highlight glow (e.g. winning cards). */
  highlight?: boolean;
}

/**
 * An animated playing card with a 3D flip between face and back.
 * Pass `faceDown` to show the back; flipping is automatic when it changes.
 */
export function PlayingCard({
  card,
  faceDown = false,
  size = "md",
  className = "",
  highlight = false,
}: PlayingCardProps) {
  const d = DIMS[size];
  const showBack = faceDown || !card;
  const color = card ? (SUIT_COLOR[card.suit] === "red" ? "#d12c2c" : "#16181d") : "#16181d";
  const symbol = card ? SUIT_SYMBOL[card.suit] : "";

  return (
    <div
      className={`relative shrink-0 ${className}`}
      style={{ width: d.w, height: d.h, perspective: 600 }}
    >
      <motion.div
        className="absolute inset-0"
        style={{ transformStyle: "preserve-3d" }}
        initial={false}
        animate={{ rotateY: showBack ? 180 : 0 }}
        transition={{ duration: 0.4, ease: [0.2, 0.7, 0.2, 1] }}
      >
        {/* FRONT */}
        <div
          className="absolute inset-0 bg-white"
          style={{
            backfaceVisibility: "hidden",
            WebkitBackfaceVisibility: "hidden",
            borderRadius: d.r,
            boxShadow: highlight
              ? "0 0 0 2px #f5d060, 0 0 18px rgba(245,208,96,0.8), 0 6px 14px rgba(0,0,0,0.5)"
              : "0 4px 12px rgba(0,0,0,0.45), inset 0 0 0 1px rgba(0,0,0,0.08)",
            color,
          }}
        >
          <span
            className="absolute font-bold leading-none text-center"
            style={{ top: 4, left: 5, fontSize: d.corner }}
          >
            {card?.rank}
            <span style={{ display: "block", fontSize: d.corner * 0.95 }}>{symbol}</span>
          </span>
          <span
            className="absolute font-bold leading-none text-center"
            style={{ bottom: 4, right: 5, fontSize: d.corner, transform: "rotate(180deg)" }}
          >
            {card?.rank}
            <span style={{ display: "block", fontSize: d.corner * 0.95 }}>{symbol}</span>
          </span>
          <span
            className="absolute inset-0 grid place-items-center"
            style={{ fontSize: d.center, opacity: 0.92 }}
          >
            {symbol}
          </span>
        </div>

        {/* BACK */}
        <div
          className="absolute inset-0 overflow-hidden"
          style={{
            backfaceVisibility: "hidden",
            WebkitBackfaceVisibility: "hidden",
            transform: "rotateY(180deg)",
            borderRadius: d.r,
            background:
              "linear-gradient(135deg, #7a1230 0%, #4a0c20 100%)",
            boxShadow: "0 4px 12px rgba(0,0,0,0.5), inset 0 0 0 2px rgba(245,208,96,0.5)",
          }}
        >
          <span
            className="absolute inset-1 rounded-[5px]"
            style={{
              border: "1px solid rgba(245,208,96,0.45)",
              backgroundImage:
                "repeating-linear-gradient(45deg, rgba(245,208,96,0.16) 0 4px, transparent 4px 8px)",
            }}
          />
          <span
            className="absolute inset-0 grid place-items-center"
            style={{ color: "#f5d060", fontSize: d.center * 0.7, opacity: 0.85 }}
          >
            ♛
          </span>
        </div>
      </motion.div>
    </div>
  );
}
