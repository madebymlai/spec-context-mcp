# 07 MCP Response Standardization

## Goal
Return MCP-compliant responses consistently across tools and server handlers.

## Rationale
`toMCPResponse` exists but isn't used; server currently stringifies JSON, which breaks structured consumers.

## Scope
- Standardize tool responses to the MCP SDK expected format.
- Keep backward compatibility for existing consumers.

## Tasks
- Update `src/server.ts` to use `toMCPResponse` (or equivalent) instead of JSON stringifying.
- Ensure tool handlers return `ToolResponse` consistently.
- Add minimal tests or fixtures for response shape.

## Acceptance
- Tool calls return proper MCP response schema.
- No regressions in existing CLI usage.
