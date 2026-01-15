# Phase 2: Spec Workflow Integration

**Issue:** https://github.com/madebymlai/spec-context-mcp/issues/1

## Summary

Add spec-driven development workflow tools and prompts from spec-workflow-mcp to the unified MCP server.

## Deferred Items from Phase 1

### 5 Spec Workflow Tools

| Tool | Purpose |
|------|---------|
| `spec-workflow-guide` | Load spec development workflow guide |
| `steering-guide` | Load steering document creation guide |
| `spec-status` | Check spec phase and task progress |
| `approvals` | Manage approval workflow (request/status/delete) |
| `log-implementation` | Record implementation details for completed tasks |

### Keyword Triggers

Update tool/prompt descriptions so Claude naturally uses them when user mentions keywords:

| Keyword | Triggers |
|---------|----------|
| "create a spec", "new spec", "spec for" | `create-spec` prompt |
| "list specs", "show specs", "my specs" | `spec-status` tool |
| "implement task", "execute task", "do task" | `implement-task` prompt |
| "steering doc", "product doc", "tech doc" | `create-steering-doc` prompt |
| "approve", "request approval" | `approvals` tool |
| "log implementation", "record changes" | `log-implementation` tool |

### 7 MCP Prompts

| Prompt | Purpose |
|--------|---------|
| `create-spec` | Start creating a new spec (requirements, design, or tasks) |
| `create-steering-doc` | Create a steering document (product, tech, or structure) |
| `implement-task` | Start implementing a specific task from a spec |
| `inject-spec-workflow-guide` | Load the spec workflow guide into context |
| `inject-steering-guide` | Load the steering doc guide into context |
| `refresh-tasks` | Refresh/regenerate tasks based on spec changes |
| `spec-status` | Get detailed status of a spec's progress |

### Workflow Core Files

Files needed from spec-workflow-mcp `src/core/`:
- `parser.ts` - Spec markdown parsing
- `task-parser.ts` - Task extraction from markdown
- `task-validator.ts` - Task format validation
- `path-utils.ts` - Path utilities
- `workspace-initializer.ts` - Initialize `.spec-workflow/` directory
- `global-dir.ts` - Global directory management
- `archive-service.ts` - Spec archival
- `project-registry.ts` - Multi-project registry
- `security-utils.ts` - Path validation, sanitization
- `implementation-log-migrator.ts` - Log format migration
- `dashboard-session.ts` - Dashboard API communication (needed by approvals tool)

### Shared Types

Files needed from spec-workflow-mcp `src/`:
- `types.ts` - ToolContext, ToolResponse, MCPToolResponse, SpecData, TaskInfo, etc.

### Prompt Support Files

Files needed from spec-workflow-mcp `src/prompts/`:
- `types.ts` - PromptHandler, PromptDefinition, PromptResponse
- `index.ts` - registerPrompts, handlePromptList, handlePromptGet

### Templates

Templates from spec-workflow-mcp `src/markdown/templates/`:
- `requirements-template.md`
- `design-template.md`
- `tasks-template.md`
- `product-template.md`
- `tech-template.md`
- `structure-template.md`

## Source Repository

https://github.com/madebymlai/spec-workflow-mcp

## Decision: Merge spec-workflow-mcp into spec-context-mcp

**Why merge is better:**
- Single unified MCP server
- One `.mcp.json` entry
- Tighter integration between search and workflow
- Easier to maintain

**Architecture:**

| Component | Location | Port |
|-----------|----------|------|
| Qdrant | 46.62.233.229 | 6333 |
| spec-workflow dashboard | 46.62.233.229 | 3000 |
| spec-context-mcp (unified) | Local | MCP stdio |

**What gets merged into spec-context-mcp:**
- 5 workflow tools
- 7 MCP prompts
- Core workflow files (parser, task-parser, etc.)
- Templates (6 markdown files)

**Dashboard stays on server:**
- Approvals and logs need persistent storage
- Web UI accessible from browser

