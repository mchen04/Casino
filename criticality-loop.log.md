# Criticality Loop — main (2026-05-28)

base: 063fa70 (greenfield initial commit)  •  aggressiveness: aggressive  •  test: npx tsc --noEmit  •  converge: 2

Scope: whole `src/` tree (greenfield — no origin/main base). ~35k LOC across 33 game
files + shared engine (`src/lib`, `src/components`). Baseline tsc: GREEN.

| # | verdict | findings (C/I/O) | commits | LOC Δ | tests | notes |
|---|---|---|---|---|---|---|
| 1 | BLOCK | 1/4/2 | 1 | ~-1200 | ✅ tsc+build | Extracted CountingNumber (16 games), sleep→lib/async (10), cryptoGames (dice/limbo/crash); fixed crash setState-after-unmount + coin-flip compounding-rounding; removed dead `trips` in evaluate3 + defensive getImageData try/catch |
