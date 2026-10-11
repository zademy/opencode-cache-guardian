# OpenCode Cache Guardian — V2 Implementation Specification

> **Agent instruction:** implement the functional plugin, its tests and documentation. Do not stop at an architectural proposal. Research the actually installed V2 SDK first and fit the implementation to its public types. The default behavior must be **observe** and **zero prompt mutations**.

## 1. Objective

Build `opencode-cache-guardian`, a **local-first, deterministic and cross-platform** (Windows/macOS/Linux) plugin to measure and — only if safe — improve the **reuse of the provider's prompt cache** in OpenCode V2.

The user already uses:

- **Context Mode**: context management, retrieval and reduction.
- **Ponytail**: quality and simplicity instructions/skill.
- **Hashline**: reading and editing with precise anchors.
- **RTK**: CLI output reduction/structuring.
- **Open Guard / Tool Guardian**: analysis of decisions, redundancies and risky actions.
- **Error Explainer**: failure interpretation.
- Potential **Encoding Guard** for ISO-8859-1/Windows-1252.

Do not duplicate any of those responsibilities. This plugin must **not** compress, summarize, clean, replace or inject context. Its first mission is to answer reliably: "are parts of the prompt changing between requests that could remain stable?".

### Guarantees

1. **No additional model calls**. No LLM, embedding, external server or additional API for optimizing.
2. **No semantic alteration by default**. `observe` only computes fingerprints and statistics; it changes no `system`, `messages`, `tools` or model options.
3. **Safety before savings**. Do not reorder blocks merely because they appear stable.
4. **Honest measurement**. Distinguish local prefix matches from *billed cache hits* by the provider; never confuse the two.
5. **Isolation** of projects/sessions/providers/models/agents; no storing prompts, source code, secrets or textual content by default.
6. **Fault tolerance**. A plugin error must never break a legitimate request in `observe` mode; degrade gracefully.
7. **Real V2 compatibility**. No V1 hooks and no internal/experimental APIs without explicit acceptance.

## 2. Official references to verify before writing code

- V2 plugins: https://dev.opencode.ai/v2/docs/build/plugins/
- V1→V2 migration: https://dev.opencode.ai/v2/docs/build/plugins/migrate-v1
- V2 configuration: check the `plugins` section in the documentation above.
- Consult the types of the installed V2 `@opencode/plugin` package.

**IMPORTANT:** the import illustrated in the V2 documentation is:

```ts
import { Plugin } from "@opencode/plugin"

export default Plugin.define({
  id: "cache-guardian",
  async setup(ctx) {
    await ctx.session.hook("context", (event) => {
      // OBSERVE MODE: never modify event.
    })
  },
})
```

This block is guidance, **not** a sufficient implementation. Confirm the exact types and how to register/dispose hooks. For auxiliary calls consider `compaction`, `generate`, `title` separately only if appropriate. Do **not** confuse `prompt` (message admission) with `context` (before the model).

V2 modifications to `event.system`, `event.messages` or `event.tools` are possible, but in this project they are forbidden by default. The `model.request`/HTTP hook should only be used if it is validated to provide useful observability without accessing or modifying sensitive information.

## 3. First mandatory diagnostic of the agent

1. Identify the exact OpenCode V2 version and plugin package.
2. Read the real types of `SessionContextHook`, `SystemPart`, `Message`, `TokenUsage`, event registration, `ctx.storage`, `ctx.command`/tools and the available metrics.
3. Verify what usage/cache data the public API offers (cache reads/writes, input tokens, cost, latency). **If they do not exist, report that they are unavailable and do not invent them.**
4. Verify the real hook order with Context Mode and other plugins in a test instance. A later registration sees earlier changes, but do not assume a universal "last before the provider" hook exists.
5. Document OpenCode V2 limitations, exact compatibility and implementation decisions.
6. Do not claim that controlling HTTP headers magically enables prompt caching; do not set cache headers without provider-specific documentation.

## 4. Three modes

### `observe` (mandatory, **default**)

- Observe requests before every model dispatch.
- Compute **irreversible** fingerprints of blocks and sequences, excluding sensitive content from logs.
- Measure stability between comparable requests.
- Keep local metrics with configurable retention.
- Generate recommendations **without altering the prompt**.
- Hook latency recorded; do not go through a remote service.

### `safe` (optional, after testing)

- Forbidden: reordering, deleting, rewriting or deduplicating `messages`, tool-call/result pairs, security instructions, system instructions from other plugins and tool schemas.
- Only allow **explicitly authorized and semantically equivalent** transformations, automatically verifiable. If V2 offers no unequivocally safe set of modifications, implement `safe` as `observe` + recommendations. This is an acceptable outcome.
- Do not move free text of `system` arbitrarily; order can alter behavior even if the content is identical.
- Before/after every transformation, check structural invariants and restore the original if any validation fails.
- Require explicit opt-in, per-project flags and dry-run mode.

