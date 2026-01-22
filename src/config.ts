import 'dotenv/config';

export interface SpecContextConfig {
    name: string;
    version: string;
    dashboardUrl: string;
    // ChunkHound settings
    chunkhoundPython: string;
    voyageaiApiKey?: string;
}

export function validateConfig(): void {
    // ChunkHound uses VoyageAI for embeddings - warn if not set
    if (!process.env.VOYAGEAI_API_KEY) {
        console.error('Warning: VOYAGEAI_API_KEY not set. Semantic search will not work.');
        console.error('Regex search and workflow tools will still work.');
        console.error('');
        console.error('To enable semantic search, set VOYAGEAI_API_KEY in your environment.');
    }
}

export function createConfig(): SpecContextConfig {
    return {
        name: 'spec-context-mcp',
        version: '1.0.0',
        dashboardUrl: process.env.DASHBOARD_URL || 'http://localhost:3000',
        // ChunkHound settings
        chunkhoundPython: process.env.CHUNKHOUND_PYTHON || 'python3',
        voyageaiApiKey: process.env.VOYAGEAI_API_KEY,
    };
}
