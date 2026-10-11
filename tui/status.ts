/**
 * Pure text helpers for the TUI status indicator. No TUI imports so the logic
 * stays unit-testable without a terminal.
 */

/** Compact, locale-independent formatting for the footer: 861, 12.3k, 24.4M. */
export function formatCount(value: number): string {
  if (!Number.isFinite(value)) return String(value)
  const abs = Math.abs(value)
  if (abs >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (abs >= 10_000) return `${(value / 1_000).toFixed(1)}k`
  return value.toLocaleString("en-US")
}

/**
 * Footer text for a session's cumulative cache-read tokens. Undefined means
 * "nothing to show": the indicator stays absent rather than printing a
 * misleading zero for a session with no usage yet.
 */
export function statusText(cacheRead?: number): string | undefined {
  if (cacheRead === undefined || !Number.isFinite(cacheRead)) return undefined
  return `cg cache read ${formatCount(cacheRead)}`
}