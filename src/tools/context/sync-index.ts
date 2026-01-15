import { Context } from '../../core/context.js';

export const syncIndexSchema = {
    name: 'sync_index',
    description: 'Incrementally sync the index with only changed files. Faster than full reindex. Detects added, modified, and removed files since last sync.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            path: {
                type: 'string',
                description: 'Absolute path to the codebase to sync',
            },
        },
        required: ['path'],
    },
};

export interface SyncIndexInput {
    path: string;
}

export interface SyncIndexOutput {
    success: boolean;
    message: string;
    added: number;
    removed: number;
    modified: number;
    totalChunks?: number;
}

export async function syncIndex(
    context: Context,
    input: SyncIndexInput
): Promise<SyncIndexOutput> {
    const { path: projectPath } = input;
    try {
        const result = await context.syncCodebase(projectPath);

        const totalChanges = result.added + result.removed + result.modified;

        if (totalChanges === 0) {
            return {
                success: true,
                message: 'No changes detected. Index is up to date.',
                added: 0,
                removed: 0,
                modified: 0
            };
        }

        return {
            success: true,
            message: `Synced ${totalChanges} file changes: ${result.added} added, ${result.removed} removed, ${result.modified} modified.`,
            added: result.added,
            removed: result.removed,
            modified: result.modified,
            totalChunks: result.totalChunks
        };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
            success: false,
            message: `Failed to sync index: ${message}`,
            added: 0,
            removed: 0,
            modified: 0
        };
    }
}
