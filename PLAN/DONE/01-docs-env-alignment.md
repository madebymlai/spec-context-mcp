# 01 Docs and Env Alignment

## Goal
Align user-facing documentation and examples with actual runtime configuration so setup is accurate and consistent.

## Rationale
README, CLI help, and .env.example currently reference OpenRouter/Qdrant embedding variables, but runtime uses ChunkHound + VoyageAI. This creates setup failures and confusion.

## Scope
- Update docs/examples to match actual env vars and defaults.
- Clarify which vars are required vs optional.

## Tasks
- Update `README.md` to describe ChunkHound/VoyageAI configuration and remove stale OpenRouter/Qdrant embedding defaults.
- Update CLI help text in `src/index.ts` to match real env vars.
- Update `.env.example` to include `VOYAGEAI_API_KEY`, `CHUNKHOUND_PYTHON`, and dashboard vars; remove unused vars.
- Cross-check any remaining docs or scripts for stale env references.

## Acceptance
- New user can configure from README + .env.example without hitting missing-variable errors.
- Help output matches README guidance.
