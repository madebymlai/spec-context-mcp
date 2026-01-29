# 04 Config and Version Unification

## Goal
Centralize version and default port configuration to prevent drift across files.

## Rationale
Version is hard-coded in multiple places and defaults conflict (e.g., dashboard port 3000 vs security default 5000). This causes inconsistent behavior and confusing logs.

## Scope
- Single source of truth for version and default port.
- Optional: typed env/config loader for server and dashboard.

## Tasks
- Read version from `package.json` at runtime and inject into server/CLI/help outputs.
- Define a shared default dashboard port and use it in dashboard CLI and security config.
- Remove hardcoded version strings in `src/config.ts` and `src/bridge/chunkhound-bridge.ts` if possible.

## Acceptance
- One authoritative version value shown everywhere.
- Default dashboard port is consistent across server, CLI, and security layers.
