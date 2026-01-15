# spec-context-mcp

Unified MCP server for semantic code search and spec-driven development.

## Features

- **Semantic Code Search**: Index your codebase and search using natural language
- **Multi-Project Support**: Each project gets its own vector collection
- **OpenRouter Integration**: Use any embedding model via OpenRouter API
- **Qdrant Backend**: Self-hosted vector database for privacy and control

## Installation

```bash
npm install -g spec-context-mcp
```

Or run directly with npx:

```bash
npx spec-context-mcp
```

## Configuration

Required environment variables:

| Variable | Description |
|----------|-------------|
| `OPENROUTER_API_KEY` | Your OpenRouter API key |
| `QDRANT_URL` | Qdrant server URL (e.g., `http://localhost:6333`) |

Optional:

| Variable | Default | Description |
|----------|---------|-------------|
| `EMBEDDING_MODEL` | `qwen/qwen3-embedding-8b` | Embedding model to use |
| `EMBEDDING_DIMENSION` | `4096` | Vector dimension |
| `QDRANT_API_KEY` | - | Qdrant API key if auth enabled |

## Usage with Claude Desktop

Add to your Claude Desktop config (`~/.config/claude-desktop/config.json` or equivalent):

```json
{
  "mcpServers": {
    "spec-context": {
      "command": "npx",
      "args": ["spec-context-mcp"],
      "env": {
        "OPENROUTER_API_KEY": "sk-or-xxx",
        "QDRANT_URL": "http://your-server:6333"
      }
    }
  }
}
```

## Tools

### `index_codebase`

Index a codebase for semantic search.

```json
{
  "path": "/path/to/project",
  "force": false,
  "customExtensions": [".ts", ".py"],
  "ignorePatterns": ["test/**"]
}
```

### `search_code`

Search indexed code using natural language.

```json
{
  "path": "/path/to/project",
  "query": "function that handles user authentication",
  "limit": 10,
  "extensionFilter": [".ts"]
}
```

### `clear_index`

Remove a codebase from the index.

```json
{
  "path": "/path/to/project"
}
```

### `get_indexing_status`

Check if a codebase is indexed.

```json
{
  "path": "/path/to/project"
}
```

## Setting up Qdrant

### Docker (recommended)

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

Then set `QDRANT_API_KEY` in your environment.

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Run in development
npm run dev
```

## License

MIT
