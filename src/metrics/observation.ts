import type { Block, BlockGroup, SkipReason } from "../fingerprint/blocks.ts"

/**
 * A single observed request. Every field here is locally derived. Nothing in this file
 * describes provider billing — see provider-usage.ts for the separate, real class.
 */

export type RequestKind = "primary" | "compaction" | "generate" | "title" | "unknown"

export const REQUEST_KINDS: readonly RequestKind[] = [
  "primary",
  "compaction",
  "generate",
  "title",
  "unknown",
]

export interface CacheObservation {
  time: number
  /** Opaque project id from ctx.location.project.id. Never a filesystem path. */
  projectKey: string
  /** Pseudonym of the session id. The raw session id is not persisted. */
  sessionKey: string
  provider: string
  model: string
  variant?: string
  agent?: string
  requestKind: RequestKind
  blockCount: number
  prefixBlockCount: number
  prefixEstimatedTokens?: number
  totalEstimatedTokens?: number
  stablePrefixRatio?: number
  hookDurationMs: number
  source: "local-estimate"
  /** Aggregate fingerprint over the ordered blocks. */
  aggregate: string
  /** Ordered digests. Held in memory only, to pair against the next request. */
  blocks: Block[]
  /**
   * Set only when a previous request existed in the same scope. That makes it the
   * marker for "this observation was part of a comparable pair".
   */
  firstDivergence?: number
  firstDivergenceGroup?: BlockGroup
  skipped?: SkipReason
}

export type StoredObservation = Omit<CacheObservation, "blocks">

/**
 * Strip everything that must not reach disk.
 *
 * The block list is a working buffer, not telemetry: it exists only to compare against
 * the next request in the same session, and is discarded on serialization.
 */
export function toStoredObservation(observation: CacheObservation): StoredObservation {
  const { blocks: _blocks, ...stored } = observation
  return stored
}
