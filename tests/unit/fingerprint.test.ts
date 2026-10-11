import { describe, expect, test } from "bun:test"
import type { BuildOptions } from "../../src/fingerprint/blocks.ts"
import { buildBlocks, estimateTokens } from "../../src/fingerprint/blocks.ts"
import { canonicalize } from "../../src/fingerprint/canonicalize.ts"
import { fingerprint, generateHashKey, shortDigest } from "../../src/fingerprint/hash.ts"
import { compareBlocks, scopeKey } from "../../src/fingerprint/prefix.ts"

const options: BuildOptions = {
  maxChars: 2_000_000,
  maxProcessingMs: 40,
  now: () => 0,
}

const digestOf = (value: unknown, key?: Uint8Array) => fingerprint(canonicalize(value) ?? "", key)

describe("canonicalize", () => {
  test("key order in a JSON object does not change the hash", () => {
    expect(digestOf({ a: 1, b: { c: 2, d: 3 } })).toBe(digestOf({ b: { d: 3, c: 2 }, a: 1 }))
  })

  test("array order does change the hash", () => {
    expect(digestOf([1, 2, 3])).not.toBe(digestOf([3, 2, 1]))
  })

  test("circular references do not recurse forever", () => {
    const node: Record<string, unknown> = { name: "root" }
    node.self = node
    expect(() => canonicalize(node)).not.toThrow()
    expect(canonicalize(node)).toContain("[circular]")
  })

  test("binary payloads collapse to a length descriptor", () => {
    const bytes = new Uint8Array(4096).fill(7)
    expect(canonicalize(bytes)).toBe('{"$binary":{"length":4096}}')
  })

  test("depth limit stops runaway nesting", () => {
    let deep: Record<string, unknown> = {}
    const root = deep
    for (let i = 0; i < 200; i++) {
      deep.next = {}
      deep = deep.next as Record<string, unknown>
    }
    expect(canonicalize(root)).toContain("[depth-limit]")
  })
})

describe("hashing", () => {
  test("the same text hashes the same and one changed character does not", () => {
    expect(fingerprint("hola")).toBe(fingerprint("hola"))
    expect(fingerprint("hola")).not.toBe(fingerprint("holb"))
  })

  test("an HMAC key changes the digest, so identical text is not linkable across keys", () => {
    const text = "system prompt"
    expect(fingerprint(text, generateHashKey())).not.toBe(fingerprint(text, generateHashKey()))
    expect(fingerprint(text)).not.toBe(fingerprint(text, generateHashKey()))
  })

  test("shortDigest truncates for logs", () => {
    expect(shortDigest(fingerprint("x"))).toHaveLength(8)
  })
})

describe("buildBlocks", () => {
  const build = (
    request: ReturnType<typeof import("../../tests/fixtures/index.ts").requestFixture>,
  ) => buildBlocks(request, options)

  test("emits system, then tools, then messages, one block per part", () => {
    const result = build({
      system: [{ type: "text", text: "sys" }],
      messages: [
        {
          role: "user",
          parts: [
            { type: "text", text: "a" },
            { type: "text", text: "b" },
          ],
        },
      ],
      tools: { bash: { description: "d", input: {} }, read: { description: "d", input: {} } },
    })
    expect(result.blocks.map((block) => block.group)).toEqual([
      "system",
      "tools",
      "tools",
      "messages",
      "messages",
    ])
    // Tools are sorted by name, so the set is compared, not object insertion order.
    expect(result.blocks.filter((b) => b.group === "tools")[0]?.digest).toBe(
      build({
        system: [{ type: "text", text: "sys" }],
        messages: [
          {
            role: "user",
            parts: [
              { type: "text", text: "a" },
              { type: "text", text: "b" },
            ],
          },
        ],
        tools: { read: { description: "d", input: {} }, bash: { description: "d", input: {} } },
      }).blocks.filter((b) => b.group === "tools")[0]?.digest,
    )
  })

  test("a changed tool schema changes the digest", () => {
    const base = build({
      system: [],
      messages: [],
      tools: { bash: { description: "d", input: { type: "object" } } },
    })
    const changed = build({
      system: [],
      messages: [],
      tools: { bash: { description: "d", input: { type: "object", required: ["cmd"] } } },
    })
    expect(base.aggregate).not.toBe(changed.aggregate)
  })

  test("tool names are part of the identity", () => {
    const a = build({ system: [], messages: [], tools: { bash: { description: "d", input: {} } } })
    const b = build({ system: [], messages: [], tools: { read: { description: "d", input: {} } } })
    expect(a.aggregate).not.toBe(b.aggregate)
  })

  test("a changed role changes the digest even when the text is identical", () => {
    const user = build({
      system: [],
      messages: [{ role: "user", parts: [{ type: "text", text: "x" }] }],
      tools: {},
    })
    const tool = build({
      system: [],
      messages: [{ role: "tool", parts: [{ type: "text", text: "x" }] }],
      tools: {},
    })
    expect(user.aggregate).not.toBe(tool.aggregate)
  })

  test("a changed tool-call name changes the digest", () => {
    const read = build({
      system: [],
      messages: [
        { role: "assistant", parts: [{ type: "tool-call", tool: "read", input: { path: "a" } }] },
      ],
      tools: {},
    })
    const bash = build({
      system: [],
      messages: [
        { role: "assistant", parts: [{ type: "tool-call", tool: "bash", input: { path: "a" } }] },
      ],
      tools: {},
    })
    expect(read.aggregate).not.toBe(bash.aggregate)
  })

  test("unicode, accents, emoji and CRLF each change the digest", () => {
    const base = build({
      system: [],
      messages: [{ role: "user", parts: [{ type: "text", text: "hola" }] }],
      tools: {},
    })
    for (const text of ["hola\u0301", "hol\u{1F600}", "hola\r\n"]) {
      const other = build({
        system: [],
        messages: [{ role: "user", parts: [{ type: "text", text }] }],
        tools: {},
      })
      expect(other.aggregate).not.toBe(base.aggregate)
    }
  })

  test("empty text is a real value, distinct from a missing part", () => {
    const empty = build({
      system: [],
      messages: [{ role: "user", parts: [{ type: "text", text: "" }] }],
      tools: {},
    })
    const missing = build({ system: [], messages: [{ role: "user", parts: [{}] }], tools: {} })
    expect(empty.aggregate).not.toBe(missing.aggregate)
  })

  test("inline media is reduced to type and length, never to bytes", () => {
    const image = build({
      system: [],
      messages: [
        {
          role: "user",
          parts: [
            {
              type: "media",
              media: { type: "base64", mediaType: "image/png", data: "AAAABBBB".repeat(500) },
            },
          ],
        },
      ],
      tools: {},
    })
    expect(image.skipped).toBeUndefined()
    expect(image.totalChars).toBeLessThan(100)
  })

  test("unknown part types are hashed, not dropped", () => {
    const unknown = build({
      system: [],
      messages: [{ role: "assistant", parts: [{ type: "effort", value: 3 }] }],
      tools: {},
    })
    expect(unknown.blocks).toHaveLength(1)
  })

  test("a request larger than the byte budget is skipped, not truncated", () => {
    const huge = buildBlocks(
      { system: [{ type: "text", text: "x".repeat(50_000) }], messages: [], tools: {} },
      { ...options, maxChars: 1000 },
    )
    expect(huge.skipped).toBe("oversized_payload")
    expect(huge.blocks).toHaveLength(0)
  })

  test("exceeding the processing budget is skipped and the request still completes", () => {
    let clock = 0
    const result = buildBlocks(
      { system: [{ type: "text", text: "a" }], messages: [], tools: {} },
      {
        ...options,
        maxProcessingMs: 5,
        now: () => {
          clock += 10
          return clock
        },
      },
    )
    expect(result.skipped).toBe("processing_budget_exceeded")
  })

  test("estimateTokens is an explicitly coarse heuristic", () => {
    expect(estimateTokens(0)).toBe(0)
    expect(estimateTokens(400)).toBe(100)
  })
})

