import type { Context } from '../../core/context.js';

export interface IndexCodebaseInput {
    path: string;
    force?: boolean;
    customExtensions?: string[];
    ignorePatterns?: string[];
}

export interface IndexCodebaseOutput {
    success: boolean;
    message: string;
    indexedFiles?: number;
    totalChunks?: number;
    collectionName?: string;
}

export async function indexCodebase(
    context: Context,
    input: IndexCodebaseInput
): Promise<IndexCodebaseOutput> {
    try {
        const result = await context.indexCodebase(input.path, {
            force: input.force,
            customExtensions: input.customExtensions,
            ignorePatterns: input.ignorePatterns,
            onProgress: (progress) => {
                // Progress could be reported via MCP notifications in the future
                console.log(`[index_codebase] ${progress.phase}: ${progress.current}/${progress.total}`);
            },
        });

        if (result.totalChunks === 0) {
            return {
                success: true,
                message: result.indexedFiles === 0
                    ? 'Codebase already indexed. Use force=true to re-index.'
                    : 'No code files found to index.',
            };
        }

        return {
            success: true,
            message: `Successfully indexed ${result.indexedFiles} files into ${result.totalChunks} chunks.`,
            indexedFiles: result.indexedFiles,
            totalChunks: result.totalChunks,
            collectionName: result.collectionName,
        };
    } catch (error) {
        return {
            success: false,
            message: `Failed to index codebase: ${error instanceof Error ? error.message : String(error)}`,
        };
    }
}

export const indexCodebaseSchema = {
    name: 'index_codebase',
    description: 'Index a codebase for semantic code search. This scans the directory, splits code into chunks, generates embeddings, and stores them in the vector database.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            path: {
                type: 'string',
                description: 'Absolute path to the codebase directory to index',
            },
            force: {
                type: 'boolean',
                description: 'Force re-indexing even if already indexed. Default: false',
            },
            customExtensions: {
                type: 'array',
                items: { type: 'string' },
                description: 'Custom file extensions to include (e.g., [".ts", ".py"]). Default: common code extensions',
            },
            ignorePatterns: {
                type: 'array',
                items: { type: 'string' },
                description: 'Additional glob patterns to ignore (e.g., ["test/**", "*.test.ts"])',
            },
        },
        required: ['path'],
    },
};
