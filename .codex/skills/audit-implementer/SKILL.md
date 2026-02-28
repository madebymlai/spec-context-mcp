---
name: audit-implementer
description: Implement and validate remediation from audit artifacts under `docs/audit/` using the best principles-aligned solution. Use when a user pastes any path like `/home/laimk/git/aegis-trader/docs/audit/**` or `docs/audit/**` (including `fixes/*.md` and `refactors/*.md`) and asks to implement or apply the writeup. First evaluate whether the concern is valid and worth fixing now; if the proposal is overengineered or not worth implementing, mark the artifact `*_SKIP.md`. If implemented successfully, mark it `*_OK.md`. Commit the outcome.
---

# Audit Implementer

## Overview

Turn an audit writeup into an implemented, validated code change while preserving architecture and key-principle compliance.

## Workflow

1. Resolve scope and load inputs.
- Read the user-provided audit artifact first (for example `docs/audit/fixes/01-*.md`).
- Read `.spec-context/steering/principles.md` before coding.
- Read `.spec-context/steering/tech.md` when implementation constraints are unclear.

2. Start and maintain plan tracking with `update_plan`.
- Immediately create a plan with concrete steps (analysis, implementation, validation, summary).
- Keep exactly one `in_progress` step at a time.
- Update statuses after each completed phase and finish with all steps `completed`.

3. Analyze before editing.
- Extract required behavior from the audit artifact: symptom/impact, root cause, exact fix intent, validation commands, and risk notes.
- Trace the referenced code paths end-to-end; confirm the current code still matches the writeup assumptions.
- If the writeup is stale, adapt the implementation while preserving the same root-cause intent.

4. Make a fix/skip decision before implementation.
- Decide whether the concern is valid in the current codebase (real, reachable, and meaningful impact).
- Decide whether it is worth fixing now versus keeping as-is (severity, frequency, blast radius, roadmap fit, migration cost).
- Evaluate whether the proposed remediation is proportional or overengineered for the current scope.
- If concern is valid and remediation is proportional: proceed to implementation.
- If concern is invalid, not worth fixing now, or proposed fix is overengineered: do not implement code changes for this artifact, rename the artifact to `*_SKIP.md`, and report concise rationale.

5. Implement the best principles-aligned solution (only when decision is "fix now").
- Prefer root-cause remediation over minimal local patches.
- Follow `.spec-context/steering/principles.md` strictly; avoid defensive clutter and boundary leaks.
- Keep changes focused on the requested finding unless adjacent edits are required for correctness.

6. Validate with artifact commands first, then project checks (fix path only).
- Run the exact validation/tests specified by the audit artifact when available.
- Add targeted tests when behavior changed and coverage is missing.
- Report what was run and what could not run.

7. Mark the processed audit artifact outcome.
- Rename the processed audit markdown file by appending `_OK` before `.md`.
- Example: `01-some-fix.md` -> `01-some-fix_OK.md`.
- Apply `_OK` only after implementation and validation succeed.
- If decision is skip, rename by appending `_SKIP` before `.md` instead.
- Example: `01-some-fix.md` -> `01-some-fix_SKIP.md`.
- If the file already ends with `_OK.md` or `_SKIP.md`, do not rename again.

8. Commit the completed outcome.
- Create one commit that includes only files relevant to this finding (code/test changes when applicable plus the renamed audit artifact).
- Use a deterministic message:
  - Fix path: `audit: implement <artifact-slug>`
  - Skip path: `audit: skip <artifact-slug>`
- If repository state prevents a safe isolated commit, report the blocker explicitly.

9. Return a concise outcome report.
- List changed files and why each changed.
- State decision explicitly: `implemented` or `skipped`.
- For skip: include why concern/proposal was not actionable now.
- Summarize behavioral outcome and residual risks.
- Confirm plan completion state.
