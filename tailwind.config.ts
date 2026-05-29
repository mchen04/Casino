import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        felt: {
          DEFAULT: "#0b6e4f",
          dark: "#063b2c",
          light: "#0d8a5f",
        },
        gold: {
          DEFAULT: "#d4af37",
          light: "#f5d060",
          dark: "#9a7d1e",
        },
        neon: {
          cyan: "#22e1ff",
          magenta: "#ff2bd1",
          violet: "#a855f7",
          lime: "#8aff80",
        },
        ink: {
          DEFAULT: "#05070a",
          soft: "#0b0f16",
          panel: "#10151f",
        },
        ruby: "#e3342f",
      },
      fontFamily: {
        display: ["var(--font-display)", "Georgia", "serif"],
        body: ["var(--font-body)", "system-ui", "sans-serif"],
      },
      boxShadow: {
        gold: "0 0 0 1px rgba(212,175,55,0.4), 0 8px 30px rgba(212,175,55,0.18)",
        neon: "0 0 18px rgba(34,225,255,0.55), 0 0 42px rgba(34,225,255,0.25)",
        felt: "inset 0 2px 30px rgba(0,0,0,0.55), inset 0 0 80px rgba(0,0,0,0.35)",
      },
      keyframes: {
        shimmer: {
          "0%": { backgroundPosition: "-200% 0" },
          "100%": { backgroundPosition: "200% 0" },
        },
        floaty: {
          "0%,100%": { transform: "translateY(0)" },
          "50%": { transform: "translateY(-6px)" },
        },
        pulseGlow: {
          "0%,100%": { opacity: "0.6" },
          "50%": { opacity: "1" },
        },
        // Diagonal glare sweeping across a surface (buttons, chips, cards).
        sheen: {
          "0%": { transform: "translateX(-160%) skewX(-18deg)" },
          "100%": { transform: "translateX(260%) skewX(-18deg)" },
        },
        // Animated gradient position for living gold/neon text.
        gradientShift: {
          "0%,100%": { backgroundPosition: "0% 50%" },
          "50%": { backgroundPosition: "100% 50%" },
        },
        // A celebratory scale+glow throb for big wins.
        winPulse: {
          "0%,100%": { transform: "scale(1)", filter: "brightness(1)" },
          "50%": { transform: "scale(1.04)", filter: "brightness(1.25)" },
        },
        // Slow drift for ambient background motes.
        floatSlow: {
          "0%,100%": { transform: "translateY(0) translateX(0)" },
          "33%": { transform: "translateY(-14px) translateX(6px)" },
          "66%": { transform: "translateY(8px) translateX(-8px)" },
        },
        // Neon sign flicker.
        flicker: {
          "0%,100%": { opacity: "1" },
          "41%": { opacity: "1" },
          "42%": { opacity: "0.4" },
          "44%": { opacity: "1" },
          "60%": { opacity: "1" },
          "61%": { opacity: "0.55" },
          "63%": { opacity: "1" },
        },
        sparkle: {
          "0%,100%": { opacity: "0", transform: "scale(0.4)" },
          "50%": { opacity: "1", transform: "scale(1)" },
        },
      },
      animation: {
        shimmer: "shimmer 2.5s linear infinite",
        floaty: "floaty 4s ease-in-out infinite",
        pulseGlow: "pulseGlow 2.4s ease-in-out infinite",
        sheen: "sheen 2.6s ease-in-out infinite",
        gradientShift: "gradientShift 6s ease-in-out infinite",
        winPulse: "winPulse 1.1s ease-in-out infinite",
        floatSlow: "floatSlow 11s ease-in-out infinite",
        flicker: "flicker 5s linear infinite",
        sparkle: "sparkle 1.6s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};

export default config;
