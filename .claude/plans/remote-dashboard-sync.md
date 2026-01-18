# Remote Dashboard Sync #3

## Summary

The remote dashboard (spec.laimk.dev) can receive data from local MCP servers via API, but cannot write changes back to local filesystems. This breaks the approval workflow and any other dashboard features that modify project files.

## Problem

Current broken flow:
1. ✅ Local MCP server → pushes approval to remote dashboard via `POST /api/projects/:id/approvals`
2. ✅ Remote dashboard → stores approval in its local filesystem on Hetzner
3. ❌ User clicks "approve/needs-revision" on dashboard → writes to Hetzner filesystem
4. ❌ Local MCP server → polls status, but reads from LOCAL filesystem (never updated)

## Affected Features (Complete List)

All dashboard write operations that touch project files:

### Specs
- `PUT /api/projects/:id/specs/:name/:document` - Edit spec documents (requirements, design, tasks)
- `POST /api/projects/:id/specs/:name/archive` - Archive a spec
- `POST /api/projects/:id/specs/:name/unarchive` - Unarchive a spec
- `PUT /api/projects/:id/specs/:name/tasks/:taskId/status` - Update task status

### Steering
- `PUT /api/projects/:id/steering/:name` - Edit steering documents (product, tech, structure)

### Approvals
- `POST /api/projects/:id/approvals` - Create approval request
- `POST /api/projects/:id/approvals/:id/:action` - Approve/reject/needs-revision
- `POST /api/projects/:id/approvals/:id/snapshot` - Capture snapshot

### Implementation Logs
- `POST /api/projects/:id/specs/:name/implementation-log` - Add log entry

### Jobs (Global Settings)
- `POST /api/jobs` - Create automation job
- `PUT /api/jobs/:jobId` - Update job
- `DELETE /api/jobs/:jobId` - Delete job
- `POST /api/jobs/:jobId/run` - Run job manually

### Projects
- `POST /api/projects/add` - Register project (already works via API)
- `DELETE /api/projects/:projectId` - Remove project

## Solution: Bidirectional Sync via WebSocket

### Architecture

```
┌─────────────────────┐         ┌─────────────────────┐
│   Local MCP Server  │◄───────►│   Remote Dashboard  │
│  (Claude Code)      │   WS    │   (spec.laimk.dev)  │
├─────────────────────┤         ├─────────────────────┤
│ - Reads local files │         │ - Serves UI         │
│ - Writes local files│         │ - Receives events   │
│ - Pushes changes    │         │ - Sends commands    │
│ - Executes commands │         │ - Stores nothing    │
└─────────────────────┘         └─────────────────────┘
         │                               │
         ▼                               ▼
   Local Filesystem              Stateless (relay only)
   ~/.spec-context-mcp/
   /project/.spec-context/
```

### Key Principle

**Dashboard becomes stateless relay** - it never stores project files. All file operations (reads AND writes) are commands sent to the MCP server which executes them locally and returns results.

## Files to Modify

### spec-context-mcp (MCP Server)
- `src/server.ts` - Add persistent WebSocket connection to dashboard
- `src/sync/dashboard-sync.ts` - NEW: WebSocket client for dashboard communication
- `src/sync/command-executor.ts` - NEW: Execute commands from dashboard
- `src/config.ts` - Add WebSocket URL config

### spec-context-mcp (Dashboard)
- `src/dashboard/multi-server.ts` - Remove direct file I/O, relay all commands to MCP via WebSocket
- `src/dashboard/project-manager.ts` - Track connected MCP servers per project, use WebSocket for `isActive`
- `src/dashboard/ws-relay.ts` - NEW: WebSocket relay logic (command routing, response handling)
- `src/dashboard/approval-storage.ts` - REMOVE or convert to WebSocket relay (no local file I/O)
- `src/dashboard/implementation-log-manager.ts` - REMOVE or convert to WebSocket relay
- `src/dashboard/parser.ts` - REMOVE or convert to WebSocket relay (reads specs locally)
- `src/dashboard/watcher.ts` - REMOVE (no local files to watch on dashboard)
- `src/dashboard/settings-manager.ts` - Convert jobs storage to WebSocket relay

### spec-context-mcp (Core)
- `src/core/workflow/project-registry.ts` - Remove PID-based `isActive`, remove `persistent` flag

