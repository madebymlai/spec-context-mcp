import type { Context } from '../../core/context.js';
import { FileSynchronizer } from '../../core/sync/synchronizer.js';

export interface ClearIndexInput {
    path: string;
}

export interface ClearIndexOutput {
    success: boolean;
    message: string;
}

export async function clearIndex(
    context: Context,
    input: ClearIndexInput
): Promise<ClearIndexOutput> {
    try {
        const isIndexed = await context.isIndexed(input.path);

        if (!isIndexed) {
            return {
                success: true,
                message: 'Codebase was not indexed.',
            };
        }

        await context.clearIndex(input.path);
        await FileSynchronizer.deleteSnapshot(input.path);

        return {
            success: true,
            message: 'Successfully cleared the codebase index and snapshot.',
        };
    } catch (error) {
        return {
            success: false,
            message: `Failed to clear index: ${error instanceof Error ? error.message : String(error)}`,
        };
    }
}

export const clearIndexSchema = {
    name: 'clear_index',
    description: 'Remove the index for a codebase. This deletes all stored embeddings for the project.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            path: {
                type: 'string',
                description: 'Absolute path to the codebase to clear from index',
            },
        },
        required: ['path'],
    },
};