## Implementation Steps

### Step 0: Modify Fork for spec-context Integration
- Fork location: `/home/laimk/git/_refs/spec-workflow-mcp`

**0a. Rename `.spec-workflow` to `.spec-context`**

Files containing `.spec-workflow` references (21 files):
```
src/config.ts
src/core/dashboard-session.ts
src/core/global-dir.ts
src/core/path-utils.ts
src/core/security-utils.ts
src/dashboard/job-scheduler.ts
src/dashboard/multi-server.ts
src/dashboard/watcher.ts
src/prompts/create-spec.ts
src/prompts/create-steering-doc.ts
src/prompts/implement-task.ts
src/prompts/inject-steering-guide.ts
src/prompts/spec-status.ts
src/tools/approvals.ts
src/tools/log-implementation.ts
src/tools/spec-status.ts
src/tools/spec-workflow-guide.ts
src/tools/steering-guide.ts
```

Actions:
- Search and replace `.spec-workflow` → `.spec-context` in all files
- Update folder name in workspace-initializer.ts
- Update any docs/README references

**0b. Make `search_code` tool the default for codebase exploration**

All prompts and templates should instruct Claude to use the `search_code` tool as the **primary method** for understanding and exploring the codebase. Grep/ripgrep is only a fallback for edge cases.

**Indexing flow:**
1. **Before starting work:** Check if indexed with `get_indexing_status`, if not run `index_codebase`
2. **During work:** Use `search_code` tool to find code
3. **After completing task:** Run `sync_index` to incrementally update only changed files
4. **Next task:** Index is fresh, repeat

**Prompts to update:**
| File | Current | New Behavior |
|------|---------|--------------|
| `src/prompts/implement-task.ts` | "Use grep/ripgrep for fast searches" | "Use the `search_code` tool to find existing implementations. Fallback to grep only if needed. After completing the task, run `sync_index` to update the index with your changes." |
| `src/prompts/create-spec.ts` | Mentions `_Leverage` but no search | "First, use the `search_code` tool to discover existing code patterns to leverage" |
| `src/prompts/create-steering-doc.ts` | No codebase exploration | "Use the `search_code` tool to understand the codebase structure before documenting" |
| `src/prompts/refresh-tasks.ts` | Only reads spec files | "Use the `search_code` tool to verify completed tasks still match the actual code" |

**Templates to update:**
| Template | Current | New Behavior |
|----------|---------|--------------|
| `requirements-template.md` | No search guidance | "Use the `search_code` tool to understand existing patterns before defining NFRs" |
| `design-template.md` | Has "Code Reuse Analysis" | "Use the `search_code` tool to find existing components for the Code Reuse Analysis section" |
| `tasks-template.md` | Has `_Leverage:` fields | "Use the `search_code` tool to populate `_Leverage:` fields with actual file paths" |
| `structure-template.md` | No search guidance | "Use the `search_code` tool to discover the actual codebase structure" |
| `tech-template.md` | No search guidance | "Use the `search_code` tool to identify current technology patterns" |

**No changes needed:**
- `inject-spec-workflow-guide.ts` - Just loads guide
- `inject-steering-guide.ts` - Just loads guide
- `spec-status.ts` - Just checks status
- `product-template.md` - High-level vision, no code exploration

**0c. Add model configuration (Sonnet vs Opus)**
- Add configurable model preference (env var or config file)
- Default model: Sonnet (cheaper, faster)
- `implement-task` prompt: Use Opus (more complex reasoning needed)
- All other prompts: Use Sonnet

**Decision: Option C - Per-prompt metadata**

Add `_metadata.preferredModel` to each prompt definition:

```typescript
const prompt: Prompt = {
  name: 'implement-task',
  // ... existing fields
  _metadata: {
    preferredModel: 'opus'  // complex reasoning
  }
};

const prompt: Prompt = {
  name: 'create-spec',
  // ... existing fields
  _metadata: {
    preferredModel: 'sonnet'  // simpler task
  }
};
```