## Steps

### Phase 1: MCP Server → Dashboard Connection

1. **Add WebSocket client to MCP server**
   - On startup, if `DASHBOARD_URL` is set, connect via WebSocket
   - Send registration message with project path and capabilities
   - Maintain connection with heartbeat/reconnect logic

2. **Track connected MCP servers on dashboard**
   - Dashboard tracks which projects have active WebSocket connections
   - `isActive` = has WebSocket connection (replaces PID check)
   - **Project dropdown only shows active projects** (MCP connected)
   - Registered but inactive projects are hidden from dropdown
   - Remove `persistent` flag - all API-registered projects stay in registry
   - Projects only removed via explicit `DELETE /api/projects/:id`

### Phase 2: Dashboard → MCP Commands

3. **Define command protocol**
   ```typescript
   type CommandType =
     // Project
     | 'project-info'           // Get project info (name, path, steering status)
     // Specs - Read
     | 'spec-list'              // List all specs
     | 'spec-read'              // Read spec documents (requirements, design, tasks)
     | 'spec-archived-list'     // List archived specs
     | 'spec-archived-read'     // Read archived spec documents
     | 'task-progress'          // Get task progress and summary
     // Specs - Write
     | 'spec-document-write'    // Edit requirements/design/tasks
     | 'spec-archive'           // Archive spec
     | 'spec-unarchive'         // Unarchive spec
     | 'task-status-update'     // Update task checkbox
     // Steering - Read
     | 'steering-read'          // Read steering document
     | 'steering-status'        // Get steering docs status (which exist)
     // Steering - Write
     | 'steering-write'         // Edit product/tech/structure
     // Approvals - Read
     | 'approval-list'          // List pending approvals
     | 'approval-get'           // Get single approval details
     | 'approval-content'       // Get approval file content
     | 'approval-snapshots'     // Get all snapshots for approval
     | 'approval-snapshot-get'  // Get specific snapshot version
     | 'approval-diff'          // Get diff between snapshots
     // Approvals - Write
     | 'approval-create'        // Create approval request
     | 'approval-update'        // Approve/reject/needs-revision
     | 'approval-snapshot'      // Capture manual snapshot
     | 'approval-delete'        // Delete approval request
     // Implementation Logs - Read
     | 'impl-log-read'          // Read implementation logs
     | 'impl-log-search'        // Search logs by keyword
     | 'impl-log-task-stats'    // Get stats for a task
     // Implementation Logs - Write
     | 'impl-log-add'           // Add implementation log entry
     // Jobs - Read
     | 'job-list'               // List all jobs
     | 'job-get'                // Get single job details
     | 'job-history'            // Get job execution history
     | 'job-stats'              // Get job statistics
     // Jobs - Write
     | 'job-create'             // Create automation job
     | 'job-update'             // Update job
     | 'job-delete'             // Delete job
     | 'job-run'                // Run job manually
     // Generic
     | 'file-read'              // Read any file
     | 'file-write';            // Write any file

   interface DashboardCommand {
     type: 'command';
     command: CommandType;
     requestId: string;
     payload: Record<string, any>;
   }

   interface McpResponse {
     type: 'response';
     requestId: string;
     success: boolean;
     data?: any;
     error?: string;
   }
   ```

4. **Implement spec commands**
   - `spec-document-write`: Write to `.spec-context/specs/{name}/{doc}.md`
   - `spec-archive`: Move spec folder to `.spec-context/archive/specs/`
   - `spec-unarchive`: Move spec folder back from archive
   - `task-status-update`: Parse tasks.md, update checkbox, write back

5. **Implement steering commands**
   - `steering-write`: Write to `.spec-context/steering/{name}.md`

6. **Implement approval commands**
   - `approval-create`: Create approval JSON in `.spec-context/approvals/`
   - `approval-update`: Update approval status, response, annotations
   - `approval-snapshot`: Capture file snapshot for version comparison

7. **Implement implementation log commands**
   - `impl-log-add`: Append entry to `.spec-context/specs/{name}/implementation-log.json`

8. **Implement job commands**
   - `job-create/update/delete`: Modify `~/.spec-context-mcp/jobs.json`
   - `job-run`: Execute job and return result

9. **Implement generic file commands**
   - `file-read`: Read any file, return content
   - `file-write`: Write content to any file path

