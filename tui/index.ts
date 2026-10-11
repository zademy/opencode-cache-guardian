/**
 * Cache Guardian TUI companion: a visible indicator with the session's
 * cumulative cache-read tokens, live from session.usage.updated.
 *
 * PARKED for opencode 2.0.26: user plugins load only in the server process,
 * whose context has no ctx.ui (verified empirically — every load shows
 * ui=false), and the TUI client loads no plugins at all. Correct code, dead
 * surface. Revive when a host version bridges ctx.ui to plugins.
 *
 * Renders a plain string on purpose. The host resolves only "effect" and
 * "@opencode/plugin" to its own copies; a third-party @opentui/solid import
 * clashes with the host's bundled copy (duplicate env-var registration), so
 * element constructors are off-limits. TSX text children are plain strings
 * anyway, so the renderer already knows how to paint one.
 *
 * Install by copying this directory into ~/.config/opencode/plugins/.
 */
import { Plugin } from "@opencode/plugin/tui"
import { statusText } from "./status.ts"

interface Reads {
  [sessionID: string]: number | undefined
}

export default Plugin.define({
  id: "cache-guardian.status",
  async setup(ctx) {
    // Only a host that provides ctx.ui can render; the 2.0.26 server does not.
    if (!("ui" in ctx)) return

    const [store, mutate] = ctx.storage.memory("cache-guardian.status", {
      initial: { reads: {} as Reads, last: undefined as number | undefined },
    })

    const off = ctx.data.on("session.usage.updated", (event) => {
      const read = event.data.tokens?.cache?.read
      const sessionID = event.data.sessionID
      if (typeof read !== "number" || !Number.isFinite(read) || !sessionID) return
      mutate((draft) => {
        draft.reads[sessionID] = read
        draft.last = read
      })
    })

    const unslot = ctx.ui.slot({
      append: "prompt.footer.status",
      render: (input) =>
        // input.sessionID is optional in the SDK; fall back to the latest read.
        statusText(store.reads[input.sessionID ?? ""] ?? store.last) ?? null,
    })

    return () => {
      unslot()
      off()
    }
  },
})