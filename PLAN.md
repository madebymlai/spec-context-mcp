# Create spec-context-mcp: Unified MCP Server #54

## Summary

Create a unified MCP server that combines semantic code search (from claude-context) with structured spec-driven development workflow (from spec-workflow-mcp). The server will use Qdrant instead of Milvus for vector storage, support multiple projects simultaneously, and provide a single MCP server for both code understanding and development workflow management.

## Project Structure

```
spec-context-mcp/
├── package.json
├── tsconfig.json
├── .gitignore
├── README.md
├── src/
│   ├── index.ts                    # Entry point (CLI + MCP server startup)
│   ├── server.ts                   # MCP server setup, tool registration
│   ├── config.ts                   # Configuration management
│   │
│   ├── core/                       # Core functionality (from claude-context)
│   │   ├── context.ts              # Main Context class for indexing/search
│   │   ├── types.ts                # Shared types
│   │   │
│   │   ├── splitter/               # Code splitting
│   │   │   ├── index.ts
│   │   │   ├── ast-splitter.ts     # AST-based code splitting
│   │   │   └── langchain-splitter.ts
│   │   │
│   │   ├── embedding/              # Embedding providers
│   │   │   ├── index.ts
│   │   │   ├── types.ts            # Embedding interface
│   │   │   └── openrouter-embedding.ts  # OpenRouter (unified API)
│   │   │
│   │   ├── vectordb/               # Vector database abstraction
│   │   │   ├── index.ts
│   │   │   ├── types.ts            # VectorDatabase interface
│   │   │   └── qdrant-vectordb.ts  # NEW: Qdrant implementation
│   │   │
│   │   └── sync/                   # File synchronization
│   │       ├── merkle.ts           # Merkle tree for change detection
│   │       └── synchronizer.ts     # File change tracking
│   │
│   ├── tools/                      # MCP tool implementations
│   │   ├── index.ts                # Tool registration and dispatch
│   │   │
│   │   ├── context/                # Code context tools (from claude-context)
│   │   │   ├── index-codebase.ts
│   │   │   ├── search-code.ts
│   │   │   ├── clear-index.ts
│   │   │   └── get-indexing-status.ts
│   │   │
│   │   └── workflow/               # Spec workflow tools (from spec-workflow-mcp)
│   │       ├── spec-workflow-guide.ts
│   │       ├── steering-guide.ts
│   │       ├── spec-status.ts
│   │       ├── approvals.ts
│   │       └── log-implementation.ts
│   │
│   ├── prompts/                    # MCP prompts (from spec-workflow-mcp)
│   │   ├── index.ts                # Prompt registration
│   │   ├── types.ts                # Prompt types
│   │   ├── create-spec.ts          # Create new spec prompt
│   │   ├── create-steering-doc.ts  # Create steering doc prompt
│   │   ├── implement-task.ts       # Implement task prompt
│   │   ├── inject-spec-workflow-guide.ts
│   │   ├── inject-steering-guide.ts
│   │   ├── refresh-tasks.ts        # Refresh tasks prompt
│   │   └── spec-status.ts          # Spec status prompt
│   │
│   ├── workflow/                   # Spec workflow core (from spec-workflow-mcp)
│   │   ├── parser.ts               # Spec markdown parser
│   │   ├── task-parser.ts          # Task extraction from markdown
│   │   ├── task-validator.ts       # Task format validation
│   │   ├── path-utils.ts           # Path utilities
│   │   ├── workspace-initializer.ts
│   │   ├── global-dir.ts           # Global directory management
│   │   ├── archive-service.ts      # Spec archival
│   │   ├── project-registry.ts     # Multi-project registry
│   │   ├── security-utils.ts       # Path validation, sanitization
│   │   └── implementation-log-migrator.ts  # Log format migration
│   │
│   └── utils/                      # Utilities
│       ├── index.ts
│       └── env-manager.ts          # Environment variable management
│
├── templates/                      # Spec workflow templates (from src/markdown/templates/)
│   ├── requirements-template.md
│   ├── design-template.md
│   ├── tasks-template.md
│   ├── product-template.md
│   ├── tech-template.md
│   └── structure-template.md
│
└── test/                           # Tests
    ├── qdrant-vectordb.test.ts
    └── integration.test.ts
```

