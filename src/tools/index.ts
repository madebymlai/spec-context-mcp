import type { Context } from '../core/context.js';
import type { ToolContext as WorkflowToolContext } from '../workflow-types.js';
import {
    indexCodebase,
    indexCodebaseSchema,
    searchCode,
    searchCodeSchema,
    clearIndex,
    clearIndexSchema,
    getIndexingStatus,
    getIndexingStatusSchema,
    syncIndex,
    syncIndexSchema,
} from './context/index.js';

// Workflow tools
import {
    specWorkflowGuideTool,
    specWorkflowGuideHandler,
} from './workflow/spec-workflow-guide.js';
import {
    steeringGuideTool,
    steeringGuideHandler,
} from './workflow/steering-guide.js';
import {
    specStatusTool,
    specStatusHandler,
} from './workflow/spec-status.js';
import {
    approvalsTool,
    approvalsHandler,
} from './workflow/approvals.js';
import {
    logImplementationTool,
    logImplementationHandler,
} from './workflow/log-implementation.js';

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
        // Context tools (vector search)
        indexCodebaseSchema,
        searchCodeSchema,
        clearIndexSchema,
        getIndexingStatusSchema,
        syncIndexSchema,
        // Workflow tools
        specWorkflowGuideTool as Tool,
        steeringGuideTool as Tool,
        specStatusTool as Tool,
        approvalsTool as Tool,
        logImplementationTool as Tool,
    ];
}

export async function handleToolCall(
    name: string,
    args: Record<string, unknown>,
    context: Context,
    workflowContext?: WorkflowToolContext
): Promise<unknown> {
    // Create workflow context if not provided
    const wfCtx: WorkflowToolContext = workflowContext || {
        projectPath: (args.projectPath as string) || process.cwd(),
        dashboardUrl: process.env.DASHBOARD_URL,
    };

    switch (name) {
        // Context tools (vector search)
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

        case 'sync_index':
            return syncIndex(context, {
                path: args.path as string,
            });

        // Workflow tools
        case 'spec-workflow-guide':
            return specWorkflowGuideHandler(args, wfCtx);

        case 'steering-guide':
            return steeringGuideHandler(args, wfCtx);

        case 'spec-status':
            return specStatusHandler(args, wfCtx);

        case 'approvals':
            return approvalsHandler(args as any, wfCtx);

        case 'log-implementation':
            return logImplementationHandler(args as any, wfCtx);

        default:
            throw new Error(`Unknown tool: ${name}`);
    }
}
