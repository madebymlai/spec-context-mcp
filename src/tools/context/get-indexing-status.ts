import type { Context } from '../../core/context.js';

export interface GetIndexingStatusInput {
    path: string;
}

export interface GetIndexingStatusOutput {
    success: boolean;
    status: 'not_indexed' | 'indexed';
    message: string;
    collectionName?: string;
}

export async function getIndexingStatus(
    context: Context,
    input: GetIndexingStatusInput
): Promise<GetIndexingStatusOutput> {
    try {
        const isIndexed = await context.isIndexed(input.path);
        const collectionName = context.getCollectionName(input.path);

        if (isIndexed) {
            return {
                success: true,
                status: 'indexed',
                message: 'Codebase is indexed and ready for search.',
                collectionName,
            };
        } else {
            return {
                success: true,
                status: 'not_indexed',
                message: 'Codebase is not indexed. Run index_codebase to index it.',
                collectionName,
            };
        }
    } catch (error) {
        return {
            success: false,
            status: 'not_indexed',
            message: `Failed to check status: ${error instanceof Error ? error.message : String(error)}`,
        };
    }
}

export const getIndexingStatusSchema = {
    name: 'get_indexing_status',
    description: 'Check if a codebase is indexed and ready for search.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            path: {
                type: 'string',
                description: 'Absolute path to the codebase to check',
            },
        },
        required: ['path'],
    },
};
