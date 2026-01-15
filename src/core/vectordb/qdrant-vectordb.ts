import { QdrantClient } from '@qdrant/js-client-rest';
import * as crypto from 'crypto';
import type {
    VectorDatabase,
    VectorDocument,
    SearchOptions,
    VectorSearchResult,
    HybridSearchRequest,
    HybridSearchOptions,
    HybridSearchResult,
} from './types.js';

export interface QdrantConfig {
    url: string;
    apiKey?: string;
}

export class QdrantVectorDB implements VectorDatabase {
    private client: QdrantClient;

    constructor(config: QdrantConfig) {
        this.client = new QdrantClient({
            url: config.url,
            apiKey: config.apiKey,
        });
    }

    async createCollection(collectionName: string, dimension: number, _description?: string): Promise<void> {
        const exists = await this.hasCollection(collectionName);
        if (exists) {
            console.log(`[Qdrant] Collection ${collectionName} already exists, skipping creation`);
            return;
        }

        await this.client.createCollection(collectionName, {
            vectors: {
                size: dimension,
                distance: 'Cosine',
            },
        });

        // Create payload indexes for filtering
        await this.client.createPayloadIndex(collectionName, {
            field_name: 'relativePath',
            field_schema: 'keyword',
        });

        await this.client.createPayloadIndex(collectionName, {
            field_name: 'fileExtension',
            field_schema: 'keyword',
        });

        console.log(`[Qdrant] Created collection ${collectionName} with dimension ${dimension}`);
    }

    async createHybridCollection(collectionName: string, dimension: number, description?: string): Promise<void> {
        // For now, create same as regular collection (dense only)
        // Hybrid search with sparse vectors can be added later
        await this.createCollection(collectionName, dimension, description);
    }

    async dropCollection(collectionName: string): Promise<void> {
        const exists = await this.hasCollection(collectionName);
        if (!exists) {
            console.log(`[Qdrant] Collection ${collectionName} does not exist, skipping drop`);
            return;
        }

        await this.client.deleteCollection(collectionName);
        console.log(`[Qdrant] Dropped collection ${collectionName}`);
    }

    async hasCollection(collectionName: string): Promise<boolean> {
        try {
            const collections = await this.client.getCollections();
            return collections.collections.some((c) => c.name === collectionName);
        } catch (error) {
            console.error('[Qdrant] Error checking collection existence:', error);
            return false;
        }
    }

    async listCollections(): Promise<string[]> {
        const collections = await this.client.getCollections();
        return collections.collections.map((c) => c.name);
    }

    async insert(collectionName: string, documents: VectorDocument[]): Promise<void> {
        if (documents.length === 0) return;

        const points = documents.map((doc) => ({
            id: this.generatePointId(doc.id),
            vector: doc.vector,
            payload: {
                content: doc.content,
                relativePath: doc.relativePath,
                startLine: doc.startLine,
                endLine: doc.endLine,
                fileExtension: doc.fileExtension,
                metadata: doc.metadata,
                originalId: doc.id,
            },
        }));

        // Insert in batches of 100
        const batchSize = 100;
        for (let i = 0; i < points.length; i += batchSize) {
            const batch = points.slice(i, i + batchSize);
            await this.client.upsert(collectionName, {
                points: batch,
            });
        }

        console.log(`[Qdrant] Inserted ${documents.length} documents into ${collectionName}`);
    }

    async insertHybrid(collectionName: string, documents: VectorDocument[]): Promise<void> {
        // For now, same as regular insert (dense only)
        await this.insert(collectionName, documents);
    }

    async search(collectionName: string, queryVector: number[], options?: SearchOptions): Promise<VectorSearchResult[]> {
        const limit = options?.topK ?? 10;
        const filter = options?.filterExpr ? this.parseFilterExpr(options.filterExpr) : undefined;

        const results = await this.client.search(collectionName, {
            vector: queryVector,
            limit,
            filter,
            with_payload: true,
        });

        return results.map((result) => ({
            document: {
                id: (result.payload?.originalId as string) ?? String(result.id),
                vector: [], // Not returned by Qdrant search
                content: (result.payload?.content as string) ?? '',
                relativePath: (result.payload?.relativePath as string) ?? '',
                startLine: (result.payload?.startLine as number) ?? 0,
                endLine: (result.payload?.endLine as number) ?? 0,
                fileExtension: (result.payload?.fileExtension as string) ?? '',
                metadata: (result.payload?.metadata as Record<string, unknown>) ?? {},
            },
            score: result.score,
        }));
    }