10. **Convert all dashboard reads to WebSocket**
    - `GET /api/projects/:id/specs` → sends `spec-list` command
    - `GET /api/projects/:id/specs/:name/all` → sends `spec-read` command
    - `GET /api/projects/:id/steering/:name` → sends `steering-read` command
    - `GET /api/projects/:id/approvals` → sends `approval-list` command
    - `GET /api/projects/:id/approvals/:id/content` → sends `file-read` command
    - `GET /api/projects/:id/specs/:name/implementation-log` → sends `impl-log-read` command
    - `GET /api/projects/:id/specs/:name/tasks/progress` → sends `task-progress` command
    - Dashboard has NO local file access - everything via MCP

### Phase 3: Real-time Sync (MCP → Dashboard)

11. **Push local changes to dashboard**
    - MCP file watcher detects changes in `.spec-context/`
    - Sends update event via WebSocket for:
      - Spec changes (new spec, document edits, task updates)
      - Steering changes
      - Approval status changes
      - Implementation log entries
    - Dashboard broadcasts to connected UI clients

12. **Handle multiple MCP instances**
    - Multiple Claude Code windows = multiple MCP servers
    - Dashboard relays commands to correct MCP instance
    - Broadcast updates to all UIs watching same project

### Phase 4: Offline/Disconnection Handling

13. **Queue commands when MCP disconnected**
    - Dashboard queues commands if MCP not connected
    - Show "offline" indicator in UI
    - Replay queue when MCP reconnects (with conflict resolution)

14. **Graceful degradation**
    - If no MCP connected, dashboard shows read-only view
    - Disable edit buttons, show "Connect Claude Code to edit"

## Edge Cases

- **MCP server crashes mid-command**: Dashboard times out (30s), shows error, allows retry
- **Multiple users editing same project**: Last-write-wins or show conflict dialog
- **Dashboard restarts**: MCP servers reconnect automatically
- **Network issues**: Exponential backoff reconnect, queue outgoing commands
- **File conflicts**: If local file changed while command in flight, return error
- **Security - Path restrictions**: `file-write` command restricted to `.spec-context/` directory only; reject writes outside project boundaries
- **Large files**: Chunk files > 1MB; use WebSocket compression (permessage-deflate) for all transfers
- **Authentication**: MCP authenticates via API key in WebSocket handshake (`Authorization` header or query param)
- **Stale connections**: Ping/pong heartbeat every 30s; disconnect if no pong received within 10s

## Dependencies

- Step 2 depends on Step 1 (connection before tracking)
- Steps 4-9 depend on Step 3 (protocol before commands)
- Step 10 depends on Steps 4-9 (reads need command handlers)
- Steps 11-12 depend on Step 10 (real-time sync after basic flow works)
- Steps 13-14 can be done last (offline handling is enhancement)

## API Changes

### New WebSocket Protocol

**MCP → Dashboard (on connect):**
```json
{
  "type": "register",
  "projectPath": "/home/user/project",
  "projectId": "abc123",
  "capabilities": ["approvals", "tasks", "files"]
}
```

**Dashboard → MCP (command):**
```json
{
  "type": "command",
  "requestId": "req_123",
  "command": "approval-update",
  "payload": {
    "approvalId": "approval_xxx",
    "status": "approved",
    "response": "Looks good!"
  }
}
```

**MCP → Dashboard (response):**
```json
{
  "type": "response",
  "requestId": "req_123",
  "success": true
}
```

**MCP → Dashboard (file change event):**
```json
{
  "type": "file-changed",
  "path": ".spec-context/steering/product.md",
  "content": "..."
}
```

## Testing Plan

### Unit Tests
1. Command executor - each command type
2. WebSocket client reconnection logic
3. Command queue serialization

### Integration Tests
4. Spec document edit flow end-to-end
5. Spec archive/unarchive flow
6. Task status update flow
7. Steering document edit flow
8. Approval create/update/snapshot flow
9. Implementation log add flow
10. Job CRUD operations

### System Tests
11. Reconnection after network drop
12. Multiple MCP servers same project
13. Dashboard restart with connected MCPs
14. MCP restart reconnects to dashboard
15. Offline queue replay on reconnect

### Load Tests
16. Rapid file changes (debouncing)
17. Many concurrent commands
18. Large file transfers
