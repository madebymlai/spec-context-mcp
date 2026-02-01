import 'dotenv/config';
import { DEFAULT_DASHBOARD_URL, getPackageVersion } from './core/workflow/constants.js';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

export interface SpecContextConfig {
    name: string;
    version: string;
    dashboardUrl: string;
    // ChunkHound settings
    chunkhoundPython: string;
    voyageaiApiKey?: string;
}

export function validateConfig(): void {
    const embeddingApiKey =
        process.env.EMBEDDING_API_KEY ||
        process.env.CHUNKHOUND_EMBEDDING__API_KEY ||
        process.env.VOYAGEAI_API_KEY ||
        process.env.OPENAI_API_KEY;

    // ChunkHound reads embedding keys from the local .chunkhound.json in the project root.
    // Treat that as configured so we don't warn users who rely on file-based config.
    let chunkhoundFileApiKey: string | undefined;
    try {
        const configPath = join(process.cwd(), '.chunkhound.json');
        if (existsSync(configPath)) {
            const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as {
                embedding?: { api_key?: unknown } | null;
            };
            const maybe = parsed?.embedding?.api_key;
            if (typeof maybe === 'string' && maybe.trim()) {
                chunkhoundFileApiKey = maybe.trim();
            }
        }
    } catch {
        // Ignore parse errors; doctor provides more detailed diagnostics.
    }

    if (!embeddingApiKey && !chunkhoundFileApiKey) {
        console.error('Warning: No embedding API key is set. Semantic search may not work.');
        console.error('Regex search and workflow tools will still work.');
        console.error('');
        console.error('To enable semantic search, set EMBEDDING_API_KEY (or VOYAGEAI_API_KEY / OPENAI_API_KEY).');
    }
}

export function createConfig(): SpecContextConfig {
    return {
        name: 'spec-context-mcp',
        version: getPackageVersion('1.0.0'),
        dashboardUrl: process.env.DASHBOARD_URL || DEFAULT_DASHBOARD_URL,
        // ChunkHound settings
        chunkhoundPython: process.env.CHUNKHOUND_PYTHON || 'python3',
        voyageaiApiKey: process.env.VOYAGEAI_API_KEY,
    };
}
