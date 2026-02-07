# Tasks Document: MCP Tool-Result Caching (Dimension 5 P1)

> Tasks follow TDD. Existing tool handler public APIs remain unchanged. Cache is an optimization layer — tests verify correctness, not performance.

- [x] 1. Create FileContentCache module with interface and implementation
  - File: `src/core/cache/file-content-cache.ts` (new)
  - Define `IFileContentCache` interface and `FileContentCache` class
  - Implement mtime+hash validation: stat-only on hit path, readFile+hash on miss
  - Return `null` on file-not-found or I/O error (no throw)
  - Track hit/miss/error telemetry counters
  - Purpose: Shared file-content cache reused by all tool consumers
  - _Leverage: `src/tools/workflow/dispatch-ledger.ts` SourceFingerprint pattern (mtime + sha256)_
  - _Requirements: 1, 5_
  - _Prompt: |
      Implement the task for spec mcp-tool-result-caching, first call get-implementer-guide to load implementation rules then implement the task:

      Role: TypeScript Developer specializing in caching infrastructure

      Task: Create an in-memory file-content cache with mtime+hash invalidation. Define IFileContentCache interface and FileContentCache implementation. The cache uses stat() for fast-path validation and readFile+sha256 for content verification on mtime mismatch. Return null on file-not-found (ENOENT) — do not throw. Track hits, misses, and errors.

      Restrictions:
      - No external dependencies (only fs.promises and crypto)
      - Consumers must depend on IFileContentCache interface, not concrete class
      - Never serve stale content — mtime+hash double-check
      - I/O errors fall through to null, not throw

      Success:
      - IFileContentCache interface exported
      - FileContentCache passes all unit tests (hit, miss, invalidation, ENOENT, telemetry)
      - Reuses sha256 hash pattern from dispatch-ledger.ts

      Before starting, mark this task as in-progress in tasks.md [-]
      When complete, mark this task as done in tasks.md [x]_

- [x] 2. Integrate cache into steering-loader
  - File: `src/tools/workflow/steering-loader.ts`
  - Make `getSteeringDocs` async, read files through `IFileContentCache`
  - Accept optional cache parameter (backward compatible — direct read if no cache)
  - `getMissingSteeringDocs` remains synchronous (existsSync only)
  - Purpose: Eliminate redundant readFileSync calls for steering docs across guide tools
  - _Leverage: `src/tools/workflow/steering-loader.ts`, `src/core/cache/file-content-cache.ts`_
  - _Requirements: 2_
  - _Prompt: |
      Implement the task for spec mcp-tool-result-caching, first call get-implementer-guide to load implementation rules then implement the task:

      Role: TypeScript Developer specializing in I/O optimization

      Task: Modify steering-loader to read files through FileContentCache. Make getSteeringDocs async. Accept optional IFileContentCache parameter — if not provided, fall back to direct readFile (backward compatible). Do NOT change getMissingSteeringDocs (stays synchronous, no content needed).

      Restrictions:
      - Public API signature change: getSteeringDocs becomes async with optional cache param
      - All existing callers must be updated to await
      - getMissingSteeringDocs stays synchronous
      - No new dependencies

      Success:
      - getSteeringDocs reads through cache when provided
      - Repeated calls with unchanged files hit cache (verified by telemetry)
      - All existing steering-loader tests pass with updated async signatures
      - Callers (get-implementer-guide, get-reviewer-guide, spec-workflow-guide) updated to await

      Before starting, mark this task as in-progress in tasks.md [-]
      When complete, mark this task as done in tasks.md [x]_

