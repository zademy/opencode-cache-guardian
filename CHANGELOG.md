# Changelog

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning according to [SemVer](https://semver.org/).

## [0.2.0] - 2026-10-11

### Added

- **Companion TUI plugin** `cache-guardian.status` (`tui/`): an indicator in the session
  footer with the cumulative count of tokens read from cache (`cg cache read 24.4M`),
  live from `session.usage.updated`. Installable by symlinking the directory; the TUI
  does not discover loose files. With no data it shows nothing, not a zero.
- Load guard in the server process: it scans the same directory but has no `ctx.ui`,
  so the plugin becomes a no-op there.

### Discovered and documented limitation

- The host resolves only `effect` and `@opencode/plugin` to its own copy (verified in
  `packages/plugin/src/runtime-modules.ts`: `runtimePackages = ["effect",
  "@opencode/plugin"]`). Importing `@opentui/solid` from a third-party plugin installs
  a second instance of `@opentui/core` and breaks with "OPENTUI_FORCE_UNICODE
  is already registered with different configuration". The indicator renders plain
  strings — text children in TSX are strings, the renderer already paints them — and
  it waits for the host to provide `@opentui`.

## [0.1.2] - 2026-10-11

Semantics of the provider counters verified against the OpenCode V2 source
(packages/core/src/session/usage.ts and projector.ts), not just against observed data.

### Fixed

- Honest labels in the provider usage block:
  - `Provider input tokens (non-cached)`: the event's `input` field is the input NOT
    served from cache (`nonCachedInputTokens`), not the total. The real request is
    approximately input + cacheRead + cacheWrite.
  - `Provider usage samples: N (one per completed model step)`: the event is published
    on Step.Ended/Step.Failed, so there is exactly one per completed dispatch.
  - `Median per dispatch: cache read X / fresh input Y`.

### Added

- `Coverage: N usage event(s) for M observed request(s)` line. When N < M there are
  dispatches that produced no usage (failures, errors). In the real data: 112/148.
- Documented the most important structural limitation found so far: the provider sees
  ~9x more input per dispatch (~111k tokens: 863 fresh + ~110k from cache) than what
  the `context` hook exposes (~12,273 estimated tokens). The local metric describes
  only the payload visible in the hook; the provider figures describe the complete
  request. Both are shown, separated, and neither is derived from the other.

## [0.1.1] - 2026-10-11

Fixed from real data of a live session (114 observations, 79 usage samples): the
provider counters are cumulative per session, not per-request values.

### Fixed

- **totalUsage was summing cumulative samples and overcounting ~33x.** The counters of
  `session.usage.updated` are monotonic within a session; the correct total per
  session is the most recent reading, summed across sessions. Regression fixture with
  the real numbers from the live session.
- A field the most recent sample does not carry now falls back to the most recent
  sample that does carry it, instead of being lost.

### Added

- usageDeltas: median per dispatch of cache read / input / output, as the delta between
  consecutive samples of the same session. Negative deltas (counter resets) are
  discarded. New line in the report: `Median per dispatch`.
- `Identical consecutive requests` line in the local block. In the real reference
  session it was 99/100 comparable pairs: the context is resent unchanged and the
  provider serves it from cache (109,168 tokens read from cache per dispatch versus
  761 of fresh input).

## [0.1.0] - 2026-10-11

First version. Plugin for OpenCode V2 `2.0.26`.

### Added

- **`observe` mode** (default): computes one-way fingerprints of `system`, `tools` and
  `messages` on every request and measures the stable prefix between comparable
  requests. Does not modify the prompt.
- **Canonical serialization**: sorts object keys, preserves array order and text byte
  by byte. Resolves circular references, `Map`/`Set`/`Date`/`RegExp`, binaries and
  excessive depth without throwing.
- **`SHA-256` and `HMAC-SHA256`**. The HMAC key is generated per process and never
  persisted.
- **Per-part fingerprints**: one block per part, with `system`, tools (sorted by name)
  and `messages` in order. Multimedia parts are reduced to a descriptor; the bytes are
  never hashed or stored.
- **Real provider usage** via `session.usage.updated`: `cache.read`, `cache.write`,
  input and output tokens, and cost.
- **Official persistence** in `ctx.storage`, with prefix `cache-guardian/v1/`, retention
  by age and by count. No hardcoded paths: cross-platform by construction.
- **Commands** `cache_guardian_report`, `cache_guardian_doctor` and
  `cache_guardian_reset` (the latter requires `--confirm`).
- **Reports that separate** local estimates from billed metrics, and print `N/A`
  when a datum does not exist. Estimated dollar savings is always `N/A`.
- **`privacy.storeContent` hardwired to `false`**, with no way to enable it.
- **Limits**: CPU budget per request and payload cap, with an explicit `skipped` when
  either is exceeded.
- 120 tests: unit tests of fingerprinting, config, metrics, storage and reports, and
  integration over a `Plugin.Context` harness, including deep equality of the payload
  before and after every hook.
- CI on `ubuntu-latest`, `macos-latest` and `windows-latest`.

### Not implemented, and why

- **`safe` mode.** No semantically provable transformation was found that would not
  reorder free text. The schema accepts it and it behaves like `observe`.
- **`experimental` mode.** Reserved; no active code.
- **`storage.storeContent`.** Hardwired to `false`.

### Notes

- The real execution order of hooks relative to other plugins could not be verified
  non-interactively. See `docs/v2-compatibility.md`.
- `estimateTokens` uses `chars / 4`. It is a heuristic labeled as such, not a tokenizer.
