/**
 * Canonical serialization for fingerprinting.
 *
 * Goal: two structurally equal payloads hash identically. That means sorting object
 * keys (JSON key order is incidental) while leaving array order and every byte of text
 * exactly as-is. The provider does not reorder arrays or re-case text, so normalizing
 * those would manufacture matches that never occur against the real provider.
 */

export type Canonical = string

const MAX_DEPTH = 64

/** Depth guard: an adversarial or self-referential payload must not blow the stack. */
function walk(value: unknown, seen: WeakSet<object>, depth: number): string | undefined {
  if (depth > MAX_DEPTH) return '"[depth-limit]"'

  if (value === null) return "null"

  switch (typeof value) {
    case "undefined":
      return undefined
    case "boolean":
      return value ? "true" : "false"
    case "number":
      return Number.isFinite(value) ? JSON.stringify(value) : '"[non-finite]"'
    case "bigint":
      return `"${value.toString()}"`
    case "string":
      return JSON.stringify(value)
    case "symbol":
    case "function":
      return undefined
  }

  const obj = value as object
  if (seen.has(obj)) return '"[circular]"'
  seen.add(obj)

  try {
    if (Array.isArray(obj)) {
      const items = obj.map((item) => walk(item, seen, depth + 1) ?? "null")
      return `[${items.join(",")}]`
    }

    if (obj instanceof ArrayBuffer || ArrayBuffer.isView(obj)) {
      // Inline image bytes are described by length only. Hashing megabytes of base64
      // would cost real latency and could never match a stable reference.
      const view = obj instanceof ArrayBuffer ? new Uint8Array(obj) : new Uint8Array(obj.buffer)
      return `{"$binary":{"length":${view.length}}}`
    }

    if (obj instanceof Map) {
      const entries = [...obj.entries()]
        .map(([k, v]) => [String(k), v] as const)
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
        .map(([k, v]) => `${JSON.stringify(k)}:${walk(v, seen, depth + 1) ?? "null"}`)
      return `{${entries.join(",")}}`
    }

    if (obj instanceof Set) {
      const items = [...obj.values()].map((v) => walk(v, seen, depth + 1) ?? "null")
      return `{"$set":[${items.join(",")}]}`
    }

    if (obj instanceof Date) return JSON.stringify(obj.toISOString())
    if (obj instanceof RegExp) return JSON.stringify(obj.source)

    const record = obj as Record<string, unknown>
    const parts: string[] = []
    for (const key of Object.keys(record).sort()) {
      const serialized = walk(record[key], seen, depth + 1)
      // undefined-valued keys are dropped, matching JSON.stringify.
      if (serialized === undefined) continue
      parts.push(`${JSON.stringify(key)}:${serialized}`)
    }
    return `{${parts.join(",")}}`
  } finally {
    seen.delete(obj)
  }
}

export function canonicalize(value: unknown): Canonical | undefined {
  return walk(value, new WeakSet<object>(), 0)
}
