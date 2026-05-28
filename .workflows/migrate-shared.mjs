export const meta = {
  name: 'migrate-shared-modules',
  description: 'Adopt shared CountingNumber / sleep / cryptoGames across games; delete local duplicates.',
  phases: [{ title: 'Migrate', detail: 'one agent per game file' }],
};

// Per-file migration map derived from grep of the codebase.
const FILES = [
  { slug: 'andar-bahar', counters: ['Counter'] },
  { slug: 'bingo', counters: ['Counter'] },
  { slug: 'caribbean-stud', counters: ['Counter'] },
  { slug: 'casino-war', counters: ['Counter'], sleep: true },
  { slug: 'coin-flip', counters: ['Counter'], sleep: true },
  { slug: 'craps', counters: ['Counter'] },
  { slug: 'dragon-tiger', counters: ['Counter'] },
  { slug: 'keno', counters: ['Counter'], sleep: true },
  { slug: 'money-wheel', counters: ['Counter'] },
  { slug: 'plinko', counters: ['Counter'] },
  { slug: 'roulette', counters: ['Counter'] },
  { slug: 'scratch', counters: ['RollingNumber'] },
  { slug: 'sic-bo', counters: ['Counter'] },
  { slug: 'mines', counters: ['ChipCounter', 'MultCounter'], sleep: true },
  { slug: 'blackjack', sleep: true },
  { slug: 'slots-megaways', sleep: true },
  { slug: 'texas-holdem', sleep: true },
  { slug: 'ultimate-texas', sleep: true },
  // crypto-math games (also have counters / sleep) — use opus for the delicate math swap
  { slug: 'dice', counters: ['ChipCounter', 'NumberTicker'], sleep: true, crypto: 'dice' },
  { slug: 'limbo', counters: ['ChipCounter'], sleep: true, crypto: 'limbo' },
  { slug: 'crash', crypto: 'crash' },
];

const COUNTING_API = `Shared component: import { CountingNumber } from "@/components/CountingNumber";
<CountingNumber value={n} duration?={ms=540} format?={(n)=>string} decimals?={number} prefix?="" suffix?="" className?="" />
It animates from the previously-displayed value to \`value\` with a cubic ease-out via requestAnimationFrame and cancels the frame loop on unmount. Default formatting is comma-grouped integers (formatChips). Use \`decimals\` for fixed decimals (e.g. 2) and \`suffix="×"\` for multiplier readouts; pass a \`format\` fn for anything custom.`;

const SLEEP_API = `Shared helper: import { sleep } from "@/lib/async";  // sleep(ms): Promise<void>`;

const CRYPTO_API = `Shared math: import { HOUSE_EDGE, rollMultiplier, toCrashPoint, payoutForChance, winChanceForTarget } from "@/lib/cryptoGames";
- HOUSE_EDGE = 0.01
- rollMultiplier(edge=HOUSE_EDGE): max(1, (1-edge)/(1-U)), U∈[0,1)   // raw crash-style draw (use for Limbo result)
- toCrashPoint(m): max(1, floor(m*100)/100)                          // 2-dp crash point (Crash: toCrashPoint(rollMultiplier()))
- payoutForChance(winChance01, edge=HOUSE_EDGE): (1-edge)/winChance01 // Dice payout multiplier (incl. stake)
- winChanceForTarget(target, edge=HOUSE_EDGE): min(1,(1-edge)/target) // Limbo win probability`;

function buildPrompt(f) {
  const parts = [];
  parts.push(`Refactor exactly ONE file: src/games/${f.slug}.tsx in the Neon Royale casino app. Adopt shared modules and DELETE the now-redundant local copies. This is a behavior-preserving refactor — do NOT change any game rules, payouts, durations, visuals, or layout. Read the file first.`);

  if (f.counters && f.counters.length) {
    parts.push(`COUNT-UP MIGRATION: this file defines local count-up number component(s): ${f.counters.join(', ')}. Replace every usage with the shared <CountingNumber>, then DELETE the local component definition(s) and any now-unused imports (e.g. useEffect/useRef/performance only used by it, formatChips if only used there — but keep anything still used elsewhere).
${COUNTING_API}
Map carefully so the on-screen result is identical:
- An integer chip counter (e.g. "Counter"/"ChipCounter" showing whole chips, often with a prefix) → <CountingNumber value={...} prefix={...} className={...} /> (default integer formatting).
- A multiplier/decimal counter (e.g. "MultCounter"/"NumberTicker" showing values like 2.00 or x12.34) → <CountingNumber value={...} decimals={2} suffix="×"? className={...} /> — match the EXACT decimal count, prefix/suffix, and wrapper className the local component used. If the local one used a custom format (commas + decimals, etc.), pass an equivalent \`format\` fn.
- Preserve the local component's wrapper element classes by passing them via className. If the local component wrapped extra markup (icons, layout) beyond the number+prefix/suffix, KEEP that surrounding markup and only swap the number-rendering inner part for <CountingNumber>.`);
  }

  if (f.sleep) {
    parts.push(`SLEEP MIGRATION: this file defines a local \`sleep\` helper (function or const arrow). Delete it and import the shared one instead.
${SLEEP_API}`);
  }

  if (f.crypto) {
    parts.push(`CRYPTO-MATH MIGRATION (${f.crypto}): this file defines its own house-edge multiplier math (local constants like EDGE/RTP/HOUSE_EDGE and functions like winChance/payoutFor/rollResult/crashPoint). Replace them with the shared helpers below, keeping the SAME numeric behavior (same house edge 0.01, same formulas). Delete the now-redundant local constants/functions.
${CRYPTO_API}
Specifically for ${f.crypto}: ${
      f.crypto === 'dice'
        ? 'keep your winChance(target,mode) logic (it is dice-specific), but compute the payout multiplier via payoutForChance(winChance) instead of a local RTP/p expression; replace any local HOUSE_EDGE/RTP constant with the imported HOUSE_EDGE (RTP = 1 - HOUSE_EDGE if still needed).'
        : f.crypto === 'limbo'
          ? 'replace the local result draw with rollMultiplier() (raw, not floored) and the local winChance(target) with winChanceForTarget(target); replace the local EDGE constant with the imported HOUSE_EDGE.'
          : 'replace the local crash-point draw with toCrashPoint(rollMultiplier()); replace the local HOUSE_EDGE constant with the imported one. Keep the rocket animation/loop untouched.'
    }`);
  }

  parts.push(`AFTER EDITING: re-read your file and self-check it compiles under TypeScript strict (no unused imports, no undefined refs, the default export and "use client" intact, no leftover references to deleted local symbols). Do NOT run npm build/tsc/next dev (it conflicts with parallel agents). Do NOT touch any other file. Return a one-line summary of what you changed.`);

  return parts.join('\n\n');
}

phase('Migrate');
log(`Migrating ${FILES.length} game files to shared modules`);

const results = await parallel(
  FILES.map((f) => () =>
    agent(buildPrompt(f), {
      label: `migrate:${f.slug}`,
      phase: 'Migrate',
      agentType: 'general-purpose',
      model: f.crypto ? undefined : 'sonnet', // opus (inherit) for delicate crypto-math files
    }).then((summary) => ({ slug: f.slug, summary })),
  ),
);

const ok = results.filter(Boolean);
log(`Migration done: ${ok.length}/${FILES.length}`);
return ok;
