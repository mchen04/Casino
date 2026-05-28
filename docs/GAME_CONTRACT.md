# Neon Royale — Game Author Contract

Every game is **one self-contained file** at `src/games/<slug>.tsx`. The lobby and
the game-player chrome (header, back-to-lobby, live balance, mute, top-up) are
already provided by `GameShell` — **your component renders only the play surface.**

## Hard rules

1. First line is `"use client";`.
2. Export a **default** React function component that takes **no required props**.
3. Money goes through the wallet only (see API). Never fabricate balance.
4. Only import from: `react`, `framer-motion`, and the `@/lib/*` / `@/components/*`
   modules listed below. **No new npm packages. No network. No assets/images** —
   draw everything with CSS/SVG/canvas/emoji.
5. Must compile under TypeScript `strict`. No `any` unless truly unavoidable.
6. Must be responsive and look great. Lean hard into **framer-motion** animation —
   dealing, flipping, spinning, chip flight, win bursts. This is the headline feature.
7. Put `data-testid="play-btn"` on the primary action button (Deal/Spin/Roll/Bet).
   Put `data-testid="round-result"` on the element that shows the round outcome
   text once a round resolves. Multiple action buttons: give each a descriptive
   `data-testid` (e.g. `bet-player`, `cashout-btn`).
8. Self-contained state with React hooks. No global stores beyond `useWallet`.

## Money model (critical — get this exactly right)

- `bet(amount)` **deducts** `amount` immediately and returns `true`, or returns
  `false` if the player can't afford it (then abort the round).
- `win(gross)` **credits** the gross return. Gross INCLUDES the returned stake.
  - Even-money win on a 100 bet → `win(200)` (stake back + 100 profit).
  - 3:2 blackjack on 100 → `win(250)`.
  - Push / tie refund → `win(100)`.
  - Loss → credit nothing.
- A multiplier game paying `x` on stake `s` → `win(s * x)` where `x` already
  includes the stake (e.g. 2× means double your money back).

## Shared API (read the real source before using — don't guess signatures)

`@/lib/wallet` → `useWallet()` returns:
`{ balance, totalWagered, totalReturned, rounds, biggestWin, ready,
   bet(amount): boolean, win(amount): void, topUp(amount?): void, reset(): void }`

`@/lib/cards`:
- types `Card { rank: Rank; suit: Suit; id: string }`, `Rank`, `Suit`
- `SUITS`, `RANKS`, `SUIT_SYMBOL` (record suit→symbol), `SUIT_COLOR` (suit→"red"|"black")
- `rankValue(rank)` Ace=14 · `blackjackValue(rank)` Ace=11
- `blackjackTotal(cards): { total, soft }` (auto-demotes aces)
- `makeDeck(decks=1): Card[]` (ordered) · `makeShoe(decks=1): Card[]` (shuffled)
- `evaluate5(cards5): HandRank` · `evaluateBest(cardsN): HandRank & { best: Card[] }`
- `compareHands(a,b): number` (>0 a wins) · `HandCategory` enum · `HAND_NAMES`
- `HandRank { category, name, tiebreak: number[], score: number }`
- `evaluate3(cards3): ThreeCardRank` · `ThreeCardCategory` enum · `THREE_CARD_NAMES`

`@/lib/rng`: `randInt(min,max)` inclusive · `randFloat(min,max)` · `pick(arr)` ·
`shuffle(arr)` (returns new array) · `chance(p)` · `weightedPick(items,weights)` ·
`clamp(n,min,max)`

`@/lib/format`: `formatChips(n)` · `formatCompact(n)` · `formatMultiplier(x)` ("2.00×") ·
`formatDelta(n)` ("+250"/"-100")

`@/lib/sound`: `import { sfx } from "@/lib/sound"` →
`sfx.click() chip() card() win() jackpot() lose() tick() thud()`. Call them for feedback.

`@/components/ui/Button` → `<Button variant="gold|ghost|danger|neon|felt" size="sm|md|lg" block? ...>`
(forwards all button props incl. `disabled`, `onClick`, `data-testid`).

`@/components/ui/Chip` → `<Chip value={number} size? showValue? selected? onClick? className? />`

`@/components/PlayingCard` → `<PlayingCard card={Card|null} faceDown? size="xs|sm|md|lg" highlight? className? />`
(handles the 3D flip animation automatically when `faceDown` changes).

`@/components/BetControls` → `<BetControls bet setBet balance min? max? chips? disabled?
primaryLabel? onPrimary? primaryDisabled? />` — a ready-made chip/bet bar. Use it for
simple single-bet games; build a custom bet UI for games that need it (roulette table, etc.).

## Theme tokens (Tailwind + custom CSS classes already defined)

Colors: `felt`/`felt-dark`/`felt-light`, `gold`/`gold-light`/`gold-dark`,
`neon-cyan`/`neon-magenta`/`neon-violet`/`neon-lime`, `ink`/`ink-soft`/`ink-panel`, `ruby`.
Shadows: `shadow-gold` `shadow-neon` `shadow-felt`. Anim: `animate-shimmer` `animate-floaty`
`animate-pulseGlow`. Fonts: `font-display` (Cinzel serif) `font-body`.
Custom classes: `.felt` (felt table surface) `.glass` `.gold-text` `.gold-border`
`.neon-cyan` `.neon-magenta` `.bg-grid` `.no-scrollbar`.

## UX expectations every game must meet

- Show the current bet and let the player change it before a round (use BetControls
  or chips). Default a sensible bet (e.g. 25–100). Disable betting mid-round.
- Block a bet the player can't afford; the shell handles top-ups when near zero.
- Clearly animate the deal/spin/roll, then clearly show win/loss with sound + color.
- Show a paytable / odds where relevant (slots, video poker, three-card, etc.).
- Wrap the surface in a `.felt` or `.glass` container with rounded corners and good padding.
- No layout shift jank; keep controls reachable. Looks intentional and premium.
