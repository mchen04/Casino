"use client";

import React from "react";
import { motion } from "framer-motion";

// Chip color schemes by denomination (standard casino-ish palette).
export const CHIP_COLORS: { max: number; ring: string; body: string; text: string }[] = [
  { max: 5, ring: "#f5f5f5", body: "#d9534f", text: "#fff" }, // red (5)
  { max: 25, ring: "#1b8a5a", body: "#147a4d", text: "#eafff3" }, // green (25)
  { max: 100, ring: "#222", body: "#111", text: "#fff" }, // black (100)
  { max: 500, ring: "#7c3aed", body: "#5b21b6", text: "#fff" }, // purple (500)
  { max: 1000, ring: "#f5d060", body: "#caa022", text: "#1a1300" }, // gold (1000)
  { max: Infinity, ring: "#22e1ff", body: "#0e7490", text: "#eafdff" }, // cyan (5000+)
];

function schemeFor(value: number) {
  return CHIP_COLORS.find((c) => value <= c.max) ?? CHIP_COLORS[CHIP_COLORS.length - 1];
}

interface ChipProps {
  value: number;
  size?: number;
  /** Show the numeric value in the center. */
  showValue?: boolean;
  selected?: boolean;
  onClick?: () => void;
  className?: string;
}

/** A casino chip. Use as a clickable denomination selector or a static token. */
export function Chip({
  value,
  size = 56,
  showValue = true,
  selected = false,
  onClick,
  className = "",
}: ChipProps) {
  const s = schemeFor(value);
  const label =
    value >= 1000 ? `${value / 1000}K` : String(value);
  const content = (
    <>
      <span
        className="absolute inset-0 rounded-full"
        style={{
          background: `radial-gradient(circle at 50% 35%, ${s.body} 0%, ${s.body} 55%, rgba(0,0,0,0.35) 100%)`,
          boxShadow: selected
            ? `0 0 0 3px ${s.ring}, 0 0 18px ${s.ring}, 0 6px 14px rgba(0,0,0,0.5)`
            : "0 6px 14px rgba(0,0,0,0.5)",
        }}
      />
      {/* dashed ring */}
      <span
        className="absolute rounded-full"
        style={{
          inset: size * 0.1,
          border: `${Math.max(2, size * 0.05)}px dashed ${s.ring}`,
          opacity: 0.85,
        }}
      />
      <span
        className="absolute rounded-full"
        style={{
          inset: size * 0.2,
          border: `1px solid rgba(255,255,255,0.25)`,
        }}
      />
      {showValue && (
        <span
          className="relative font-bold"
          style={{ color: s.text, fontSize: size * 0.26, lineHeight: 1 }}
        >
          {label}
        </span>
      )}
    </>
  );

  const chipClass = `relative grid place-items-center rounded-full ${
    onClick ? "cursor-pointer" : "cursor-default"
  } ${className}`;
  const chipStyle = { width: size, height: size };

  if (!onClick) {
    return (
      <motion.div className={chipClass} style={chipStyle}>
        {content}
      </motion.div>
    );
  }

  return (
    <motion.button
      type="button"
      onClick={onClick}
      whileHover={{ y: -4, scale: 1.05 }}
      whileTap={{ scale: 0.92 }}
      className={chipClass}
      style={chipStyle}
      aria-label={`${value} chip`}
    >
      {content}
    </motion.button>
  );
}
