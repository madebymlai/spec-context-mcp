# 02 Product Naming Normalization

## Goal
Remove legacy "spec-workflow-mcp" naming so CLI output, UI, and errors are consistent with spec-context-mcp.

## Rationale
Multiple user-facing strings still reference the old package name and commands, which is confusing and makes instructions incorrect.

## Scope
- Update names in CLI help, error messages, dashboard UI, and workflow tool responses.

## Tasks
- Replace "spec-workflow-mcp" with "spec-context-mcp" and "spec-context-dashboard" where appropriate in:
  - `src/tools/workflow/approvals.ts`
  - `src/tools/workflow/wait-for-approval.ts`
  - `src/tools/workflow/steering-guide.ts`
  - `src/tools/workflow/spec-workflow-guide.ts`
  - `src/core/workflow/global-dir.ts`
  - `src/dashboard/multi-server.ts`
  - `src/dashboard_frontend/src/modules/app/App.tsx`
- Audit for old package scope references and update accordingly.

## Acceptance
- No user-facing string instructs to run the old package.
- UI banner and CLI instructions match the package name in `package.json`.
