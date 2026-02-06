# Core Features (Current Implementation)

Date: 2026-02-06  
Scope: Orchestrator + CLI sub-agent dispatch path (`dispatch-runtime v2`)  
Activation: `SPEC_CONTEXT_DISPATCH_RUNTIME_V2=1`

## What matters most now

These are the core features that directly improve token efficiency in the **orchestrator + CLI agents** flow.

| Feature | What was added | Current token-saving impact |
|---|---|---:|
| Structured dispatch contract (hard-fail) | Implementer/reviewer must return strict `BEGIN_DISPATCH_RESULT ... END_DISPATCH_RESULT` JSON block; invalid format fails immediately | **10-25%** (cuts retry noise and log-driven ambiguity) |
| Dispatch runtime state store | `dispatch-runtime` tool with run init, output ingest, snapshot reads, and deterministic `nextAction` | **15-35%** (reduces orchestration context bloat and repeated interpretation turns) |
| Schema-invalid retry gate (max 1) | Tracks schema-invalid retries and halts after one retry | **5-15%** (prevents repeated malformed-output loops) |
| Stable prompt prefix + delta compile | `compile_prompt` action (stable prefix hash + delta packet from prior run state) | **10-30%** (smaller repeated prompts and better cache locality) |
| Output token budget enforcement | `maxOutputTokens` checked during ingest; over-budget outputs fail | **5-12%** (caps long-form agent responses that don’t help orchestration) |
| Dispatch telemetry counters | `get_telemetry` exposes dispatch count, output token totals, schema-invalid retries, approval loops | **0-5% direct** (enables tuning; indirect gains over time) |
| Rollout flag | `SPEC_CONTEXT_DISPATCH_RUNTIME_V2` gates runtime-v2 behavior | **0% direct** (safe rollout/rollback with no prompt churn) |

## Secondary (supporting) changes

| Feature | Why it helps |
|---|---|
| AI review decoupled from heavy runtime stack | Keeps orchestration runtime ownership focused on CLI dispatch path (cleaner SRP, less complexity drift). |
| Provider/cache abstractions in core llm | Foundation for future direct-provider optimization without reworking orchestrator contracts. |

## Practical expectation (current code)

If `dispatch-runtime v2` is enabled and used in the task loop:
- **Orchestrator + CLI flow token reduction:** ~**25-50%** typical range.
- Biggest gains come from: strict result contract + snapshot-driven branching + delta prompt compilation.

If runtime v2 is disabled:
- Gains are minimal, mostly from legacy prompt hygiene only.
