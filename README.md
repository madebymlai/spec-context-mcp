# spec-context-mcp

Unified MCP server combining semantic code search with spec-driven development workflow.

## Features

- **Semantic Code Search**: Index your codebase and search using natural language via ChunkHound (local index)
- **Spec Workflow**: Requirements → Design → Tasks → Implementation with approval gates
- **Dashboard UI**: Web interface for managing specs, approvals, and implementation logs
- **Multi-Project Support**: Each project gets its own ChunkHound index and spec directory

## Installation

```bash
npm install -g spec-context-mcp
```

Or run directly with npx:

```bash
npx spec-context-mcp
```

## Python Setup (Required for Semantic Search)

ChunkHound requires Python 3.10+ for semantic code search. Run the setup command:

```bash
npx spec-context-mcp setup
```

This will:
- Detect Python 3.10+ on your system
- Create a virtual environment in the package directory
- Install ChunkHound and dependencies
- Verify the installation

**Manual Setup** (if automatic setup fails):

```bash
# macOS
brew install cmake ninja swig python@3.11

# Ubuntu/Debian
sudo apt install cmake ninja-build swig python3.11 python3.11-venv

# Fedora
sudo dnf install cmake ninja-build swig python3.11

# Then install manually
cd $(npm root -g)/spec-context-mcp
python3 -m venv .venv
.venv/bin/pip install -e .

# Optionally set CHUNKHOUND_PYTHON in your environment
export CHUNKHOUND_PYTHON=$(npm root -g)/spec-context-mcp/.venv/bin/python
```

Run `npx spec-context-mcp doctor` to verify your setup.

## Configuration

Add to your Claude Code config (`.mcp.json` in project root):

```json
{
  "mcpServers": {
    "spec-context": {
      "command": "npx",
      "args": ["spec-context-mcp"],
      "env": {
        "EMBEDDING_PROVIDER": "voyageai",
        "EMBEDDING_API_KEY": "sk-embed-xxx",
        "EMBEDDING_MODEL": "voyage-code-3",
        "DASHBOARD_URL": "http://localhost:3000"
      }
    }
  }
}
```

### Environment Variables

| Variable              | Required | Description                                               |
|-----------------------|----------|-----------------------------------------------------------|
| `EMBEDDING_PROVIDER`  | No       | Embedding provider for ChunkHound (default: `voyageai`)                  |
| `EMBEDDING_API_KEY`   | Conditional | API key for embedding provider (required for hosted providers)       |
| `EMBEDDING_MODEL`     | No       | Embedding model name (provider-specific)                               |
| `EMBEDDING_BASE_URL`  | No       | Base URL for embedding API (e.g., OpenAI-compatible endpoints)         |
| `EMBEDDING_RERANK_MODEL` | No    | Reranking model name (enables multi-hop search)                        |
| `EMBEDDING_RERANK_URL` | No     | Rerank endpoint URL (absolute or relative to base URL)                 |
| `EMBEDDING_RERANK_FORMAT` | No  | Reranking API format (`auto`, `cohere`, `tei`)                         |
| `EMBEDDING_RERANK_BATCH_SIZE` | No | Max docs per rerank batch                                            |
| `EMBEDDING_DIMENSION` | No       | Optional; currently ignored (model defines dimensions)                 |
| `VOYAGEAI_API_KEY`    | No       | Alias for `EMBEDDING_API_KEY` when provider is `voyageai`              |
| `OPENAI_API_KEY`      | No       | Alias for `EMBEDDING_API_KEY` when provider is `openai`                |
| `CHUNKHOUND_PYTHON`   | No       | Python executable for ChunkHound (default: auto-detect `.venv/bin/python`, else `python3`) |
| `DASHBOARD_URL`       | No       | Dashboard URL shown in prompts (default: `http://localhost:3000`) |
| `OPENROUTER_API_KEY`  | No       | Required only for dashboard AI review                     |
| `SPEC_CONTEXT_DISABLE_VERSION_CHECK` | No | Disable dashboard startup version check (default: `false`) |
| `CHUNKHOUND_EMBED_SWEEP_SECONDS` | No | Periodic safety sweep for missing embeddings (default: `300`) |
| `CHUNKHOUND_EMBED_SWEEP_BACKOFF_SECONDS` | No | Skip sweep if recent per-file embeds occurred (default: `30`) |
| `CHUNKHOUND_FILE_QUEUE_MAXSIZE` | No | Max realtime file queue size (default: `2000`, 0 = unbounded) |
| `CHUNKHOUND_FILE_QUEUE_DRAIN_SECONDS` | No | Interval to drain overflowed file queue entries (default: `1.0`) |
| `SPEC_CONTEXT_DISCIPLINE` | No | Discipline mode: `full` (TDD+reviews), `standard` (reviews), `minimal` (verification only). Default: `full` |
| `SPEC_CONTEXT_IMPLEMENTER` | No | CLI command for implementer dispatch (e.g., `claude`, `codex`) |
| `SPEC_CONTEXT_REVIEWER` | No | CLI command for reviewer dispatch |
| `SPEC_CONTEXT_BRAINSTORM` | No | CLI command for brainstorm dispatch |

### Discipline Modes

Control development rigor via `SPEC_CONTEXT_DISCIPLINE`:

| Mode | TDD | Code Reviews | Verification |
|------|-----|--------------|--------------|
| `full` (default) | Yes | Yes | Yes |
| `standard` | No | Yes | Yes |
| `minimal` | No | No | Yes |

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
    ├── structure.md
    └── principles.md
```

## Semantic Search Setup

ChunkHound runs locally and stores its index in your project. No external vector
database is required. To enable semantic search, set `EMBEDDING_PROVIDER` and
`EMBEDDING_API_KEY` (or `VOYAGEAI_API_KEY` / `OPENAI_API_KEY`). If no embedding
API key is set, regex search and workflow tools still work.

You may also need Python 3.10+ available as `python3` (or set `CHUNKHOUND_PYTHON`).
The default embedding provider is `voyageai`; set `EMBEDDING_PROVIDER=openai` and
`EMBEDDING_BASE_URL` for OpenAI-compatible endpoints.

Note: ChunkHound's YAML parser uses `rapidyaml`/`ryml` (requires `rapidyaml>=0.10.0`).
PyPI currently ships an older `rapidyaml` build; install from the git tag `v0.10.0`
if you're managing the Python environment yourself.

## Development

```bash
npm install          # Install dependencies
npm run build        # Build server and dashboard
npm run dev          # Run in development mode
```

## Doctor

Run a preflight check for Python, ChunkHound, embeddings, and dashboard connectivity:

```bash
npx spec-context-mcp doctor
```

## License

MIT