- [x] 3. Add steering-change invalidation to guide caches
  - File: `src/tools/workflow/get-implementer-guide.ts`, `src/tools/workflow/get-reviewer-guide.ts`
  - Store steering doc fingerprints in guide cache entries
  - On compact mode hit, compare stored fingerprints against cache.getFingerprint()
  - If any fingerprint differs, invalidate guide entry and force full reload
  - Purpose: Prevent stale guide content when steering docs are edited externally
  - _Leverage: `src/core/cache/file-content-cache.ts`, existing guide cache Maps_
  - _Requirements: 4_
  - _Prompt: |
      Implement the task for spec mcp-tool-result-caching, first call get-implementer-guide to load implementation rules then implement the task:

      Role: TypeScript Developer specializing in cache invalidation

      Task: Add steering-doc fingerprint tracking to guide cache entries. On compact mode cache hit, compare stored fingerprints against IFileContentCache.getFingerprint(). If any steering doc fingerprint changed, invalidate the guide entry and fall through to full mode recompilation. Apply to both implementer and reviewer guide handlers.

      Restrictions:
      - Do not change guide tool public response shapes
      - Fingerprint check uses getFingerprint() (no I/O beyond stat)
      - Only invalidate on actual fingerprint mismatch, not on every call

      Success:
      - Guide cache entries store steering fingerprints
      - Compact mode detects steering doc changes and forces full reload
      - Unchanged steering docs still serve cached compact guides
      - Tests verify invalidation on steering change and cache hit on no change

      Before starting, mark this task as in-progress in tasks.md [-]
      When complete, mark this task as done in tasks.md [x]_

- [x] 4. Integrate cache into spec-status tool
  - File: `src/tools/workflow/spec-status.ts`
  - Cache parsed SpecParser results keyed on `{projectPath}:{specName}`
  - Check tasks.md fingerprint via FileContentCache before re-parsing
  - If fingerprint matches, return cached parse result
  - Purpose: Eliminate redundant spec file parsing during implementation phase
  - _Leverage: `src/tools/workflow/spec-status.ts`, `src/core/cache/file-content-cache.ts`, `src/core/workflow/parser.ts`_
  - _Requirements: 3_
  - _Prompt: |
      Implement the task for spec mcp-tool-result-caching, first call get-implementer-guide to load implementation rules then implement the task:

      Role: TypeScript Developer specializing in parsed-result caching

      Task: Add a parsed-result cache to spec-status. Before calling SpecParser.getSpec(), check if tasks.md fingerprint (via IFileContentCache.getFingerprint) matches the cached entry. If match, return cached result. If mismatch or no cache, parse fresh and store with fingerprint. Cache is a module-level Map keyed on projectPath:specName.

      Restrictions:
      - Do not change spec-status public response shape
      - Cache invalidation driven by tasks.md fingerprint only
      - SpecParser is the only parser — do not duplicate parsing logic

      Success:
      - Repeated spec-status calls with unchanged tasks.md return cached result
      - Modified tasks.md triggers re-parse on next call
      - Spec-status response shape unchanged
      - Tests verify cache hit and invalidation paths

      Before starting, mark this task as in-progress in tasks.md [-]
      When complete, mark this task as done in tasks.md [x]_

- [x] 5. Wire cache instance and add telemetry exposure
  - File: `src/tools/index.ts` or appropriate wiring location
  - Create shared `FileContentCache` instance
  - Pass to steering-loader and spec-status via tool handler context or direct injection
  - Expose cache telemetry through existing patterns (e.g., include in dispatch-runtime get_telemetry or new lightweight accessor)
  - Purpose: Single cache instance shared across all consumers, observable via telemetry
  - _Leverage: `src/tools/index.ts`, `src/core/cache/file-content-cache.ts`_
  - _Requirements: 5_
  - _Prompt: |
      Implement the task for spec mcp-tool-result-caching, first call get-implementer-guide to load implementation rules then implement the task:

      Role: TypeScript Developer specializing in dependency wiring

      Task: Create a single shared FileContentCache instance and wire it to all consumers (steering-loader calls in guide handlers, spec-status handler). Expose cache telemetry (hits, misses, errors) through an existing telemetry surface — preferably by extending the ToolContext or adding to dispatch-runtime get_telemetry response.

      Restrictions:
      - Single shared instance, not one per tool
      - Do not add new MCP tools for telemetry
      - Keep wiring minimal — prefer constructor/parameter injection over global state

      Success:
      - All tool handlers use the same FileContentCache instance
      - Cache telemetry is queryable
      - Integration test confirms end-to-end cache behavior across tool calls

      Before starting, mark this task as in-progress in tasks.md [-]
      When complete, mark this task as done in tasks.md [x]_
