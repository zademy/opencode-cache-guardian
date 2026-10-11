import type { CacheGuardianOptions } from "../config/schema.ts"
import { type Block, buildBlocks, estimateTokens } from "../fingerprint/blocks.ts"
import { fingerprint, generateHashKey, type HashKey } from "../fingerprint/hash.ts"
import { compareBlocks, type Scope, scopeKey } from "../fingerprint/prefix.ts"
import {
  type CacheObservation,
  type RequestKind,
  type StoredObservation,
  toStoredObservation,
} from "../metrics/observation.ts"
import { type ProviderUsageSample, parseUsageEvent } from "../metrics/provider-usage.ts"
import {
  loadObservations,
  prune,
  recordObservation,
  recordUsage,
  type StorageLike,
} from "../storage/store.ts"

/**
 * Ties fingerprinting, prefix comparison, persistence and usage capture together.
 * Holds the only in-memory state the plugin keeps: the previous block list per scope,
 * so a request can be compared against its predecessor, and the hash key.
 */

export interface SessionIdentity {
  provider?: string
  model?: string
}

/** Bound on live scopes, so a long session cannot grow this map without limit. */
const MAX_TRACKED_SESSIONS = 256

export class Recorder {
  private readonly previous = new Map<string, Block[]>()
  private readonly sessions = new Map<string, SessionIdentity & { sessionKey: string }>()
  private key: HashKey
  private seq = 0

  constructor(
    private readonly options: CacheGuardianOptions,
    private readonly store: StorageLike,
    private readonly now: () => number,
  ) {
    this.key = options.privacy.hashing === "hmac-sha256" ? generateHashKey() : undefined
  }

  /** Raw session ids are never persisted; the pseudonym is what reaches storage. */
  sessionKeyFor(rawSessionID: string): string {
    return fingerprint(rawSessionID, this.key).slice(0, 16)
  }

  private rememberSession(rawSessionID: string, identity: SessionIdentity): void {
    if (this.sessions.size >= MAX_TRACKED_SESSIONS) {
      const oldest = this.sessions.keys().next()
      if (!oldest.done) this.sessions.delete(oldest.value)
    }
    this.sessions.set(rawSessionID, { ...identity, sessionKey: this.sessionKeyFor(rawSessionID) })
  }

  observe(input: {
    rawSessionID: string
    scope: Scope
    requestKind: RequestKind
    system: readonly unknown[]
    messages: readonly unknown[]
    tools: Record<string, { description: string; input: unknown }> | undefined
  }): CacheObservation | undefined {
    if (!this.options.enabled || !this.options.metrics.enabled) return undefined

    const started = this.now()
    const identity: SessionIdentity = { provider: input.scope.provider, model: input.scope.model }
    this.rememberSession(input.rawSessionID, identity)

    const built = buildBlocks(
      { system: input.system, messages: input.messages, tools: input.tools },
      {
        key: this.key,
        maxChars: this.options.limits.maxRequestBytes,
        maxProcessingMs: this.options.limits.maxProcessingMs,
        now: this.now,
      },
    )

    const scope = scopeKey(input.scope)
    const pairKey = `${scope}|${this.sessionKeyFor(input.rawSessionID)}`
    const predecessor = this.previous.get(pairKey)
    this.previous.set(pairKey, built.blocks)

    const observation: CacheObservation = {
      time: started,
      projectKey: input.scope.projectKey,
      sessionKey: this.sessionKeyFor(input.rawSessionID),
      provider: input.scope.provider,
      model: input.scope.model,
      requestKind: input.requestKind,
      blockCount: built.blocks.length,
      prefixBlockCount: 0,
      hookDurationMs: this.now() - started,
      source: "local-estimate",
      aggregate: built.aggregate,
      blocks: built.blocks,
    }
    if (input.scope.variant !== undefined) observation.variant = input.scope.variant
    if (input.scope.agent !== undefined) observation.agent = input.scope.agent
    if (built.skipped) observation.skipped = built.skipped

    if (!built.skipped && predecessor) {
      const comparison = compareBlocks(predecessor, built.blocks)
      observation.prefixBlockCount = comparison.stablePrefixBlocks
      observation.stablePrefixRatio = comparison.stablePrefixRatio
      observation.prefixEstimatedTokens = comparison.stablePrefixTokens
      observation.totalEstimatedTokens = comparison.totalTokens
      observation.firstDivergence = comparison.firstDivergence
      if (comparison.firstDivergenceGroup) {
        observation.firstDivergenceGroup = comparison.firstDivergenceGroup
      }
    } else if (!built.skipped) {
      observation.totalEstimatedTokens = estimateTokens(built.totalChars)
    }

    observation.hookDurationMs = this.now() - started
    return observation
  }

  /** Fire-and-forget persistence. A storage failure never surfaces to the request path. */
  async persist(observation: CacheObservation): Promise<void> {
    const stored = toStoredObservation(observation)
    await recordObservation(this.store, stored, this.seq++)
    await prune(
      this.store,
      "cache-guardian/v1/observation/",
      this.options.metrics.maxObservations,
      this.options.metrics.retentionDays,
      this.now(),
    )
  }

  /**
   * The usage event carries a session id but no model, so the scope is resolved from the
   * last request observed for that session. Unmatched sessions yield no sample rather
   * than a sample with invented attribution.
   */
  captureUsage(event: unknown): ProviderUsageSample | undefined {
    if (!this.options.report.includeProviderUsage) return undefined
    return parseUsageEvent(event, (rawSessionID) => this.sessions.get(rawSessionID), this.now())
  }

  async persistUsage(sample: ProviderUsageSample): Promise<void> {
    await recordUsage(this.store, sample, this.seq++)
  }

  observations(): Promise<StoredObservation[]> {
    return loadObservations(this.store)
  }
}
