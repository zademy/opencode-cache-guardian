import type { BlockGroup, SkipReason } from "../fingerprint/blocks.ts"
import type { StoredObservation } from "./observation.ts"

/**
 * Local, derived statistics. These describe structural stability of requests. They are
 * never a cache hit rate and are never used to state savings.
 */

export interface LatencySummary {
  samples: number
  p50: number
  p95: number
  p99: number
  max: number
}

export interface LocalMetrics {
  requestsObserved: number
  /** Observations that had a previous request in the same scope to compare against. */
  comparablePairs: number
  /** Comparable pairs where the two requests matched block for block. */
  divergenceFreePairs: number
  medianStablePrefixRatio?: number
  stablePrefixBlocks: number
  totalBlocks: number
  medianStablePrefixTokens?: number
  medianTotalTokens?: number
  /** Comparable pairs whose first divergence landed in each group. */
  firstDivergenceByGroup: Record<BlockGroup, number>
  skippedTotal: number
  skippedByReason: Partial<Record<SkipReason, number>>
  hookLatencyMs: LatencySummary
}

export const EMPTY_LATENCY: LatencySummary = { samples: 0, p50: 0, p95: 0, p99: 0, max: 0 }

/** Nearest-rank percentile. Returns 0 for an empty sample instead of NaN. */
export function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil(fraction * sorted.length)))
  return sorted[rank - 1] ?? 0
}

/** Trim to 6 decimals so persisted floats stay compact and comparable. */
const round = (value: number) => Math.round(value * 1e6) / 1e6

export function summarizeLatency(values: readonly number[]): LatencySummary {
  if (values.length === 0) return EMPTY_LATENCY
  return {
    samples: values.length,
    p50: round(percentile(values, 0.5)),
    p95: round(percentile(values, 0.95)),
    p99: round(percentile(values, 0.99)),
    max: round(Math.max(...values)),
  }
}

function median(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[middle]
  const low = sorted[middle - 1]
  const high = sorted[middle]
  return low !== undefined && high !== undefined ? (low + high) / 2 : high
}

export function aggregate(observations: readonly StoredObservation[]): LocalMetrics {
  const firstDivergenceByGroup: Record<BlockGroup, number> = { system: 0, tools: 0, messages: 0 }
  const skippedByReason: Partial<Record<SkipReason, number>> = {}

  const ratios: number[] = []
  const prefixTokens: number[] = []
  const totalTokens: number[] = []
  const latencies: number[] = []

  let comparablePairs = 0
  let divergenceFreePairs = 0
  let stablePrefixBlocks = 0
  let totalBlocks = 0
  let skippedTotal = 0

  for (const observation of observations) {
    latencies.push(observation.hookDurationMs)
    stablePrefixBlocks += observation.prefixBlockCount
    totalBlocks += observation.blockCount

    if (observation.skipped) {
      skippedTotal += 1
      skippedByReason[observation.skipped] = (skippedByReason[observation.skipped] ?? 0) + 1
      continue
    }

    // firstDivergence is set only when a previous request existed in the same scope.
    if (observation.firstDivergence === undefined) continue

    comparablePairs += 1
    if (observation.firstDivergence === -1) divergenceFreePairs += 1

    const group = observation.firstDivergenceGroup
    if (group) firstDivergenceByGroup[group] += 1

    if (observation.stablePrefixRatio !== undefined) ratios.push(observation.stablePrefixRatio)
    if (observation.prefixEstimatedTokens !== undefined) {
      prefixTokens.push(observation.prefixEstimatedTokens)
    }
    if (observation.totalEstimatedTokens !== undefined) {
      totalTokens.push(observation.totalEstimatedTokens)
    }
  }

  return {
    requestsObserved: observations.length,
    comparablePairs,
    divergenceFreePairs,
    medianStablePrefixRatio: median(ratios),
    stablePrefixBlocks,
    totalBlocks,
    medianStablePrefixTokens: median(prefixTokens),
    medianTotalTokens: median(totalTokens),
    firstDivergenceByGroup,
    skippedTotal,
    skippedByReason,
    hookLatencyMs: summarizeLatency(latencies),
  }
}

export interface Recommendation {
  readonly text: string
  readonly basis: string
}

/**
 * Observations only, never mutation instructions: in observe mode the plugin has no
 * authority over the prompt, so advice implying otherwise would be misleading.
 */
export function recommend(metrics: LocalMetrics): Recommendation[] {
  const out: Recommendation[] = []
  const pairs = metrics.comparablePairs

  const oversized = metrics.skippedByReason.oversized_payload ?? 0
  if (oversized > 0) {
    out.push({
      text: `${oversized} request(s) exceeded the payload limit and were not hashed.`,
      basis: "skipped: oversized_payload",
    })
  }

  if (pairs === 0) {
    out.push({
      text: "Not enough comparable pairs yet.",
      basis: "no observed request in this scope had a previous request to compare against",
    })
    return out
  }

  for (const group of ["system", "tools", "messages"] as const) {
    const count = metrics.firstDivergenceByGroup[group]
    const share = count / pairs
    if (share < 0.5) continue
    out.push({
      text: `First divergence lands in ${group} in ${Math.round(share * 100)}% of comparable pairs.`,
      basis: `${count}/${pairs} pairs diverged at ${group}`,
    })
  }

  const ratio = metrics.medianStablePrefixRatio ?? 0
  if (ratio < 0.5) {
    out.push({
      text: `Median stable prefix is ${Math.round(ratio * 100)}% of blocks; dynamic content appears early.`,
      basis: "median stable prefix ratio across comparable pairs",
    })
  } else if (ratio >= 0.95) {
    out.push({
      text: `Median stable prefix is ${Math.round(ratio * 100)}% of blocks; little structural churn.`,
      basis: "median stable prefix ratio across comparable pairs",
    })
  }

  return out
}
