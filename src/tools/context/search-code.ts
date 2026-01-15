import type { Context } from '../../core/context.js';

export interface SearchCodeInput {
    path: string;
    query: string;
    limit?: number;
    extensionFilter?: string[];
}

export interface SearchCodeOutput {
    success: boolean;
    results?: Array<{
        content: string;
        relativePath: string;
        startLine: number;
        endLine: number;
        language: string;
        score: number;
    }>;
    message?: string;
}

export async function searchCode(
    context: Context,
    input: SearchCodeInput
): Promise<SearchCodeOutput> {
    try {
        const results = await context.search(input.path, input.query, {
            limit: input.limit,
            extensionFilter: input.extensionFilter,
        });

        if (results.length === 0) {
            return {
                success: true,
                results: [],
                message: 'No results found for the query.',
            };
        }

        return {
            success: true,
            results: results.map((r) => ({
                content: r.content,
                relativePath: r.relativePath,
                startLine: r.startLine,
                endLine: r.endLine,
                language: r.language,
                score: r.score,
            })),
        };
    } catch (error) {
        return {
            success: false,
            message: error instanceof Error ? error.message : String(error),
        };
    }
}

export const searchCodeSchema = {
    name: 'search_code',
    description: 'Search for code using natural language. Returns semantically similar code snippets from the indexed codebase.',
    inputSchema: {
        type: 'object' as const,
        properties: {
            path: {
                type: 'string',
                description: 'Absolute path to the indexed codebase',
            },
            query: {
                type: 'string',
                description: 'Natural language search query (e.g., "function that handles user authentication")',
            },
            limit: {
                type: 'number',
                description: 'Maximum number of results to return. Default: 10',
            },
            extensionFilter: {
                type: 'array',
                items: { type: 'string' },
                description: 'Filter results by file extension (e.g., [".ts", ".py"])',
            },
        },
        required: ['path', 'query'],
    },
};
