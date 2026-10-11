import type { Block, BlockGroup } from "./blocks.ts"

/**
 * Structural stability indicator.
 *
 * This measures how much of a request's block sequence repeated between two comparable
 * requests. It does NOT measure provider cache hits, and never will: the provider
 * decides cache boundaries, minimum prefix size and TTL. See docs/cache-metrics.md.
 */

export interface PrefixComparison {
  stablePrefixBlocks: number
  totalBlocks: number
  /** Undefined rather than 0 when there is nothing to compare. */
  stablePrefixRatio?: number
  stablePrefixTokens: number
  totalTokens: number
  /** 0-based index of the first differing block, or -1 when fully identical. */
  firstDivergence: number
  /** Which group the first divergence landed in. Undefined when there was none. */
  firstDivergenceGroup?: BlockGroup
  identical: boolean
}

/** Rough heuristic, matching blocks.ts. Reported only as a local estimate. */
const estimateTokens = (chars: number) => Math.ceil(chars / 4)

/**
 * Ordered longest-common-prefix over block digests.
 *
 * A mismatch also fires when the group changes, so a block is never credited as stable
 * just because a same-grouped block happened to hash identically at that position.
 */
export function compareBlocks(
  previous: readonly Block[],
  current: readonly Block[],
): PrefixComparison {
  const limit = Math.min(previous.length, current.length)
  let stablePrefixBlocks = 0

  for (let i = 0; i < limit; i++) {
    const a = previous[i]
    const b = current[i]
    if (!a || !b || a.group !== b.group || a.digest !== b.digest) break
    stablePrefixBlocks = i + 1
  }

  // Either the shared prefix ended in a mismatch, or one side simply has more blocks.
  const firstDivergence =
    stablePrefixBlocks < limit || previous.length !== current.length ? stablePrefixBlocks : -1

  const totalChars = current.reduce((sum, block) => sum + block.chars, 0)
  const stableChars = current
    .slice(0, stablePrefixBlocks)
    .reduce((sum, block) => sum + block.chars, 0)

  return {
    stablePrefixBlocks,
    totalBlocks: current.length,
    stablePrefixRatio: current.length === 0 ? undefined : stablePrefixBlocks / current.length,
    stablePrefixTokens: estimateTokens(stableChars),
    totalTokens: estimateTokens(totalChars),
    firstDivergence,
    firstDivergenceGroup: firstDivergence >= 0 ? current[firstDivergence]?.group : undefined,
    identical:
      current.length > 0 &&
      previous.length === current.length &&
      stablePrefixBlocks === current.length,
  }
}

export interface Scope {
  projectKey: string
  provider: string
  model: string
  variant?: string
  agent?: string
  requestKind: string
}

/**
 * Observations are only ever paired inside the same scope. Comparing a cheap model
 * against an expensive one, or a compaction against a primary request, produces stability
 * numbers that describe nothing.
 */
export function scopeKey(scope: Scope): string {
  return [
    scope.projectKey,
    scope.provider,
    scope.model,
    scope.variant ?? "-",
    scope.agent ?? "-",
    scope.requestKind,
  ].join("|")
}