Model assignments:
| Prompt | Model | Reason |
|--------|-------|--------|
| `implement-task` | Opus | Complex multi-step reasoning |
| `create-spec` | Sonnet | Template-based creation |
| `create-steering-doc` | Sonnet | Template-based creation |
| `refresh-tasks` | Sonnet | Structured comparison |
| `spec-status` | Sonnet | Simple status check |
| `inject-spec-workflow-guide` | Sonnet | Just loads guide |
| `inject-steering-guide` | Sonnet | Just loads guide |

### Step 1: Copy Shared Types
Copy from `/home/laimk/git/_refs/spec-workflow-mcp/src/` to `src/`:
- `types.ts` → `src/workflow-types.ts` (rename to avoid conflict)

Update imports in all workflow files to use `workflow-types.js`.

### Step 2: Copy Workflow Tools to spec-context-mcp
Copy from `/home/laimk/git/_refs/spec-workflow-mcp/src/tools/` to `src/tools/workflow/`:
- `spec-workflow-guide.ts`
- `steering-guide.ts`
- `spec-status.ts`
- `approvals.ts`
- `log-implementation.ts`

Create `src/tools/workflow/index.ts`:
```typescript
export * from './spec-workflow-guide.js';
export * from './steering-guide.js';
export * from './spec-status.js';
export * from './approvals.js';
export * from './log-implementation.js';
```

Update import paths in each file:
- `../types.js` → `../../workflow-types.js`
- `../core/...` → `../../core/workflow/...`

Register tools in `src/tools/index.ts`.

### Step 3: Copy Prompts to spec-context-mcp
Copy from `/home/laimk/git/_refs/spec-workflow-mcp/src/prompts/` to `src/prompts/`:
- `types.ts` - PromptHandler, PromptDefinition types
- `index.ts` - registerPrompts, handlePromptList, handlePromptGet
- `create-spec.ts`
- `create-steering-doc.ts`
- `implement-task.ts`
- `inject-spec-workflow-guide.ts`
- `inject-steering-guide.ts`
- `refresh-tasks.ts`
- `spec-status.ts`

Update import paths in each file:
- `../types.js` → `../workflow-types.js`
- `../core/...` → `../core/workflow/...`

Update prompts per Step 0b (search_code tool) and 0c (model metadata).

### Step 4: Copy Core Workflow Files
Copy from `/home/laimk/git/_refs/spec-workflow-mcp/src/core/` to `src/core/workflow/`:
- `parser.ts`
- `task-parser.ts`
- `task-validator.ts`
- `path-utils.ts`
- `workspace-initializer.ts`
- `global-dir.ts`
- `archive-service.ts`
- `project-registry.ts`
- `security-utils.ts`
- `implementation-log-migrator.ts`
- `dashboard-session.ts`

Create `src/core/workflow/index.ts`:
```typescript
export * from './parser.js';
export * from './task-parser.js';
export * from './task-validator.js';
export * from './path-utils.js';
export * from './workspace-initializer.js';
export * from './global-dir.js';
export * from './archive-service.js';
export * from './project-registry.js';
export * from './security-utils.js';
export * from './implementation-log-migrator.js';
export * from './dashboard-session.js';
```

Update import paths in each file:
- `../types.js` → `../../workflow-types.js`

### Step 5: Copy Templates
Copy from `/home/laimk/git/_refs/spec-workflow-mcp/src/markdown/templates/` to `src/templates/`:
- `requirements-template.md`
- `design-template.md`
- `tasks-template.md`
- `product-template.md`
- `tech-template.md`
- `structure-template.md`

Update template references in tools/prompts to use new path.

### Step 6: Setup Dashboard on Hetzner Server

