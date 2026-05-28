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
      },
      animation: {
        shimmer: "shimmer 2.5s linear infinite",
        floaty: "floaty 4s ease-in-out infinite",
        pulseGlow: "pulseGlow 2.4s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};

export default config;
