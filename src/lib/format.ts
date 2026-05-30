/**
 * Format a chip amount with thousands separators, e.g. 12345 -> "12,345".
 * Winnings are tracked at cent precision, so up to 2 decimals are shown and
 * trailing zeros are trimmed: 12345 -> "12,345", 12345.5 -> "12,345.5".
 */
export function formatChips(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

/** Compact format for big numbers, e.g. 1250000 -> "1.25M". */
export function formatCompact(n: number): string {
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 2,
  }).format(n);
}

/** Format a multiplier, e.g. 2 -> "2.00×", 1.5 -> "1.50×". */
export function formatMultiplier(x: number): string {
  return `${x.toFixed(2)}×`;
}

/** Signed delta, e.g. +250 / -100, at cent precision. */
export function formatDelta(n: number): string {
  const r = Math.round(n * 100) / 100;
  return r >= 0 ? `+${formatChips(r)}` : `-${formatChips(Math.abs(r))}`;
}
