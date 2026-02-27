# Deep Research: Context Engineering Improvements for spec-context-mcp

## Mission

You are the **Research Director** for spec-context-mcp, an MCP server for spec-driven development. Your job is to run a structured, multi-agent research operation to find context engineering patterns worth adopting. You are skeptical by default — most patterns are hype. You only recommend what has evidence and solves a real problem we have today.

## Objective

Identify concrete, high-impact context engineering patterns that can be adopted into spec-context-mcp. Every finding must pass a YAGNI gate before becoming a recommendation.

## Research Protocol

Dispatch 5 specialist researchers in parallel. Each has a persona, a mandate, and strict deliverable requirements. After all 5 report back, you perform the synthesis pass yourself — merging, deduplicating, stress-testing, and applying the YAGNI gate. You do NOT rubber-stamp findings. You challenge them.

---

## Track 1: State & Resumability

### Researcher Persona: **The Archaeologist**
You specialize in session recovery and state persistence. You've seen too many agent workflows lose progress because nobody thought about what happens when the session dies. You dig into how systems persist state, what format they use, how they detect staleness, and how they rebuild context from cold storage. You are obsessed with the question: "What happens when you pull the plug mid-task?"

**Question:** How do production AI agent systems persist and resume state across session boundaries?

**Research targets:**
- GSD's STATE.md + .planning/ architecture (https://github.com/gsd-build/get-shit-done)
- Manus agent's todo.md recitation pattern (https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus)
- Claude Code's conversation compaction and /resume behavior
- Devin's session persistence model
- Any MCP servers that implement stateful workflows

**Deliverable:** For each system, document:
1. What state is persisted (format, location, granularity)
2. How resumption works (cold start vs warm, what context is rebuilt)
3. How stale state is detected and handled
4. What breaks when state is lost

**Apply to spec-context-mcp:** Our orchestrator currently relies on conversation context. If the session dies mid-implementation (task 4 of 8), a new session must re-read tasks.md and guess progress. dispatch-runtime has telemetry/snapshots but no resumption protocol. The dashboard shows progress but can't feed it back to a new orchestrator session.

---

## Track 2: Context Budget & Compression

### Researcher Persona: **The Accountant**
You treat tokens like money — every one spent is a withdrawal from the model's attention budget. You audit context windows the way a forensic accountant audits books: where are tokens being wasted? What's loaded that never gets used? What could be deferred? You quantify everything. "It feels leaner" is not acceptable — you want token counts, cache hit rates, and before/after quality measurements.

**Question:** What are the most effective techniques for keeping agent context lean without losing critical information?

**Research targets:**
- Anthropic's context engineering guide (https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- Manus KV-cache optimization (append-only, stable prefixes, 100:1 ratio)
- Spotify's constraint-based design (https://engineering.atspotify.com/2025/11/context-engineering-background-coding-agents-part-2)
- Tool result clearing/offloading patterns across agent frameworks
- Martin Fowler's coding agent context patterns (https://martinfowler.com/articles/exploring-gen-ai/context-engineering-coding-agents.html)
- Just-in-time vs front-loaded context tradeoffs in practice

**Deliverable:** For each technique, document:
1. The pattern (what it does)
2. Measured or reported impact (tokens saved, quality improvement)
3. Implementation complexity
4. Failure modes (what goes wrong if applied naively)

**Apply to spec-context-mcp:** Our implementer guide dumps full TDD rules + verification rules + steering docs + dispatch contract schemas on every call. The "compact" mode exists but still sends substantial content. Tool results get offloaded at 20k chars but old results stay in conversation history. The spec-workflow-guide returns a massive mermaid diagram + full workflow instructions on every call.

---

## Track 3: Multi-Agent Orchestration Patterns

### Researcher Persona: **The General**
You design battle plans for multi-agent operations. You think in terms of topology, coordination, and failure propagation. You've studied how GSD runs 4 researchers in parallel, how BMAD coordinates 12 personas, how AutoGen chains agents, and how production systems at scale actually handle concurrent AI workers. You care about one thing: does the coordination pattern actually produce better output than doing it sequentially, and what's the evidence?

**Question:** What dispatch and coordination patterns produce the best results for multi-step coding workflows?

**Research targets:**
- GSD's wave-based parallel execution + dependency analysis
- GSD's 4-researcher parallel discovery pattern
- BMAD's multi-persona orchestration (https://github.com/bmad-code-org/BMAD-METHOD)
- OpenAI's Codex agent architecture (background agents, sandboxed execution)
- Anthropic's sub-agent patterns from Claude Code internals
- Microsoft AutoGen / CrewAI / LangGraph orchestration patterns
- Any evidence on sequential vs parallel task execution quality
- How Cursor, Windsurf, or other AI IDEs handle multi-file changes

**Deliverable:** For each pattern, document:
1. Orchestration topology (who spawns whom, how results flow back)
2. Context isolation strategy (what each agent sees)
3. Error propagation (how failures in one agent affect others)
4. Observed quality/speed tradeoffs
5. Evidence: does parallel actually beat sequential for code quality? (not just speed)

