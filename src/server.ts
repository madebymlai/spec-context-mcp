import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
    ListToolsRequestSchema,
    CallToolRequestSchema,
    ListPromptsRequestSchema,
    GetPromptRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import type { SpecContextConfig } from './config.js';
import { getTools, handleToolCall } from './tools/index.js';
import { handlePromptList, handlePromptGet } from './prompts/index.js';
import { initChunkHoundBridge } from './bridge/chunkhound-bridge.js';

const LOCAL_DASHBOARD_URL = 'http://127.0.0.1:3000';

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

                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify(result, null, 2),
                        },
                    ],
                };
            } catch (error) {
                return {
                    content: [
                        {
                            type: 'text',
                            text: JSON.stringify({
                                success: false,
                                error: error instanceof Error ? error.message : String(error),
                            }),
                        },
                    ],
                    isError: true,
                };
            }
        });

        // List available prompts
        this.server.setRequestHandler(ListPromptsRequestSchema, async () => {
            return handlePromptList();
        });

        // Handle prompt requests
        this.server.setRequestHandler(GetPromptRequestSchema, async (request) => {
            const { name, arguments: args } = request.params;
            const context = {
                projectPath: process.cwd(),
                dashboardUrl: this.config.dashboardUrl,
            };
            return handlePromptGet(name, args || {}, context);
        });
    }

    async run(): Promise<void> {
        console.error(`[${this.config.name}] Starting MCP server...`);

        // Initialize ChunkHound bridge (auto-indexes if needed)
        try {
            await initChunkHoundBridge(process.cwd());
        } catch (err) {
            console.error(`[${this.config.name}] ChunkHound initialization failed:`, err);
            console.error(`[${this.config.name}] Workflow tools will still work, but search/research will be unavailable`);
        }

        // Register with local dashboard
        await this.registerWithDashboard();

        const transport = new StdioServerTransport();
        await this.server.connect(transport);

        console.error(`[${this.config.name}] Server running on stdio`);
    }

    private async registerWithDashboard(): Promise<void> {
        const projectPath = process.cwd();

        try {
            const response = await fetch(`${LOCAL_DASHBOARD_URL}/api/projects/add`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ projectPath }),
            });

            if (response.ok) {
                console.error(`[${this.config.name}] Registered with local dashboard`);
            }
        } catch {
            // Dashboard not running - that's fine
        }
    }
}
