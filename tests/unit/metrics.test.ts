import { describe, expect, test } from "bun:test"
import {
  aggregate,
  percentile,
  recommend,
  summarizeLatency,
} from "../../src/metrics/aggregation.ts"
import { type StoredObservation, toStoredObservation } from "../../src/metrics/observation.ts"
import {
  type ProviderUsageSample,
  parseUsageEvent,
  totalUsage,
  usageDeltas,
} from "../../src/metrics/provider-usage.ts"

const observation = (over: Partial<StoredObservation> = {}): StoredObservation => ({
  time: 1,
  projectKey: "proj",
  sessionKey: "sess",
  provider: "anthropic",
  model: "claude",
  requestKind: "primary",
  blockCount: 10,
  prefixBlockCount: 0,
  hookDurationMs: 1,
  source: "local-estimate",
  aggregate: "agg",
  ...over,
})

describe("percentile and latency", () => {
  test("an empty sample is 0, never NaN", () => {
    expect(percentile([], 0.95)).toBe(0)
    expect(summarizeLatency([]).p95).toBe(0)
  })

  test("nearest-rank percentiles", () => {
    const values = [10, 1, 5, 100, 2]
    expect(percentile(values, 0.5)).toBe(5)
    expect(percentile(values, 1)).toBe(100)
    expect(summarizeLatency(values).max).toBe(100)
  })
})

describe("aggregate", () => {
  test("the first observation in a scope has no comparable pair", () => {
    const metrics = aggregate([observation()])
    expect(metrics.requestsObserved).toBe(1)
    expect(metrics.comparablePairs).toBe(0)
    expect(metrics.medianStablePrefixRatio).toBeUndefined()
  })

  test("skipped requests are counted with their reason and excluded from pairs", () => {
    const metrics = aggregate([
      observation({ skipped: "oversized_payload" }),
      observation({ skipped: "processing_budget_exceeded" }),
    ])
    expect(metrics.skippedTotal).toBe(2)
    expect(metrics.skippedByReason.oversized_payload).toBe(1)
    expect(metrics.comparablePairs).toBe(0)
  })

  test("first divergence is tallied per group", () => {
    const metrics = aggregate([
      observation({ firstDivergence: 0, firstDivergenceGroup: "messages", stablePrefixRatio: 0 }),
      observation({ firstDivergence: 0, firstDivergenceGroup: "messages", stablePrefixRatio: 0 }),
      observation({ firstDivergence: -1, stablePrefixRatio: 1 }),
    ])
    expect(metrics.comparablePairs).toBe(3)
    expect(metrics.divergenceFreePairs).toBe(1)
    expect(metrics.firstDivergenceByGroup.messages).toBe(2)
  })

  test("median stable prefix ratio", () => {
    const metrics = aggregate([
      observation({ firstDivergence: 1, stablePrefixRatio: 0.5 }),
      observation({ firstDivergence: 9, stablePrefixRatio: 1 }),
    ])
    expect(metrics.medianStablePrefixRatio).toBe(0.75)
  })
})

describe("recommend", () => {
  test("says so when there is nothing to compare", () => {
    const out = recommend(aggregate([observation()]))
    expect(out).toHaveLength(1)
    expect(out[0]?.text).toContain("Not enough comparable pairs")
  })

  test("names the group where requests first diverge", () => {
    const out = recommend(
      aggregate([
        observation({ firstDivergence: 0, firstDivergenceGroup: "system", stablePrefixRatio: 0 }),
      ]),
    )
    expect(out.some((r) => r.text.includes("system"))).toBe(true)
  })

  test("flags oversized payloads", () => {
    const out = recommend(aggregate([observation({ skipped: "oversized_payload" })]))
    expect(out.some((r) => r.basis.includes("oversized_payload"))).toBe(true)
  })
})

describe("parseUsageEvent", () => {
  const scope = { sessionKey: "abc", provider: "anthropic", model: "claude" }

  test("reads real cache read and write tokens from a usage event", () => {
    const sample = parseUsageEvent(
      {
        type: "session.usage.updated",
        data: {
          sessionID: "ses_1",
          cost: 0.0123,
          tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 4096, write: 256 } },
        },
      },
      () => scope,
      1000,
    )
    expect(sample).toEqual({
      time: 1000,
      sessionKey: "abc",
      source: "provider",
      provider: "anthropic",
      model: "claude",
      inputTokens: 100,
      outputTokens: 20,
      reasoningTokens: 5,
      cacheReadTokens: 4096,
      cacheWriteTokens: 256,
      costUsd: 0.0123,
    })
  })

  test("ignores every other event type", () => {
    expect(parseUsageEvent({ type: "session.idle", data: {} }, () => scope, 0)).toBeUndefined()
    expect(parseUsageEvent(null, () => scope, 0)).toBeUndefined()
    expect(parseUsageEvent("nonsense", () => scope, 0)).toBeUndefined()
  })

  test("a drifted shape yields absent fields, never invented zeros", () => {
    const sample = parseUsageEvent(
      { type: "session.usage.updated", data: { sessionID: "ses_1", tokens: { input: 7 } } },
      () => scope,
      0,
    )
    expect(sample?.inputTokens).toBe(7)
    expect(sample?.cacheReadTokens).toBeUndefined()
    expect(sample?.costUsd).toBeUndefined()
  })

  test("an unknown session produces no sample at all", () => {
    expect(
      parseUsageEvent(
        { type: "session.usage.updated", data: { sessionID: "x", tokens: {} } },
        () => undefined,
        0,
      ),
    ).toBeUndefined()
  })
})

