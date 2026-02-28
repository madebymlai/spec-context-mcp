---
name: yagni-fixer
description: Audit active code paths for `.spec-context/steering/principles.md` violations and immediately implement the highest-value non-YAGNI fix. Use when users ask to find something worth fixing now, to apply principles fixes on the spot, or to avoid document-only audits.
---

# YAGNI Fixer

## Workflow

1. Load constraints.
- Read `.spec-context/steering/principles.md`.
- Read `.spec-context/steering/tech.md` only when architecture constraints are unclear.

2. Build a short candidate set from active runtime paths.
- Prefer entrypoints used by CLI/runtime services, not dead or test-only paths.
- Trace end-to-end call flow before deciding a violation is real.

3. Apply YAGNI gate before coding.
- Keep only candidates that are both:
  - principle-violating (clear mismatch to one or more principles), and
  - worth fixing now (meaningful impact/risk in current flows).
- Reject candidates that are speculative, low-impact, or broad refactors with weak near-term payoff.
- Broad refactors are allowed only when a small patch cannot remove the root cause in an active runtime path.
- A broad refactor is YAGNI-valid only if it reduces current correctness or safety risk now (not speculative future risk) and stays scoped to one flow/objective.

4. Select one best fix.
- Pick the highest leverage item by this order:
  - correctness/risk reduction,
  - blast radius and user impact,
  - implementation confidence,
  - smallest sufficient change.
- Prefer the smallest sufficient change; choose a broader refactor when it is the minimum reliable root-cause fix.
- Choose one concrete remediation path, not multiple alternatives, unless asked.

5. Implement immediately.
- Edit production code directly; do not create audit writeups by default.
- Add or update targeted tests for changed behavior.
- Keep changes focused on root cause, not cosmetic cleanup.

6. Validate with tests (required).
- Always run tests for the changed behavior before finishing.
- If no test currently covers the behavior, write a new targeted test and run it.
- Prefer running the smallest relevant test scope first, then broader checks if needed.

7. Report.
- Report:
  - what was fixed,
  - why it passed YAGNI,
  - files changed,
  - tests added/updated,
  - test commands run and outcomes,
  - residual risks.

## Rules

- Default output is code + tests, not `docs/audit/*` artifacts.
- Write documentation artifacts only when the user explicitly asks for documentation.
- Fail loud over silent fallback where principles demand it.
- Prefer dependency inversion, explicit contracts, and invalid-state prevention when selecting fixes.
- Do not mark work complete without executed tests proving the new behavior.
