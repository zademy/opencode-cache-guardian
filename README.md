# Cache Guardian

A plugin for **OpenCode V2** that measures whether the provider's prompt cache is being
reused the way you would expect — and tells the truth about what it measures.

It does not compress. It does not summarize. It does not reorder. It does not touch the prompt.

## What it does and what it does not

**Does**

- Compute one-way fingerprints (`SHA-256` or `HMAC-SHA256`) of every block of
  `system`, `tools` and `messages` in each request, before it is sent to the provider.
- Compare consecutive requests in the same scope and measure **how much of the prefix
  did not change**, and in which block it changed first.
- Collect the real cache usage the provider reports (`cache.read` / `cache.write`) and
  the cost, via the `session.usage.updated` event.
- Report both, clearly separated.

**Does not**

- Does not modify `system`, `messages`, `tools` or `options`. In `observe` the plugin is
  immutable by construction: there are deep-equality tests before and after every hook.
- Makes no calls to models, embeddings or the network. It is deterministic and local.
- Does not compress context or compete with Context Mode.
- Stores no prompts, code, secrets or absolute paths.
- Does not announce savings in dollars. See [docs/cache-metrics.md](docs/cache-metrics.md).

## Installation

Requires OpenCode `2.0.26` or higher.

```bash
git clone https://github.com/zademy/opencode-cache-guardian
cd opencode-cache-guardian
bun install
bun run build
```

### Option A — local path in `opencode.json`

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "/absolute/path/to/opencode-cache-guardian",
      "options": { "mode": "observe" }
    }
  ]
}
```

Or in `.opencode/plugins/cache-guardian/index.ts`, which is discovered automatically:

```ts
export { default } from "../../../opencode-cache-guardian/dist/index.js"
```

### Option B — shim in the plugins directory

The `plugin` key of `opencode.json` resolves npm specifiers; a local path there is
silently ignored in some versions. If your configuration does not load the plugin, write a
single file in the directory OpenCode does discover:

```bash
cat > ~/.config/opencode/plugins/cache-guardian.ts <<'EOF'
export { default } from "/absolute/path/to/opencode-cache-guardian/dist/index.js"
EOF
```

### Verification

In an interactive session:

```
/cache_guardian_doctor
/cache_guardian_report
```

## Commands

| Command | What it does |
| --- | --- |
| `/cache_guardian_report` | Report: stable prefixes, real provider usage, per scope |
| `/cache_guardian_doctor` | SDK version, registered hooks, metric sources |
| `/cache_guardian_reset` | Deletes local telemetry. Requires `--confirm` |

V2 offers no return channel in commands (`execute` returns `Promise<void>`), so
the output goes to `stdout`.

### Evidence from a live run

Measured against real OpenCode `2.0.26`, in a live agent session:

```text
plugin list --builtin  ->  cache-guardian  local  ~/.config/opencode/plugins/cache-guardian.ts

hook:  requestKind=primary  blockCount=15  prefixBlockCount=15
       stablePrefixRatio=1  firstDivergence=-1  hookDurationMs=0
       prefixEstimatedTokens=12284  provider=minimax-coding-plan

usage: cacheReadTokens=21958529  cacheWriteTokens=0
       inputTokens=1178097  outputTokens=108161  costUsd=0
