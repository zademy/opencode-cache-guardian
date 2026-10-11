import { describe, expect, test } from "bun:test"

import type { StoredObservation } from "../../src/metrics/observation.ts"
import type { ProviderUsageSample } from "../../src/metrics/provider-usage.ts"
import { NOT_AVAILABLE, renderDoctor, renderReport } from "../../src/opencode/reporting.ts"

const T0 = Date.UTC(2026, 4, 1, 12, 0, 0)

const observation = (overrides: Partial<StoredObservation> = {}): StoredObservation => ({
  time: T0,
  projectKey: "proj_1",
  sessionKey: "sess_1",
  provider: "anthropic",
  model: "claude-sonnet-4",
  requestKind: "primary",
  blockCount: 10,
  prefixBlockCount: 7,
  prefixEstimatedTokens: 350,
  totalEstimatedTokens: 500,
  stablePrefixRatio: 0.7,
  hookDurationMs: 2.7,
  source: "local-estimate",
  aggregate: "a".repeat(64),
  firstDivergence: 7,
  firstDivergenceGroup: "messages",
  ...overrides,
})

const sample = (overrides: Partial<ProviderUsageSample> = {}): ProviderUsageSample => ({
  time: T0,
  sessionKey: "sess_1",
  provider: "anthropic",
  model: "claude-sonnet-4",
  inputTokens: 100,
  outputTokens: 20,
  cacheReadTokens: 400,
  cacheWriteTokens: 80,
  costUsd: 0.0123,
  source: "provider",
  ...overrides,
})

const report = (observations: StoredObservation[], usage: ProviderUsageSample[] = []) =>
  renderReport({ mode: "observe", appVersion: "2.0.26", observations, usage })

describe("report: header and honesty guarantees", () => {
  test("states the mode and the host version", () => {
    expect(report([])).toContain("Cache Guardian | observe | OpenCode 2.0.26")
  })

  test("never invents a savings figure", () => {
    for (const output of [report([]), report([observation()], [sample()])]) {
      expect(output).toContain("Estimated savings in USD: N/A")
      expect(output).not.toMatch(/savings in USD: \$?[0-9]/)
      expect(output).not.toMatch(/saved \$/)
      expect(output).not.toMatch(/[0-9]+% savings/i)
    }
  })

  test("always ends with the privacy statement", () => {
    expect(
      report([])
        .trimEnd()
        .endsWith("No prompts, source code or request content are stored. Only one-way digests."),
    ).toBe(true)
    expect(
      report([observation()], [sample()])
        .trimEnd()
        .endsWith("No prompts, source code or request content are stored. Only one-way digests."),
    ).toBe(true)
  })

  test("local estimates and provider usage are in separate sections", () => {
    const output = report([observation()], [sample()])
    const localAt = output.indexOf("-- local estimates (structural, not billing) --")
    const providerAt = output.indexOf("-- provider-reported usage (real, billed) --")
    expect(localAt).toBeGreaterThan(-1)
    expect(providerAt).toBeGreaterThan(localAt)
  })
})

describe("report: absent data renders as N/A, never as zero", () => {
  const empty = report([])

  test("uses the N/A sentinel with a reason", () => {
    expect(empty).toContain("Median local stable prefix: N/A")
    expect(empty).toContain("Provider cache read tokens: N/A")
    expect(empty).toContain("Provider cache write tokens: N/A")
    expect(empty).toContain("Provider input tokens (non-cached): N/A")
    expect(empty).toContain("Provider cost: N/A")
    expect(NOT_AVAILABLE).toBe("N/A")
  })

  test("does not claim a provider cache hit rate it cannot compute", () => {
    expect(empty).not.toMatch(/cache hit rate/i)
  })

  test("a sample missing a field renders that field as N/A, not 0", () => {
    const output = report([observation()], [sample({ cacheReadTokens: undefined })])
    expect(output).toContain("Provider cache read tokens: N/A")
    expect(output).toContain("Provider cache write tokens: 80")
  })

  test("cost of exactly zero is still a real number, not N/A", () => {
    const output = report([observation()], [sample({ costUsd: 0 })])
    expect(output).toContain("Provider cost: $0")
    expect(output).not.toContain("Provider cost: N/A")
  })
})

