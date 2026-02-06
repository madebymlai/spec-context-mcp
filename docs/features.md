# Core Additions (This Commit)

Date: 2026-02-06  
Scope: `src/core/llm/*`, `src/dashboard/services/ai-review-service.ts`, `src/dashboard/multi-server.ts`, `src/config/discipline.ts`

Notes:
- Token savings are **estimated** for affected request paths and are **not additive**.
- Prompt-engineering power score is on a **1-10** scale (higher = stronger controllability/reliability).

| Feature | Core Addition | Estimated Token Efficiency Save | Prompt Engineering Power |
|---|---|---:|---:|
| Stable prefix/tail cache keying | `PromptPrefixCompiler` + OpenRouter integration | 10-35% (iterative prompts; via better cache locality) | 8/10 |
| Provider cache abstraction | `ProviderCacheAdapter` (+ OpenRouter/OpenAI/Claude/Gemini adapters) | 0-5% now, 10-30% when direct providers are wired | 7/10 |
| Normalized cache telemetry | unified `cachedInputTokens/cacheWriteTokens/cacheMissReason` | 0-3% direct, enables faster optimization loops | 6/10 |
| Strict prompt template contract | `PromptTemplateRegistry` used by AI review prompt build | 5-15% (less prompt drift/redundancy) | 8/10 |
| Strict structured output + bounded schema retries | `SchemaRegistry` + AI review response validation/retry | 5-20% (fewer malformed retries/manual repair loops) | 9/10 |
| Canonical runtime events | event envelope validation + idempotent sequencing | 0-5% direct (indirect savings via cleaner deltas) | 7/10 |
| Durable bounded event stream | `RuntimeEventStream` retention + JSONL persistence | 0-3% direct, reduces replay/log inflation risk | 6/10 |
| Async coalesced snapshots | `RuntimeSnapshotStore` buffered persistence worker | 0-2% tokens, 5-20% p95 latency improvement in write-heavy runs | 5/10 |
| Event->projection->snapshot path | `EventBusAdapter` + `StateProjector` wired into AI review | 5-20% (snapshot/delta path replaces raw-log expansion) | 7/10 |
| Budget queue semantics | non-interactive `queue` decision in `BudgetGuard` | 0-10% (prevents wasteful out-of-policy attempts) | 4/10 |
| Provider capability downgrade retry | strips unsupported params once and retries | 0-8% (avoids repeated hard-fail retries) | 6/10 |
| Runtime telemetry endpoint | `/api/runtime/ai-review/telemetry` | 0-2% direct, supports ongoing token tuning | 5/10 |
| Service cache hardening | hashed key + TTL/LRU for AI review service cache | 0-2% tokens, improves stability/security | 3/10 |
| DRY provider catalog for CLI agents | canonical provider map + alias mapping | 0% token impact (maintainability gain) | 4/10 |

## Highest ROI for Token Efficiency
1. Stable prefix/tail cache keying
2. Strict prompt template contract
3. Event->projection->snapshot path
4. Strict structured output + bounded schema retries

## Highest ROI for Prompt Engineering Power
1. Strict structured output + bounded schema retries (9/10)
2. Stable prefix/tail cache keying (8/10)
3. Strict prompt template contract (8/10)
4. Provider cache abstraction (7/10, increases as direct providers are wired)
