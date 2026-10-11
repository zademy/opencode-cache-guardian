import { describe, expect, test } from "bun:test"

import plugin from "../../src/index.ts"
import { loadObservations } from "../../src/storage/store.ts"
import { FakeStorage, fakeContext, requestFixture, snapshot } from "../fixtures/index.ts"

const NAMES = ["context", "compaction", "generate", "title"]

const payload = (overrides: Record<string, unknown> = {}) => {
  const fixture = requestFixture()
  return {
    sessionID: "ses_abc123",
    agent: "build",
    model: { providerID: "anthropic", modelID: "claude-sonnet-4" },
    system: fixture.system,
    messages: fixture.messages,
    tools: fixture.tools,
    options: { temperature: 0 },
    ...overrides,
  }
}

describe("plugin registration", () => {
  test("exports a V2 plugin: an id plus setup, not a V1 tools/hooks object", () => {
    expect(plugin.id).toBe("cache-guardian")
    expect(typeof plugin.setup).toBe("function")
    expect(plugin).not.toHaveProperty("tools")
    expect(plugin).not.toHaveProperty("hooks")
  })

  test("registers one hook per request kind and no others", async () => {
    const host = fakeContext()
    const dispose = await plugin.setup(host.ctx)
    expect(host.hooks.map((hook) => hook.name).sort()).toEqual([...NAMES].sort())
    await (dispose as () => Promise<void>)()
  })

  test("registers the three documented commands", async () => {
    const host = fakeContext()
    const dispose = await plugin.setup(host.ctx)
    expect([...host.commands.keys()].sort()).toEqual([
      "cache_guardian_doctor",
      "cache_guardian_report",
      "cache_guardian_reset",
    ])
    await (dispose as () => Promise<void>)()
  })

  test("cleanup disposes every hook and every command registration", async () => {
    const host = fakeContext()
    const dispose = await plugin.setup(host.ctx)
    await (dispose as () => Promise<void>)()
    expect(host.disposed.sort()).toEqual([...NAMES].sort())
    expect(host.hooks).toHaveLength(0)
    expect(host.commands.size).toBe(0)
  })
})

describe("observe mode never mutates the request", () => {
  test("the context event is deep-equal before and after the hook runs", async () => {
    const host = fakeContext()
    const dispose = await plugin.setup(host.ctx)
    const event = payload()
    const before = snapshot(event)
    await host.trigger("context", event)
    expect(snapshot(event)).toBe(before)
    await (dispose as () => Promise<void>)()
  })

  test("every request kind leaves the event untouched", async () => {
    const host = fakeContext()
    const dispose = await plugin.setup(host.ctx)
    for (const name of NAMES) {
      const event = payload()
      const before = snapshot(event)
      await host.trigger(name, event)
      expect(snapshot(event)).toBe(before)
    }
    await (dispose as () => Promise<void>)()
  })

  test("a whole conversation leaves the accumulated event untouched", async () => {
    const host = fakeContext()
    const dispose = await plugin.setup(host.ctx)
    const events = [
      payload({ messages: [{ role: "user", parts: [{ type: "text", text: "one" }] }] }),
      payload({
        messages: [
          { role: "user", parts: [{ type: "text", text: "one" }] },
          { role: "assistant", parts: [{ type: "text", text: "two" }] },
        ],
      }),
      payload({
        messages: [
          { role: "user", parts: [{ type: "text", text: "one" }] },
          { role: "assistant", parts: [{ type: "text", text: "two" }] },
          { role: "user", parts: [{ type: "text", text: "three" }] },
        ],
      }),
    ]
    const before = events.map((event) => snapshot(event))
    for (const event of events) await host.trigger("context", event)
    expect(events.map((event) => snapshot(event))).toEqual(before)
    await (dispose as () => Promise<void>)()
  })

  test("a disabled plugin registers no hooks at all", async () => {
    const host = fakeContext({ enabled: false })
    const dispose = await plugin.setup(host.ctx)
    expect(host.hooks).toHaveLength(0)
    expect(dispose).toBeUndefined()
  })
})

