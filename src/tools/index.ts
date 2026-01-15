import type { Context } from '../core/context.js';
import {
    indexCodebase,
    indexCodebaseSchema,
    searchCode,
    searchCodeSchema,
    clearIndex,
    clearIndexSchema,
    getIndexingStatus,
    getIndexingStatusSchema,
} from './context/index.js';

export interface Tool {
    name: string;
    description: string;
    inputSchema: {
        type: 'object';
        properties: Record<string, unknown>;
        required?: string[];
    };
}

export function getTools(): Tool[] {
    return [
        indexCodebaseSchema,
        searchCodeSchema,
        clearIndexSchema,
        getIndexingStatusSchema,
    ];
}

export async function handleToolCall(
    name: string,
    args: Record<string, unknown>,
    context: Context
): Promise<unknown> {
    switch (name) {
        case 'index_codebase':
            return indexCodebase(context, {
                path: args.path as string,
                force: args.force as boolean | undefined,
                customExtensions: args.customExtensions as string[] | undefined,
                ignorePatterns: args.ignorePatterns as string[] | undefined,
            });

        case 'search_code':
            return searchCode(context, {
                path: args.path as string,
                query: args.query as string,
                limit: args.limit as number | undefined,
                extensionFilter: args.extensionFilter as string[] | undefined,
            });

        case 'clear_index':
            return clearIndex(context, {
                path: args.path as string,
            });

        case 'get_indexing_status':
            return getIndexingStatus(context, {
                path: args.path as string,
            });

        default:
            throw new Error(`Unknown tool: ${name}`);
    }
}