describe("totalUsage", () => {
  const sample = (over: Partial<ProviderUsageSample>): ProviderUsageSample => ({
    time: 1,
    sessionKey: "s",
    source: "provider",
    ...over,
  })

  test("no samples means every field is absent, which is not the same as zero", () => {
    const totals = totalUsage([])
    expect(totals.samples).toBe(0)
    expect(totals.cacheReadTokens).toBeUndefined()
  })

  // Live-verified shape: session.usage.updated carries session-lifetime
  // cumulative counters, monotonic within a session. These are real numbers
  // from a live session, kept as a regression fixture against double-counting.
  const LIVE = [
    { inputTokens: 1148635, cacheReadTokens: 20300000 },
    { inputTokens: 1214178, cacheReadTokens: 24371828 },
  ]

  test("takes each session's latest counter instead of summing cumulative samples", () => {
    const totals = totalUsage(LIVE.map((v, i) => sample({ time: i + 1, ...v })))
    expect(totals.inputTokens).toBe(1214178)
    expect(totals.cacheReadTokens).toBe(24371828)
  })

  test("sums across sessions but never within one", () => {
    const totals = totalUsage([
      sample({ sessionKey: "a", inputTokens: 100, cacheReadTokens: 7 }),
      sample({ sessionKey: "b", inputTokens: 50, cacheReadTokens: 3 }),
    ])
    expect(totals.inputTokens).toBe(150)
    expect(totals.cacheReadTokens).toBe(10)
  })

  test("a field the newest sample lacks falls back to the newest one carrying it", () => {
    const totals = totalUsage([
      sample({ time: 1, cacheReadTokens: 100 }),
      sample({ time: 2, inputTokens: 5 }),
    ])
    expect(totals.cacheReadTokens).toBe(100)
    expect(totals.inputTokens).toBe(5)
  })
})

describe("usageDeltas", () => {
  const sample = (over: Partial<ProviderUsageSample>): ProviderUsageSample => ({
    time: 1,
    sessionKey: "s",
    source: "provider",
    ...over,
  })

  test("per-dispatch deltas of cumulative counters, median over the series", () => {
    const deltas = usageDeltas([
      sample({ time: 1, inputTokens: 1148635, cacheReadTokens: 20300000 }),
      sample({ time: 2, inputTokens: 1180000, cacheReadTokens: 22000000 }),
      sample({ time: 3, inputTokens: 1214178, cacheReadTokens: 24371828 }),
    ])
    expect(deltas.dispatches).toBe(2)
    expect(deltas.medianCacheReadTokens).toBe(2371828)
    expect(deltas.medianInputTokens).toBe(34178)
  })

  test("a counter reset yields no delta rather than a negative one", () => {
    const deltas = usageDeltas([
      sample({ time: 1, cacheReadTokens: 100 }),
      sample({ time: 2, cacheReadTokens: 50 }),
    ])
    expect(deltas.dispatches).toBe(0)
    expect(deltas.medianCacheReadTokens).toBeUndefined()
  })

  test("sessions never share a delta window", () => {
    const deltas = usageDeltas([
      sample({ time: 1, sessionKey: "a", cacheReadTokens: 100 }),
      sample({ time: 2, sessionKey: "a", cacheReadTokens: 200 }),
      sample({ time: 3, sessionKey: "b", cacheReadTokens: 500 }),
      sample({ time: 4, sessionKey: "b", cacheReadTokens: 700 }),
    ])
    expect(deltas.dispatches).toBe(2)
    expect(deltas.medianCacheReadTokens).toBe(200)
  })

  test("no samples means no dispatches, not zero", () => {
    expect(usageDeltas([]).dispatches).toBe(0)
    expect(usageDeltas([]).medianInputTokens).toBeUndefined()
  })
})

describe("toStoredObservation", () => {
  test("drops the in-memory block list before anything is written", () => {
    const stored = toStoredObservation({
      ...observation(),
      blocks: [{ group: "messages", digest: "d", short: "d", chars: 1 }],
    })
    expect("blocks" in stored).toBe(false)
  })
})
