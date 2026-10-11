import type { Mode } from "../config/schema.ts"
import { aggregate, type LocalMetrics, recommend } from "../metrics/aggregation.ts"
import type { StoredObservation } from "../metrics/observation.ts"
import { type ProviderUsageSample, totalUsage } from "../metrics/provider-usage.ts"

/**
 * Rendering only. Two metric classes are printed in separate blocks and never merged:
 * local structural estimates (ours) and provider-reported usage (theirs). A missing
 * field prints as N/A with its reason; it is never rendered as 0 or as a percentage.
 */

export const NOT_AVAILABLE = "N/A"

export const na = (reason: string) => `${NOT_AVAILABLE} — ${reason}`

const pct = (value: number | undefined) =>
  value === undefined ? na("no comparable pairs") : `${Math.round(value * 100)}%`

const ms = (value: number) => `${value.toFixed(2)}ms`

const int = (value: number | undefined) =>
  value === undefined ? na("not reported by provider") : value.toLocaleString("en-US")

export interface ScopeSummary {
  scope: string
  projectKey: string
  provider: string
  model: string
  requestKind: string
  metrics: LocalMetrics
}

export function scopeId(observation: StoredObservation): string {
  return [
    observation.projectKey,
    observation.provider,
    observation.model,
    observation.variant ?? "-",
    observation.agent ?? "-",
    observation.requestKind,
  ].join("|")
}

export function summarizeScopes(observations: readonly StoredObservation[]): ScopeSummary[] {
  const groups = new Map<string, StoredObservation[]>()
  for (const observation of observations) {
    const id = scopeId(observation)
    const bucket = groups.get(id)
    if (bucket) bucket.push(observation)
    else groups.set(id, [observation])
  }
  return [...groups.entries()].map(([scope, bucket]) => {
    const first = bucket[0] as StoredObservation
    return {
      scope,
      projectKey: first.projectKey,
      provider: first.provider,
      model: first.model,
      requestKind: first.requestKind,
      metrics: aggregate(bucket),
    }
  })
}

export interface ReportInput {
  mode: Mode
  appVersion: string
  observations: readonly StoredObservation[]
  usage: readonly ProviderUsageSample[]
}

export function renderReport(input: ReportInput): string {
  const metrics = aggregate(input.observations)
  const usage = totalUsage(input.usage)
  const scopes = summarizeScopes(input.observations)
  const lines: string[] = []

  lines.push(`Cache Guardian | ${input.mode} | OpenCode ${input.appVersion}`)
  lines.push(`Requests observed: ${metrics.requestsObserved}`)
  lines.push(`Comparable pairs: ${metrics.comparablePairs}`)
  lines.push(`Median local stable prefix: ${pct(metrics.medianStablePrefixRatio)} (blocks)`)
  lines.push("")
  lines.push("-- local estimates (structural, not billing) --")
  lines.push(
    `Stable blocks: ${metrics.stablePrefixBlocks}/${metrics.totalBlocks} across comparable pairs`,
  )
  lines.push(`Median estimated stable prefix: ${int(metrics.medianStablePrefixTokens)} tokens`)
  lines.push(`Median estimated request size: ${int(metrics.medianTotalTokens)} tokens`)
  lines.push(
    `Hook overhead p50/p95: ${ms(metrics.hookLatencyMs.p50)} / ${ms(metrics.hookLatencyMs.p95)}`,
  )
  if (metrics.skippedTotal > 0) {
    lines.push(
      `Skipped: ${metrics.skippedTotal} request(s) ${JSON.stringify(metrics.skippedByReason)}`,
    )
  } else {
    lines.push("Skipped: 0")
  }
  lines.push("")
  lines.push("-- provider-reported usage (real, billed) --")
  lines.push(
    usage.samples === 0
      ? `Provider usage samples: ${na("no session.usage.updated events captured")}`
      : `Provider usage samples: ${usage.samples}`,
  )
  lines.push(`Provider cache read tokens: ${int(usage.cacheReadTokens)}`)
  lines.push(`Provider cache write tokens: ${int(usage.cacheWriteTokens)}`)
  lines.push(`Provider input tokens: ${int(usage.inputTokens)}`)
  lines.push(
    `Provider cost: ${usage.costUsd === undefined ? na("not reported by provider") : `$${usage.costUsd.toFixed(4)}`}`,
  )
  lines.push(
    `Estimated savings in USD: ${na("cache reuse is decided by the provider, not by this plugin")}`,
  )
  lines.push("")

  if (scopes.length > 0) {
    lines.push("-- by scope --")
    for (const scope of scopes) {
      lines.push(
        `${scope.provider}/${scope.model} [${scope.requestKind}] ${scope.projectKey}: ` +
          `${scope.metrics.comparablePairs} comparable pair(s), median stable prefix ` +
          `${pct(scope.metrics.medianStablePrefixRatio)}`,
      )
    }
    lines.push("")
  }

  const recommendations = recommend(metrics)
  if (recommendations.length > 0) {
    lines.push("-- observations --")
    for (const recommendation of recommendations) {
      lines.push(`- ${recommendation.text}`)
      lines.push(`  basis: ${recommendation.basis}`)
    }
    lines.push("")
  }

  lines.push("No prompts, source code or request content are stored. Only one-way digests.")
  return lines.join("\n")
}

export interface DoctorInput {
  appName: string
  appVersion: string
  mode: Mode
  optionsSummary: string[]
  registeredHooks: readonly string[]
  failedHooks: ReadonlyArray<{ hook: string; error: string }>
  usageCapture: { samples: number; error?: string }
  usageSamplesStored: number
  providerUsageAvailable: boolean
}

export function renderDoctor(input: DoctorInput): string {
  const lines: string[] = []
  lines.push(`Cache Guardian doctor | OpenCode ${input.appVersion} (${input.appName})`)
  lines.push(`Mode: ${input.mode}`)
  lines.push(`SDK contract: @opencode/plugin V2 (Plugin.define + ctx.session.hook)`)
  lines.push("")
  lines.push("-- hooks --")
  for (const hook of input.registeredHooks) lines.push(`ok    ${hook}`)
  for (const failure of input.failedHooks) lines.push(`FAIL  ${failure.hook}: ${failure.error}`)
  lines.push("")
  lines.push("-- options --")
  for (const line of input.optionsSummary) lines.push(`  ${line}`)
  lines.push("")
  lines.push("-- metric sources --")
  lines.push(`  local prefix estimate: available`)
  lines.push(
    input.providerUsageAvailable
      ? `  provider cache usage: available via session.usage.updated (${input.usageSamplesStored} sample(s) stored)`
      : `  provider cache usage: ${na("no session.usage.updated events captured yet")}`,
  )
  lines.push(
    input.usageCapture.error
      ? `  event stream error: ${input.usageCapture.error}`
      : `  event stream: ok (${input.usageCapture.samples} usage event(s) seen)`,
  )
  lines.push("")
  lines.push("Mutation policy: observe mode performs no writes to system/messages/tools/options.")
  return lines.join("\n")
}
