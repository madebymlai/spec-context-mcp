# 05 Dashboard Version Check Update

## Goal
Fix or remove the startup version check that points to an unrelated npm package.

## Rationale
`src/dashboard/multi-server.ts` checks `@pimzino/spec-workflow-mcp` which is not this project; it can mislead and adds latency on startup.

## Scope
- Update the package name to `spec-context-mcp` OR make the check opt-in.
- Cache the result to avoid repeated fetches.

## Tasks
- Replace registry URL with the correct package name.
- Add a timeout and/or disable by default via env flag.
- Keep fallback to local `package.json`.

## Acceptance
- Dashboard startup does not contact the wrong npm package.
- Version display reflects the actual installed package.