## Files to Modify/Create

### New Files (to create)

1. **`src/core/vectordb/qdrant-vectordb.ts`** - Qdrant implementation of VectorDatabase interface
2. **`src/index.ts`** - Unified entry point
3. **`src/server.ts`** - MCP server with all tools
4. **`src/config.ts`** - Configuration for Qdrant, embeddings, projects
5. **`src/tools/index.ts`** - Combined tool registration
6. **`package.json`** - Dependencies including @qdrant/js-client-rest

### Files to Copy from claude-context

**Core** (`packages/core/src/`):
- `context.ts` - Modify to use project-aware collections
- `types.ts`
- `splitter/*` - Copy as-is
- `embedding/openai-embedding.ts` - Use as reference for OpenRouter (same OpenAI-compatible API)
- `vectordb/types.ts` - Copy interface definition only
- `sync/*` - Copy as-is

**MCP** (`packages/mcp/src/`):
- `handlers.ts` - Adapt for tool implementations
- `snapshot.ts` - Codebase snapshot management
- `sync.ts` - Background sync
- `utils.ts` - Utility functions

### Files NOT to Copy from claude-context (Zilliz/Milvus-specific)

These files are Milvus/Zilliz Cloud specific and will be replaced with Qdrant:

```
packages/core/src/vectordb/
├── milvus-vectordb.ts         # SKIP - Replace with qdrant-vectordb.ts
├── milvus-restful-vectordb.ts # SKIP - Milvus REST API
└── zilliz-utils.ts            # SKIP - Zilliz Cloud cluster management

packages/mcp/src/
├── config.ts                  # REWRITE - Remove Milvus/Zilliz config, add Qdrant
├── embedding.ts               # KEEP but remove Zilliz references
```

Also skip:
- `packages/chrome-extension/` - Browser extension (not needed)
- `packages/vscode-extension/` - VS Code extension (not needed)
- `examples/` - Examples reference Zilliz
- `evaluation/` - Evaluation scripts

### Files to Copy from spec-workflow-mcp

**Tools** (`src/tools/`):
- `tools/spec-workflow-guide.ts`
- `tools/steering-guide.ts`
- `tools/spec-status.ts`
- `tools/approvals.ts`
- `tools/log-implementation.ts`

**Prompts** (`src/prompts/`):
- `prompts/index.ts`
- `prompts/types.ts`
- `prompts/create-spec.ts`
- `prompts/create-steering-doc.ts`
- `prompts/implement-task.ts`
- `prompts/inject-spec-workflow-guide.ts`
- `prompts/inject-steering-guide.ts`
- `prompts/refresh-tasks.ts`
- `prompts/spec-status.ts`

**Workflow Core** (`src/core/` → `src/workflow/`):
- `core/parser.ts`
- `core/task-parser.ts`
- `core/task-validator.ts`
- `core/path-utils.ts`
- `core/workspace-initializer.ts`
- `core/global-dir.ts`
- `core/archive-service.ts`
- `core/project-registry.ts`
- `core/security-utils.ts`
- `core/implementation-log-migrator.ts`

**Templates** (`src/markdown/templates/` → `templates/`):
- `requirements-template.md`
- `design-template.md`
- `tasks-template.md`
- `product-template.md`
- `tech-template.md`
- `structure-template.md`

**NOT copying** (dashboard-specific, not needed for MCP):
- `src/dashboard/*` - Web dashboard server
- `src/dashboard_frontend/*` - React frontend
- `core/dashboard-session.ts` - Dashboard session management

## Steps

### Phase 1: Project Setup (Steps 1-3)

