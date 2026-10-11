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
 * Sum samples. A field is present only if at least one sample carried it, so "no
 * provider data" stays visibly distinct from "the provider reported zero".
 */
export function totalUsage(samples: readonly ProviderUsageSample[]): ProviderUsageTotals {
  const totals: ProviderUsageTotals = { samples: samples.length }
  let input: number | undefined
  let output: number | undefined
  let read: number | undefined
  let write: number | undefined
  let cost: number | undefined

  for (const sample of samples) {
    if (sample.inputTokens !== undefined) input = (input ?? 0) + sample.inputTokens
    if (sample.outputTokens !== undefined) output = (output ?? 0) + sample.outputTokens
    if (sample.cacheReadTokens !== undefined) read = (read ?? 0) + sample.cacheReadTokens
    if (sample.cacheWriteTokens !== undefined) write = (write ?? 0) + sample.cacheWriteTokens
    if (sample.costUsd !== undefined) cost = (cost ?? 0) + sample.costUsd
  }

  if (input !== undefined) totals.inputTokens = input
  if (output !== undefined) totals.outputTokens = output
  if (read !== undefined) totals.cacheReadTokens = read
  if (write !== undefined) totals.cacheWriteTokens = write
  if (cost !== undefined) totals.costUsd = cost

  return totals
}
