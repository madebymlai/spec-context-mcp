#!/usr/bin/env node

import { validateConfig, createConfig } from './config.js';
import { SpecContextServer, cleanupDashboardRegistrations } from './server.js';

async function main(): Promise<void> {
    // Check for help flag
    if (process.argv.includes('--help') || process.argv.includes('-h')) {
        console.log(`
spec-context-mcp - Unified MCP server for semantic code search

Usage: spec-context-mcp [options]

Options:
  --help, -h    Show this help message

Environment Variables:
  OPENROUTER_API_KEY  (required) Your OpenRouter API key
  QDRANT_URL          (required) Qdrant server URL (e.g., http://localhost:6333)
  EMBEDDING_MODEL     Embedding model (default: qwen/qwen3-embedding-8b)
  EMBEDDING_DIMENSION Vector dimension (default: 4096)
  QDRANT_API_KEY      Qdrant API key if authentication enabled

Example:
  OPENROUTER_API_KEY=sk-or-xxx QDRANT_URL=http://localhost:6333 spec-context-mcp

For Claude Desktop, add to your config:
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
`);
        process.exit(0);
    }

    // Validate configuration
    validateConfig();

    // Create config and server
    const config = createConfig();
    const server = new SpecContextServer(config);

    // Cleanup on exit
    const cleanup = async () => {
        await cleanupDashboardRegistrations(config.dashboardApiKey);
        process.exit(0);
    };
    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);

    // Run server
    await server.run();
}

main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
});