describe("compareBlocks", () => {
  const blocks = (digests: string[], group: "system" | "tools" | "messages" = "messages") =>
    digests.map((digest, index) => ({
      group,
      digest,
      short: digest.slice(0, 8),
      chars: 100,
      index,
    }))

  test("no divergence when identical", () => {
    const result = compareBlocks(blocks(["a", "b", "c"]), blocks(["a", "b", "c"]))
    expect(result.stablePrefixBlocks).toBe(3)
    expect(result.firstDivergence).toBe(-1)
    expect(result.identical).toBe(true)
  })

  test("divergence at the very start", () => {
    const result = compareBlocks(blocks(["a"]), blocks(["z"]))
    expect(result.stablePrefixBlocks).toBe(0)
    expect(result.firstDivergence).toBe(0)
    expect(result.stablePrefixRatio).toBe(0)
  })

  test("divergence in the middle", () => {
    const result = compareBlocks(blocks(["a", "b", "c", "d"]), blocks(["a", "b", "z", "d"]))
    expect(result.stablePrefixBlocks).toBe(2)
    expect(result.firstDivergence).toBe(2)
    expect(result.stablePrefixRatio).toBe(0.5)
  })

  test("divergence at the end", () => {
    const result = compareBlocks(blocks(["a", "b", "c"]), blocks(["a", "b", "z"]))
    expect(result.stablePrefixBlocks).toBe(2)
    expect(result.firstDivergence).toBe(2)
  })

  test("a growing request diverges past its old length", () => {
    const result = compareBlocks(blocks(["a", "b"]), blocks(["a", "b", "c"]))
    expect(result.stablePrefixBlocks).toBe(2)
    expect(result.firstDivergence).toBe(2)
  })

  test("a block is not stable across groups, even with an identical digest", () => {
    const previous = [{ group: "messages" as const, digest: "a", short: "a", chars: 10 }]
    const current = [{ group: "system" as const, digest: "a", short: "a", chars: 10 }]
    const result = compareBlocks(previous, current)
    expect(result.stablePrefixBlocks).toBe(0)
    expect(result.firstDivergenceGroup).toBe("system")
  })

  test("a zero-block request yields undefined ratio, never NaN", () => {
    const result = compareBlocks([], [])
    expect(result.stablePrefixRatio).toBeUndefined()
    expect(result.stablePrefixBlocks).toBe(0)
    expect(result.totalTokens).toBe(0)
  })

  test("a single observation with no predecessor is handled by the recorder, not here", () => {
    expect(compareBlocks([], blocks(["a"])).stablePrefixRatio).toBe(0)
  })
})

describe("scopeKey", () => {
  test("different provider, model, variant, agent or kind produce different scopes", () => {
    const base = { projectKey: "p", provider: "anthropic", model: "claude", requestKind: "primary" }
    const keys = new Set([
      scopeKey(base),
      scopeKey({ ...base, provider: "openai" }),
      scopeKey({ ...base, model: "gpt" }),
      scopeKey({ ...base, variant: "thinking" }),
      scopeKey({ ...base, agent: "plan" }),
      scopeKey({ ...base, requestKind: "compaction" }),
    ])
    expect(keys.size).toBe(6)
  })
})