```bash
# SSH to server
ssh root@46.62.233.229

# Clone forked repo
cd /opt
git clone https://github.com/madebymlai/spec-workflow-mcp.git
cd spec-workflow-mcp

# Install dependencies
npm install

# Build
npm run build

# Create PM2 ecosystem file
cat > ecosystem.config.cjs << 'EOF'
module.exports = {
  apps: [{
    name: 'spec-workflow-dashboard',
    script: 'dist/dashboard/multi-server.js',
    cwd: '/opt/spec-workflow-mcp',
    env: {
      NODE_ENV: 'production',
      PORT: 3000
    },
    instances: 1,
    autorestart: true,
    max_memory_restart: '500M'
  }]
};
EOF

# Start with PM2
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup

# Open firewall
ufw allow 3000/tcp
ufw reload
```

Verify: `curl http://46.62.233.229:3000/health`

### Step 7: Register MCP Prompts in Server
Add prompt handler in `src/server.ts`:

```typescript
import {
    ListToolsRequestSchema,
    CallToolRequestSchema,
    ListPromptsRequestSchema,
    GetPromptRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { handlePromptList, handlePromptGet } from './prompts/index.js';

// In constructor, update capabilities:
capabilities: {
    tools: {},
    prompts: {},  // ADD THIS
}

// In setupHandlers(), add:
this.server.setRequestHandler(ListPromptsRequestSchema, async () => {
    return handlePromptList();
});

this.server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const context = { projectPath: process.cwd(), dashboardUrl: this.config.dashboardUrl };
    return handlePromptGet(name, args || {}, context);
});
```

Add `dashboardUrl` to config:
- `src/config.ts`: Add `dashboardUrl?: string` field
- Read from `DASHBOARD_URL` env var

### Step 8: Update Tool/Prompt Descriptions for Keyword Triggers

Update descriptions to include trigger keywords so Claude uses them naturally:

**Tools (`src/tools/workflow/*.ts`):**
```typescript
// spec-status.ts
export const specStatusTool: Tool = {
  name: 'spec-status',
  description: 'Check spec status, list specs, show my specs, get spec progress. Use when user asks about specs, their status, or wants to see all specs.',
  // ...
};

// approvals.ts
export const approvalsTool: Tool = {
  name: 'approvals',
  description: 'Manage spec approvals - request approval, check approval status, approve specs. Use when user mentions approve, approval, or review.',
  // ...
};

// log-implementation.ts
export const logImplementationTool: Tool = {
  name: 'log-implementation',
  description: 'Log implementation details, record changes, document what was built. Use after completing a task to record the implementation.',
  // ...
};
```

**Prompts (`src/prompts/*.ts`):**
```typescript
// create-spec.ts
export const createSpecPrompt: PromptDefinition = {
  prompt: {
    name: 'create-spec',
    description: 'Create a new spec, start spec workflow, spec for a feature. Use when user wants to create, start, or make a new spec.',
    // ...
  },
  // ...
};

// implement-task.ts
export const implementTaskPrompt: PromptDefinition = {
  prompt: {
    name: 'implement-task',
    description: 'Implement a task, execute task, do task, work on task. Use when user wants to implement, execute, or work on a specific task from a spec.',
    // ...
  },
  // ...
};
```

### Step 9: Add Dependencies
Add required dependencies to `package.json`:

```bash
npm install @toon-format/toon simple-git
```

These are needed by:
- `@toon-format/toon` - Used in workflow-types.ts for response encoding
- `simple-git` - Git operations for implementation logging

**Note:** `chokidar` and `toml` are only needed for dashboard (installed separately on Hetzner in Step 6).

### Step 10: Test
- Build: `npm run build`
- Test tools: index, search, sync, workflow tools
- Test prompts: create-spec, implement-task, etc.
- Access dashboard at `http://46.62.233.229:3000`

**Test commands:**
```bash
# Build
npm run build

# Test MCP server manually (in another project)
cd /home/laimk/git/aegis-trader
# Restart Claude Code to reload MCP server

# Test in Claude Code:
# 1. "index this codebase" - should work
# 2. "search for trading pipeline" - should work
# 3. "/create-spec" - should load create-spec prompt
# 4. "/implement-task" - should load implement-task prompt
```