describe("report: local metrics", () => {
  test("coverage line shows how many dispatches produced usage events", () => {
    const oneObs = observation()
    const report = renderReport({
      mode: "observe",
      appVersion: "2.0.26",
      observations: [oneObs, { ...oneObs, time: 2, firstDivergence: -1, stablePrefixRatio: 1 }],
      usage: [sample()],
    })
    expect(report).toContain("Coverage: 1 usage event(s) for 2 observed request(s)")
  })
  test("counts observations and comparable pairs separately", () => {
    const output = report([observation(), observation({ time: T0 + 1, firstDivergence: 9 })])
    expect(output).toContain("Requests observed: 2")
    expect(output).toContain("Comparable pairs: 2")
  })

  test("an observation with no predecessor is not counted as a pair", () => {
    const output = report([observation({ firstDivergence: undefined })])
    expect(output).toContain("Requests observed: 1")
    expect(output).toContain("Comparable pairs: 0")
  })

  test("reports the hook overhead it actually measured", () => {
    const output = report([
      observation({ hookDurationMs: 1 }),
      observation({ time: T0 + 1, hookDurationMs: 5 }),
      observation({ time: T0 + 2, hookDurationMs: 9 }),
    ])
    expect(output).toContain("Hook overhead p50/p95: 5.00ms / 9.00ms")
  })

  test("groups scopes by provider, model, request kind and project", () => {
    const output = report([observation(), observation({ time: T0 + 1, firstDivergence: 8 })])
    expect(output).toContain("-- by scope --")
    expect(output).toContain("anthropic/claude-sonnet-4 [primary] proj_1")
  })

  test("keeps different providers and projects in separate scopes", () => {
    const output = report([
      observation({ time: T0 + 1 }),
      observation({ time: T0 + 2, projectKey: "proj_2", firstDivergence: 8 }),
    ])
    expect(output).toContain("anthropic/claude-sonnet-4 [primary] proj_1")
    expect(output).toContain("anthropic/claude-sonnet-4 [primary] proj_2")
  })

  test("surfaces skipped requests instead of silently dropping them", () => {
    const output = report([observation({ skipped: "oversized_payload" })])
    expect(output).toContain("Skipped: 1")
  })

  test("explains where the first divergence lands", () => {
    const output = report([observation({ firstDivergenceGroup: "tools" })])
    expect(output).toContain("First divergence lands in tools")
  })
})

describe("doctor", () => {
  const base = {
    appName: "opencode",
    appVersion: "2.0.26",
    mode: "observe" as const,
    optionsSummary: ["mode: observe"],
    registeredHooks: ["context", "compaction"],
    failedHooks: [] as { hook: string; error: string }[],
    usageCapture: { samples: 2 },
    usageSamplesStored: 2,
    providerUsageAvailable: true,
  }

  test("names the SDK contract it was written against", () => {
    const output = renderDoctor(base)
    expect(output).toContain("@opencode/plugin V2 (Plugin.define + ctx.session.hook)")
  })

  test("marks each hook ok or FAIL", () => {
    const output = renderDoctor({ ...base, failedHooks: [{ hook: "title", error: "boom" }] })
    expect(output).toContain("ok    context")
    expect(output).toContain("FAIL  title: boom")
  })

  test("says out loud that observe mode writes nothing", () => {
    expect(renderDoctor(base)).toContain(
      "Mutation policy: observe mode performs no writes to system/messages/tools/options.",
    )
  })

  test("reports a dead event stream instead of pretending it works", () => {
    const output = renderDoctor({
      ...base,
      usageCapture: { samples: 0, error: "stream closed" },
      providerUsageAvailable: false,
    })
    expect(output).toContain("event stream error: stream closed")
    expect(output).toContain("provider cache usage: N/A")
  })
})
