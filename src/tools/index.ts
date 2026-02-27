import type { ToolContext as WorkflowToolContext, ToolResponse } from '../workflow-types.js';
import { filterVisibleTools } from './registry.js';
import { TOOL_CATALOG_ORDER, type ToolName } from './catalog.js';
import { mkdir, readdir, rm, stat, writeFile } from 'fs/promises';
import { join, relative } from 'path';
import { randomUUID } from 'crypto';

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
} from './workflow/spec-status.js';
import {
    approvalsTool,
} from './workflow/approvals.js';
import {
    waitForApprovalTool,
    waitForApprovalHandler,
} from './workflow/wait-for-approval.js';
import {
    getImplementerGuideTool,
    getImplementerGuideHandler,
} from './workflow/get-implementer-guide.js';
import {
    getReviewerGuideTool,
    getReviewerGuideHandler,
} from './workflow/get-reviewer-guide.js';
import {
    getBrainstormGuideTool,
    getBrainstormGuideHandler,
} from './workflow/get-brainstorm-guide.js';
import {
    dispatchRuntimeTool,
} from './workflow/dispatch-runtime.js';

export interface Tool {
    name: string;
    description: string;
    inputSchema: {
        type: 'object';
        properties: Record<string, unknown>;
        required?: string[];
    };
}

interface OffloadConfig {
    thresholdChars: number;
    previewChars: number;
    previewLines: number;
    ttlMinutes: number;
}

function readOffloadConfig(): OffloadConfig {
    const parsedThreshold = Number(process.env.SPEC_CONTEXT_TOOL_RESULT_OFFLOAD_CHARS ?? 20000);
    const parsedPreview = Number(process.env.SPEC_CONTEXT_TOOL_RESULT_PREVIEW_CHARS ?? 1200);
    const parsedPreviewLines = Number(process.env.SPEC_CONTEXT_TOOL_RESULT_PREVIEW_LINES ?? 10);
    const parsedTtlMinutes = Number(process.env.SPEC_CONTEXT_TOOL_RESULT_TTL_MINUTES ?? 30);
    return {
        thresholdChars: Number.isFinite(parsedThreshold) && parsedThreshold > 0 ? parsedThreshold : 20000,
        previewChars: Number.isFinite(parsedPreview) && parsedPreview > 0 ? parsedPreview : 1200,
        previewLines: Number.isFinite(parsedPreviewLines) && parsedPreviewLines > 0 ? parsedPreviewLines : 10,
        ttlMinutes: Number.isFinite(parsedTtlMinutes) && parsedTtlMinutes > 0 ? parsedTtlMinutes : 30,
    };
}

function serializeToolData(data: unknown): { serialized: string; contentType: 'text' | 'json' } | null {
    if (typeof data === 'undefined') {
        return null;
    }
    if (typeof data === 'string') {
        return { serialized: data, contentType: 'text' };
    }
    try {
        return {
            serialized: JSON.stringify(data, null, 2),
            contentType: 'json',
        };
    } catch (error) {
        throw new Error(`Failed to serialize tool response payload: ${String(error)}`);
    }
}

function clipPreview(value: string, maxChars: number): string {
    if (value.length <= maxChars) {
        return value;
    }
    if (maxChars <= 3) {
        return value.slice(0, maxChars);
    }
    return `${value.slice(0, maxChars - 3)}...`;
}

function isMeaningfulPreviewLine(line: string): boolean {
    const trimmed = line.trim();
    if (!trimmed) {
        return false;
    }
    return !/^[\[\]{}(),]+$/.test(trimmed);
}

function buildMeaningfulPreview(serialized: string, maxLines: number, maxChars: number): string {
    const lines = serialized.split(/\r?\n/);
    const selected: string[] = [];
    for (const line of lines) {
        if (!isMeaningfulPreviewLine(line)) {
            continue;
        }
        selected.push(line.trim());
        if (selected.length >= maxLines) {
            break;
        }
    }

    if (selected.length === 0) {
        return clipPreview(serialized.trim(), maxChars);
    }

    return clipPreview(selected.join('\n'), maxChars);
}

async function cleanupExpiredOffloads(outputDir: string, ttlMinutes: number): Promise<void> {
    const ttlMs = ttlMinutes * 60 * 1000;
    const cutoff = Date.now() - ttlMs;
    let entries: string[] = [];
    try {
        entries = await readdir(outputDir);
    } catch (error) {
        if (typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'ENOENT') {
            return;
        }
        throw error;
    }

    await Promise.all(entries.map(async entry => {
        const entryPath = join(outputDir, entry);
        try {
            const fileStat = await stat(entryPath);
            if (!fileStat.isFile()) {
                return;
            }
            if (fileStat.mtimeMs < cutoff) {
                await rm(entryPath, { force: true });
            }
        } catch (error) {
            console.error(`[tools] Failed to clean expired offload entry ${entryPath}`, error);
        }
    }));
}

