/**
 * Provider-reported usage — the real, billed class of metric.
 *
 * Sourced from the V2 session.usage.updated event, which carries TokenUsage.Info
 * (input, output, reasoning, cache.read, cache.write) plus a USD cost. These are the
 * provider's own numbers, and they are kept strictly apart from the local prefix
 * estimates in observation.ts.
 */

export interface ProviderUsageSample {
  time: number
  sessionKey: string
  /** Resolved from the session's last observed request; the event itself has no model. */
  provider?: string
  model?: string
  inputTokens?: number
  outputTokens?: number
  reasoningTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  costUsd?: number
  source: "provider"
}

export interface ProviderUsageTotals {
  samples: number
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  costUsd?: number
}

export type UsageScopeResolver = (
  rawSessionID: string,
) => { sessionKey: string; provider?: string; model?: string } | undefined

const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : undefined

/**
 * Parse a session.usage.updated event.
 *
 * Returns undefined for any other event type, and for a usage event whose shape has
 * drifted: a missing field must produce "no data", never a fabricated zero.
 */
export function parseUsageEvent(
  event: unknown,
  resolve: UsageScopeResolver,
  now: number,
): ProviderUsageSample | undefined {
  const envelope = record(event)
  if (envelope?.type !== "session.usage.updated") return undefined

  const data = record(envelope.data)
  if (!data) return undefined

  const scope = resolve(typeof data.sessionID === "string" ? data.sessionID : "")
  if (!scope) return undefined

  const tokens = record(data.tokens)
  const cache = record(tokens?.cache)

  const sample: ProviderUsageSample = {
    time: now,
    sessionKey: scope.sessionKey,
    source: "provider",
  }
  if (scope.provider !== undefined) sample.provider = scope.provider
  if (scope.model !== undefined) sample.model = scope.model

  const input = num(tokens?.input)
  if (input !== undefined) sample.inputTokens = input
  const output = num(tokens?.output)
  if (output !== undefined) sample.outputTokens = output
  const reasoning = num(tokens?.reasoning)
  if (reasoning !== undefined) sample.reasoningTokens = reasoning
  const read = num(cache?.read)
  if (read !== undefined) sample.cacheReadTokens = read
  const write = num(cache?.write)
  if (write !== undefined) sample.cacheWriteTokens = write
  const cost = num(data.cost)
  if (cost !== undefined) sample.costUsd = cost

  return sample
}

/**
 * Per-session sample lists ordered by time.
 */
function samplesBySession(samples: readonly ProviderUsageSample[]): ProviderUsageSample[][] {
  const bySession = new Map<string, ProviderUsageSample[]>()
  for (const sample of samples) {
    const bucket = bySession.get(sample.sessionKey)
    if (bucket) bucket.push(sample)
    else bySession.set(sample.sessionKey, [sample])
  }
  for (const bucket of bySession.values()) bucket.sort((a, b) => a.time - b.time)
  return [...bySession.values()]
}

/**
 * The most recent value of a counter within one session. Verified against live
 * data: session.usage.updated carries session-lifetime cumulative counters (values
 * are monotonic within a session), so summing samples would count the same tokens
 * once per event. The session total is the latest reading, not the sum.
 */
function latestIn(session: readonly ProviderUsageSample[], field: keyof ProviderUsageSample) {
  for (let i = session.length - 1; i >= 0; i--) {
    const value = session[i]?.[field]
    if (typeof value === "number" && Number.isFinite(value)) return value
  }
  return undefined
}

/**
 * Totals across sessions. A field is present only if some sample carried it, so
 * "no provider data" stays visibly distinct from "the provider reported zero".
 */
export function totalUsage(samples: readonly ProviderUsageSample[]): ProviderUsageTotals {
  const totals: ProviderUsageTotals = { samples: samples.length }
  let input: number | undefined
  let output: number | undefined
  let read: number | undefined
  let write: number | undefined
  let cost: number | undefined

  for (const session of samplesBySession(samples)) {
    const add = (field: keyof ProviderUsageSample, acc?: number) =>
      latestIn(session, field) === undefined
        ? acc
        : (acc ?? 0) + (latestIn(session, field) as number)
    input = add("inputTokens", input)
    output = add("outputTokens", output)
    read = add("cacheReadTokens", read)
    write = add("cacheWriteTokens", write)
    cost = add("costUsd", cost)
  }

  if (input !== undefined) totals.inputTokens = input
  if (output !== undefined) totals.outputTokens = output
  if (read !== undefined) totals.cacheReadTokens = read
  if (write !== undefined) totals.cacheWriteTokens = write
  if (cost !== undefined) totals.costUsd = cost

  return totals
}

export interface UsageDeltas {
  /** Consecutive same-session sample pairs both carrying the counter. */
  dispatches: number
  medianCacheReadTokens?: number
  medianInputTokens?: number
  medianOutputTokens?: number
}

/**
 * Per-dispatch deltas: the increase of each cumulative counter between consecutive
 * samples of the same session. Negative deltas (a counter reset, e.g. after a model
 * switch) are dropped rather than clamped, so they neither skew the median nor
     silently understate it.
 */
export function usageDeltas(samples: readonly ProviderUsageSample[]): UsageDeltas {
  const read: number[] = []
  const input: number[] = []
  const output: number[] = []

  for (const session of samplesBySession(samples)) {
    for (const field of ["cacheReadTokens", "inputTokens", "outputTokens"] as const) {
      let previous: number | undefined
      for (const sample of session) {
        const value = sample[field]
        if (typeof value === "number" && Number.isFinite(value)) {
          if (previous !== undefined && value >= previous) {
            const target =
              field === "cacheReadTokens" ? read : field === "inputTokens" ? input : output
            target.push(value - previous)
          }
          previous = value
        }
      }
    }
  }

  const median = (values: number[]) =>
    values.length === 0
      ? undefined
      : [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]

  const dispatches = read.length || input.length || output.length
  return {
    dispatches,
    medianCacheReadTokens: median(read),
    medianInputTokens: median(input),
    medianOutputTokens: median(output),
  }
}
