import OpenAI from 'openai';
import type { EmbeddingProvider } from './types.js';

export interface OpenRouterEmbeddingConfig {
    apiKey: string;
    model: string;
    dimension: number;
}

export class OpenRouterEmbedding implements EmbeddingProvider {
    private client: OpenAI;
    private model: string;
    private dimension: number;

    constructor(config: OpenRouterEmbeddingConfig) {
        this.client = new OpenAI({
            apiKey: config.apiKey,
            baseURL: 'https://openrouter.ai/api/v1',
        });
        this.model = config.model;
        this.dimension = config.dimension;
    }

    async embed(texts: string[]): Promise<number[][]> {
        if (texts.length === 0) {
            return [];
        }

        // OpenRouter/OpenAI has a limit on batch size, process in chunks
        const batchSize = 100;
        const allEmbeddings: number[][] = [];

        for (let i = 0; i < texts.length; i += batchSize) {
            const batch = texts.slice(i, i + batchSize);
            const response = await this.client.embeddings.create({
                model: this.model,
                input: batch,
            });

            // Sort by index to ensure correct order
            const sorted = response.data.sort((a, b) => a.index - b.index);
            allEmbeddings.push(...sorted.map((d) => d.embedding));
        }

        return allEmbeddings;
    }

    async embedSingle(text: string): Promise<number[]> {
        const results = await this.embed([text]);
        return results[0];
    }

    getDimension(): number {
        return this.dimension;
    }
}