**Step 1: Initialize TypeScript Project**

Create the project structure with proper TypeScript configuration.

- Initialize npm project with `npm init`
- Configure `tsconfig.json` for ES modules, strict mode, Node.js target
- Set up `.gitignore` for node_modules, dist, .env
- Dependencies to install:
  - `@modelcontextprotocol/sdk` - MCP SDK
  - `@qdrant/js-client-rest` - Qdrant client
  - `openai` - OpenAI embeddings
  - `@google/generative-ai` - Gemini embeddings
  - `tree-sitter`, `tree-sitter-typescript`, `tree-sitter-python`, etc. - AST parsing
  - `langchain` - Fallback text splitting
  - `dotenv` - Environment variables

**Step 2: Copy Core Infrastructure from claude-context**

Copy the following modules with minimal modification:

- `src/core/splitter/*` - AST-based code splitting (copy as-is)
- `src/core/embedding/*` - All embedding providers (copy as-is)
- `src/core/sync/*` - Merkle tree and synchronizer (copy as-is)
- `src/core/vectordb/types.ts` - VectorDatabase interface (copy as-is)
- `src/utils/env-manager.ts` - Environment management (copy as-is)

**Step 3: Copy Workflow Infrastructure from spec-workflow-mcp**

Copy the following modules:

- `src/workflow/parser.ts` - Spec markdown parsing
- `src/workflow/task-parser.ts` - Task extraction
- `src/workflow/task-validator.ts` - Format validation
- `src/workflow/path-utils.ts` - Path utilities
- `src/workflow/workspace-initializer.ts` - Initialize .spec-workflow directory
- `src/workflow/approval-storage.ts` - Approval state (file-based)
- `src/workflow/implementation-log-manager.ts` - Implementation logging
- `templates/*` - All spec templates

### Phase 2: Qdrant Integration (Steps 4-6)

**Step 4: Implement QdrantVectorDB Class**

Create `src/core/vectordb/qdrant-vectordb.ts` implementing the VectorDatabase interface.

Key design decisions:
- Use `@qdrant/js-client-rest` client library
- Connect to dedicated Qdrant server (configured via `QDRANT_URL`)
- Support both dense vectors (semantic search) and sparse vectors (hybrid search)

Methods to implement (12 total):

```typescript
interface VectorDatabase {
  // Collection management
  createCollection(collectionName: string, dimension: number, description?: string): Promise<void>;
  createHybridCollection(collectionName: string, dimension: number, description?: string): Promise<void>;
  dropCollection(collectionName: string): Promise<void>;
  hasCollection(collectionName: string): Promise<boolean>;
  listCollections(): Promise<string[]>;

  // Document operations
  insert(collectionName: string, documents: VectorDocument[]): Promise<void>;
  insertHybrid(collectionName: string, documents: VectorDocument[]): Promise<void>;
  delete(collectionName: string, ids: string[]): Promise<void>;

  // Search operations
  search(collectionName: string, queryVector: number[], options?: SearchOptions): Promise<VectorSearchResult[]>;
  hybridSearch(collectionName: string, searchRequests: HybridSearchRequest[], options?: HybridSearchOptions): Promise<HybridSearchResult[]>;

  // Query
  query(collectionName: string, filter: string, outputFields: string[], limit?: number): Promise<Record<string, any>[]>;

  // Utility
  checkCollectionLimit(): Promise<boolean>; // Always return true for Qdrant (no limit)
}
```

Qdrant-specific implementation notes:
- Use `QdrantClient` from `@qdrant/js-client-rest`
- Collection names: Keep MD5 hash approach for project namespacing
- Schema mapping:
  - `id` (string) -> Qdrant point ID (use UUID from hash)
  - `vector` (float[]) -> Qdrant vector
  - `content`, `relativePath`, etc. -> Qdrant payload
- Filter expressions: Translate Milvus-style to Qdrant filter syntax
- Hybrid search: Use Qdrant's built-in sparse vector support or implement RRF manually

