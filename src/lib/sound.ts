"use client";

// Tiny synthesised SFX via the WebAudio API — no asset files, no network.
// Safe to call from anywhere; silently no-ops during SSR or if audio is blocked.
// Honors a global mute flag persisted in localStorage.

let ctx: AudioContext | null = null;
let muted = false;

function init() {
  if (typeof window === "undefined") return null;
  if (!ctx) {
    try {
      const AC =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
    } catch {
      return null;
    }
  }
  // Resume if suspended (autoplay policy).
  if (ctx.state === "suspended") ctx.resume().catch(() => {});
  return ctx;
}

if (typeof window !== "undefined") {
  try {
    muted = localStorage.getItem("neon-royale-muted") === "1";
  } catch {
    /* ignore */
  }
}

export function isMuted(): boolean {
  return muted;
}

export function setMuted(m: boolean) {
  muted = m;
  try {
    localStorage.setItem("neon-royale-muted", m ? "1" : "0");
  } catch {
    /* ignore */
  }
}

export function toggleMuted(): boolean {
  setMuted(!muted);
  return muted;
}

type Wave = "sine" | "square" | "triangle" | "sawtooth";

function tone(
  freq: number,
  duration = 0.12,
  type: Wave = "sine",
  gain = 0.08,
  delay = 0,
) {
  if (muted) return;
  const ac = init();
  if (!ac) return;
  const t0 = ac.currentTime + delay;
  const osc = ac.createOscillator();
  const g = ac.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
  osc.connect(g);
  g.connect(ac.destination);
  osc.start(t0);
  osc.stop(t0 + duration + 0.02);
}

export const sfx = {
  /** Soft click for buttons / chip placement. */
  click() {
    tone(420, 0.05, "triangle", 0.05);
  },
  /** Chip plonk. */
  chip() {
    tone(660, 0.06, "square", 0.04);
    tone(880, 0.05, "square", 0.03, 0.02);
  },
  /** Card flip / deal. */
  card() {
    tone(300, 0.04, "triangle", 0.04);
  },
  /** Generic win flourish (ascending). */
  win() {
    [523, 659, 784, 1046].forEach((f, i) => tone(f, 0.16, "triangle", 0.06, i * 0.08));
  },
  /** Big win fanfare. */
  jackpot() {
    [523, 659, 784, 1046, 1318].forEach((f, i) =>
      tone(f, 0.22, "square", 0.05, i * 0.07),
    );
  },
  /** Lose buzz (descending). */
  lose() {
    [330, 247].forEach((f, i) => tone(f, 0.18, "sawtooth", 0.05, i * 0.1));
  },
  /** Spin / reel tick. */
  tick() {
    tone(1200, 0.02, "square", 0.025);
  },
  /** Wheel/reel stop thunk. */
  thud() {
    tone(160, 0.12, "sine", 0.07);
  },
};