describe("observations", () => {
  test("a single request is recorded but is not a comparable pair", async () => {
    const host = fakeContext()
    const dispose = await plugin.setup(host.ctx)
    await host.trigger("context", payload())
    const stored = await loadObservations(host.storage)
    expect(stored).toHaveLength(1)
    expect(stored[0]?.firstDivergence).toBeUndefined()
    expect(stored[0]?.requestKind).toBe("primary")
    expect(stored[0]?.source).toBe("local-estimate")
    await (dispose as () => Promise<void>)()
  })

  test("the second identical request is a comparable pair with a full stable prefix", async () => {
    const host = fakeContext()
    const dispose = await plugin.setup(host.ctx)
    await host.trigger("context", payload())
    await host.trigger("context", payload())
    const stored = await loadObservations(host.storage)
    expect(stored).toHaveLength(2)
    expect(stored[1]?.firstDivergence).toBe(-1)
    expect(stored[1]?.stablePrefixRatio).toBe(1)
    await (dispose as () => Promise<void>)()
  })

  test("each request kind is labelled with its own kind, never guessed", async () => {
    const host = fakeContext()
    const dispose = await plugin.setup(host.ctx)
    for (const name of NAMES) await host.trigger(name, payload())
    const stored = await loadObservations(host.storage)
    expect(stored.map((entry) => entry.requestKind).sort()).toEqual([
      "compaction",
      "generate",
      "primary",
      "title",
    ])
    await (dispose as () => Promise<void>)()
  })

  test("different sessions never get compared against each other", async () => {
    const host = fakeContext()
    const dispose = await plugin.setup(host.ctx)
    await host.trigger("context", payload({ sessionID: "ses_a" }))
    await host.trigger("context", payload({ sessionID: "ses_b" }))
    const stored = await loadObservations(host.storage)
    expect(stored).toHaveLength(2)
    expect(stored.every((entry) => entry.firstDivergence === undefined)).toBe(true)
    expect(stored[0]?.sessionKey).not.toBe(stored[1]?.sessionKey)
    await (dispose as () => Promise<void>)()
  })

  test("the raw session id is never persisted", async () => {
    const host = fakeContext()
    const dispose = await plugin.setup(host.ctx)
    await host.trigger("context", payload({ sessionID: "ses_supersecret" }))
    expect(JSON.stringify([...host.storage.entries.values()])).not.toContain("ses_supersecret")
    await (dispose as () => Promise<void>)()
  })

  test("the metrics flag suppresses persistence but not the hook", async () => {
    const host = fakeContext({ metrics: { enabled: false } })
    const dispose = await plugin.setup(host.ctx)
    await host.trigger("context", payload())
    expect(await loadObservations(host.storage)).toHaveLength(0)
    expect(host.hooks).toHaveLength(4)
    await (dispose as () => Promise<void>)()
  })
})

describe("a broken plugin must never break a request", () => {
  test("a hook that throws is swallowed and the event still comes through", async () => {
    const storage = new FakeStorage()
    storage.failOnSet = true
    const host = fakeContext({}, storage)
    const dispose = await plugin.setup(host.ctx)
    const event = payload()
    const before = snapshot(event)
    expect(() => host.trigger("context", event)).not.toThrow()
    expect(snapshot(event)).toBe(before)
    await (dispose as () => Promise<void>)()
  })

  test("a malformed event does not throw", async () => {
    const host = fakeContext()
    const dispose = await plugin.setup(host.ctx)
    for (const junk of [undefined, null, 42, "string", {}, { system: "not-an-array" }]) {
      expect(() => host.trigger("context", junk)).not.toThrow()
    }
    await (dispose as () => Promise<void>)()
  })

  test("a circular payload is recorded as unserializable rather than crashing", async () => {
    const host = fakeContext()
    const dispose = await plugin.setup(host.ctx)
    const circular: Record<string, unknown> = { type: "text", text: "hi" }
    circular.self = circular
    expect(() =>
      host.trigger("context", payload({ messages: [{ role: "user", parts: [circular] }] })),
    ).not.toThrow()
    await (dispose as () => Promise<void>)()
  })

  test("an event-stream failure is captured, not thrown", async () => {
    const host = fakeContext()
    host.ctx.event.subscribe = () =>
      ({
        [Symbol.asyncIterator]: () => ({
          next: () => Promise.reject(new Error("stream exploded")),
        }),
      }) as never
    const dispose = await plugin.setup(host.ctx)
    await host.commands.get("cache_guardian_doctor")?.execute({})
    await (dispose as () => Promise<void>)()
  })
})
