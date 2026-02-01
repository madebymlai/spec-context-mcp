import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
    ListToolsRequestSchema,
    CallToolRequestSchema,
    ListPromptsRequestSchema,
    GetPromptRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import type { SpecContextConfig } from './config.js';
import type { ToolResponse, MCPToolResponse } from './workflow-types.js';
import { getTools, handleToolCall } from './tools/index.js';
import { handlePromptList, handlePromptGet } from './prompts/index.js';
import { initChunkHoundBridge } from './bridge/chunkhound-bridge.js';
import { resolveDashboardUrl } from './core/workflow/dashboard-url.js';
import { DEFAULT_DASHBOARD_URL } from './core/workflow/constants.js';
import { toMCPResponse } from './workflow-types.js';

export class SpecContextServer {
    private server: Server;
    private config: SpecContextConfig;

    constructor(config: SpecContextConfig) {
        this.config = config;

        // Initialize MCP server
        this.server = new Server(
            {
                name: config.name,
                version: config.version,
            },
            {
                capabilities: {
                    tools: {},
                    prompts: {},
                },
            }
        );

        this.setupHandlers();
    }

    private setupHandlers(): void {
        // List available tools
        this.server.setRequestHandler(ListToolsRequestSchema, async () => {
            return { tools: getTools() };
        });

        // Handle tool calls
        this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
            const { name, arguments: args } = request.params;

            try {
                const result = await handleToolCall(
                    name,
                    args as Record<string, unknown>
                );

                return normalizeToolResult(result);
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                const errorResponse: ToolResponse = {
                    success: false,
                    message,
                };
                return toMCPResponse(errorResponse, true);
            }
        });

        // List available prompts
        this.server.setRequestHandler(ListPromptsRequestSchema, async () => {
            return handlePromptList();
        });

        // Handle prompt requests
        this.server.setRequestHandler(GetPromptRequestSchema, async (request) => {
            const { name, arguments: args } = request.params;
            const dashboardUrl = await resolveDashboardUrl({
                defaultUrl: DEFAULT_DASHBOARD_URL,
            });
            const context = {
                projectPath: process.cwd(),
                dashboardUrl,
            };
            return handlePromptGet(name, args || {}, context);
        });
    }

    async run(): Promise<void> {
        console.error(`[${this.config.name}] Starting MCP server...`);

        const transport = new StdioServerTransport();
        await this.server.connect(transport);

        console.error(`[${this.config.name}] Server running on stdio`);

        // Fire-and-forget: warm up ChunkHound and dashboard registration without
        // blocking MCP startup (clients like Codex enforce short startup timeouts).
        void initChunkHoundBridge(process.cwd());
        void this.registerWithDashboard();
    }

    private async registerWithDashboard(): Promise<void> {
        const projectPath = process.cwd();

        try {
            const dashboardUrl = await resolveDashboardUrl({
                defaultUrl: DEFAULT_DASHBOARD_URL,
            });
            const response = await fetch(`${dashboardUrl}/api/projects/add`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ projectPath }),
            });

            if (response.ok) {
                console.error(`[${this.config.name}] Registered with dashboard at ${dashboardUrl}`);
            }
        } catch {
            // Dashboard not running - that's fine
        }
    }
}

function isMCPToolResponse(value: unknown): value is MCPToolResponse {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const candidate = value as MCPToolResponse;
    return Array.isArray(candidate.content);
}

function isToolResponse(value: unknown): value is ToolResponse {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const candidate = value as ToolResponse;
    return typeof candidate.success === 'boolean' && typeof candidate.message === 'string';
}

function normalizeToolResult(result: unknown): MCPToolResponse {
    if (isMCPToolResponse(result)) {
        return result;
    }
    if (isToolResponse(result)) {
        return toMCPResponse(result);
    }
    return {
        content: [
            {
                type: 'text',
                text: JSON.stringify(result, null, 2),
            },
        ],
    };
}
