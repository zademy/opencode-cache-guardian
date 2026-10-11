import { describe, expect, test } from "bun:test"

import plugin from "../../src/index.ts"
import { loadObservations, loadUsage } from "../../src/storage/store.ts"
import { fakeContext } from "../fixtures/index.ts"

/**
 * Deliberately fake secrets. Nothing here is a real credential, and the fixtures assert
 * that none of it reaches the store in readable form.
 */
const FAKE = {
  apiKey: "sk-fake-0000000000000000000000000000000000000000",
  bearer: "Bearer fake-token-abcdef0123456789abcdef0123456789",
  password: "hunter2-not-a-real-password",
  sessionCookie: "oc_session=fake-cookie-value-9876543210",
  privatePath: "/Users/someone/Private/secrets/client-keys.pem",
  internalHost: "https://internal.corp.example.com/v1",
  email: "someone@private-corp.example.com",
  connString: "postgres://admin:s3cr3t@db.internal:5432/prod",
} as const

const SECRET_STRINGS = Object.values(FAKE).map((value) => value.split("/").pop() ?? value)

const hostContext = () =>
  fakeContext({
    location: { directory: FAKE.privatePath, project: { id: "proj_private" } },
  })

const event = () => ({
  sessionID: "ses_private_abcdef0123456789",
  agent: "build",
  model: { providerID: "anthropic", modelID: "claude-sonnet-4" },
  system: [
    { type: "text", text: "You are helpful." },
    { type: "text", text: FAKE.apiKey },
    { type: "text", text: FAKE.bearer },
    { type: "text", text: FAKE.password },
    { type: "text", text: FAKE.connString },
  ],
  messages: [
    { role: "user", parts: [{ type: "text", text: `here is my key ${FAKE.apiKey}` }] },
    {
      role: "assistant",
      parts: [
        { type: "tool-call", tool: "read", callID: "c1", state: { status: "done" } },
        {
          type: "tool-result",
          tool: "read",
          callID: "c1",
          output: { status: "completed", content: `${FAKE.privatePath}\n${FAKE.sessionCookie}` },
        },
      ],
    },
    {
      role: "user",
      parts: [
        {
          type: "media",
          media: {
            source: { type: "base64", data: "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU2" },
            mediaType: "image/png",
          },
        },
      ],
    },
  ],
  tools: {
    fetch: { description: `Call ${FAKE.internalHost}`, input: { type: "object" } },
    mail: { description: `Email ${FAKE.email}`, input: { type: "object" } },
  },
  options: { apiKey: FAKE.apiKey, headers: { Authorization: FAKE.bearer } },
})

const dumpStore = async (host: ReturnType<typeof fakeContext>) => {
  const entries: unknown[] = [...host.storage.entries.values()]
  const observations = await loadObservations(host.storage)
  const usage = await loadUsage(host.storage)
  return JSON.stringify({ entries, observations, usage })
}

describe("nothing readable reaches the store", () => {
  test("no secret, path or host appears in any stored record", async () => {
    const host = hostContext()
    const dispose = await plugin.setup(host.ctx)
    await host.trigger("context", event())
    const stored = await dumpStore(host)
    for (const secret of SECRET_STRINGS) {
      expect(stored).not.toContain(secret)
    }
    await (dispose as () => Promise<void>)()
  })

  test("no digest is short enough to be a usable prefix of the secret", async () => {
    const host = hostContext()
    const dispose = await plugin.setup(host.ctx)
    await host.trigger("context", event())
    for (const [key, value] of host.storage.entries) {
      const serialized = JSON.stringify(value)
      for (const secret of SECRET_STRINGS) {
        expect(serialized.includes(secret.slice(0, 12))).toBe(false)
      }
      expect(key).not.toContain(FAKE.privatePath)
    }
    await (dispose as () => Promise<void>)()
  })

  test("the raw session id never reaches the store", async () => {
    const host = hostContext()
    const dispose = await plugin.setup(host.ctx)
    await host.trigger("context", event())
    expect(await dumpStore(host)).not.toContain("ses_private_abcdef0123456789")
    await (dispose as () => Promise<void>)()
  })

  test("media payloads are reduced to a descriptor, never copied", async () => {
    const host = hostContext()
    const dispose = await plugin.setup(host.ctx)
    await host.trigger("context", event())
    const stored = await dumpStore(host)
    expect(stored).not.toContain("QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU2")
    await (dispose as () => Promise<void>)()
  })

  test("the report output carries no secret either", async () => {
    const host = hostContext()
    const dispose = await plugin.setup(host.ctx)
    await host.trigger("context", event())
    const report = host.commands.get("cache_guardian_report")
    expect(report).toBeDefined()
    const printed: string[] = []
    const original = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((chunk: string) => {
      printed.push(String(chunk))
      return true
    }) as typeof process.stdout.write
    try {
      await report?.execute({})
    } finally {
      process.stdout.write = original
    }
    const output = printed.join("")
    expect(output.length).toBeGreaterThan(0)
    for (const secret of SECRET_STRINGS) expect(output).not.toContain(secret)
    expect(output).not.toContain(FAKE.privatePath)
    await (dispose as () => Promise<void>)()
  })
})

describe("secrets still change the fingerprint", () => {
  test("rotating a key changes the system digest without storing the key", async () => {
    const host = hostContext()
    const dispose = await plugin.setup(host.ctx)
    await host.trigger("context", event())
    const _before = await loadObservations(host.storage)
    await host.trigger("context", {
      ...event(),
      system: [
        { type: "text", text: "You are helpful." },
        { type: "text", text: "sk-fake-1111111111111111111111111111111111111111" },
        { type: "text", text: FAKE.bearer },
        { type: "text", text: FAKE.password },
        { type: "text", text: FAKE.connString },
      ],
    })
    const after = await loadObservations(host.storage)
    expect(after).toHaveLength(2)
    expect(after[0]?.aggregate).not.toBe(after[1]?.aggregate)
    expect(after[1]?.firstDivergenceGroup).toBe("system")
    await (dispose as () => Promise<void>)()
  })
})

describe("the host's own location is used as an opaque id", () => {
  test("the project directory is not stored, only the project id", async () => {
    const host = fakeContext()
    Object.assign(host.ctx, {
      location: {
        directory: FAKE.privatePath,
        project: { id: "proj_opaque_1", directory: FAKE.privatePath, canonical: FAKE.privatePath },
      },
    })
    const dispose = await plugin.setup(host.ctx)
    await host.trigger("context", event())
    const observations = await loadObservations(host.storage)
    expect(observations[0]?.projectKey).toBe("proj_opaque_1")
    expect(await dumpStore(host)).not.toContain(FAKE.privatePath)
    await (dispose as () => Promise<void>)()
  })
})

describe("tool definitions are fingerprinted, not copied", () => {
  test("a tool description containing a URL leaves only a digest", async () => {
    const host = hostContext()
    const dispose = await plugin.setup(host.ctx)
    await host.trigger("context", event())
    const stored = await dumpStore(host)
    expect(stored).not.toContain(FAKE.internalHost)
    expect(stored).not.toContain(FAKE.email)
    await (dispose as () => Promise<void>)()
  })

  test("the tool set is still compared correctly", async () => {
    const host = hostContext()
    const dispose = await plugin.setup(host.ctx)
    const first = event()
    await host.trigger("context", first)
    const repeated = event()
    await host.trigger("context", repeated)
    await host.trigger("context", { ...repeated })
    const observations = await loadObservations(host.storage)
    expect(observations[1]?.firstDivergence).toBe(-1)
    await (dispose as () => Promise<void>)()
  })
})
