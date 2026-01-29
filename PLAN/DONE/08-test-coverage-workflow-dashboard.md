# 08 Test Coverage for Workflow + Dashboard

## Goal
Add targeted tests for workflow tools and dashboard session/port behavior.

## Rationale
Only one dashboard test exists, leaving core flows unverified and regressions likely.

## Scope
- Workflow tools: approvals, wait-for-approval, spec-status.
- Dashboard session discovery and port handling.

## Tasks
- Add unit tests for dashboard session manager and dashboard URL discovery.
- Add tool tests for happy-path and failure conditions.
- Ensure tests run via existing `vitest` setup.

## Acceptance
- Key workflow tool paths have tests.
- Non-default dashboard port is covered by tests.
