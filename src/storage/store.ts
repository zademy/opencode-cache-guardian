import type { Plugin } from "@opencode/plugin"
import type { StoredObservation } from "../metrics/observation.ts"
import type { ProviderUsageSample } from "../metrics/provider-usage.ts"

/**
 * Persistence on the host's own storage (ctx.storage). No hardcoded paths, so Windows,
 * macOS and Linux all work without a branch, and no lock file of our own to corrupt.
 *
 * Everything here swallows its errors: telemetry must never break a request.
 */

export type StorageLike = Plugin.Context["storage"]

export const ROOT = "cache-guardian/v1"
export const OBSERVATION_PREFIX = `${ROOT}/observation/`
export const USAGE_PREFIX = `${ROOT}/usage/`
export const KEY_RING_PREFIX = `${ROOT}/`

const SCAN_PAGE = 500

/**
 * Zero-padded epoch millis so keys sort chronologically as plain strings, which makes
 * "oldest first" a lexicographic scan with no extra bookkeeping.
 */
const keyFor = (prefix: string, time: number, seq: number) =>
  prefix +
  String(Math.max(0, Math.floor(time))).padStart(16, "0") +
  "-" +
  String(seq).padStart(6, "0")

export interface WriteResult {
  readonly written: boolean
  readonly error?: string
}

export async function recordObservation(
  store: StorageLike,
  observation: StoredObservation,
  seq: number,
): Promise<WriteResult> {
  try {
    await store.set(keyFor(OBSERVATION_PREFIX, observation.time, seq), observation as never)
    return { written: true }
  } catch (error) {
    return { written: false, error: describe(error) }
  }
}

export async function recordUsage(
  store: StorageLike,
  sample: ProviderUsageSample,
  seq: number,
): Promise<WriteResult> {
  try {
    await store.set(keyFor(USAGE_PREFIX, sample.time, seq), sample as never)
    return { written: true }
  } catch (error) {
    return { written: false, error: describe(error) }
  }
}

async function* scanAll(store: StorageLike, prefix: string) {
  let after: string | undefined
  for (;;) {
    let page: Awaited<ReturnType<StorageLike["scan"]>>
    try {
      page = await store.scan({ prefix, after, limit: SCAN_PAGE })
    } catch {
      return
    }
    yield* page.entries
    if (!page.next) return
    after = page.next
  }
}

function parse<T>(entry: { readonly value: unknown }): T | undefined {
  if (typeof entry.value !== "object" || entry.value === null || Array.isArray(entry.value)) {
    return undefined
  }
  return entry.value as T
}

export async function loadObservations(store: StorageLike): Promise<StoredObservation[]> {
  const out: StoredObservation[] = []
  for await (const entry of scanAll(store, OBSERVATION_PREFIX)) {
    const parsed = parse<StoredObservation>(entry)
    if (parsed && typeof parsed.time === "number") out.push(parsed)
  }
  return out
}

export async function loadUsage(store: StorageLike): Promise<ProviderUsageSample[]> {
  const out: ProviderUsageSample[] = []
  for await (const entry of scanAll(store, USAGE_PREFIX)) {
    const parsed = parse<ProviderUsageSample>(entry)
    if (parsed && typeof parsed.time === "number") out.push(parsed)
  }
  return out
}

export interface PruneResult {
  removed: number
  kept: number
}

const ageOf = (entry: { readonly value: unknown }) => {
  const parsed = parse<{ time?: unknown }>(entry)
  return typeof parsed?.time === "number" ? parsed.time : undefined
}

/**
 * Enforce both retention bounds: age first, then count. Entries beyond `maxEntries` are
 * removed oldest-first, so the store self-limits without ever needing an index.
 */
export async function prune(
  store: StorageLike,
  prefix: string,
  maxEntries: number,
  retentionDays: number,
  now: number,
): Promise<PruneResult> {
  const cutoff = now - retentionDays * 24 * 60 * 60 * 1000
  let removed = 0
  const survivors: { key: string; value: unknown }[] = []

  for await (const entry of scanAll(store, prefix)) {
    const time = ageOf(entry)
    if (time !== undefined && time < cutoff) {
      try {
        await store.remove(entry.key)
        removed += 1
        continue
      } catch {
        // Failed removal is not fatal; the entry stays until it ages out again.
      }
    }
    survivors.push(entry)
  }

  let trimmed = 0
  for (const entry of survivors.slice(0, survivors.length - maxEntries)) {
    try {
      await store.remove(entry.key)
      trimmed += 1
    } catch {
      // Same: a failed delete must not abort pruning.
    }
  }

  removed += trimmed
  return { removed, kept: survivors.length - trimmed }
}

export async function reset(store: StorageLike): Promise<number> {
  let removed = 0
  for await (const entry of scanAll(store, KEY_RING_PREFIX)) {
    try {
      await store.remove(entry.key)
      removed += 1
    } catch {
      // Best effort.
    }
  }
  return removed
}

export function describe(error: unknown): string {
  if (error instanceof Error) return error.message
  return typeof error === "string" ? error : "unknown error"
}
