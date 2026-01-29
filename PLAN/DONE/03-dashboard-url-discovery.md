# 03 Dashboard URL Discovery

## Goal
Remove hardcoded dashboard URLs and consistently discover the active dashboard port/URL.

## Rationale
Server registers only to `127.0.0.1:3000`, and tools default to 3000 even if dashboard runs elsewhere. This breaks approvals and status workflows.

## Scope
- Use dashboard session data when available.
- Fall back to env var / default when session not present.

## Tasks
- Use `DashboardSessionManager` to resolve the active dashboard URL in `src/server.ts` and workflow tools.
- Update default fallback in `src/tools/index.ts` and `src/tools/workflow/wait-for-approval.ts`.
- Ensure `DASHBOARD_URL` can still override when explicitly set.

## Acceptance
- Approvals and waiting work when dashboard runs on a non-default port.
- No hardcoded `127.0.0.1:3000` remains in runtime logic.
