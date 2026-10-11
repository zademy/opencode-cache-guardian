import { describe, expect, test } from "bun:test"

import type { StoredObservation } from "../../src/metrics/observation.ts"
import type { ProviderUsageSample } from "../../src/metrics/provider-usage.ts"
import {
  describe as describeError,
  KEY_RING_PREFIX,
  loadObservations,
  loadUsage,
  OBSERVATION_PREFIX,
  prune,
  ROOT,
  recordObservation,
  recordUsage,
  reset,
  USAGE_PREFIX,
} from "../../src/storage/store.ts"
import { FakeStorage } from "../fixtures/index.ts"

const DAY = 24 * 60 * 60 * 1000

const observation = (
  time: number,
  overrides: Partial<StoredObservation> = {},
): StoredObservation => ({
  time,
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
  hookDurationMs: 1.5,
  source: "local-estimate",
  aggregate: "a".repeat(64),
  firstDivergence: 7,
  ...overrides,
})

const usage = (
  time: number,
  overrides: Partial<ProviderUsageSample> = {},
): ProviderUsageSample => ({
  time,
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

describe("storage key layout", () => {
  test("everything we write lives under one versioned prefix", () => {
    expect(ROOT).toBe("cache-guardian/v1")
    expect(OBSERVATION_PREFIX.startsWith(ROOT)).toBe(true)
    expect(USAGE_PREFIX.startsWith(ROOT)).toBe(true)
    expect(KEY_RING_PREFIX.startsWith(ROOT)).toBe(true)
  })

  test("keys sort chronologically as plain strings", async () => {
    const store = new FakeStorage()
    const early = Date.UTC(2026, 0, 1)
    const late = Date.UTC(2026, 0, 2)
    await recordObservation(store, observation(late), 0)
    await recordObservation(store, observation(early), 0)
    await recordObservation(store, observation(early), 1)
    const keys = [...store.entries.keys()].sort()
    expect(keys[0]).toContain(String(early).padStart(16, "0"))
    expect(keys[0]).toContain("-000000")
    expect(keys[1]).toContain("-000001")
    expect(keys[2]).toContain(String(late).padStart(16, "0"))
  })
})

describe("round trip", () => {
  test("observations survive a write and a read", async () => {
    const store = new FakeStorage()
    expect(await recordObservation(store, observation(1000), 0)).toEqual({ written: true })
    const loaded = await loadObservations(store)
    expect(loaded).toHaveLength(1)
    expect(loaded[0]?.blockCount).toBe(10)
    expect(loaded[0]?.firstDivergence).toBe(7)
  })

  test("usage samples survive a write and a read", async () => {
    const store = new FakeStorage()
    expect(await recordUsage(store, usage(2000), 0)).toEqual({ written: true })
    const loaded = await loadUsage(store)
    expect(loaded).toHaveLength(1)
    expect(loaded[0]?.cacheReadTokens).toBe(400)
  })

  test("observations and usage do not bleed into each other", async () => {
    const store = new FakeStorage()
    await recordObservation(store, observation(1000), 0)
    await recordUsage(store, usage(2000), 0)
    expect(await loadObservations(store)).toHaveLength(1)
    expect(await loadUsage(store)).toHaveLength(1)
  })

  test("pagination: a scan larger than one page loads everything", async () => {
    const store = new FakeStorage()
    for (let i = 0; i < 1200; i++) {
      await recordObservation(store, observation(1000 + i), i)
    }
    expect(store.entries.size).toBe(1200)
    expect(await loadObservations(store)).toHaveLength(1200)
  })

  test("malformed stored values are dropped, not thrown on", async () => {
    const store = new FakeStorage()
    store.entries.set(`${OBSERVATION_PREFIX}bad`, "not-an-object")
    store.entries.set(`${OBSERVATION_PREFIX}bad2`, [1, 2, 3])
    store.entries.set(`${OBSERVATION_PREFIX}bad3`, { time: "yesterday" })
    await recordObservation(store, observation(1000), 0)
    const loaded = await loadObservations(store)
    expect(loaded).toHaveLength(1)
  })
})

describe("failure tolerance", () => {
  test("a failing set is reported, never thrown", async () => {
    const store = new FakeStorage()
    store.failOnSet = true
    const result = await recordObservation(store, observation(1000), 0)
    expect(result.written).toBe(false)
    expect(result.error).toBe("disk full")
  })

  test("a failing usage set is reported, never thrown", async () => {
    const store = new FakeStorage()
    store.failOnSet = true
    expect((await recordUsage(store, usage(1000), 0)).error).toBe("disk full")
  })

  test("a failing scan yields an empty list, never a throw", async () => {
    const store = new FakeStorage()
    await recordObservation(store, observation(1000), 0)
    store.failOnScan = true
    expect(await loadObservations(store)).toEqual([])
    expect(await loadUsage(store)).toEqual([])
    expect(await prune(store, OBSERVATION_PREFIX, 10, 14, Date.now())).toEqual({
      removed: 0,
      kept: 0,
    })
    expect(await reset(store)).toBe(0)
  })

  test("a failing remove during prune does not abort the sweep", async () => {
    const store = new FakeStorage()
    for (let i = 0; i < 5; i++) await recordObservation(store, observation(1000 + i), i)
    const original = store.remove.bind(store)
    store.remove = async (_key: string) => {
      throw new Error("locked")
    }
    const result = await prune(store, OBSERVATION_PREFIX, 2, 14, 2000)
    store.remove = original
    expect(result.removed).toBe(0)
    expect(result.kept).toBe(5)
    expect(store.removed).toEqual([])
  })
})

describe("prune", () => {
  const now = Date.UTC(2026, 5, 1)

  test("entries older than the retention window are removed", async () => {
    const store = new FakeStorage()
    await recordObservation(store, observation(now - 40 * DAY), 0)
    await recordObservation(store, observation(now - 1 * DAY), 0)
    const result = await prune(store, OBSERVATION_PREFIX, 1000, 14, now)
    expect(result.removed).toBe(1)
    expect(result.kept).toBe(1)
    expect(await loadObservations(store)).toHaveLength(1)
  })

  test("exceeding the count cap drops the oldest first", async () => {
    const store = new FakeStorage()
    for (let i = 0; i < 6; i++) await recordObservation(store, observation(now - (6 - i) * 1000), i)
    const result = await prune(store, OBSERVATION_PREFIX, 2, 3650, now)
    expect(result.removed).toBe(4)
    expect(result.kept).toBe(2)
    const kept = await loadObservations(store)
    expect(kept.map((entry) => entry.time).sort((a, b) => a - b)).toEqual([now - 2000, now - 1000])
  })

  test("age is applied before the count cap", async () => {
    const store = new FakeStorage()
    await recordObservation(store, observation(now - 90 * DAY), 0)
    await recordObservation(store, observation(now - 89 * DAY), 0)
    await recordObservation(store, observation(now - 1 * DAY), 0)
    const result = await prune(store, OBSERVATION_PREFIX, 2, 30, now)
    expect(result.removed).toBe(2)
    expect(result.kept).toBe(1)
  })

  test("pruning only touches the prefix it was given", async () => {
    const store = new FakeStorage()
    await recordObservation(store, observation(now - 90 * DAY), 0)
    await recordUsage(store, usage(now - 90 * DAY), 0)
    await prune(store, OBSERVATION_PREFIX, 1000, 30, now)
    expect(await loadObservations(store)).toHaveLength(0)
    expect(await loadUsage(store)).toHaveLength(1)
  })

  test("pruning an empty store is a no-op", async () => {
    const store = new FakeStorage()
    expect(await prune(store, OBSERVATION_PREFIX, 10, 14, now)).toEqual({ removed: 0, kept: 0 })
  })
})

describe("reset", () => {
  test("clears every record this plugin owns", async () => {
    const store = new FakeStorage()
    await recordObservation(store, observation(1000), 0)
    await recordUsage(store, usage(1000), 0)
    expect(await reset(store)).toBe(2)
    expect(store.entries.size).toBe(0)
  })

  test("leaves keys outside our prefix alone", async () => {
    const store = new FakeStorage()
    store.entries.set("someone-else/data", { keep: true })
    await recordObservation(store, observation(1000), 0)
    await reset(store)
    expect(store.entries.has("someone-else/data")).toBe(true)
    expect(store.entries.size).toBe(1)
  })

  test("reset on an empty store reports zero", async () => {
    expect(await reset(new FakeStorage())).toBe(0)
  })
})

describe("concurrent writers", () => {
  test("parallel writes all land and none overwrite another", async () => {
    const store = new FakeStorage()
    const now = Date.UTC(2026, 5, 1)
    await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        recordObservation(store, observation(now + i, { blockCount: i }), i),
      ),
    )
    const loaded = await loadObservations(store)
    expect(loaded).toHaveLength(50)
    expect(new Set(loaded.map((entry) => entry.blockCount)).size).toBe(50)
  })

  test("a reset racing with writes leaves no orphaned prefix entries", async () => {
    const store = new FakeStorage()
    const now = Date.UTC(2026, 5, 1)
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => recordObservation(store, observation(now + i), i)),
    )
    await Promise.all([reset(store), prune(store, OBSERVATION_PREFIX, 5, 14, now)])
    const remaining = await loadObservations(store)
    expect(remaining.length).toBeLessThanOrEqual(20)
    for (const entry of remaining) expect(entry.time).toBeGreaterThan(0)
  })
})

describe("describe", () => {
  test("unwraps errors, strings and anything else", () => {
    expect(describeError(new Error("boom"))).toBe("boom")
    expect(describeError("plain")).toBe("plain")
    expect(describeError(undefined)).toBe("unknown error")
    expect(describeError({ nope: true })).toBe("unknown error")
  })
})
