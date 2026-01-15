import 'dotenv/config';

export interface SpecContextConfig {
    name: string;
    version: string;
    openrouterApiKey: string;
    embeddingModel: string;
    embeddingDimension: number;
    qdrantUrl: string;
    qdrantApiKey?: string;
    dashboardUrl?: string;
}

export function validateConfig(): void {
    const errors: string[] = [];

    if (!process.env.OPENROUTER_API_KEY) {
        errors.push('OPENROUTER_API_KEY is required');
    }

    if (!process.env.QDRANT_URL) {
        errors.push('QDRANT_URL is required');
    }

    if (errors.length > 0) {
        console.error('Configuration errors:');
        errors.forEach((e) => console.error(`  - ${e}`));
        console.error('\nRequired environment variables:');
        console.error('  OPENROUTER_API_KEY  Your OpenRouter API key');
        console.error('  QDRANT_URL          Qdrant server URL (e.g., http://localhost:6333)');
        console.error('\nOptional:');
        console.error('  EMBEDDING_MODEL     Model to use (default: qwen/qwen3-embedding-8b)');
        console.error('  EMBEDDING_DIMENSION Vector dimension (default: 4096)');
        console.error('  QDRANT_API_KEY      Qdrant API key if authentication enabled');
        console.error('  DASHBOARD_URL       Spec workflow dashboard URL (e.g., http://server:3000)');
        process.exit(1);
    }
}

export function createConfig(): SpecContextConfig {
    return {
        name: 'spec-context-mcp',
        version: '0.1.0',
        openrouterApiKey: process.env.OPENROUTER_API_KEY!,
        embeddingModel: process.env.EMBEDDING_MODEL || 'qwen/qwen3-embedding-8b',
        embeddingDimension: parseInt(process.env.EMBEDDING_DIMENSION || '4096', 10),
        qdrantUrl: process.env.QDRANT_URL!,
        qdrantApiKey: process.env.QDRANT_API_KEY,
        dashboardUrl: process.env.DASHBOARD_URL,
    };
}
