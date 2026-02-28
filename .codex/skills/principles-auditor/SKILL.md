---
name: principles auditor
description: key-principles compliance auditing workflow for Aegis Trader. Use when asked to audit the codebase against `.spec-context/steering/principles.md` key principles, to investigate/report correctness bugs found while tracing flows, or to produce audit artifacts (journals + writeups) under `docs/audit/`.
---

# principles.md Auditor

## Canonical Contract (Source of Truth)

- Open `docs/audit/AGENTS.md` and follow it verbatim (especially the “Full Audit Prompt” block).
- Auditor-only: never edit production code; only write audit artifacts under `docs/audit/`.
- Use MCP tools for code search (semantic → regex); read only files returned by search (unless given an exact path or it’s a config file).

If anything in this skill conflicts with `docs/audit/AGENTS.md`, treat `docs/audit/AGENTS.md` as authoritative.

## Workflow

### 1) Start journals (always writing)
- Ensure these files exist and have the required header:
  - `docs/audit/journal/refactors`
  - `docs/audit/journal/fixes`
- Append an entry before any multi-step investigation or >30s of thinking.

### 2) Load the contract (principles.md principles)
- Open `.spec-context/steering/principles.md`.
- Extract and enumerate principles as `P1..Pn` in the journal (short quote fragments OK).

### 3) Sweep the codebase (flow-tracing)
- MCP search first (semantic), then narrow/confirm (regex).
- Read closely and trace end-to-end execution/data flow before asserting a violation.
- For each candidate issue:
  - Journal hypothesis → confirm/discard (with evidence).
  - If confirmed, write exactly one markdown artifact:
    - principles non-compliance → `docs/audit/refactors/NN-<slug>.md`
    - Correctness bug → `docs/audit/fixes/NN-<slug>.md`
  - Record `Artifact:` in the journal entry.

### 4) Close-out (stop condition)
- Keep sweeping/journaling until the `docs/audit/AGENTS.md` stop condition is satisfied.

## Artifact Requirements (Checklist)

Follow the exact sections/fields specified in `docs/audit/AGENTS.md` for:
- Refactors writeups (`docs/audit/refactors/`)
- Fixes writeups (`docs/audit/fixes/`)
- Journal entry formatting (`docs/audit/journal/*`)

This skill intentionally bundles no additional resources; the canonical contract lives at `docs/audit/AGENTS.md`.
