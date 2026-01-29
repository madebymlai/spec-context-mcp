# 09 Doctor CLI Preflight

## Goal
Add a "doctor" command to validate local environment and surface actionable setup errors.

## Rationale
Failures often occur after startup (missing Python, missing API keys, dashboard unreachable). A preflight makes onboarding smoother.

## Scope
- CLI command `spec-context-mcp doctor` (or `--doctor`) that checks dependencies.

## Tasks
- Check Python availability and ChunkHound importability.
- Validate required env vars and warn about optional ones.
- Check dashboard session or reachability (if configured).
- Output clear pass/fail summary with next steps.

## Acceptance
- Doctor command reports configuration gaps before runtime failures.
- Output is concise and actionable.