**Step 5: Implement Collection Naming Strategy**

Each project gets its own collection, namespaced by path hash.

```typescript
function getCollectionName(projectPath: string, isHybrid: boolean = true): string {
  const normalizedPath = path.resolve(projectPath);
  const hash = crypto.createHash('md5').update(normalizedPath).digest('hex');
  const prefix = isHybrid ? 'hybrid_code_chunks' : 'code_chunks';
  return `${prefix}_${hash.substring(0, 8)}`;
}
```

This approach:
- Allows multiple projects to coexist in one Qdrant instance
- Keeps collection names short and URL-safe
- Maintains compatibility with existing claude-context behavior

**Step 6: Adapt Context Class for Qdrant**

Modify `src/core/context.ts` to:
- Accept QdrantVectorDB as the vector database implementation
- Use project-aware collection naming
- Support multi-project scenarios (no singleton pattern)

### Phase 3: Tool Implementation (Steps 7-10)

**Step 7: Implement Code Context Tools**

Create tools in `src/tools/context/`:

1. **`index-codebase.ts`**
   - Input: `{ path: string, force?: boolean, splitter?: 'ast' | 'langchain', customExtensions?: string[], ignorePatterns?: string[] }`
   - Indexes a project's codebase for semantic search
   - Creates collection if needed, processes files, generates embeddings
   - Progress callback support for status updates

2. **`search-code.ts`**
   - Input: `{ path: string, query: string, limit?: number, extensionFilter?: string[] }`
   - Performs semantic search in indexed codebase
   - Returns code snippets with file paths and line numbers

3. **`clear-index.ts`**
   - Input: `{ path: string }`
   - Drops the collection for a project

4. **`get-indexing-status.ts`**
   - Input: `{ path: string }`
   - Returns current indexing state (not indexed, indexing, indexed, failed)

**Step 8: Implement Spec Workflow Tools**

Create tools in `src/tools/workflow/`:

1. **`spec-workflow-guide.ts`**
   - Input: `{}`
   - Returns the complete spec workflow guide (Requirements -> Design -> Tasks -> Implementation)

2. **`steering-guide.ts`**
   - Input: `{}`
   - Returns the steering document creation guide

3. **`spec-status.ts`**
   - Input: `{ specName: string, projectPath?: string }`
   - Returns current spec phase and task progress

4. **`approvals.ts`**
   - Input: `{ action: 'request' | 'status' | 'delete', ... }`
   - Manages approval workflow via file-based storage

5. **`log-implementation.ts`**
   - Input: `{ specName: string, taskId: string, summary: string, artifacts: {...}, ... }`
   - Records implementation details for completed tasks

**Step 9: Create Unified Tool Registry**

Create `src/tools/index.ts` that:
- Exports `registerTools()` returning all 9 tools
- Exports `handleToolCall(name, args, context)` for dispatching

**Step 10: Create MCP Server**

Create `src/server.ts`:
- Initialize MCP server with all tools
- Handle `ListToolsRequestSchema` and `CallToolRequestSchema`
- Support both stdio transport (for Claude Desktop) and potential HTTP (for dashboard)
- Context injection for project path, dashboard URL, etc.

### Phase 4: Configuration and Entry Point (Steps 11-12)

**Step 11: Create Configuration Module**

Create `src/config.ts`:

```typescript
interface SpecContextConfig {
  // Server identity
  name: string;
  version: string;

  // Embedding configuration (OpenRouter only)
  openrouterApiKey: string;
  embeddingModel: string;  // default: 'qwen/qwen3-embedding-8b'
  embeddingDimension: number;  // default: 4096

  // Qdrant configuration (dedicated server)
  qdrantUrl: string;  // Required - dedicated vector DB server
  qdrantApiKey?: string;

  // Project configuration
  defaultProjectPath?: string;
}
```

