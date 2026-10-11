import type { Plugin } from "@opencode/plugin"
import type { CacheGuardianOptions } from "../config/schema.ts"
import { loadUsage, reset as resetStore } from "../storage/store.ts"
import type { HookReport, UsageCapture } from "./hooks.ts"
import type { Recorder } from "./recorder.ts"
import { renderDoctor, renderReport } from "./reporting.ts"

/** The shape ctx.command.transform returns. Declared locally so a package rename cannot break us. */
interface Registration {
  dispose: () => Promise<void>
}

/** Stand-in for a host that cannot register commands. */
const NO_REGISTRATION: Registration = { dispose: async () => {} }

type Context = Plugin.Context

/**
 * Commands registered through ctx.command.transform, the documented V2 mechanism.
 *
 * CommandDefinition.execute returns Promise<void> in V2 — there is no return channel for
 * text. Output therefore goes to stdout, which the host surfaces in its log. See
 * docs/v2-compatibility.md.
 */

export const REPORT_COMMAND = "cache_guardian_report"
export const DOCTOR_COMMAND = "cache_guardian_doctor"
export const RESET_COMMAND = "cache_guardian_reset"

/** Reset destroys telemetry, so it requires an explicit typed confirmation. */
export const RESET_CONFIRMATION = "--confirm"

export interface CommandContext {
  app: { name: string; version: string }
  hooks: HookReport
  usage: UsageCapture
}

const emit = (text: string) => {
  process.stdout.write(`${text}\n`)
}

export async function installCommands(
  ctx: Context,
  recorder: Recorder,
  options: CacheGuardianOptions,
  state: CommandContext,
): Promise<Registration> {
  try {
    return await ctx.command.transform((editor) => {
      editor.add({
        name: REPORT_COMMAND,
        description: "Cache Guardian: local prefix stability and provider cache usage",
        execute: async () => {
          const [observations, usage] = await Promise.all([
            recorder.observations(),
            loadUsage(ctx.storage),
          ])
          emit(
            renderReport({
              mode: options.mode,
              appVersion: state.app.version,
              observations,
              usage,
            }),
          )
        },
      })

      editor.add({
        name: DOCTOR_COMMAND,
        description: "Cache Guardian: SDK version, hooks, options and metric sources",
        execute: async () => {
          const usageSamples = await loadUsage(ctx.storage)
          emit(
            renderDoctor({
              appName: state.app.name,
              appVersion: state.app.version,
              mode: options.mode,
              optionsSummary: [
                `enabled=${options.enabled}`,
                `hashing=${options.privacy.hashing} (key rotates each OpenCode start)`,
                `storeContent=${options.privacy.storeContent} (not configurable)`,
                `metrics.enabled=${options.metrics.enabled}`,
                `metrics.retentionDays=${options.metrics.retentionDays}`,
                `metrics.maxObservations=${options.metrics.maxObservations}`,
                `limits.maxProcessingMs=${options.limits.maxProcessingMs} (soft budget)`,
                `limits.maxRequestBytes=${options.limits.maxRequestBytes}`,
                `report.includeProviderUsage=${options.report.includeProviderUsage}`,
                `safe.dryRun=${options.safe.dryRun}`,
                `safe.allowMutations=${options.safe.allowMutations} (observe never mutates)`,
              ],
              registeredHooks: state.hooks.registered,
              failedHooks: state.hooks.failed,
              usageCapture: state.usage,
              usageSamplesStored: usageSamples.length,
              providerUsageAvailable: usageSamples.length > 0,
            }),
          )
        },
      })

      editor.add({
        name: RESET_COMMAND,
        description: `Cache Guardian: delete local telemetry. Requires '${RESET_CONFIRMATION}'.`,
        execute: async (input) => {
          const confirmed = input.prompt.text.includes(RESET_CONFIRMATION)
          if (!confirmed) {
            emit(
              `${RESET_COMMAND}: refusing to delete telemetry without an explicit confirmation.\n` +
                `Re-run with: ${RESET_COMMAND} ${RESET_CONFIRMATION}`,
            )
            return
          }
          const removed = await resetStore(ctx.storage)
          emit(`${RESET_COMMAND}: removed ${removed} stored record(s).`)
        },
      })
    })
  } catch {
    // A host that cannot register commands still gets the plugin; reports are then read
    // from storage rather than through /commands.
    return NO_REGISTRATION
  }
}
