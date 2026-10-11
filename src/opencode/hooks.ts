import type { Plugin } from "@opencode/plugin"
import type { RequestKind } from "../metrics/observation.ts"
import type { Recorder } from "./recorder.ts"

/**
 * Hook installation.
 *
 * Observe mode reads and never writes: the callbacks below contain no assignment to
 * event.system, event.messages, event.tools or event.options, and no call that could
 * mutate them. Every callback body is wrapped, because a plugin failure must never fail
 * a legitimate request.
 */

type Context = Plugin.Context

/**
 * Structural subset shared by every payload-bearing hook. SessionContext,
 * SessionCompaction, SessionGenerate and SessionTitle are all assignable to it.
 */
interface PayloadEvent {
  sessionID: string
  model?: { providerID?: string; id?: string; variant?: string }
  agent?: string
  system?: unknown[]
  messages?: unknown[]
  tools?: Record<string, { description: string; input: unknown }>
}

export interface HookReport {
  registered: string[]
  failed: Array<{ hook: string; error: string }>
  dispose: () => Promise<void>
}

const describe = (error: unknown) =>
  error instanceof Error ? error.message : typeof error === "string" ? error : "unknown error"

/** The project id from ctx.location, never a filesystem path. */
export function projectKeyOf(ctx: Context): string {
  const project = ctx.location?.project
  return project?.id ? String(project.id) : "unknown-project"
}

/**
 * Payload-bearing hooks. The hook that fired is the request kind: "context" is the agent
 * loop and the auxiliary hooks carry their own kind, matching the SDK's
 * SessionRequestKind union.
 */
type PayloadHookName = "context" | "compaction" | "generate" | "title"

const PAYLOAD_HOOKS = [
  ["context", "primary"],
  ["compaction", "compaction"],
  ["generate", "generate"],
  ["title", "title"],
] as const satisfies ReadonlyArray<readonly [PayloadHookName, RequestKind]>

export async function installHooks(ctx: Context, recorder: Recorder): Promise<HookReport> {
  const report: HookReport = { registered: [], failed: [], dispose: async () => {} }
  const registrations: Array<{ dispose: () => Promise<void> }> = []

  const handler = (kind: RequestKind) => async (event: PayloadEvent) => {
    try {
      const observation = recorder.observe({
        rawSessionID: String(event.sessionID ?? ""),
        scope: {
          projectKey: projectKeyOf(ctx),
          provider: event.model?.providerID ? String(event.model.providerID) : "unknown",
          model: event.model?.id ? String(event.model.id) : "unknown",
          variant: event.model?.variant ? String(event.model.variant) : undefined,
          agent: event.agent ? String(event.agent) : undefined,
          requestKind: kind,
        },
        requestKind: kind,
        system: Array.isArray(event.system) ? event.system : [],
        messages: Array.isArray(event.messages) ? event.messages : [],
        tools: event.tools,
      })
      if (observation) await recorder.persist(observation)
    } catch {
      // Telemetry is best-effort. Swallow, so the request always goes out.
    }
  }

  for (const [name, kind] of PAYLOAD_HOOKS) {
    try {
      // Each name is passed as its own literal, so the SDK picks that hook's payload
      // type rather than the union across every hook.
      const callback = handler(kind)
      const registration =
        name === "context"
          ? await ctx.session.hook("context", callback as never)
          : name === "compaction"
            ? await ctx.session.hook("compaction", callback as never)
            : name === "generate"
              ? await ctx.session.hook("generate", callback as never)
              : await ctx.session.hook("title", callback as never)
      registrations.push(registration)
      report.registered.push(name)
    } catch (error) {
      report.failed.push({ hook: name, error: describe(error) })
    }
  }

  report.dispose = async () => {
    await Promise.allSettled(registrations.map((registration) => registration.dispose()))
  }
  return report
}

export interface UsageCapture {
  stop: () => void
  samples: number
  error?: string
}

/**
 * Provider usage arrives on the event stream, not through the request hooks. The loop is
 * detached so setup never blocks on it; a stream that ends or errors simply stops.
 */
export function installUsageCapture(ctx: Context, recorder: Recorder): UsageCapture {
  const capture: UsageCapture = { stop: () => {}, samples: 0 }
  let stopped = false

  void (async () => {
    try {
      for await (const event of ctx.event.subscribe()) {
        if (stopped) return
        const sample = recorder.captureUsage(event)
        if (!sample) continue
        capture.samples += 1
        await recorder.persistUsage(sample)
      }
    } catch (error) {
      capture.error = describe(error)
    }
  })()

  capture.stop = () => {
    stopped = true
  }
  return capture
}
