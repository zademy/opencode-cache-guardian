import type { Plugin } from "@opencode/plugin"

type CommandDefinition = {
  readonly name: string
  readonly description?: string
  readonly execute: (input: unknown) => Promise<void>
}

import type { StorageLike } from "../../src/storage/store.ts"

type StorageValue = Parameters<StorageLike["set"]>[1]

/** In-memory StorageDomain. Records removals so prune and reset can be asserted on. */
export class FakeStorage implements StorageLike {
  readonly entries = new Map<string, unknown>()
  removed: string[] = []
  failOnSet = false
  failOnScan = false

  async get(key: string) {
    return this.entries.get(key) as StorageValue
  }

  async set(key: string, value: StorageValue) {
    if (this.failOnSet) throw new Error("disk full")
    this.entries.set(key, value)
  }

  async remove(key: string) {
    this.removed.push(key)
    this.entries.delete(key)
  }

  async scan(options: { prefix: string; after?: string; limit?: number }) {
    if (this.failOnScan) throw new Error("scan unavailable")
    const keys = [...this.entries.keys()]
      .filter((key) => key.startsWith(options.prefix) && (!options.after || key > options.after))
      .sort()
    const limit = options.limit ?? keys.length
    const page = keys.slice(0, limit)
    return {
      entries: page.map((key) => ({ key, value: this.entries.get(key) as never })),
      next: keys.length > page.length ? page[page.length - 1] : undefined,
    }
  }
}

export const SYSTEM_PROMPT = "You are a careful assistant. Answer in Spanish."

export const toolDefs = (): Record<string, { description: string; input: unknown }> => ({
  read: {
    description: "Read a file",
    input: { type: "object", properties: { path: { type: "string" } } },
  },
  bash: {
    description: "Run a shell command",
    input: { type: "object", properties: { cmd: { type: "string" } } },
  },
})

/** Deliberately loose: the fingerprint layer must tolerate any part shape the host sends. */
export const part = (fields: Record<string, unknown>) => ({ type: "text", text: "", ...fields })
export const message = (role: string, ...parts: unknown[]) => ({ role, parts })

export const userMessage = (text: string) => message("user", part({ text }))
export const assistantMessage = (text: string) => message("assistant", part({ text }))

export const requestFixture = () => ({
  system: [{ type: "text", text: SYSTEM_PROMPT }],
  messages: [userMessage("hola"), assistantMessage("buenas")],
  tools: toolDefs(),
})

/** Structured snapshot used for before/after deep-equality assertions. */
export const snapshot = <T>(value: T): string => JSON.stringify(value)

export interface FakeHook {
  name: string
  callback: (event: unknown) => Promise<void> | void
}

/**
 * A structural stand-in for Plugin.Context holding only the members the plugin touches.
 * Every callback it captures is replayable, so tests can assert on what a real host
 * would have passed in.
 */
export const fakeContext = (options: Record<string, unknown> = {}, storage = new FakeStorage()) => {
  const hooks: FakeHook[] = []
  const disposed: string[] = []
  const commands = new Map<string, CommandDefinition>()
  const events: unknown[] = []
  const ctx = {
    app: { name: "opencode", version: "2.0.26", channel: "stable" },
    options,
    location: {
      directory: "/private/tmp/demo",
      project: {
        id: "proj_1",
        directory: "/private/tmp/demo",
        canonical: "/private/tmp/demo",
      },
    },
    storage,
    session: {
      hook: async (name: string, callback: (event: unknown) => Promise<void> | void) => {
        hooks.push({ name, callback })
        return {
          dispose: async () => {
            disposed.push(name)
            const at = hooks.findIndex((entry) => entry.name === name)
            if (at >= 0) hooks.splice(at, 1)
          },
        }
      },
    },
    event: {
      subscribe: async function* () {
        for (const event of events) yield event
      },
    },
    command: {
      transform: async (callback: (editor: { add: (def: CommandDefinition) => void }) => void) => {
        callback({
          add: (definition: CommandDefinition) => commands.set(definition.name, definition),
        })
        return { dispose: async () => commands.clear() }
      },
      reload: async () => {},
    },
  }
  const trigger = async (name: string, event: unknown) => {
    for (const hook of hooks.filter((entry) => entry.name === name)) {
      await hook.callback(event)
    }
  }
  return {
    ctx: ctx as unknown as Plugin.Context,
    storage,
    hooks,
    disposed,
    commands,
    trigger,
    pushEvent: (event: unknown) => {
      events.push(event)
    },
  }
}
