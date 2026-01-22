import type { ToolContext as WorkflowToolContext } from '../workflow-types.js';
import { getChunkHoundBridge, SearchArgs, CodeResearchArgs } from '../bridge/chunkhound-bridge.js';

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
import {
    waitForApprovalTool,
    waitForApprovalHandler,
} from './workflow/wait-for-approval.js';

export interface Tool {
    name: string;
    description: string;
    inputSchema: {
        type: 'object';
        properties: Record<string, unknown>;
        required?: string[];
    };
}

// ChunkHound tool schemas
const searchTool: Tool = {
    name: 'search',
    description: `Search code by exact pattern (regex) or meaning (semantic).

TYPE SELECTION:
- regex: Exact pattern matching. Use for function names, variable names,
  import statements, or known string patterns.
  Example queries: "def authenticate", "import.*pandas", "TODO:.*fix"

- semantic: Meaning-based search. Use when describing functionality
  conceptually or unsure of exact keywords.
  Example queries: "authentication logic", "error handling for database"

WHEN TO USE: Quick lookup, finding references, exploring unfamiliar code.
DO NOT USE: Multi-file architecture questions (use code_research instead).

OUTPUT: {results: [{file_path, content, start_line, end_line}], pagination}
COST: Fast, cheap - use liberally.`,
    inputSchema: {
        type: 'object',
        properties: {
            type: {
                type: 'string',
                enum: ['semantic', 'regex'],
                description: '"semantic" for meaning-based, "regex" for exact pattern',
            },
            query: {
                type: 'string',
                description: 'Search query (natural language for semantic, regex pattern for regex)',
            },
            path: {
                type: 'string',
                description: 'Optional path to limit search scope (e.g., "src/auth/")',
            },
            page_size: {
                type: 'number',
                description: 'Number of results per page (1-100)',
                default: 10,
            },
            offset: {
                type: 'number',
                description: 'Starting offset for pagination',
                default: 0,
            },
        },
        required: ['type', 'query'],
    },
};

const codeResearchTool: Tool = {
    name: 'code_research',
    description: `Deep analysis for architecture and cross-file code.

USE FOR:
- Understanding how systems/features are implemented across files
- Discovering component relationships and dependencies
- Getting architectural explanations with code citations

DO NOT USE:
- Looking for specific code locations (use search instead)
- Simple pattern matching (use search with type="regex")
- You already know where the code is (read files directly)

OUTPUT: Comprehensive markdown with architecture overview, key locations, relationships.
COST: Expensive (LLM synthesis). 10-60s latency. One call often replaces 5-10 searches.

ERROR RECOVERY: If incomplete, try narrower query or use path parameter to scope.`,
    inputSchema: {
        type: 'object',
        properties: {
            query: {
                type: 'string',
                description: 'Research query',
            },
            path: {
                type: 'string',
                description: 'Optional relative path to limit research scope (e.g., "src/")',
            },
        },
        required: ['query'],
    },
};

export function getTools(): Tool[] {
    return [
        // ChunkHound context tools
        searchTool,
        codeResearchTool,
        // Workflow tools
        specWorkflowGuideTool as Tool,
        steeringGuideTool as Tool,
        specStatusTool as Tool,
        approvalsTool as Tool,
        logImplementationTool as Tool,
        waitForApprovalTool as Tool,
    ];
}

export async function handleToolCall(
    name: string,
    args: Record<string, unknown>,
    workflowContext?: WorkflowToolContext
): Promise<unknown> {
    // Create workflow context if not provided
    const wfCtx: WorkflowToolContext = workflowContext || {
        projectPath: (args.projectPath as string) || process.cwd(),
        dashboardUrl: process.env.DASHBOARD_URL || 'http://localhost:3000',
    };

    switch (name) {
        // ChunkHound context tools
        case 'search': {
            const bridge = getChunkHoundBridge(wfCtx.projectPath);
            return bridge.search(args as unknown as SearchArgs);
        }

        case 'code_research': {
            const bridge = getChunkHoundBridge(wfCtx.projectPath);
            return bridge.codeResearch(args as unknown as CodeResearchArgs);
        }

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

        case 'wait-for-approval':
            return waitForApprovalHandler(args as any, wfCtx);

        default:
            throw new Error(`Unknown tool: ${name}`);
    }
}
