/**
 * Plugin options. These are Cache Guardian's own keys, not OpenCode's: the plugin
 * receives them verbatim through ctx.options and must never assume the host validated
 * them.
 */

export type Mode = "observe" | "safe" | "experimental"
export type Hashing = "sha256" | "hmac-sha256"

export interface CacheGuardianOptions {
  mode: Mode
  enabled: boolean
  privacy: {
    /** Content is never stored. Present so the intent is explicit and assertable in tests. */
    storeContent: boolean
    hashing: Hashing
  }
  metrics: {
    enabled: boolean
    retentionDays: number
    maxObservations: number
  }
  limits: {
    /**
     * Soft budget: the hook stops hashing once exceeded and records a skip. Not a hard
     * interrupt — JS cannot preempt a running synchronous loop from outside.
     */
    maxProcessingMs: number
    maxRequestBytes: number
  }
  report: {
    includeProviderUsage: boolean
  }
  safe: {
    dryRun: boolean
    allowMutations: boolean
  }
}

export const DEFAULT_OPTIONS: CacheGuardianOptions = {
  mode: "observe",
  enabled: true,
  privacy: { storeContent: false, hashing: "hmac-sha256" },
  metrics: { enabled: true, retentionDays: 14, maxObservations: 10_000 },
  limits: { maxProcessingMs: 40, maxRequestBytes: 2_000_000 },
  report: { includeProviderUsage: true },
  safe: { dryRun: true, allowMutations: false },
}

const MODES: readonly string[] = ["observe", "safe", "experimental"]
const HASHINGS: readonly string[] = ["sha256", "hmac-sha256"]

const asRecord = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {}

const bool = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback)

const count = (v: unknown, fallback: number, min: number, max: number) => {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback
  return Math.min(max, Math.max(min, Math.floor(v)))
}

const pick = (v: unknown, allowed: readonly string[], fallback: string) =>
  typeof v === "string" && allowed.includes(v) ? v : fallback

/**
 * Anything invalid degrades to a safe value rather than throwing: a config typo must
 * never break the host's request path.
 */
export function parseOptions(raw: unknown): CacheGuardianOptions {
  const o = asRecord(raw)
  const privacy = asRecord(o.privacy)
  const metrics = asRecord(o.metrics)
  const limits = asRecord(o.limits)
  const report = asRecord(o.report)
  const safe = asRecord(o.safe)

  return {
    mode: pick(o.mode, MODES, DEFAULT_OPTIONS.mode) as Mode,
    enabled: bool(o.enabled, DEFAULT_OPTIONS.enabled),
    privacy: {
      // Hard-wired off. Not a supported configuration, only a documented rejection, so
      // a stray true in a config file cannot switch content storage on.
      storeContent: false,
      hashing: pick(privacy.hashing, HASHINGS, DEFAULT_OPTIONS.privacy.hashing) as Hashing,
    },
    metrics: {
      enabled: bool(metrics.enabled, DEFAULT_OPTIONS.metrics.enabled),
      retentionDays: count(metrics.retentionDays, DEFAULT_OPTIONS.metrics.retentionDays, 1, 365),
      maxObservations: count(
        metrics.maxObservations,
        DEFAULT_OPTIONS.metrics.maxObservations,
        10,
        1_000_000,
      ),
    },
    limits: {
      maxProcessingMs: count(
        limits.maxProcessingMs,
        DEFAULT_OPTIONS.limits.maxProcessingMs,
        1,
        5_000,
      ),
      maxRequestBytes: count(
        limits.maxRequestBytes,
        DEFAULT_OPTIONS.limits.maxRequestBytes,
        1_024,
        100_000_000,
      ),
    },
    report: {
      includeProviderUsage: bool(
        report.includeProviderUsage,
        DEFAULT_OPTIONS.report.includeProviderUsage,
      ),
    },
    safe: {
      dryRun: bool(safe.dryRun, DEFAULT_OPTIONS.safe.dryRun),
      allowMutations: bool(safe.allowMutations, DEFAULT_OPTIONS.safe.allowMutations),
    },
  }
}