### `experimental` (do not implement as an active feature in the MVP)

- Reserve for research in an isolated branch/environment; do not enable in production.
- Never selected by default after an upgrade.

## 5. Data model and fingerprinting

A logical observation must include:

```ts
interface CacheObservation {
  time: number;
  projectKey: string;        // pseudonym/no absolute path in logs
  sessionKey: string;        // pseudonym
  provider: string;
  model: string;
  variant?: string;
  agent?: string;
  requestKind: "primary" | "compaction" | "generate" | "title" | "unknown";
  blockCount: number;
  prefixBlockCount: number;
  prefixEstimatedTokens?: number;
  totalEstimatedTokens?: number;
  stablePrefixRatio?: number; // local metric, NOT the provider hit rate
  hookDurationMs: number;
  source: "local-estimate";
}
```

You may improve this model according to the available public types.

Rules:

- Compute SHA-256 (or a cryptographic equivalent) over **canonical serialization** of the observed content, preserving semantic order. Include role, part type, tool name and schema where applicable.
- Avoid comparing JSON strings whose incidental key order makes hashes unstable; normalize keys of structured objects without reordering arrays.
- **Do not normalize whitespace, line breaks, capitalization or Unicode text** if the provider does not: normalizing can fabricate false matches.
- Separate fingerprints of `system`, `messages` and `tools`; also record the aggregate prefix exactly as observed.
- The provider's order/serialization may differ from the SDK representation: **label the measurement as a local approximation**, not as truth about real cache hits.
- Pair observations only within the same provider, model, variant and request type, and preferably the same project/session or configuration scope.
- Handle multimodal content safely: stable metadata/identifiers if allowed; never copy blobs or images to storage.
- Use optional keyed local hashing (HMAC) to resist dictionary attacks on known strings; document the protection and key rotation.
- Handle non-serializable content, circular references, unknown types and large payloads without failing the request.
- Do not retain hashes of highly sensitive secrets if they are identified by the SDK contract; be conservative with aggregate metrics.

## 6. Algorithm to identify reusable prefixes

The goal is not to reconstruct the provider's exact internal serialization. The goal is a **structural stability indicator**.

```text
previousBlocks = canonicalFingerprints(previousRequest)
currentBlocks  = canonicalFingerprints(currentRequest)

stablePrefix = 0
for i = 0; i < min(lengths):
    if previousBlocks[i] != currentBlocks[i]: break
    stablePrefix += 1

report(stablePrefix, totalBlocks, estimatedTokenLengths)
```

- Do not combine blocks whose roles or formats differ.
- Compare only compatible requests.
- Compute prefix stability without assuming all providers cache on the same minimum boundaries or TTLs.
- Record whether the first divergence appears in `system`, tool definitions or variable context, **without recording that block's content**.
- If the request or metadata is not observable, skip with an explicit reason.
- Prefer metrics based on exact counts **if the SDK provides them**; otherwise offer estimates labeled as such, with a provider/model-specific tokenizer if a local one is available. Do not use `string.length` as an exact token count.

## 7. Metrics and costs: two separate classes

### 7.1 Local observable metrics

- Count of studied requests.
- Stable blocks / total blocks.
- Stable prefix in blocks and token estimate.
- First-divergence distribution.
- Added hook latency p50/p95.
- Skipped requests and reasons.
- Frequency of changes to `system`/`tools`/`messages`.

### 7.2 **Real** provider metrics (only if available)

- Cache tokens read/written, per the provider's definitions.
- Non-cached input tokens.
- Reported cost, or computable with rates **explicitly configured and dated**.
- **Real** cache hit rate only with a defined denominator and sufficiently reliable fields.
- Distinguish cached tokens, billed tokens, discounts and latency differences.

If there is no access to real usage, show for example:

```text
Provider cache read tokens: N/A — not exposed by current API
Estimated stable prefix: 8,400 tokens (local estimate)
Estimated savings in USD: N/A — insufficient billing data
```

**Never** announce "X% savings" on a figure that only measures matching prefixes. Caching is determined by the provider, not by Cache Guardian.

## 8. Explicit compatibility with the user's stack

### Context Mode

- Do not compete in compaction, RAG, indexing, search or filtering.
- Do not redo outputs or summarize context.
- In `observe` mode, observe what actually remains in the context hook at its current position.
- Record the known hook order; expose the limitation if another plugin transforms context afterwards.

### Ponytail

- Do not reorder, replace, simplify or delete its instructions.
- Do not infer a block's priorities from its name.

