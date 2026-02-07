# Requirements Document: MCP Tool-Result Caching (Dimension 5 P1)

## Introduction

Add in-memory mtime-based caching for deterministic MCP tool calls so repeated invocations return cached results instead of re-reading files from disk and re-computing responses. The primary targets are steering document loading (called by every guide tool), spec-status parsing (called frequently during implementation), and guide compilation. This eliminates redundant token volume sent through MCP to the host agent.

This corresponds to Dimension 5 P1 ("Tool-Result Caching for MCP Operations") in `docs/research/token-efficiency-findings.md`.

## Evidence Notes (from references)

* MCP spec recommends caching for deterministic tool results.
* Steering docs are read by 3+ tools per dispatch cycle (`get-implementer-guide`, `get-reviewer-guide`, `spec-workflow-guide`) via `steering-loader.ts` which calls `readFileSync` on every invocation.
* `spec-status` re-stats directories and re-parses `tasks.md` on every call with zero caching.
* Guide tools have per-run `Map` caches keyed on `runId` but with no file-change invalidation — stale if steering docs are edited externally.
* The dispatch ledger already implements the ideal validation pattern (`SourceFingerprint` with mtime + sha256 hash) but without a cache layer.

## Alignment with Product Vision

This feature supports spec-context-mcp by:

* Reducing redundant file I/O during dispatch cycles
* Cutting MCP response token volume for repeated tool calls
* Reusing the mtime+hash fingerprint pattern already proven in `dispatch-ledger.ts`
* Preserving correctness via deterministic invalidation (no stale reads)

## Requirements

### Requirement 1: File-Content Cache with Mtime+Hash Invalidation

**User Story:** As a tool handler, I want a shared file-content cache that validates entries via mtime and content hash, so I avoid redundant `readFile` calls for unchanged files.

#### Acceptance Criteria

1. WHEN a cached file is requested AND the file's mtime matches the cached entry THEN the cache SHALL return the cached content without reading the file.
2. WHEN a cached file is requested AND the file's mtime has changed THEN the cache SHALL re-read the file, recompute the hash, and update the entry.
3. WHEN a cached file is requested AND the file does not exist THEN the cache SHALL return a miss (not an error).
4. The cache SHALL be an in-memory `Map` with no external dependencies.
5. The cache SHALL expose an interface (not a concrete class) so consumers depend on the abstraction.

### Requirement 2: Steering Document Cache Integration

**User Story:** As the steering loader, I want to read steering docs through the file-content cache, so repeated guide tool calls don't re-read unchanged files from disk.

#### Acceptance Criteria

1. WHEN `getSteeringDocs` is called THEN it SHALL read each document through the file-content cache.
2. WHEN a steering document has not changed since last read THEN the cache SHALL return the previously read content.
3. WHEN a steering document is modified externally THEN the next call SHALL detect the mtime change and re-read.
4. The steering loader's public API (`getSteeringDocs`, `getMissingSteeringDocs`) SHALL remain unchanged.

### Requirement 3: Spec-Status Cache Integration

**User Story:** As the spec-status tool, I want to cache parsed spec status results keyed on file fingerprints, so repeated status checks during implementation don't re-parse unchanged files.

#### Acceptance Criteria

1. WHEN `spec-status` is called AND the tasks.md file has not changed (mtime+hash match) THEN the tool SHALL return the cached parse result.
2. WHEN tasks.md is modified THEN the next `spec-status` call SHALL re-parse and update the cache.
3. WHEN spec directory structure changes (new/removed phase files) THEN the cache SHALL detect the change via directory mtime.
4. The spec-status tool's public response shape SHALL remain unchanged.

### Requirement 4: Guide Cache Invalidation on Steering Changes

**User Story:** As a guide tool, I want my cached guide to invalidate when underlying steering docs change, so I never serve stale guidance.

#### Acceptance Criteria

1. WHEN `get-implementer-guide` or `get-reviewer-guide` returns a cached guide AND the underlying steering docs have changed since the guide was cached THEN the guide cache SHALL be invalidated and the guide recompiled.
2. WHEN steering docs have not changed THEN the existing per-run guide cache SHALL continue to serve cached entries.
3. The guide tools' public response shapes SHALL remain unchanged.

### Requirement 5: Cache Telemetry

**User Story:** As an operator, I want visibility into cache hit/miss rates, so I can measure the effectiveness of caching.

#### Acceptance Criteria

1. The cache SHALL track hit count and miss count per cache key namespace (steering, spec-status, guide).
2. Cache telemetry SHALL be queryable (e.g., via a method or included in existing telemetry surfaces).
3. Cache telemetry SHALL NOT add new MCP tools — expose through existing telemetry patterns.

### Requirement 6: Tests

**User Story:** As a developer, I want deterministic tests for cache behavior, so future changes cannot silently break invalidation correctness.

#### Acceptance Criteria

1. Unit tests SHALL cover cache hit, cache miss, mtime-triggered invalidation, and file-not-found scenarios.
2. Unit tests SHALL verify that steering loader returns cached content when files are unchanged.
3. Unit tests SHALL verify that spec-status returns cached results when tasks.md is unchanged.
4. Unit tests SHALL verify that guide caches invalidate when steering docs change.
5. Existing tool handler tests SHALL remain passing.

## Non-Functional Requirements

### Performance

* Cache lookup (hit path) must add negligible overhead compared to file I/O it replaces.
* Mtime `stat` calls are acceptable on every lookup (fast syscall); full file re-reads only on mtime mismatch.

### Reliability

* Cache must never serve stale content — mtime+hash double-check ensures correctness.
* Cache failures (stat errors, permission issues) must fall through to uncached reads, not throw.

### Compatibility

* All existing tool handler public APIs remain unchanged.
* No new runtime dependencies.

### Code Architecture

* Single file-content cache module, reused by all consumers (DRY).
* Consumers depend on cache interface, not concrete implementation (DIP).
* Cache concerns separated from tool handler logic (SRP).

## References

* MCP Tools Specification: [https://modelcontextprotocol.io/specification/2025-06-18/server/tools](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)
* Existing pattern: `dispatch-ledger.ts` `SourceFingerprint` (mtime + sha256)
* Token efficiency research: `docs/research/token-efficiency-findings.md` Dimension 5