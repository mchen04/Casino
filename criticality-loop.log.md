# Criticality Loop — main (2026-05-28)

base: 063fa70 (greenfield initial commit)  •  aggressiveness: aggressive  •  test: npx tsc --noEmit  •  converge: 2

Scope: whole `src/` tree (greenfield — no origin/main base). ~35k LOC across 33 game
files + shared engine (`src/lib`, `src/components`). Baseline tsc: GREEN.

| # | verdict | findings (C/I/O) | commits | LOC Δ | tests | notes |
|---|---|---|---|---|---|---|
| 1 | BLOCK | 1/4/2 | 1 | ~-1200 | ✅ tsc+build | Extracted CountingNumber (16 games), sleep→lib/async (10), cryptoGames (dice/limbo/crash); fixed crash setState-after-unmount + coin-flip compounding-rounding; removed dead `trips` in evaluate3 + defensive getImageData try/catch |
| 2 | BLOCK | 2/3/1 | 1 | ~-90 | ✅ tsc+build | CRITICAL: fixed slots-egypt base-spin double-credit (win(total+bet)→win(total)); removed texas-holdem try/catch around pure evaluateBest; extracted baccarat third-card tableau→lib/baccarat.ts, pai-gow eval/houseWay→lib/paiGow.ts. Declined sound.ts cast (current typed form safer than `any`). Held reel-render/multi-bet/ResultBanner unification — risky rewrites of working games, 2/4 auditors APPROVE, would homogenize per-game SOTA visuals. |
| 3 | BLOCK | 1/0/0 | 1 | +6 | ✅ tsc+build | Fixed mines.tsx setState-after-unmount in the bust + perfect-clear async reveals (mountedRef guard, matching dice/crash/plinko). Slots-egypt fix re-verified correct. Cards + shared slices APPROVE. |
| 4 | BLOCK | 1/0/0 | 1 | +40 | ✅ tsc+build | Async-unmount sweep: added mountedRef guards to all 6 remaining unguarded sleep-based games (coin-flip, casino-war, limbo, slots-megaways, ultimate-texas, texas-holdem drive-loop + startHand). Verified craps Place 6/8 "underpay" finding is a FALSE POSITIVE — working bets stay up and are refunded via clearBets(). |
| 5 | APPROVE* | 0 valid (1 FP) | 0 | 0 | ✅ | 3/4 slices APPROVE. The 1 BLOCK (pai-gow-poker:413 `bet*1.95`) is a FALSE POSITIVE: even-money-less-5%-commission = stake + (1.0−0.05)×stake = 1.95× (commission is on the winnings, not the player's returned stake). Matches baccarat banker. No code change. consecutive_approve=1. |
| 6 | APPROVE | 0 | 0 | 0 | ✅ | Final correctness sweep + structural/deslop sweep across all 33 games: both APPROVE, zero findings. CONVERGED (2 consecutive clean cycles). |

## Summary

- **Exit:** CONVERGED — 2 consecutive clean audit cycles (5 after declining a false positive, 6 fully clean).
- **Cycles:** 6 (4 BLOCK + fixes, then 2 clean).
- **Real bugs fixed:** slots-egypt base-spin stake double-credit; crash + mines + coin-flip(rounding) + casino-war + limbo + slots-megaways + ultimate-texas + texas-holdem async setState-after-unmount; removed defensive try/catch (texas-holdem, scratch) + dead `trips` var (cards.ts).
- **False positives correctly declined (no change):** craps Place 6/8 profit-only (bets stay working, refunded via clearBets); pai-gow/baccarat banker 1.95× (even money less 5% commission on winnings).
- **Structural:** extracted shared CountingNumber, lib/async(sleep), lib/cryptoGames, lib/baccarat, lib/paiGow; deduped count-up/sleep/crypto math across 21 games. Net ≈ −390 LOC.
- **Tests:** `npx tsc --noEmit` + `next build` green every cycle.