Environment variables:
- `OPENROUTER_API_KEY` (required)
- `EMBEDDING_MODEL` (default: `qwen/qwen3-embedding-8b`)
- `EMBEDDING_DIMENSION` (default: `4096`)
- `QDRANT_URL` (required - dedicated vector DB server)
- `QDRANT_API_KEY` (optional)

**Step 12: Create Entry Point**

Create `src/index.ts`:
- Parse CLI arguments
- Support `--help` flag
- Create configuration from environment
- Initialize Context with Qdrant and embedding provider
- Start MCP server with stdio transport

### Phase 5: Testing and Documentation (Steps 13-14)

**Step 13: Add Integration Tests**

Create tests for:
- QdrantVectorDB operations (create/drop collection, insert, search)
- Full indexing and search flow
- Spec workflow tool handlers

**Step 14: Create README.md**

Document:
- Installation instructions
- Configuration (environment variables)
- Usage with Claude Desktop / Claude CLI
- Tool descriptions and examples

## Edge Cases

1. **Qdrant Connection Failure**
   - Retry with exponential backoff
   - Clear error message if Qdrant is unreachable

2. **Collection Already Exists**
   - Skip creation if exists (unless force=true)
   - Support force re-indexing

3. **Empty Codebase**
   - Return early with success and 0 files/chunks

4. **Large Files**
   - Respect AST splitter chunk limits
   - Log warnings for files generating many chunks

5. **Hybrid Search Without Sparse Vectors**
   - Qdrant doesn't have built-in BM25 like Milvus
   - Options: (a) dense-only search, (b) implement sparse vectors separately, (c) use full-text search payload index
   - Recommendation: Start with dense-only, add sparse later if needed

6. **Multi-Project Concurrent Access**
   - Each project has its own collection (no conflicts)
   - No locking needed for different projects

7. **Project Path Normalization**
   - Always resolve to absolute path
   - Handle `~` expansion, trailing slashes

8. **Missing Spec Workflow Directory**
   - WorkspaceInitializer creates `.spec-workflow/` on first use
   - Copy templates from bundled resources

## Dependencies

```json
{
  "dependencies": {
    "@modelcontextprotocol/sdk": "^0.6.0",
    "@qdrant/js-client-rest": "^1.7.0",
    "openai": "^4.0.0",
    "tree-sitter": "^0.21.0",
    "tree-sitter-typescript": "^0.21.0",
    "tree-sitter-python": "^0.21.0",
    "tree-sitter-javascript": "^0.21.0",
    "langchain": "^0.1.0",
    "dotenv": "^16.0.0"
  },
  "devDependencies": {
    "typescript": "^5.3.0",
    "@types/node": "^20.0.0",
    "vitest": "^1.0.0"
  }
}
```

## Qdrant Schema Design

### Collection Schema (Dense Only - Initial Implementation)

```typescript
// Qdrant collection configuration
{
  vectors: {
    size: 4096,  // qwen/qwen3-embedding-8b default dimension
    distance: "Cosine"
  }
}

// Point structure
{
  id: "chunk_abc123def456",  // UUID derived from content hash
  vector: [0.1, 0.2, ...],   // Dense embedding
  payload: {
    content: "function foo() {...}",
    relativePath: "src/utils/helper.ts",
    startLine: 10,
    endLine: 25,
    fileExtension: ".ts",
    metadata: {
      codebasePath: "/home/user/project",
      language: "typescript",
      chunkIndex: 5
    }
  }
}
```

### Filter Translation

Milvus filter syntax to Qdrant:

| Milvus | Qdrant |
|--------|--------|
| `fileExtension in [".ts", ".py"]` | `{ "should": [{ "key": "fileExtension", "match": { "value": ".ts" } }, ...] }` |
| `relativePath == "src/foo.ts"` | `{ "must": [{ "key": "relativePath", "match": { "value": "src/foo.ts" } }] }` |
| `id in ["a", "b", "c"]` | Use `points.delete` with IDs directly |

## Implementation Order