```

21.9M tokens read from cache versus 1.2M of input: reuse is happening and the
plugin sees it. `costUsd=0` is a real zero (free plan) and is reported as `0`, not as
`N/A`. Hook overhead is 0-1 ms.

`primary` and `title` appear as separate values of `requestKind`: hooks are registered
and labeled separately, and `title` does not double-fire alongside `context`.

## Session heartbeat (visible confirmation)

The plugin confirms it is working inside your own conversation: the first time it
records usage in a session, it injects exactly one synthetic message —

```text
Cache Guardian activo — registrando métricas de prompt-cache de esta sesión (cache-read: 13,926,976 tokens)
```

— labeled with a random geek tag (`cache-guardian segfault`, `cache-guardian tlb-miss`…).
One per session, ever: the announcement is remembered durably in the plugin storage,
so neither restarts nor the host re-instantiating plugins can repeat it.

## Terminal indicator (TUI plugin) — parked

The `tui/` directory holds a second plugin, `cache-guardian.status`, that renders the
cumulative cache-read count in the session footer. On opencode 2.0.26 it cannot
display anything: user plugins load only in the server process, whose context has no
`ctx.ui` (verified empirically — every load shows `ui=false`), and the TUI client
loads no plugins at all. The code is kept parked and correct; revive it when a host
version bridges `ctx.ui` to plugins.

## Configuration

See [examples/opencode.jsonc](examples/opencode.jsonc). Every value has a sensible
default and an invalid value degrades to the default instead of failing.

| Option | Default | What it does |
| --- | --- | --- |
| `mode` | `observe` | Operating mode |
| `enabled` | `true` | Whether the plugin does anything |
| `privacy.hashing` | `sha256` | `sha256` or `hmac-sha256` |
| `metrics.enabled` | `true` | Persist telemetry |
| `metrics.retentionDays` | `14` | Retention by age |
| `metrics.maxObservations` | `10000` | Cap by count |
| `limits.maxProcessingMs` | `40` | CPU budget per request |
| `limits.maxRequestBytes` | `2000000` | Cap on the analyzed payload |
| `report.includeProviderUsage` | `true` | Include real metrics |
| `safe.dryRun` | `true` | Safe mode without writing |
| `safe.allowMutations` | `false` | Mutations (see Limitations) |

## Privacy

- **Only** one-way digests, lengths and labels are stored. Never text.
- `privacy.storeContent` is hardwired to `false` and **cannot** be enabled from
  configuration.
- Multimedia parts are reduced to `media:<type>:<mediaType>`. Image bytes are never
  hashed or copied.
- `projectKey` is the opaque project identifier, not its path. `sessionKey` is a prefix
  of the digest of the session id. The real id is never persisted.
- Telemetry never leaves the machine. There is no network in the plugin.
- Storage keys live under `cache-guardian/v1/` in OpenCode's official storage,
  which respects per-project isolation.

### About HMAC

With `hmac-sha256`, an attacker without the key cannot confirm that a known text is
present by trying digests. The key is generated **per process** and never persisted, so:

- digests are not comparable across restarts (each process starts with an empty prefix);
- rotation is automatic: restarting OpenCode is enough.

It is a conscious trade: dictionary protection in exchange for non-persistent history.
Aggregate counts remain valid; prefix comparison only works within a single run.

## Compatibility

The plugin does not depend on the name or internal API of any other plugin, and does
not require any of them to know it exists:

| Other plugin | Relationship |
| --- | --- |
| Context Mode | No competition. What is left in the hook at its current position is observed |
| Ponytail | Does not reorder or rewrite its instructions |
| Hashline | Does not touch tools or the `N:hh` anchor format |
| RTK | Does not re-compress CLI outputs |
| Tool Guardian | Does not intercept or duplicate security rules |
| Error Explainer | Does not deduplicate errors; they are treated as dynamic |
| Encoding Guard | Does not read or rewrite file bytes |

## Limitations

Stated plainly:

1. **`safe` and `experimental` do nothing.** The schema accepts them, but they behave
   exactly like `observe`. No semantically provable transformation was found that would
   not reorder free text, and reordering can change behavior even when the content is
   identical. It is an acceptable outcome of the specification, not an oversight:
   the alternative was an `allowMutations` flag that would not honor its name.
2. **Slash commands have not been seen in an interactive session.** The rest of the
   plugin has: it loaded and ran against real OpenCode `2.0.26`, with hooks firing,
   observations persisted and real provider usage captured. Type
   `/cache_guardian_doctor` in a session to confirm command registration. See
   [docs/v2-compatibility.md](docs/v2-compatibility.md).
3. **Tokens are an estimate.** `chars / 4`, labeled as such.
4. **The block split is ours, not the provider's.** It is a structural indicator.
5. **Without real metrics, the report says `N/A`.** It does not fill gaps.
6. **Payloads over the limit are skipped** and counted as `Skipped`.

## A/B comparison

1. Same provider, model and task; one session with the plugin, one without.
2. Separate **cold** from **warm** cache. Mixing them invents results.
3. Compare `costUsd` and `cacheReadTokens`, which are the only billable ones.
4. Measure overhead with `hookDurationMs` p50/p95.

In `observe` the request is identical with and without the plugin, so a quality A/B
should not differ. If it does, it is a bug in this plugin.

## Development

```bash
bun install
bun run typecheck
bun run lint
bun test
bun run build
```

CI runs typecheck, lint and tests on `ubuntu-latest`, `macos-latest` and `windows-latest`.
The plugin uses no hardcoded Unix paths: persistence goes through `ctx.storage`.

## Documentation

- [docs/v2-compatibility.md](docs/v2-compatibility.md) — the verified SDK contract.
- [docs/cache-metrics.md](docs/cache-metrics.md) — what each number means.
- [CHANGELOG.md](CHANGELOG.md)

## License

MIT. See [LICENSE](LICENSE).
