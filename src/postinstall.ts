#!/usr/bin/env node
/**
 * Post-install script that runs after npm install.
 * Checks if Python environment is set up and prints guidance if not.
 * Never fails (always exits 0).
 */

import { existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function main(): void {
    try {
        // Package root is one level up from dist/
        const packageRoot = resolve(__dirname, '..');
        const venvPath = resolve(packageRoot, '.venv');
        const venvPython = resolve(venvPath, 'bin', 'python');

        // Check if venv exists and has Python
        if (existsSync(venvPython)) {
            // Already set up, nothing to do
            return;
        }

        // Print setup guidance
        console.log(`
┌─────────────────────────────────────────────────────────────────┐
│  spec-context-mcp: Python Setup Required                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Semantic search requires Python. Run:                          │
│                                                                 │
│    npx spec-context-mcp setup                                   │
│                                                                 │
│  This will:                                                     │
│    • Create a virtual environment                               │
│    • Install ChunkHound dependencies                            │
│    • Configure Python path automatically                        │
│                                                                 │
│  After setup, restart your IDE/terminal for changes to apply.   │
│                                                                 │
│  Troubleshooting: npx spec-context-mcp doctor                   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
`);
    } catch (error) {
        console.warn('[postinstall] setup check failed:', error);
    }
}

main();
process.exit(0);