1. Steps 1-3 (Project setup, copy infrastructure) - Foundation
2. Steps 4-6 (Qdrant integration) - Critical path
3. Steps 7-8 (Tool implementation) - Feature completeness
4. Steps 9-10 (Server integration) - Bring it together
5. Steps 11-12 (Configuration, entry point) - Usability
6. Steps 13-14 (Testing, documentation) - Polish

Steps 4-6 are the core new work. Most other code is adaptation from existing repos.

## Configuration Example

```bash
# .env file
OPENROUTER_API_KEY=sk-or-xxx
EMBEDDING_MODEL=qwen/qwen3-embedding-8b
EMBEDDING_DIMENSION=4096
QDRANT_URL=http://<your-qdrant-server>:6333
```

## Usage Example

```json
// Claude Desktop config
{
  "mcpServers": {
    "spec-context": {
      "command": "npx",
      "args": ["spec-context-mcp"],
      "env": {
        "OPENROUTER_API_KEY": "sk-or-xxx",
        "QDRANT_URL": "http://<your-qdrant-server>:6333"
      }
    }
  }
}
```

## Tools Summary (9 tools)

| Tool | Source | Purpose |
|------|--------|---------|
| `index_codebase` | claude-context | Index project for semantic search |
| `search_code` | claude-context | Semantic code search |
| `clear_index` | claude-context | Remove project index |
| `get_indexing_status` | claude-context | Check indexing progress |
| `spec-workflow-guide` | spec-workflow-mcp | Load spec development workflow |
| `steering-guide` | spec-workflow-mcp | Load steering doc workflow |
| `spec-status` | spec-workflow-mcp | Check spec progress |
| `approvals` | spec-workflow-mcp | Manage approval requests |
| `log-implementation` | spec-workflow-mcp | Record implementation details |

## Prompts Summary (7 prompts)

MCP prompts are pre-defined conversation starters that guide the AI through specific workflows.

| Prompt | Purpose |
|--------|---------|
| `create-spec` | Start creating a new spec (requirements, design, or tasks) |
| `create-steering-doc` | Create a steering document (product, tech, or structure) |
| `implement-task` | Start implementing a specific task from a spec |
| `inject-spec-workflow-guide` | Load the spec workflow guide into context |
| `inject-steering-guide` | Load the steering doc guide into context |
| `refresh-tasks` | Refresh/regenerate tasks based on spec changes |
| `spec-status` | Get detailed status of a spec's progress |

## OpenRouter Embedding Implementation

Create `src/core/embedding/openrouter-embedding.ts`:

```typescript
import OpenAI from 'openai';

export interface EmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>;
  embedSingle(text: string): Promise<number[]>;
  getDimension(): number;
}

export class OpenRouterEmbedding implements EmbeddingProvider {
  private client: OpenAI;
  private model: string;
  private dimension: number;

  constructor(config: { apiKey: string; model: string; dimension: number }) {
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: 'https://openrouter.ai/api/v1',
    });
    this.model = config.model;
    this.dimension = config.dimension;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const response = await this.client.embeddings.create({
      model: this.model,
      input: texts,
    });
    return response.data.map((d) => d.embedding);
  }

  async embedSingle(text: string): Promise<number[]> {
    const results = await this.embed([text]);
    return results[0];
  }

  getDimension(): number {
    return this.dimension;
  }
}
```

Usage:
```typescript
const embedding = new OpenRouterEmbedding({
  apiKey: process.env.OPENROUTER_API_KEY!,
  model: 'qwen/qwen3-embedding-8b',
  dimension: 4096,
});

const vectors = await embedding.embed(['function hello() { return "world"; }']);
```

## MCP Prompts Handler Registration

Add to `src/server.ts` - prompts require `ListPromptsRequestSchema` and `GetPromptRequestSchema` handlers:

```typescript
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { registerPrompts, getPrompt } from "./prompts/index.js";

// In server setup:
this.server = new Server(
  { name: config.name, version: config.version },
  {
    capabilities: {
      tools: {},
      prompts: {},  // Enable prompts capability
    }
  }
);

// Register prompts handler
this.server.setRequestHandler(ListPromptsRequestSchema, async () => {
  return { prompts: registerPrompts() };
});

this.server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  return getPrompt(name, args);
});
```

Prompts registration in `src/prompts/index.ts`:
```typescript
import { Prompt } from '@modelcontextprotocol/sdk/types.js';

export function registerPrompts(): Prompt[] {
  return [
    {
      name: 'create-spec',
      description: 'Start creating a new spec (requirements, design, or tasks)',
      arguments: [
        { name: 'specName', description: 'Name for the new spec', required: true },
        { name: 'documentType', description: 'Type: requirements, design, or tasks', required: true },
      ],
    },
    // ... other prompts
  ];
}

export function getPrompt(name: string, args: Record<string, string>): { messages: any[] } {
  switch (name) {
    case 'create-spec':
      return { messages: [{ role: 'user', content: { type: 'text', text: `Create a ${args.documentType} spec named ${args.specName}...` } }] };
    // ... other prompts
    default:
      throw new Error(`Unknown prompt: ${name}`);
  }
}
```

## npm Package Setup

Update `package.json` with bin field and publish configuration:

```json
{
  "name": "spec-context-mcp",
  "version": "0.1.0",
  "description": "Unified MCP server for semantic code search and spec-driven development",
  "type": "module",
  "main": "./dist/index.js",
  "bin": {
    "spec-context-mcp": "./dist/index.js"
  },
  "files": [
    "dist",
    "templates"
  ],
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch",
    "start": "node dist/index.js",
    "test": "vitest",
    "prepublishOnly": "npm run build"
  },
  "keywords": ["mcp", "claude", "code-search", "embeddings", "qdrant"],
  "author": "",
  "license": "MIT",
  "engines": {
    "node": ">=18.0.0"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^0.6.0",
    "@qdrant/js-client-rest": "^1.7.0",
    "openai": "^4.0.0",
    "tree-sitter": "^0.21.0",
    "tree-sitter-typescript": "^0.21.0",
    "tree-sitter-python": "^0.21.0",
    "tree-sitter-javascript": "^0.21.0",
    "langchain": "^0.1.0",
    "dotenv": "^16.0.0"
  },
  "devDependencies": {
    "typescript": "^5.3.0",
    "@types/node": "^20.0.0",
    "vitest": "^1.0.0"
  }
}
```

Add shebang to `src/index.ts`:
```typescript
#!/usr/bin/env node
```

## Required Environment Variable Validation

Add to `src/config.ts`:

```typescript
export function validateConfig(): void {
  const errors: string[] = [];

  if (!process.env.OPENROUTER_API_KEY) {
    errors.push('OPENROUTER_API_KEY is required');
  }

  if (!process.env.QDRANT_URL) {
    errors.push('QDRANT_URL is required');
  }

  if (errors.length > 0) {
    console.error('Configuration errors:');
    errors.forEach((e) => console.error(`  - ${e}`));
    console.error('\nRequired environment variables:');
    console.error('  OPENROUTER_API_KEY  Your OpenRouter API key');
    console.error('  QDRANT_URL          Qdrant server URL (e.g., http://localhost:6333)');
    console.error('\nOptional:');
    console.error('  EMBEDDING_MODEL     Model to use (default: qwen/qwen3-embedding-8b)');
    console.error('  EMBEDDING_DIMENSION Vector dimension (default: 4096)');
    console.error('  QDRANT_API_KEY      Qdrant API key if authentication is enabled');
    process.exit(1);
  }
}
```

Call in `src/index.ts`:
```typescript
import { validateConfig } from './config.js';

// At startup, before anything else
validateConfig();
```

## Git Remote and Repository Setup

**Step 0: Create GitHub Repository** (before Step 1)

