# 🎰 Neon Royale — The Casino

A neon, art-deco casino floor with **33+ fully playable casino games**, built as a
single Next.js app with state-of-the-art animations. Pure play money — chase the
jackpot risk-free. Every game lives in one dashboard; click a card to play.

> ⚠️ For entertainment only. No real-money wagering. No accounts, no payments.

## ✨ Highlights

- **33 games** across Cards, Table, Slots, Wheels, Dice, Modern (crypto-style) and Lottery.
- **One persistent chip wallet** (localStorage) shared across every game, with stats and rescue top-ups.
- **SOTA animations** with Framer Motion: 3D card flips & deals, spinning roulette wheels,
  cascading Megaways reels, rising Crash rockets, bouncing Plinko balls, tumbling dice and more.
- **Synthesised sound** via the WebAudio API — zero asset files, fully mute-able.
- **Code-split per game** — each game is lazy-loaded so the lobby stays fast.
- Fully responsive, keyboard-focusable, respects `prefers-reduced-motion`.

## 🎮 The games

| Category | Games |
| --- | --- |
| **Cards** | Blackjack · Spanish 21 · Baccarat · Video Poker · Texas Hold'em · Ultimate Texas Hold'em · Three Card Poker · Caribbean Stud · Let It Ride · Pai Gow Poker · Casino War · Red Dog · Dragon Tiger · Andar Bahar · Teen Patti · Hi-Lo |
| **Table** | Roulette (European & American) · Craps · Sic Bo |
| **Wheel** | Money Wheel (Big Six) · Coin Flip |
| **Slots** | Lucky Sevens · Fruit Frenzy · Pharaoh's Fortune · Neon Megaways |
| **Dice / Modern** | Dice · Limbo · Crash · Plinko · Mines |
| **Lottery** | Keno · Scratch Cards · Bingo |

## 🏗️ Architecture

```
src/
  app/
    layout.tsx              Root layout, fonts, WalletProvider
    page.tsx                Lobby (Dashboard)
    globals.css             Theme: felt, gold, neon utilities
    not-found.tsx           Styled 404
    icon.svg                Favicon
    games/[slug]/
      page.tsx              SSG route per game (generateStaticParams)
      GamePlayer.tsx        Loads the game via next/dynamic inside GameShell
  components/
    Dashboard.tsx           Lobby grid, search, category filter, hero
    GameShell.tsx           Per-game chrome (back, balance, mute, top-up)
    BetControls.tsx         Reusable chip/bet bar
    PlayingCard.tsx         Animated 3D playing card
    ui/Button.tsx, ui/Chip.tsx
  lib/
    games.ts                Game registry (metadata + dynamic import)
    wallet.tsx              WalletProvider + useWallet (persisted)
    cards.ts                Deck + poker hand evaluators (5-card, 3-card)
    rng.ts                  Random helpers (shuffle, weightedPick, …)
    format.ts               Chip / multiplier formatting
    sound.ts                WebAudio SFX
  games/<slug>.tsx          One self-contained component per game
docs/
    GAME_CONTRACT.md        The contract every game implements
```

### How a game plugs in

Every game is a `"use client"` default-exported React component that:
- uses `useWallet()` for all money (`bet(amount) → boolean`, `win(gross)`),
- renders only its play surface (the `GameShell` provides the header/balance),
- is registered in `src/lib/games.ts` with a lazy `import()`.

See [`docs/GAME_CONTRACT.md`](docs/GAME_CONTRACT.md) for the full author spec.

### Money model

- `bet(amount)` deducts immediately, returns `false` if unaffordable.
- `win(gross)` credits the **gross** return (stake + profit). A push refunds the stake;
  an even-money win on 100 is `win(200)`; a 3:2 blackjack is `win(250)`.

Balance starts at **10,000** chips and persists in `localStorage`. Drop near zero and
the shell offers free top-ups; **Reset** restores the starting bankroll.

## 🚀 Getting started

```bash
npm install
npm run dev        # http://localhost:3000
npm run build      # production build (static export of all routes)
npm start          # serve the production build
```

Requires Node 18.18+ (built and tested on Node 20).

## ☁️ Deploy

Zero-config on **Vercel** — it's a standard Next.js 14 App Router app. Push the repo and
import it, or `vercel --prod`. No environment variables required.

## 🛠️ Tech

Next.js 14 · React 18 · TypeScript (strict) · Tailwind CSS 3 · Framer Motion 11.

## 📜 License & disclaimer

Built for fun and demonstration. All wagering is simulated with valueless chips.
If real gambling is affecting you, call 1-800-GAMBLER.