## Edge Cases

| Scenario | Handling |
|----------|----------|
| Dashboard down | Tools that need dashboard (approvals, log-implementation) return error with message to check dashboard. Other tools work offline. |
| Codebase not indexed | `search_code` returns error suggesting to run `index_codebase` first |
| Invalid project path | Security utils validate path, return error if outside allowed directories |
| Concurrent indexing | SnapshotManager tracks indexing state, rejects duplicate requests |
| Large codebase | Chunking + batching already implemented in Phase 1 |
| Template not found | Return clear error with expected template path |

## Rollback Plan

If merge fails:
1. Keep spec-workflow-mcp as separate MCP server
2. Revert to two-server `.mcp.json` config
3. Dashboard on Hetzner still works independently

## Incremental Sync (Implemented)

Added incremental sync support from claude-context:
- **Merkle DAG** - Tree of file hashes for fast change detection
- **`sync_index` tool** - Incrementally update index with only changed files
- **Snapshot file** - Stores hashes in `~/.spec-context-mcp/merkle/{project-hash}.json`

**Files added:**
- `src/core/sync/merkle.ts`
- `src/core/sync/synchronizer.ts`
- `src/tools/context/sync-index.ts`

---

## Final `.mcp.json` Configuration (Unified Server)

```json
{
  "mcpServers": {
    "spec-context": {
      "command": "node",
      "args": ["/home/laimk/git/spec-context-mcp/dist/index.js"],
      "env": {
        "OPENROUTER_API_KEY": "...",
        "QDRANT_URL": "http://46.62.233.229:6333",
        "DASHBOARD_URL": "http://46.62.233.229:3000"
      }
    }
  }
}
```

**Single unified server provides:**
- 9 tools (4 context + 5 workflow)
- 7 prompts
- Semantic code search + spec workflow in one MCP server

## Implementation Order Summary

| Step | Description | Files |
|------|-------------|-------|
| 0a | Rename `.spec-workflow` → `.spec-context` | 21 files in fork |
| 0b | Add `search_code` tool references | 4 prompts + 5 templates |
| 0c | Add `_metadata.preferredModel` | 7 prompts |
| 1 | Copy shared types | 1 file |
| 2 | Copy workflow tools | 5 files + index |
| 3 | Copy prompts | 9 files |
| 4 | Copy core workflow | 11 files + index |
| 5 | Copy templates | 6 files |
| 6 | Setup dashboard on Hetzner | Server config |
| 7 | Register prompts in server | src/server.ts |
| 8 | Update descriptions for keyword triggers | 5 tools + 7 prompts |
| 9 | Add dependencies | package.json |
| 10 | Test | Manual testing |

**Total new files:** ~35 files
**Dependencies to add:** 3 packages

## Usage After Implementation

### Creating Specs
- "Create a spec for user authentication" → `create-spec` prompt
- "Create a spec called payment-gateway with features: X, Y, Z" → `create-spec` prompt
- "Build a spec from @requirements.md" → `create-spec` prompt

### Managing & Monitoring
- "List all my specs" → `spec-status` tool
- "Show me the status of user-auth spec" → `spec-status` tool
- "What specs do I have?" → `spec-status` tool

### Task Implementation
- "Implement task 1.2 from user-auth spec" → `implement-task` prompt
- "Implement all database tasks from user-auth" → `implement-task` prompt
- "Show me what's left to do" → `spec-status` tool
- "Start working on the next task" → `implement-task` prompt

### Steering & Architecture
- "Create steering documents for my project" → `create-steering-doc` prompt

### Code Search (spec-context addition)
- "Search for authentication code" → `search_code` tool
- "Find similar patterns to this function" → `search_code` tool
- "Index this codebase" → `index_codebase` tool