### Hashline

- Do not reorder tools, replace their definitions, or affect `N:hh` anchors.
- Do not modify the content of tool calls or results.

### RTK

- Do not re-compress CLI results.
- Do not interfere with shell commands.

### Open Guard / Tool Guardian

- Do not intercept or duplicate security rules, deduplication or tool execution.

### Error Explainer

- Do not deduplicate errors, diagnostics or messages; consider them dynamic.

### Encoding Guard

- Do not read or rewrite file bytes; do not change ISO-8859-1, Windows-1252 or CRLF/BOM files.

### Degradation

- No other plugin needs to know that Cache Guardian exists.
- No depending on plugin names or their internal APIs.
- If detecting the exact provenance of blocks is impossible, show `source: unknown` instead of guessing.

## 9. Proposed configuration

Use `ctx.options` in the official V2 form if available; validate the schema with types and tests. **The following JSON is our plugin's proposal, not native OpenCode keys**:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "./plugins/cache-guardian",
      "options": {
        "mode": "observe",
        "enabled": true,
        "privacy": { "storeContent": false, "hashing": "hmac-sha256" },
        "metrics": { "enabled": true, "retentionDays": 14, "maxObservations": 10000 },
        "limits": { "maxProcessingMs": 40, "maxRequestBytes": 2000000 },
        "report": { "includeProviderUsage": true },
        "safe": { "dryRun": true, "allowMutations": false }
      }
    }
  ]
}
```

Indicative values; choose reasonable limits and do not promise a hard timeout without real interruption capability. Add configuration via environment variables if useful, without exposing secrets.

## 10. Reporting and commands

Propose an OpenCode V2 command or query tool, using only the registered/documented mechanism:

- `cache_guardian_report` (read-only): status per session, project, provider/model and time windows.
- `cache_guardian_doctor` (read-only): check SDK version, mode, hooks, compatibility and metric sources.
- `cache_guardian_reset` (explicit action): clean the plugin's local telemetry, with confirmation if the API allows it.

Do not claim that `/cache report` exists automatically. If V2 allows registering commands, implement them via the official API; if not, an equivalent tool and document the invocation.

Example:

```text
Cache Guardian | observe | OpenCode V2
Requests observed: 84
Comparable pairs: 61
Median local stable prefix: 72% (blocks)
Provider cache reads: unavailable
USD savings: unavailable
Hook overhead p95: 2.7ms (example only)
Changed block group first: messages in 71% of comparable pairs
No prompts or source code stored.
```

Do not store or publish fabricated examples as real metrics.

## 11. Proposed architecture

```text
opencode-cache-guardian/
├── src/
│   ├── index.ts
│   ├── opencode/
│   │   ├── hooks.ts
│   │   ├── reporting.ts
│   │   └── version-capabilities.ts
│   ├── fingerprint/
│   │   ├── canonicalize.ts
│   │   ├── hash.ts
│   │   ├── blocks.ts
│   │   └── prefix.ts
│   ├── metrics/
│   │   ├── observation.ts
│   │   ├── aggregation.ts
│   │   ├── provider-usage.ts
│   │   └── costs.ts
│   ├── storage/
│   │   ├── store.ts
│   │   └── retention.ts
│   ├── policy/
│   │   ├── modes.ts
│   │   └── invariants.ts
│   └── config/
│       ├── schema.ts
│       └── defaults.ts
├── tests/
│   ├── unit/
│   ├── integration/
│   └── fixtures/
├── README.md
├── CHANGELOG.md
├── LICENSE
├── package.json
└── tsconfig.json
```

Simplify if convenient, but clearly separate the V2 SDK, the deterministic algorithm, persistence and reporting.

## 12. Persistence, privacy and platforms

- Prefer official `ctx.storage` if it supports the required queries and retention; otherwise secure local persistence (for example SQLite only if justified) with cross-platform paths.
- No hardcoded Unix paths. Use the runtime's path APIs and project scopes.
- Do not collect full prompts, file contents, secret tokens, private endpoints, tool arguments or HTTP bodies.
- Do not send telemetry to third parties.
- Do not show full repository paths in shared reports by default.
- Respect storage limits and prune by time/count.
- Avoid file locking and corruption from concurrent access.
- Treat token/cost metadata as local information.
- Validate the absence of sensitive data writes by inspecting the telemetry files.

## 13. Performance

- Deterministic algorithm, no network and no LLM.
- Optimize incremental hashing if it brings real benefits.
- Do not repeatedly serialize giant payloads if they can be bounded without lying about coverage.
- If a limit is exceeded, record `skipped: oversized_payload` and continue without blocking.
- Measure p50/p95/p99 latency of the plugin itself.
- Do not read the repository or walk files to build cache metrics.
- `observe` mode must cause no visible side effect on context or tools.

## 14. Mandatory tests

### Unit

- Equal hashes for equivalent structures with JSON keys in different order.
- Different hashes if one character, the array order, a role, a tool call or a schema changes.
- Unicode, accents, emojis, CRLF, empty strings and large content.
- First divergence at the beginning/middle/end.
- Zero-block comparison / single request / model or variant change.
- Unknown/multimodal data does not crash.
- Absence of real metrics handled without inventing savings.
- `observe` rules never mutate `event`.

### V2 integration

- The plugin loads via `Plugin.define` on the installed official version.
- The request with the plugin in `observe` matches the request without the plugin in all observable fields of `system`, `messages`, `tools` and `options` (deep equality).
- Context Mode, Ponytail and Hashline keep working if they are installed.
- Register the `context` request during the agent loop and do not mislabel `compaction`/`title`.
- Check storage exception handling and concurrent execution.
- Check hook registration cleanup when unloading the plugin, if applicable.
- Verify Windows/macOS/Linux with at least a CI matrix per operating system.

### Privacy

- Include a fixture with a fake token and a private path; demonstrate that they are not stored in clear in logs or metrics.
- Do not store plaintext of the system prompt or the history.

### Quality and A/B benchmark

- Baseline A: OpenCode V2 without Cache Guardian.
- Variant B: OpenCode V2 + Cache Guardian (`observe`).
- Keep the same provider/model/task and document cold/warm cache.
- Measure overhead and real metrics when available.
- **Do not conclude cost improvement from local prefix estimates.**
- For the future `safe`, add equivalence tests and functional tasks; if quality worsens, disable it.

## 15. Delivery phases

### Phase 1 — Discovery (mandatory)

Identify the real V2 API, official metrics and limits. Write the findings in `docs/v2-compatibility.md`.

### Phase 2 — Deterministic core

Implement canonical serialization, hashing, prefix comparison, scope separation and tests.

### Phase 3 — Observe hook

Install the `ctx.session.hook("context", ...)` hook, evaluate capturing other request types only if necessary, and guarantee immutability.

### Phase 4 — Persistence and reporting

Private local storage, aggregations, retention, query tools and `doctor`.

### Phase 5 — Integration and benchmarks

Tests with the stack's plugins, cross-platform compatibility and the A/B report.

### Phase 6 — Safe mode (only if proven viable)

Design limited, opt-in transformations **without reordering free-text instructions**. If no semantically provable transformation exists, document it and introduce no risky changes.

## 16. Acceptance criteria / Definition of Done

- [ ] Installable TypeScript project as an **OpenCode V2** plugin, not V1.
- [ ] Compiles and passes typecheck, lint and tests.
- [ ] `observe` mode enabled by default.
- [ ] **Zero changes** to prompts, tools, roles, options and model results in `observe`.
- [ ] Zero LLM, embedding or network calls by the optimizer.
- [ ] Local fingerprints comparable per model/provider/agent/project.
- [ ] The report distinguishes stability estimates from the provider's real statistics.
- [ ] Without real metrics, it presents `N/A`, not fictitious savings percentages.
- [ ] No storage of confidential text.
- [ ] Latency and limits measured, without blocking legitimate tasks.
- [ ] Compatible in tests with Context Mode, Ponytail, Hashline and RTK; without rewriting other plugins' behavior.
- [ ] Windows/macOS/Linux supported and CI configured.
- [ ] README with local V2 installation, configuration, privacy, examples, limitations and an A/B comparison guide.
- [ ] Real SDK version documented, and how cache usage is obtained or unknown.
- [ ] No semantically risky optimization enabled by default.

## 17. Deliverables

1. Publishable plugin source code (no invented URL).
2. `package.json`, with `test`, `typecheck`, `lint`, `build` scripts.
3. Unit and real V2 integration tests.
4. README in Spanish (and optionally English).
5. `docs/v2-compatibility.md` and `docs/cache-metrics.md`.
6. Tested example of a V2 `opencode.jsonc`.
7. Final agent report: features implemented, commands run, tests performed, constraints, metrics observed and deferred functionality.

## 18. Final instruction for OpenCode

**Build the plugin, do not just design it.** Start by inspecting the project and the installed V2 SDK; follow the phases; implement the complete `observe` MVP; run verifications and fix failures. If you cannot obtain cache billing fields from the public API, document the limitation and continue with honest local metrics. Do not copy V1 APIs. Do not modify existing plugins' files or turn the optimizer into another Context Mode. Prioritize accuracy, privacy, compatibility and measurable cost over savings promises.