```bash
# Create GitHub repo
cd ~/git/spec-context-mcp
gh repo create spec-context-mcp --public --source=. --remote=origin --description "Unified MCP server for semantic code search and spec-driven development"

# Push initial commit
git push -u origin main
```

Or manually:
1. Create repo at https://github.com/new
2. Add remote: `git remote add origin git@github.com:<username>/spec-context-mcp.git`
3. Push: `git push -u origin main`

## Snapshot Manager Details

The snapshot manager tracks indexing state per project. State is stored locally in a JSON file.

**Location:** `~/.spec-context-mcp/snapshot.json` (global) or `<project>/.spec-context-mcp/snapshot.json` (per-project)

**Structure:**
```typescript
interface CodebaseSnapshot {
  formatVersion: 'v1';
  codebases: Record<string, CodebaseInfo>;  // projectPath -> info
  lastUpdated: string;  // ISO timestamp
}

interface CodebaseInfo {
  status: 'indexing' | 'indexed' | 'failed';
  lastUpdated: string;
  // If indexed:
  indexedFiles?: number;
  totalChunks?: number;
  collectionName?: string;
  // If indexing:
  indexingPercentage?: number;
  // If failed:
  errorMessage?: string;
}
```

**Adaptation from claude-context:**
- Remove Zilliz Cloud sync logic (we use dedicated Qdrant)
- Keep local file-based snapshot
- Add `collectionName` to track Qdrant collection per project

Create `src/snapshot.ts`:
```typescript
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const SNAPSHOT_DIR = path.join(os.homedir(), '.spec-context-mcp');
const SNAPSHOT_FILE = path.join(SNAPSHOT_DIR, 'snapshot.json');

export class SnapshotManager {
  private snapshot: CodebaseSnapshot;

  constructor() {
    this.snapshot = this.load();
  }

  private load(): CodebaseSnapshot {
    if (fs.existsSync(SNAPSHOT_FILE)) {
      return JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf-8'));
    }
    return { formatVersion: 'v1', codebases: {}, lastUpdated: new Date().toISOString() };
  }

  save(): void {
    fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
    this.snapshot.lastUpdated = new Date().toISOString();
    fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(this.snapshot, null, 2));
  }

  setIndexing(projectPath: string, percentage: number): void {
    this.snapshot.codebases[projectPath] = {
      status: 'indexing',
      lastUpdated: new Date().toISOString(),
      indexingPercentage: percentage,
    };
    this.save();
  }

  setIndexed(projectPath: string, files: number, chunks: number, collection: string): void {
    this.snapshot.codebases[projectPath] = {
      status: 'indexed',
      lastUpdated: new Date().toISOString(),
      indexedFiles: files,
      totalChunks: chunks,
      collectionName: collection,
    };
    this.save();
  }

  setFailed(projectPath: string, error: string): void {
    this.snapshot.codebases[projectPath] = {
      status: 'failed',
      lastUpdated: new Date().toISOString(),
      errorMessage: error,
    };
    this.save();
  }

  getStatus(projectPath: string): CodebaseInfo | undefined {
    return this.snapshot.codebases[projectPath];
  }

  removeCodebase(projectPath: string): void {
    delete this.snapshot.codebases[projectPath];
    this.save();
  }
}
```

## Phase 1 Scope (Code Search Only)

Phase 1 focuses on getting code search working. Spec workflow tools are deferred to Issue #001.

**Phase 1 deliverables:**
- [x] Project setup (package.json, tsconfig.json)
- [x] OpenRouter embedding provider
- [x] Qdrant vector database adapter
- [x] 4 code context tools only:
  - `index_codebase`
  - `search_code`
  - `clear_index`
  - `get_indexing_status`
- [x] Snapshot manager
- [x] MCP server with tools (no prompts yet)
- [x] README.md

**Deferred to Phase 2 (Issue #001):**
- 5 spec workflow tools
- 7 MCP prompts
- Workflow core files
- Templates
