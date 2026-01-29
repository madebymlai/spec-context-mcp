# 06 Embedding Provider Configuration

## Goal
Expose a clear and flexible embedding provider config path and map it into `.chunkhound.json` automatically.

## Rationale
Runtime assumes VoyageAI but config is partly duplicated; users should be able to select providers/models without editing internal files.

## Scope
- Add env vars for provider/model/dimensions where supported.
- Ensure generated `.chunkhound.json` reflects those choices.

## Tasks
- Introduce env vars such as `EMBEDDING_PROVIDER`, `EMBEDDING_MODEL`, `EMBEDDING_DIMENSION`, and provider-specific API keys.
- Update `src/bridge/chunkhound-bridge.ts` to build `.chunkhound.json` from these values.
- Document the new configuration in README and `.env.example`.

## Acceptance
- A user can change embedding provider without touching source code.
- Generated `.chunkhound.json` matches env config.
