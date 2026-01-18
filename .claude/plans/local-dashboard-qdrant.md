# Plan: Move Dashboard and Qdrant to Local

## Summary

Migrate from remote Qdrant (Hetzner #2) to local Qdrant, and set up dashboard to auto-start with Claude Code. This eliminates €48/year server cost and reduces latency.

## Current State

- Qdrant: Running on Hetzner #2 (€4/mo)
- Dashboard: Not auto-starting, manual process
- MCP: Already local (runs in Claude Code)

## Target State

- Qdrant: Local Docker container
- Dashboard: Auto-starts when `claude` command runs
- Hetzner #2: Cancelled

## Steps

### 1. Install Qdrant locally

```bash
docker run -d \
  --name qdrant \
  --restart=always \
  -p 6333:6333 \
  -p 6334:6334 \
  -v qdrant_storage:/qdrant/storage \
  qdrant/qdrant
```

### 2. Update spec-context-mcp config

Edit MCP config (`.mcp.json` or environment):

```
QDRANT_URL=http://localhost:6333
```

Remove any `QDRANT_API_KEY` if set (local doesn't need auth).

### 3. Re-index codebases

Collections will be empty on fresh Qdrant. Re-index each project:

```
# In Claude Code, for each project:
Use the index_codebase tool
```

### 4. Set up dashboard auto-start

Add to `~/.bashrc` or `~/.zshrc`:

```bash
claude() {
  # Start dashboard if not running
  if ! pgrep -f 'spec-context-mcp.*multi-server' > /dev/null; then
    (cd ~/git/spec-context-mcp && node dist/dashboard/multi-server.js > /dev/null 2>&1 &)
  fi
  command claude "$@"
}
```

Then: `source ~/.bashrc` or `source ~/.zshrc`

### 5. Test locally

- [ ] Qdrant accessible at `http://localhost:6333/dashboard`
- [ ] `claude` command starts dashboard automatically
- [ ] Dashboard accessible at `http://localhost:3000`
- [ ] Code search works (index + search)

### 6. Cancel Hetzner #2

Once confirmed working locally:

1. Log into Hetzner Cloud console
2. Delete server or cancel subscription
3. Optionally: Point cool domain at Hetzner #1 (aegis-trader) instead

## Rollback

If issues arise:
- Qdrant: Just change `QDRANT_URL` back to remote
- Dashboard: Remove the shell wrapper

## Time to Complete

~15 minutes active work
