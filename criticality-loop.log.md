# Criticality Loop — main (2026-05-28)

base: 063fa70 (greenfield initial commit)  •  aggressiveness: aggressive  •  test: npx tsc --noEmit  •  converge: 2

Scope: whole `src/` tree (greenfield — no origin/main base). ~35k LOC across 33 game
files + shared engine (`src/lib`, `src/components`). Baseline tsc: GREEN.

| # | verdict | findings (C/I/O) | commits | LOC Δ | tests | notes |
|---|---|---|---|---|---|---|
| 1 | BLOCK | 1/4/2 | 1 | ~-1200 | ✅ tsc+build | Extracted CountingNumber (16 games), sleep→lib/async (10), cryptoGames (dice/limbo/crash); fixed crash setState-after-unmount + coin-flip compounding-rounding; removed dead `trips` in evaluate3 + defensive getImageData try/catch |
| 2 | BLOCK | 2/3/1 | 1 | ~-90 | ✅ tsc+build | CRITICAL: fixed slots-egypt base-spin double-credit (win(total+bet)→win(total)); removed texas-holdem try/catch around pure evaluateBest; extracted baccarat third-card tableau→lib/baccarat.ts, pai-gow eval/houseWay→lib/paiGow.ts. Declined sound.ts cast (current typed form safer than `any`). Held reel-render/multi-bet/ResultBanner unification — risky rewrites of working games, 2/4 auditors APPROVE, would homogenize per-game SOTA visuals. |
| 3 | BLOCK | 1/0/0 | 1 | +6 | ✅ tsc+build | Fixed mines.tsx setState-after-unmount in the bust + perfect-clear async reveals (mountedRef guard, matching dice/crash/plinko). Slots-egypt fix re-verified correct. Cards + shared slices APPROVE. |
