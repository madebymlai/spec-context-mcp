#!/usr/bin/env node

import { validateConfig, createConfig } from './config.js';
import { SpecContextServer } from './server.js';

async function main(): Promise<void> {
    const args = process.argv.slice(2);

    // Check for help flag
    if (args.includes('--help') || args.includes('-h')) {
        console.log(`
spec-context-mcp - Unified MCP server for semantic code search

Usage: spec-context-mcp [options]
       spec-context-mcp doctor


Options:
  --help, -h    Show this help message
  --doctor      Run preflight checks (alias: doctor)

Environment Variables:
  EMBEDDING_PROVIDER  Embedding provider (default: voyageai)
  EMBEDDING_API_KEY   API key for embedding provider (required for hosted providers)
  EMBEDDING_MODEL     Embedding model name (provider-specific)
  EMBEDDING_BASE_URL  Base URL for embedding API (optional)
  VOYAGEAI_API_KEY    Alias for EMBEDDING_API_KEY when provider=voyageai
  OPENAI_API_KEY      Alias for EMBEDDING_API_KEY when provider=openai
  CHUNKHOUND_PYTHON   Python executable for ChunkHound (default: python3)
  DASHBOARD_URL       Dashboard URL shown in prompts (default: http://localhost:3000)
  OPENROUTER_API_KEY  Required only for dashboard AI review

Example:
  EMBEDDING_PROVIDER=voyageai EMBEDDING_API_KEY=sk-embed-xxx spec-context-mcp

For Claude Desktop, add to your config:
  {
    "mcpServers": {
      "spec-context": {
        "command": "npx",
        "args": ["spec-context-mcp"],
        "env": {
          "EMBEDDING_PROVIDER": "voyageai",
          "EMBEDDING_API_KEY": "sk-embed-xxx",
          "EMBEDDING_MODEL": "voyage-code-3",
          "CHUNKHOUND_PYTHON": "python3",
          "DASHBOARD_URL": "http://localhost:3000"
        }
      }
    }
  }
`);
        process.exit(0);
    }

    if (args.includes('doctor') || args.includes('--doctor')) {
        const { runDoctor } = await import('./doctor.js');
        const exitCode = await runDoctor();
        process.exit(exitCode);
    }

    // Validate configuration
    validateConfig();

    // Create config and server
    const config = createConfig();
    const server = new SpecContextServer(config);

    // Run server
    await server.run();
}

main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
});