    async hybridSearch(
        collectionName: string,
        searchRequests: HybridSearchRequest[],
        options?: HybridSearchOptions
    ): Promise<HybridSearchResult[]> {
        // For now, use only the first request (dense search)
        // Full hybrid search with RRF can be implemented later
        if (searchRequests.length === 0) {
            return [];
        }

        const request = searchRequests[0];
        if (typeof request.data === 'string') {
            throw new Error('Text-based hybrid search not yet implemented');
        }

        const results = await this.search(collectionName, request.data, {
            topK: options?.limit ?? request.limit,
            filterExpr: options?.filterExpr,
        });

        return results;
    }

    async delete(collectionName: string, ids: string[]): Promise<void> {
        if (ids.length === 0) return;

        const pointIds = ids.map((id) => this.generatePointId(id));

        await this.client.delete(collectionName, {
            points: pointIds,
        });

        console.log(`[Qdrant] Deleted ${ids.length} documents from ${collectionName}`);
    }

    async query(
        collectionName: string,
        filter: string,
        outputFields: string[],
        limit?: number
    ): Promise<Record<string, unknown>[]> {
        const qdrantFilter = this.parseFilterExpr(filter);

        const results = await this.client.scroll(collectionName, {
            filter: qdrantFilter,
            limit: limit ?? 100,
            with_payload: true,
        });

        return results.points.map((point) => {
            const record: Record<string, unknown> = {};
            for (const field of outputFields) {
                if (point.payload && field in point.payload) {
                    record[field] = point.payload[field];
                }
            }
            record['id'] = point.payload?.originalId ?? point.id;
            return record;
        });
    }

    async checkCollectionLimit(): Promise<boolean> {
        // Qdrant doesn't have collection limits like Zilliz Cloud
        return true;
    }

    /**
     * Generate a numeric point ID from a string ID
     * Qdrant requires numeric or UUID point IDs
     */
    private generatePointId(id: string): string {
        // Create a UUID v5 from the string ID using a namespace
        const namespace = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'; // Standard UUID namespace
        const hash = crypto.createHash('md5').update(namespace + id).digest('hex');
        // Format as UUID
        return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
    }

    /**
     * Parse a simple filter expression into Qdrant filter format
     * Supports: field == "value", field in ["a", "b"], field != "value"
     */
    private parseFilterExpr(expr: string): Record<string, unknown> | undefined {
        if (!expr || expr.trim() === '') return undefined;

        const conditions: unknown[] = [];

        // Handle: field in ["a", "b"]
        const inMatch = expr.match(/(\w+)\s+in\s+\[([^\]]+)\]/i);
        if (inMatch) {
            const field = inMatch[1];
            const values = inMatch[2].split(',').map((v) => v.trim().replace(/['"]/g, ''));
            conditions.push({
                should: values.map((value) => ({
                    key: field,
                    match: { value },
                })),
            });
        }

        // Handle: field == "value"
        const eqMatch = expr.match(/(\w+)\s*==\s*["']([^"']+)["']/);
        if (eqMatch) {
            conditions.push({
                key: eqMatch[1],
                match: { value: eqMatch[2] },
            });
        }

        // Handle: field != "value"
        const neqMatch = expr.match(/(\w+)\s*!=\s*["']([^"']+)["']/);
        if (neqMatch) {
            conditions.push({
                must_not: [{
                    key: neqMatch[1],
                    match: { value: neqMatch[2] },
                }],
            });
        }

        if (conditions.length === 0) return undefined;
        if (conditions.length === 1) return conditions[0] as Record<string, unknown>;

        return { must: conditions };
    }
}
