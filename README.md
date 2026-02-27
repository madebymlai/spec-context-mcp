# spec-context-mcp

MCP server for spec-driven development workflow.

## Features

- **Spec Workflow**: Requirements → Design → Tasks → Implementation with approval gates
- **Dashboard UI**: Web interface for managing specs, approvals, and implementation logs
- **Multi-Project Support**: Each project gets its own spec directory

## Installation

```bash
npm install -g spec-context-mcp
```

Or run directly with npx:

```bash
npx spec-context-mcp
```

## Configuration

`spec-context-mcp` loads `.env` from the server package directory on startup.

If you run from source or a local clone, start from `.env.example`:

```bash
cp .env.example .env
# edit .env and set required keys
```

Then use a minimal MCP config (`.mcp.json` in your project):

```json
{
  "mcpServers": {
    "spec-context": {
      "command": "node",
      "args": ["/absolute/path/to/spec-context-mcp/dist/index.js"]
    }
  }
}
```

If you run via `npx` / global install, you can pass env directly in `.mcp.json` instead:

```json
{
  "mcpServers": {
    "spec-context": {
      "command": "npx",
      "args": ["spec-context-mcp"],
      "env": {
        "DASHBOARD_URL": "http://localhost:3000"
      }
    }
  }
}
```

### Environment Variables

| Variable              | Required | Description                                               |
|-----------------------|----------|-----------------------------------------------------------|
| `DASHBOARD_URL`       | No       | Dashboard URL shown in prompts (default: `http://localhost:3000`) |
| `OPENROUTER_API_KEY`  | No       | Required for dashboard AI review |
| `SPEC_CONTEXT_DISABLE_VERSION_CHECK` | No | Disable dashboard startup version check (default: `false`) |
| `SPEC_CONTEXT_DISCIPLINE` | No | Discipline mode: `full` (TDD+reviews), `standard` (reviews), `minimal` (verification only). Default: `full` |
| `SPEC_CONTEXT_IMPLEMENTER` | No | CLI command for implementer dispatch (shortcuts: `claude`, `codex`, `gemini`, `opencode`) |
| `SPEC_CONTEXT_REVIEWER` | No | CLI command for reviewer dispatch |

### Discipline Modes

Control development rigor via `SPEC_CONTEXT_DISCIPLINE`:

| Mode | TDD | Code Reviews | Verification |
|------|-----|--------------|--------------|
| `full` (default) | Yes | Yes | Yes |
| `standard` | No | Yes | Yes |
| `minimal` | No | No | Yes |

## Tools

### Spec Workflow

| Tool                    | Description                                           |
|-------------------------|-------------------------------------------------------|
| `spec-workflow-guide`   | Load the complete spec workflow guide                 |
| `steering-guide`        | Guide for creating project steering docs              |
| `spec-status`           | Check spec progress and task completion               |
| `approvals`             | Manage approval requests (request/status/delete)      |
| `get-implementer-guide` | Get implementation guidance (TDD, verification, feedback) |
| `get-reviewer-guide`    | Get code review criteria and checklist                |
| `get-brainstorm-guide`  | Get brainstorming methodology for pre-spec ideation   |

## Prompts

MCP prompts available as slash commands in Claude Code:

| Prompt                | Description                                    |
|-----------------------|------------------------------------------------|
| `create-spec`         | Create requirements, design, or tasks document |
| `create-steering-doc` | Create product, tech, or structure steering doc|
| `implement-task`      | Implement a task from a spec                   |
| `spec-status`         | Check current spec status                      |
| `refresh-tasks`       | Update tasks based on design changes           |

## Dashboard

Run the dashboard server:

```bash
npx spec-context-dashboard --port 3000
```

To skip the dashboard's startup version check, set `SPEC_CONTEXT_DISABLE_VERSION_CHECK=true`.

The dashboard provides:
- Project overview and stats
- Spec document viewer
- Task progress tracking
- Approval management
- Implementation logs

## Spec Workflow

```
Requirements → Design → Tasks → Implementation
     ↓           ↓        ↓           ↓
  Approval   Approval  Approval   Log & Complete
```

Each phase requires approval before proceeding. Documents are stored in:

```
.spec-context/
├── specs/
│   └── {spec-name}/
│       ├── requirements.md
│       ├── design.md
│       ├── tasks.md
│       └── Implementation Logs/
└── steering/            # Optional project docs
    ├── product.md
    ├── tech.md
    ├── structure.md
    └── principles.md
```

## Development

```bash
npm install          # Install dependencies
npm run build        # Build server and dashboard
npm run dev          # Run in development mode
```

## Doctor

Run a preflight check for dashboard connectivity:

```bash
npx spec-context-mcp doctor
```

## License

MIT
