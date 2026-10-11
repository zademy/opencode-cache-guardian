import { canonicalize } from "./canonicalize.ts"
import { combine, fingerprint, type HashKey, shortDigest } from "./hash.ts"

/**
 * Turns a request into an ordered list of fingerprinted blocks.
 *
 * Block order mirrors how OpenCode assembles a request: system, then tool definitions,
 * then messages. That is an assumption about assembly order, not a claim about provider
 * serialization — see docs/v2-compatibility.md.
 */

export type BlockGroup = "system" | "tools" | "messages"

export interface Block {
  group: BlockGroup
  /** Full-length one-way digest. Never logged, never rendered. */
  digest: string
  /** Truncated digest for human-facing reports only. */
  short: string
  chars: number
}

export type SkipReason =
  | "oversized_payload"
  | "processing_budget_exceeded"
  | "unserializable_request"

export interface BuildResult {
  blocks: Block[]
  /** Digest over the whole ordered block list: the aggregate prefix fingerprint. */
  aggregate: string
  totalChars: number
  skipped?: SkipReason
}

/** Structural subset of the V2 hook event. Keeps this module SDK-free and unit-testable. */
export interface RequestShape {
  system: readonly unknown[]
  messages: readonly unknown[]
  tools: Record<string, { description: string; input: unknown }> | undefined
}

export interface BuildOptions {
  key?: HashKey
  maxChars: number
  /** Injected clock so the budget is testable without real timing. */
  now: () => number
  maxProcessingMs: number
}

const CHARS_PER_TOKEN = 4

/**
 * Rough heuristic, NOT a tokenizer. No provider tokenizer ships with the V2 SDK, so every
 * number derived from this is labelled local-estimate in reports. Length is a character
 * count and is never presented as an exact token count.
 */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN)
}

/**
 * Reduce a part to a hashable descriptor.
 *
 * Inline media is reduced to media type and byte length: the payload is never copied,
 * never serialized into a digest input, and never stored. Structured content keeps role,
 * part type and tool name, so swapping two different tools or two different roles always
 * changes the digest.
 */
function describePart(part: unknown): { canonical: string; chars: number } | undefined {
  if (part === null || typeof part !== "object") return undefined

  const record = part as Record<string, unknown>
  const type = typeof record.type === "string" ? record.type : "unknown"

  if (type === "media") {
    const media = record.media as Record<string, unknown> | undefined
    const asset = (media?.asset ?? media) as Record<string, unknown> | undefined
    const sourceType = typeof asset?.type === "string" ? asset.type : "unknown"
    const mediaType = typeof asset?.mediaType === "string" ? asset.mediaType : "unknown"
    // Deliberately no bytes: an inline image must never enter a digest input.
    return { canonical: `media:${sourceType}:${mediaType}`, chars: 0 }
  }

  if (type === "tool-call" || type === "tool-result") {
    // Tool name is part of the identity; arguments and output are hashed, not kept.
    const name = typeof record.tool === "string" ? record.tool : String(record.tool ?? "")
    const canonical = canonicalize({ type, name, input: record.input, output: record.output })
    if (canonical === undefined) return undefined
    return { canonical: `${type}:${name}:${canonical}`, chars: canonical.length }
  }

  const canonical = canonicalize(record)
  if (canonical === undefined) return undefined
  return { canonical, chars: canonical.length }
}

function messageToBlocks(message: unknown): { canonical: string; chars: number }[] {
  const record = (message ?? {}) as Record<string, unknown>
  const role = typeof record.role === "string" ? record.role : "unknown"
  const parts = Array.isArray(record.parts) ? record.parts : []

  return parts.map((part) => {
    const described = describePart(part)
    return {
      canonical: `${role}\u0000${described?.canonical ?? "[unserializable]"}`,
      chars: (described?.chars ?? 0) + role.length,
    }
  })
}

/**
 * One block per system part, per tool definition, and per message part.
 *
 * A message with several parts becomes several blocks, because a provider's cache
 * boundary falls between serialized chunks — not necessarily at message boundaries — and
 * a coarser block would overstate how much stayed stable.
 */
export function buildBlocks(request: RequestShape, options: BuildOptions): BuildResult {
  const started = options.now()
  const blocks: Block[] = []
  let totalChars = 0

  const skip = (reason: SkipReason): BuildResult => ({
    blocks: [],
    aggregate: "",
    totalChars,
    skipped: reason,
  })

  const push = (group: BlockGroup, canonical: string, chars: number): SkipReason | undefined => {
    totalChars += chars
    if (totalChars > options.maxChars) return "oversized_payload"
    if (options.now() - started > options.maxProcessingMs) return "processing_budget_exceeded"
    const digest = fingerprint(canonical, options.key)
    blocks.push({ group, digest, short: shortDigest(digest), chars })
    return undefined
  }

  try {
    for (const part of Array.isArray(request.system) ? request.system : []) {
      const described = describePart(part)
      if (!described) return skip("unserializable_request")
      const reason = push("system", described.canonical, described.chars)
      if (reason) return skip(reason)
    }

    // Sorted by name: tool-set membership is what matters, not key insertion order.
    for (const name of Object.keys(request.tools ?? {}).sort()) {
      const schema = canonicalize(request.tools?.[name])
      if (schema === undefined) return skip("unserializable_request")
      const reason = push("tools", `${name}\u0000${schema}`, schema.length)
      if (reason) return skip(reason)
    }

    for (const message of Array.isArray(request.messages) ? request.messages : []) {
      for (const block of messageToBlocks(message)) {
        const reason = push("messages", block.canonical, block.chars)
        if (reason) return skip(reason)
      }
    }
  } catch {
    return skip("unserializable_request")
  }

  return {
    blocks,
    aggregate: combine(blocks.map((block) => block.digest)),
    totalChars,
  }
}