async function maybeOffloadToolResponse(
    toolName: string,
    response: ToolResponse,
    context: WorkflowToolContext
): Promise<ToolResponse> {
    if (!response.success) {
        return response;
    }

    const serialized = serializeToolData(response.data);
    if (!serialized) {
        return response;
    }

    const config = readOffloadConfig();
    if (serialized.serialized.length <= config.thresholdChars) {
        return response;
    }

    const outputDir = join(context.projectPath, '.spec-context', 'tmp', 'tool-results');
    await mkdir(outputDir, { recursive: true });
    await cleanupExpiredOffloads(outputDir, config.ttlMinutes);
    const extension = serialized.contentType === 'json' ? 'json' : 'txt';
    const filename = `${toolName}-${Date.now()}-${randomUUID().slice(0, 8)}.${extension}`;
    const absolutePath = join(outputDir, filename);
    await writeFile(absolutePath, serialized.serialized, 'utf8');

    const relativePath = relative(context.projectPath, absolutePath);
    return {
        ...response,
        data: {
            offloaded: true,
            tool: toolName,
            path: relativePath,
            contentType: serialized.contentType,
            originalSize: serialized.serialized.length,
            preview: buildMeaningfulPreview(serialized.serialized, config.previewLines, config.previewChars),
        },
        nextSteps: [
            ...(response.nextSteps ?? []),
            `Large tool output was offloaded to ${relativePath}`,
        ],
    };
}

export type ToolHandler = (
    args: Record<string, unknown>,
    context: WorkflowToolContext
) => Promise<ToolResponse>;

interface RegisteredTool {
    tool: Tool;
    handler: ToolHandler;
}

export interface ToolRuntimeDependencies {
    resolveDashboardUrl: () => Promise<string | undefined>;
    getFileContentCache: () => NonNullable<WorkflowToolContext['fileContentCache']>;
    specStatusHandler: ToolHandler;
    approvalsHandler: ToolHandler;
    dispatchRuntimeHandler: ToolHandler;
}

export interface ToolRuntime {
    getAllTools(): Tool[];
    getVisibleTools(): Tool[];
    getTools(): Tool[];
    handleToolCall(
        name: string,
        args: Record<string, unknown>,
        workflowContext?: WorkflowToolContext
    ): Promise<unknown>;
}

function buildToolRegistry(dependencies: ToolRuntimeDependencies): Record<ToolName, RegisteredTool> {
    return {
        'spec-workflow-guide': {
            tool: specWorkflowGuideTool as Tool,
            handler: specWorkflowGuideHandler,
        },
        'steering-guide': {
            tool: steeringGuideTool as Tool,
            handler: steeringGuideHandler,
        },
        'spec-status': {
            tool: specStatusTool as Tool,
            handler: dependencies.specStatusHandler,
        },
        approvals: {
            tool: approvalsTool as Tool,
            handler: dependencies.approvalsHandler,
        },
        'wait-for-approval': {
            tool: waitForApprovalTool as Tool,
            handler: (args, context) => waitForApprovalHandler(args as any, context),
        },
        'get-implementer-guide': {
            tool: getImplementerGuideTool as Tool,
            handler: getImplementerGuideHandler,
        },
        'get-reviewer-guide': {
            tool: getReviewerGuideTool as Tool,
            handler: getReviewerGuideHandler,
        },
        'get-brainstorm-guide': {
            tool: getBrainstormGuideTool as Tool,
            handler: getBrainstormGuideHandler,
        },
        'dispatch-runtime': {
            tool: dispatchRuntimeTool as Tool,
            handler: dependencies.dispatchRuntimeHandler,
        },
    };
}

export function createToolRuntime(dependencies: ToolRuntimeDependencies): ToolRuntime {
    const toolRegistry = buildToolRegistry(dependencies);

    function getRegisteredTool(name: string): RegisteredTool | undefined {
        if (!Object.prototype.hasOwnProperty.call(toolRegistry, name)) {
            return undefined;
        }
        return toolRegistry[name as ToolName];
    }

    function getAllTools(): Tool[] {
        return TOOL_CATALOG_ORDER.map(name => toolRegistry[name].tool);
    }

    function getVisibleTools(): Tool[] {
        return filterVisibleTools(getAllTools());
    }

    async function handleToolCall(
        name: string,
        args: Record<string, unknown>,
        workflowContext?: WorkflowToolContext
    ): Promise<unknown> {
        const projectPath = (args.projectPath as string) || workflowContext?.projectPath || process.cwd();
        const dashboardUrl = workflowContext?.dashboardUrl || await dependencies.resolveDashboardUrl();
        const fileContentCache = workflowContext?.fileContentCache ?? dependencies.getFileContentCache();
        const wfCtx: WorkflowToolContext = {
            ...workflowContext,
            projectPath,
            dashboardUrl,
            fileContentCache,
        };

        const registeredTool = getRegisteredTool(name);
        if (!registeredTool) {
            throw new Error(`Unknown tool: ${name}`);
        }

        const rawResponse = await registeredTool.handler(args, wfCtx);
        return maybeOffloadToolResponse(name, rawResponse, wfCtx);
    }

    return {
        getAllTools,
        getVisibleTools,
        getTools: getVisibleTools,
        handleToolCall,
    };
}
