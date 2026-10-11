import { Plugin } from "@opencode/plugin"
import { parseOptions } from "./config/schema.ts"
import { installCommands } from "./opencode/commands.ts"
import { installHooks, installUsageCapture } from "./opencode/hooks.ts"
import { Recorder } from "./opencode/recorder.ts"

/**
 * opencode-cache-guardian — local-first prompt cache stability observer for OpenCode V2.
 *
 * Observe mode is the default and the only implemented behaviour: requests are read,
 * fingerprinted and reported on. Nothing in this plugin writes to system, messages,
 * tools or options, makes a model call, or reaches the network.
 *
 * See docs/v2-compatibility.md for the verified SDK contract and docs/cache-metrics.md
 * for what the numbers do and do not mean.
 */

export default Plugin.define({
  id: "cache-guardian",

  async setup(ctx) {
    const options = parseOptions(ctx.options)
    const now = () => Date.now()
    const recorder = new Recorder(options, ctx.storage, now)
    if (!options.enabled) return

    // Hooks and commands both degrade independently: a failure in one must not stop the
    // other, and neither may surface as a failed request.
    const hooks = await installHooks(ctx, recorder)
    const usage = installUsageCapture(ctx, recorder)
    const commands = await installCommands(ctx, recorder, options, {
      app: { name: ctx.app.name, version: ctx.app.version },
      hooks,
      usage,
    })

    return async () => {
      usage.stop()
      await hooks.dispose()
      await commands.dispose()
    }
  },
})
