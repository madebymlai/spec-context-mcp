#!/usr/bin/env node

import 'dotenv/config';
import { MultiProjectDashboardServer } from './multi-server.js';
import { DashboardSessionManager } from '../core/workflow/dashboard-session.js';

const DEFAULT_DASHBOARD_PORT = 3000;

function showHelp() {
  console.error(`
Spec Context Dashboard - Web UI for spec-driven development

USAGE:
  spec-context-dashboard [options]

OPTIONS:
  --help                  Show this help message
  --port <number>         Specify dashboard port (default: ${DEFAULT_DASHBOARD_PORT})
  --no-open               Don't automatically open browser

EXAMPLES:
  spec-context-dashboard
  spec-context-dashboard --port 8080
  spec-context-dashboard --no-open
`);
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    showHelp();
    process.exit(0);
  }

  const noOpen = args.includes('--no-open');
  let port = DEFAULT_DASHBOARD_PORT;

  // Parse --port parameter
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--port=')) {
      port = parseInt(arg.split('=')[1], 10);
    } else if (arg === '--port' && i + 1 < args.length) {
      port = parseInt(args[i + 1], 10);
      i++;
    }
  }

  // Check for existing dashboard
  const sessionManager = new DashboardSessionManager();
  const existingSession = await sessionManager.getDashboardSession();

  if (existingSession) {
    console.error(`Dashboard is already running at: ${existingSession.url}`);
    console.error(`To stop it: kill ${existingSession.pid}`);
    process.exit(1);
  }

  console.error(`Starting Spec Context Dashboard on port ${port}...`);
  if (noOpen) {
    console.error('Browser auto-open disabled');
  }

  // Load env vars for security config
  let bindAddress: string | undefined;
  let allowExternalAccess: boolean | undefined;

  if (process.env.SPEC_CONTEXT_BIND_ADDRESS) {
    bindAddress = process.env.SPEC_CONTEXT_BIND_ADDRESS;
  }

  if (process.env.SPEC_CONTEXT_ALLOW_EXTERNAL_ACCESS?.toLowerCase() === 'true') {
    allowExternalAccess = true;
  }

  try {
    const dashboardServer = new MultiProjectDashboardServer({
      autoOpen: !noOpen,
      port,
      bindAddress,
      allowExternalAccess
    });

    const dashboardUrl = await dashboardServer.start();
    console.error(`Dashboard started at: ${dashboardUrl}`);
    console.error('Press Ctrl+C to stop');

    // Handle shutdown
    const shutdown = async () => {
      console.error('\nShutting down dashboard...');
      await dashboardServer.stop();
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    process.stdin.resume();

  } catch (error: any) {
    console.error(`Failed to start dashboard: ${error.message}`);
    process.exit(1);
  }
}

main().catch(() => process.exit(1));
