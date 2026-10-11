/**
 * Cache Guardian TUI companion: a footer indicator with the session's
 * cumulative cache-read tokens, live from session.usage.updated.
 *
 * The server plugin (src/index.ts) is unaffected; this side only reads events.
 *
 * Renders a plain string on purpose. The host resolves only "effect" and
 * "@opencode/plugin" to its own copies; a third-party @opentui/solid import
 * clashes with the host's bundled copy (duplicate env-var registration), so
 * element constructors are off-limits. TSX text children are plain strings
 * anyway, so the renderer already knows how to paint one.
 *
 * Install by symlinking this directory into ~/.config/opencode/plugins/.
 */
import { Plugin } from "@opencode/plugin/tui"
import { statusText } from "./status.ts"

interface Reads {
  [sessionID: string]: number | undefined
}

export default Plugin.define({
  id: "cache-guardian.status",
  async setup(ctx) {
    // The server process loads plugins from the same directory but has no UI;
    // without this guard its context would crash on ctx.ui.
    if (!("ui" in ctx) || !("theme" in ctx)) return

    const [store, mutate] = ctx.storage.memory("cache-guardian.status", {
      initial: { reads: {} as Reads },
    })

    const off = ctx.data.on("session.usage.updated", (event) => {
      const read = event.data.tokens?.cache?.read
      const sessionID = event.data.sessionID
      if (typeof read !== "number" || !Number.isFinite(read) || !sessionID) return
      mutate((draft) => {
        draft.reads[sessionID] = read
      })
    })

    const unslot = ctx.ui.slot({
      append: "prompt.footer.status",
      render: (input) => statusText(store.reads[input.sessionID ?? ""]) ?? null,
    })

    return () => {
      unslot()
      off()
    }
  },
})