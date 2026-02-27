#!/usr/bin/env node

import { createConfig } from './config.js';
import { SpecContextServer } from './server.js';

async function main(): Promise<void> {
    const args = process.argv.slice(2);

    // Check for help flag
    if (args.includes('--help') || args.includes('-h')) {
        console.log(`
spec-context-mcp - MCP server for spec-driven development

Usage: spec-context-mcp [options]
       spec-context-mcp doctor

Options:
  --help, -h    Show this help message
  --doctor      Run preflight checks (alias: doctor)

Environment Variables:
  DASHBOARD_URL       Dashboard URL shown in prompts (default: http://localhost:3000)
  OPENROUTER_API_KEY  Required for dashboard AI review

Example:
  spec-context-mcp

For Claude Desktop, add to your config:
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
`);
        process.exit(0);
    }

    if (args.includes('doctor') || args.includes('--doctor')) {
        const { runDoctor } = await import('./doctor.js');
        const exitCode = await runDoctor();
        process.exit(exitCode);
    }

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
