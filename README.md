# spec-context-mcp

Unified MCP server combining semantic code search with spec-driven development workflow.

## Features

- **Semantic Code Search**: Index your codebase and search using natural language via Qdrant
- **Spec Workflow**: Requirements → Design → Tasks → Implementation with approval gates
- **Dashboard UI**: Web interface for managing specs, approvals, and implementation logs
- **Multi-Project Support**: Each project gets its own vector collection and spec directory

## Installation

```bash
npm install -g spec-context-mcp
```

Or run directly with npx:

```bash
npx spec-context-mcp
```

## Configuration

Add to your Claude Code config (`.mcp.json` in project root):

```json
{
  "mcpServers": {
    "spec-context": {
      "command": "npx",
      "args": ["spec-context-mcp"],
      "env": {
        "OPENROUTER_API_KEY": "sk-or-xxx",
        "QDRANT_URL": "http://localhost:6333",
        "DASHBOARD_URL": "https://your-dashboard.example.com"
      }
    }
  }
}
```

### Environment Variables

| Variable              | Required | Description                                               |
|-----------------------|----------|-----------------------------------------------------------|
| `OPENROUTER_API_KEY`  | Yes      | OpenRouter API key for embeddings                         |
| `QDRANT_URL`          | Yes      | Qdrant server URL                                         |
| `DASHBOARD_URL`       | No       | Dashboard URL for remote registration                     |
| `DASHBOARD_API_KEY`   | No       | API key for dashboard authentication                      |
| `EMBEDDING_MODEL`     | No       | Model for embeddings (default: `qwen/qwen3-embedding-8b`) |
| `EMBEDDING_DIMENSION` | No       | Vector dimension (default: `4096`)                        |
| `QDRANT_API_KEY`      | No       | Qdrant API key if auth enabled                            |
| `CHUNKHOUND_EMBED_SWEEP_SECONDS` | No | Periodic safety sweep for missing embeddings (default: `300`) |
| `CHUNKHOUND_EMBED_SWEEP_BACKOFF_SECONDS` | No | Skip sweep if recent per-file embeds occurred (default: `30`) |
| `CHUNKHOUND_FILE_QUEUE_MAXSIZE` | No | Max realtime file queue size (default: `2000`, 0 = unbounded) |

## Tools

### Code Search

| Tool                 | Description                                  |
|----------------------|----------------------------------------------|
| `index_codebase`     | Index a codebase for semantic search         |
| `search_code`        | Search code using natural language           |
| `sync_index`         | Incrementally update index with changed files|
| `get_indexing_status`| Check if codebase is indexed                 |
| `clear_index`        | Remove codebase from index                   |

### Spec Workflow

| Tool                  | Description                                           |
|-----------------------|-------------------------------------------------------|
| `spec-workflow-guide` | Load the complete spec workflow guide                 |
| `steering-guide`      | Guide for creating project steering docs              |
| `spec-status`         | Check spec progress and task completion               |
| `approvals`           | Manage approval requests (request/status/delete)      |

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
npx spec-context-mcp dashboard --port 3000
```

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
├── templates/           # Auto-populated templates
├── specs/
│   └── {spec-name}/
│       ├── requirements.md
│       ├── design.md
│       ├── tasks.md
│       └── Implementation Logs/
└── steering/            # Optional project docs
    ├── product.md
    ├── tech.md
    └── structure.md
```

## Setting up Qdrant

### Docker

```bash
docker run -p 6333:6333 -v qdrant_storage:/qdrant/storage qdrant/qdrant
```

### With authentication

```bash
docker run -p 6333:6333 \
  -e QDRANT__SERVICE__API_KEY=your-api-key \
  -v qdrant_storage:/qdrant/storage \
  qdrant/qdrant
```

## Development

```bash
npm install          # Install dependencies
npm run build        # Build server and dashboard
npm run dev          # Run in development mode
```

## License

MIT
