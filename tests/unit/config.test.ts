import { describe, expect, test } from "bun:test"
import { DEFAULT_OPTIONS, parseOptions } from "../../src/config/schema.ts"

describe("parseOptions", () => {
  test("an absent config yields the documented defaults, with observe as the mode", () => {
    const options = parseOptions(undefined)
    expect(options.mode).toBe("observe")
    expect(options).toEqual(DEFAULT_OPTIONS)
  })

  test("a non-object config falls back to defaults instead of throwing", () => {
    for (const input of [null, 42, "observe", [], true]) {
      expect(parseOptions(input)).toEqual(DEFAULT_OPTIONS)
    }
  })

  test("an unknown mode degrades to observe, never to a risky mode", () => {
    expect(parseOptions({ mode: "nuke-everything" }).mode).toBe("observe")
  })

  test("storeContent cannot be switched on by config", () => {
    expect(parseOptions({ privacy: { storeContent: true } }).privacy.storeContent).toBe(false)
  })

  test("numeric limits are clamped rather than trusted", () => {
    const options = parseOptions({
      metrics: { retentionDays: -5, maxObservations: 9_999_999 },
      limits: { maxProcessingMs: 0, maxRequestBytes: Number.NaN },
    })
    expect(options.metrics.retentionDays).toBe(1)
    expect(options.metrics.maxObservations).toBe(1_000_000)
    expect(options.limits.maxProcessingMs).toBe(1)
    expect(options.limits.maxRequestBytes).toBe(DEFAULT_OPTIONS.limits.maxRequestBytes)
  })

  test("wrongly typed values fall back instead of propagating", () => {
    const options = parseOptions({
      enabled: "yes",
      metrics: { enabled: 1 },
      report: { includeProviderUsage: null },
      safe: { dryRun: "true" },
    })
    expect(options.enabled).toBe(DEFAULT_OPTIONS.enabled)
    expect(options.metrics.enabled).toBe(DEFAULT_OPTIONS.metrics.enabled)
    expect(options.report.includeProviderUsage).toBe(true)
    expect(options.safe.dryRun).toBe(true)
  })

  test("valid overrides are honoured", () => {
    const options = parseOptions({
      mode: "safe",
      privacy: { hashing: "sha256" },
      metrics: { retentionDays: 30 },
      safe: { allowMutations: true },
    })
    expect(options.mode).toBe("safe")
    expect(options.privacy.hashing).toBe("sha256")
    expect(options.metrics.retentionDays).toBe(30)
    expect(options.safe.allowMutations).toBe(true)
  })
})
