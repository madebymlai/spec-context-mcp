import dotenv from 'dotenv';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { DEFAULT_DASHBOARD_URL, getPackageVersion } from './core/workflow/constants.js';

// Load .env from the server's own directory, not the user's project cwd
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: resolve(__dirname, '..', '.env') });

export interface SpecContextConfig {
    name: string;
    version: string;
    dashboardUrl: string;
}

export function createConfig(): SpecContextConfig {
    return {
        name: 'spec-context-mcp',
        version: getPackageVersion(),
        dashboardUrl: process.env.DASHBOARD_URL || DEFAULT_DASHBOARD_URL,
    };
}
