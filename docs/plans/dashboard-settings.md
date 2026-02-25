# Dashboard-Editable Settings

## Problem

Model selection, discipline mode, and dispatch config live in `.env`. This makes them
invisible to the dashboard and uneditable at runtime. Users have to edit a file and
restart the MCP server to change models.

## Approach

Extend the existing `SettingsManager` + `GlobalSettings` to hold runtime-editable
settings alongside the automation jobs it already manages. Keep secrets (API keys) in
`.env` — only move non-secret tuning knobs to JSON.

## What moves out of `.env`

| Setting | Env var | Default |
|---|---|---|
| Discipline mode | `SPEC_CONTEXT_DISCIPLINE` | `full` |
| Implementer provider | `SPEC_CONTEXT_IMPLEMENTER` | (unset) |
| Reviewer provider | `SPEC_CONTEXT_REVIEWER` | (unset) |
| Implementer model (simple) | `SPEC_CONTEXT_IMPLEMENTER_MODEL_SIMPLE` | (unset) |
| Implementer model (complex) | `SPEC_CONTEXT_IMPLEMENTER_MODEL_COMPLEX` | (unset) |
| Reviewer model (simple) | `SPEC_CONTEXT_REVIEWER_MODEL_SIMPLE` | (unset) |
| Reviewer model (complex) | `SPEC_CONTEXT_REVIEWER_MODEL_COMPLEX` | (unset) |
| Implementer reasoning effort | `SPEC_CONTEXT_IMPLEMENTER_REASONING_EFFORT` | (unset) |
| Reviewer reasoning effort | `SPEC_CONTEXT_REVIEWER_REASONING_EFFORT` | (unset) |
| Dashboard URL | `DASHBOARD_URL` | `http://localhost:3000` |

## What stays in `.env`

- `EMBEDDING_API_KEY` / `VOYAGEAI_API_KEY` — secrets
- `OPENROUTER_API_KEY` — secret
- `EMBEDDING_PROVIDER`, `EMBEDDING_MODEL`, `EMBEDDING_RERANK_MODEL` — chunkhound-specific
- `CHUNKHOUND_*` — chunkhound-specific

## Design

### 1. Extend `GlobalSettings` type

```ts
// workflow-types.ts
export interface RuntimeSettings {
  discipline?: 'full' | 'standard' | 'minimal';
  implementer?: string;       // provider name
  reviewer?: string;          // provider name
  implementerModelSimple?: string;
  implementerModelComplex?: string;
  reviewerModelSimple?: string;
  reviewerModelComplex?: string;
  implementerReasoningEffort?: string;
  reviewerReasoningEffort?: string;
  dashboardUrl?: string;
}

export interface GlobalSettings {
  automationJobs: AutomationJob[];
  security?: SecurityConfig;
  runtimeSettings?: RuntimeSettings;  // <-- new
  createdAt?: string;
  lastModified?: string;
}
```

### 2. Resolution order

When the MCP server or dispatch runtime reads a setting:

1. `settings.json` → `runtimeSettings.discipline` (if set)
2. `process.env.SPEC_CONTEXT_DISCIPLINE` (fallback)
3. hardcoded default

This lets `.env` still work as a baseline, with dashboard overrides taking priority.
One helper function: `resolveSettings(): RuntimeSettings` that merges both sources.

### 3. SettingsManager additions

Add to existing `SettingsManager`:

```ts
async getRuntimeSettings(): Promise<RuntimeSettings>
async updateRuntimeSettings(updates: Partial<RuntimeSettings>): Promise<void>
```

These read/write the `runtimeSettings` key within the existing `settings.json`.
No new files, no new storage — just a new section of the existing JSON.

### 4. Dashboard API routes

Add to the dashboard Fastify server:

- `GET /api/settings/runtime` — returns current merged settings
- `PUT /api/settings/runtime` — updates runtime settings

### 5. Dashboard UI

A settings page (or panel) with:
- Dropdown for discipline mode (full / standard / minimal)
- Text/dropdown for implementer and reviewer providers
- Text inputs for model overrides
- Dropdowns for reasoning effort (low / medium / high)
- Save button → `PUT /api/settings/runtime`
- Show which values come from `.env` vs dashboard (greyed out defaults)

### 6. MCP server picks up changes

Two options (pick one):
- **Simple**: Re-read `settings.json` on each tool call (it's a small file, cheap)
- **Watch**: `fs.watch` on `settings.json`, update in-memory cache on change

Simple is fine for personal use. No restart needed either way.

## Scope

- Extend `GlobalSettings` and `SettingsManager` (small)
- Add `resolveSettings()` helper that replaces direct `process.env` reads (medium — need to find all env var read sites)
- Two new API routes (small)
- One new dashboard page (medium)
- Update `.env.example` to note which settings are dashboard-editable (trivial)

## Out of scope

- Per-project settings overrides (not needed yet)
- Editing API keys from dashboard (security concern)
- Live WebSocket push of settings changes (overkill)
