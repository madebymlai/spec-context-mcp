import 'dotenv/config';
import { DEFAULT_DASHBOARD_URL, getPackageVersion } from './core/workflow/constants.js';

export interface SpecContextConfig {
    name: string;
    version: string;
    dashboardUrl: string;
    // ChunkHound settings
    chunkhoundPython: string;
}

export function validateConfig(): void {
    const embeddingApiKey =
        process.env.EMBEDDING_API_KEY ||
        process.env.CHUNKHOUND_EMBEDDING__API_KEY ||
        process.env.VOYAGEAI_API_KEY;

    if (!embeddingApiKey) {
        console.error('Warning: No embedding API key is set. Semantic search may not work.');
        console.error('Regex search and workflow tools will still work.');
        console.error('');
        console.error('To enable semantic search, set EMBEDDING_API_KEY (or VOYAGEAI_API_KEY) in .env.');
    }
}

export function createConfig(): SpecContextConfig {
    return {
        name: 'spec-context-mcp',
        version: getPackageVersion('1.0.0'),
        dashboardUrl: process.env.DASHBOARD_URL || DEFAULT_DASHBOARD_URL,
        // ChunkHound settings
        chunkhoundPython: process.env.CHUNKHOUND_PYTHON || 'python3',
    };
}
