"use client";

import React from "react";
import { motion, type HTMLMotionProps } from "framer-motion";
import { sfx } from "@/lib/sound";

type Variant = "gold" | "ghost" | "danger" | "neon" | "felt";
type Size = "sm" | "md" | "lg";

interface ButtonProps extends Omit<HTMLMotionProps<"button">, "ref"> {
  variant?: Variant;
  size?: Size;
  block?: boolean;
}

const base =
  "relative inline-flex items-center justify-center gap-2 rounded-xl font-semibold tracking-wide " +
  "transition-colors select-none disabled:opacity-40 disabled:cursor-not-allowed " +
  "focus:outline-none focus-visible:ring-2 focus-visible:ring-gold/70";

const variants: Record<Variant, string> = {
  gold:
    "text-ink bg-gradient-to-b from-gold-light to-gold-dark shadow-gold hover:from-gold hover:to-gold-dark",
  ghost:
    "text-gold/90 bg-white/5 border border-white/10 hover:bg-white/10 backdrop-blur",
  danger:
    "text-white bg-gradient-to-b from-red-500 to-red-700 shadow-[0_8px_24px_rgba(220,38,38,0.35)] hover:from-red-400",
  neon:
    "text-ink bg-gradient-to-b from-neon-cyan to-cyan-600 shadow-neon hover:brightness-110",
  felt:
    "text-emerald-50 bg-gradient-to-b from-felt-light to-felt-dark border border-emerald-300/20 hover:from-felt",
};

const sizes: Record<Size, string> = {
  sm: "text-xs px-3 py-1.5",
  md: "text-sm px-5 py-2.5",
  lg: "text-base px-7 py-3.5",
};

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    { variant = "gold", size = "md", block, className = "", onClick, children, ...rest },
    ref,
  ) {
    return (
      <motion.button
        ref={ref}
        whileHover={{ y: -1 }}
        whileTap={{ scale: 0.96 }}
        onClick={(e) => {
          sfx.click();
          onClick?.(e);
        }}
        className={`${base} ${variants[variant]} ${sizes[size]} ${
          block ? "w-full" : ""
        } ${className}`}
        {...rest}
      >
        {children}
      </motion.button>
    );
  },
);