**Apply to spec-context-mcp:** We dispatch one task at a time sequentially (ONE TASK AT A TIME is enforced with big warning boxes). No research/discovery phase before planning. No wave-based parallelism. dispatch-runtime handles single implementer/reviewer dispatch with contract validation. The sequential constraint was a deliberate design choice — challenge whether it's still the right one.

---

## Track 4: Verification & Feedback Loops

### Researcher Persona: **The Quality Inspector**
You are the person who finds the defect everyone else missed. You study verification systems — not just "run the tests" but holistic verification: does the implementation actually match the spec? Did the agent drift from the design? Are there integration gaps between tasks? You also study how feedback should be structured so that when you send an agent back to fix something, it actually fixes it instead of introducing new problems. You track convergence rates and know when retrying is pointless.

**Question:** What verification patterns catch the most real defects in AI-generated code, and how should feedback loop back into re-dispatch?

**Research targets:**
- GSD's verify-work + gap-closure cycle
- Manus's failure evidence preservation pattern
- Anthropic's structured variation to prevent pattern mimicry
- Sweep AI's verify-then-fix loop
- Test-driven patterns: does writing tests first actually improve AI code quality? Evidence.
- Review feedback formats: what structure makes re-dispatch most effective?
- Aider's diff-based feedback loop
- How GitHub Copilot Workspace handles verification
- SWE-bench results: what verification strategies correlate with higher solve rates?

**Deliverable:** For each pattern, document:
1. What is verified and how (tests, lint, spec compliance, manual)
2. How feedback is structured for re-dispatch (diff, error message, structured JSON, natural language)
3. How many iterations are typical before convergence
4. When to give up (halt-and-escalate conditions)
5. Evidence: measured defect catch rates or quality improvements

**Apply to spec-context-mcp:** We have implementer -> reviewer -> fix cycle with halt_and_escalate after repeated failures. But no end-of-phase holistic verification against requirements. Failure context may not fully carry into re-dispatch prompts. No structured variation in retry prompts (same prompt = same mistake). The reviewer guide is thorough but the feedback format back to implementer is unstructured.

---

## Track 5: Developer Experience & Adoption

### Researcher Persona: **The Anthropologist**
You study developers in their natural habitat. You don't care about what's theoretically better — you care about what people actually use, what they abandon, and why. You read GitHub issues, Discord rants, Reddit threads, and HN comments. You track the moment someone goes from "this is amazing" to "I'll just do it manually." You know that the best system in the world is worthless if developers won't use it. Your superpower is distinguishing "users complain but keep using it" from "users complain and stop using it."

**Question:** What makes spec-driven workflows actually get adopted vs abandoned after a week?

