import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
    ListToolsRequestSchema,
    CallToolRequestSchema,
    ListPromptsRequestSchema,
    GetPromptRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import type { SpecContextConfig } from './config.js';
import type { ToolResponse, MCPToolResponse } from './workflow-types.js';
import { getTools, handleToolCall } from './tools/index.js';
import { processToolCall, isToolVisible, getVisibilityTier, ensureTierAtLeast } from './tools/registry.js';
import { handlePromptList, handlePromptGet } from './prompts/index.js';
import { initChunkHoundBridge, resetChunkHoundBridge } from './bridge/chunkhound-bridge.js';
import { resolveDashboardUrlForNode } from './core/workflow/node-dashboard-url.js';
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
                    tools: { listChanged: true },
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
            let modeChanged = false;
            let shouldNotifyListChanged = false;

            try {
                // Pre-check: entry-point tools trigger mode transition before
                // visibility gate so they pass on first call from undetermined.
                modeChanged = processToolCall(name);
                shouldNotifyListChanged = modeChanged;

                // Visibility gate: reject calls to tools not in current tier.
                if (!isToolVisible(name)) {
                    console.error(`[spec-context] tool call rejected: "${name}" not visible in current mode/tier`);
                    const rejectResponse: ToolResponse = {
                        success: false,
                        message: `Tool "${name}" is not available in the current session mode. Call an entry-point tool first (e.g. spec-workflow-guide, get-implementer-guide, get-reviewer-guide).`,
                    };
                    return toMCPResponse(rejectResponse, true);
                }

                // Snapshot tier before handler — handlers may call escalateTier().
                const tierBefore = getVisibilityTier();

                const result = await handleToolCall(
                    name,
                    args as Record<string, unknown>
                );

                if (isToolResponse(result) && result.success) {
                    const minTier = parseMinVisibilityTier(result);
                    if (minTier) {
                        ensureTierAtLeast(minTier);
                    }
                }

                const tierAfter = getVisibilityTier();
                if (tierAfter !== tierBefore) {
                    shouldNotifyListChanged = true;
                }

                return normalizeToolResult(result);
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                const errorResponse: ToolResponse = {
                    success: false,
                    message,
                };
                return toMCPResponse(errorResponse, true);
            } finally {
                if (shouldNotifyListChanged) {
                    this.server.sendToolListChanged().catch(err =>
                        console.error('[spec-context] tool list changed notification failed:', err)
                    );
                }
            }
        });

        // List available prompts
        this.server.setRequestHandler(ListPromptsRequestSchema, async () => {
            return handlePromptList();
        });

        // Handle prompt requests
        this.server.setRequestHandler(GetPromptRequestSchema, async (request) => {
            const { name, arguments: args } = request.params;
            const dashboardUrl = await resolveDashboardUrlForNode({
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
        await this.connectTransport(transport);

        console.error(`[${this.config.name}] Server running on stdio`);

        // Exit when the parent process disconnects (stdin closes).
        // StdioServerTransport doesn't listen for 'end', so without this
        // the Node process stays alive as an orphan after the client exits.
        process.stdin.on('end', () => this.shutdown());

        // Clean exit on signals
        process.on('SIGINT', () => this.shutdown());
        process.on('SIGTERM', () => this.shutdown());

        // Fire-and-forget: warm up ChunkHound and dashboard registration without
        // blocking MCP startup (clients like Codex enforce short startup timeouts).
        void initChunkHoundBridge(process.cwd());
        void this.registerWithDashboard();
    }

    async connectTransport(transport: Transport): Promise<void> {
        await this.server.connect(transport);
    }

    async closeTransport(): Promise<void> {
        resetChunkHoundBridge();
        await this.server.close();
    }

    private shutdown(): void {
        console.error(`[${this.config.name}] Shutting down...`);
        resetChunkHoundBridge();
        this.server.close().finally(() => process.exit(0));
    }

    private async registerWithDashboard(): Promise<void> {
        const projectPath = process.cwd();

        try {
            const dashboardUrl = await resolveDashboardUrlForNode({
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
        } catch (error) {
            console.error(`[${this.config.name}] Failed to register with dashboard`, error);
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

function parseMinVisibilityTier(response: ToolResponse): 1 | 2 | 3 | undefined {
    const value = response.meta?.minVisibilityTier;
    if (value === 1 || value === 2 || value === 3) {
        return value;
    }
    return undefined;
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