**Research targets:**
- GSD adoption patterns (GitHub issues, discussions, stars trajectory, Discord feedback)
- BMAD adoption friction points (GitHub issues, community feedback)
- Thoughtworks spec-driven development report (https://thoughtworks.medium.com/spec-driven-development-d85995a81387)
- GitHub Spec Kit adoption (https://developer.microsoft.com/blog/spec-driven-development-spec-kit)
- Common complaints about spec-driven tools on Reddit, HN, Discord
- What makes people drop back to "vibe coding"
- Cursor/Windsurf UX patterns that reduce friction
- How much ceremony is too much? Where's the line?

**Deliverable:** For each finding, document:
1. The friction point or praise (direct quotes where possible)
2. Root cause (too much ceremony? too slow? not enough value? bad defaults?)
3. How it maps to spec-context-mcp's current workflow
4. Severity: annoyance vs dealbreaker

**Apply to spec-context-mcp:** Our workflow requires Requirements -> Design -> Tasks -> Implementation with 3 approval gates before any code is written. This is thorough but potentially heavy for small features. No "quick mode" for simple changes. No escape hatch for experienced users who know what they want. The brainstorm guide is optional but there's no lightweight alternative to the full spec flow.

---

## YAGNI Gate

**Gatekeeper Persona: The Skeptic**
You have seen too many projects bloat themselves to death by adopting every shiny pattern from every blog post. Your job is to kill recommendations that don't earn their place. You are not mean — you are honest. You respect the researchers' work but you hold the line: if it doesn't pass ALL five gates, it doesn't ship. You write a clear, one-sentence reason for every rejection so the team understands and doesn't re-propose it next quarter.

Every recommendation from the 5 tracks MUST pass ALL of these criteria to become an action item:

### Gate 1: Evidence
Is there concrete evidence (measurements, user reports, production data) that this pattern improves outcomes? Reject patterns that are theoretically appealing but unproven. "Manus does it" is not evidence — "Manus reported X% improvement in Y" is.

### Gate 2: Problem Exists
Does spec-context-mcp actually have the problem this pattern solves? Not "could theoretically have" — actually has today. Cite a specific scenario where a real user would hit this.

### Gate 3: Incremental
Can this be implemented incrementally without rewriting existing working systems? If it requires redesigning dispatch-runtime or the tool registry from scratch, it's too big. Break it down or reject.

### Gate 4: Token Budget
Does this pattern reduce net tokens consumed, or at worst break even? Reject patterns that add context "just in case." Every token depletes the model's attention budget. If you can't estimate the token impact, the research was insufficient.

### Gate 5: Client Agnostic
Does this work across MCP clients (Claude Code, Codex, Cursor, etc.)? Reject patterns that only work with one CLI's specific features. We are an MCP server — our advantage is protocol-level integration, not CLI tricks.

---

## Synthesis

### Synthesis Persona: **The Research Director** (you)
You are pragmatic, technical, and allergic to hype. You've read all 5 track reports. Now you merge, deduplicate, and rank. You look for patterns that multiple tracks converge on — if The Archaeologist and The Accountant both point to the same solution from different angles, that's a strong signal. You also look for contradictions — if The General wants parallel execution but The Quality Inspector has evidence it reduces quality, you resolve the conflict. You produce the final ranked list and you own every word.

After all 5 tracks complete, produce a single ranked list:

```markdown
## Recommendations (ranked by impact / effort)

### 1. [Name]
- **Track:** which research track(s)
- **Problem:** what spec-context-mcp problem it solves (specific scenario)
- **Pattern:** what to implement (1-2 paragraphs max)
- **Evidence:** concrete data supporting this (with source links)
- **YAGNI gates:** ✅ for each gate with one-line justification
- **Effort:** S/M/L with brief rationale
- **Files affected:** list of spec-context-mcp source files that would change
- **Depends on:** other recommendations that must come first (if any)

### 2. [Name]
...
```

### Rejected Patterns
For each rejected pattern:
```markdown
- **[Name]** — Rejected at Gate [N]: [one-sentence reason]
```

---

## Current Architecture Reference

spec-context-mcp is a Model Context Protocol server (TypeScript, Node.js) providing:

- **Tools:** spec-workflow-guide, steering-guide, spec-status, approvals, wait-for-approval, get-implementer-guide, get-reviewer-guide, get-brainstorm-guide, dispatch-runtime
- **Workflow:** Requirements -> Design -> Tasks -> Implementation with approval gates
- **Dispatch:** Orchestrator dispatches to implementer/reviewer subagents via CLI (claude, codex, gemini, opencode)
- **State:** .spec-context/specs/{name}/ with requirements.md, design.md, tasks.md
- **Steering:** .spec-context/steering/ with product.md, tech.md, structure.md, principles.md
- **Dashboard:** Web UI for approvals, task tracking, implementation logs
- **Discipline modes:** full (TDD+reviews), standard (reviews), minimal (verification only)
- **Tool visibility:** 3-tier progressive disclosure per session mode
- **Dispatch contracts:** Schema-validated structured output from implementer/reviewer agents
- **Tool result offloading:** Large results (>20k chars) saved to file, preview returned in context

## Output Protocol

### Phase 1: Raw Findings
Each researcher writes their track findings to a separate file:
- `docs/research/track-1-state-resumability.md`
- `docs/research/track-2-context-budget.md`
- `docs/research/track-3-orchestration.md`
- `docs/research/track-4-verification.md`
- `docs/research/track-5-developer-experience.md`

Each file follows the deliverable format specified in the track. No editorializing — raw findings with sources.

### Phase 2: Synthesis
The Research Director reads all 5 track files, then writes:
- `docs/research/synthesis-v1.md` — first pass: merged recommendations, YAGNI gate applied, ranked list + reject list

### Phase 3: Revision
The Research Director re-reads `synthesis-v1.md` with fresh eyes and asks:
- Did I let anything through the YAGNI gate that shouldn't have passed?
- Did I reject anything that deserved a second look?
- Are the effort estimates honest or optimistic?
- Do the dependency chains make sense?
- Would a developer reading this know exactly what to build?

Write the revised version to:
- `docs/research/synthesis-final.md` — final ranked recommendations, ready to become specs

If nothing changed, copy v1 to final with a note: "No revisions needed."

---

## Current Architecture Reference

Key source paths:
- `src/tools/workflow/dispatch-runtime.ts` — dispatch orchestration (~1800 lines)
- `src/tools/workflow/spec-workflow-guide.ts` — main workflow guide
- `src/tools/workflow/get-implementer-guide.ts` — implementer context loading
- `src/tools/workflow/get-reviewer-guide.ts` — reviewer context loading
- `src/tools/workflow/get-brainstorm-guide.ts` — brainstorm methodology
- `src/tools/workflow/dispatch-ledger.ts` — task progress tracking
- `src/tools/workflow/dispatch-executor.ts` — CLI execution engine
- `src/tools/workflow/dispatch-contract-schemas.ts` — output validation
- `src/tools/catalog.ts` — tool registry and visibility tiers
- `src/tools/index.ts` — tool runtime and result offloading
- `src/tools/registry.ts` — session mode and tier state machine
- `src/config/discipline.ts` — discipline mode config
- `src/core/routing/` — task complexity classification and routing
- `src/core/session/` — session fact store and extraction
- `src/core/cache/` — file content caching
