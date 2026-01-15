import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
    ListToolsRequestSchema,
    CallToolRequestSchema,
    ListPromptsRequestSchema,
    GetPromptRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import type { SpecContextConfig } from './config.js';
import { Context } from './core/context.js';
import { QdrantVectorDB } from './core/vectordb/index.js';
import { OpenRouterEmbedding } from './core/embedding/index.js';
import { LangChainCodeSplitter } from './core/splitter/index.js';
import { getTools, handleToolCall } from './tools/index.js';
import { handlePromptList, handlePromptGet } from './prompts/index.js';
import { SnapshotManager, SyncManager } from './managers/index.js';

// Track registered projects for cleanup on exit
const registeredProjects: { dashboardUrl: string; projectId: string }[] = [];

export class SpecContextServer {
    private server: Server;
    private context: Context;
    private config: SpecContextConfig;
    private snapshotManager: SnapshotManager;
    private syncManager: SyncManager;

    constructor(config: SpecContextConfig) {
        this.config = config;

        // Initialize components
        const vectorDb = new QdrantVectorDB({
            url: config.qdrantUrl,
            apiKey: config.qdrantApiKey,
        });

        const embedding = new OpenRouterEmbedding({
            apiKey: config.openrouterApiKey,
            model: config.embeddingModel,
            dimension: config.embeddingDimension,
        });

        const splitter = new LangChainCodeSplitter();

        this.context = new Context(vectorDb, embedding, splitter);

        // Initialize managers
        this.snapshotManager = new SnapshotManager();
        this.snapshotManager.loadSnapshot();
        this.syncManager = new SyncManager(this.context, this.snapshotManager);

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
                    args as Record<string, unknown>,
                    this.context
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
        console.error(`[${this.config.name}] Embedding: ${this.config.embeddingModel} (${this.config.embeddingDimension}d)`);
        console.error(`[${this.config.name}] Qdrant: ${this.config.qdrantUrl}`);

        // Register with remote dashboard if configured
        if (this.config.dashboardUrl) {
            await this.registerWithDashboard();
        }

        // Start background sync (every 5 minutes)
        this.syncManager.startBackgroundSync();

        const transport = new StdioServerTransport();
        await this.server.connect(transport);

        console.error(`[${this.config.name}] Server running on stdio`);
    }

    private async registerWithDashboard(): Promise<void> {
        const projectPath = process.cwd();
        const dashboardUrl = this.config.dashboardUrl!;

        try {
            const headers: Record<string, string> = { 'Content-Type': 'application/json' };
            if (this.config.dashboardApiKey) {
                headers['Authorization'] = `Bearer ${this.config.dashboardApiKey}`;
            }

            const response = await fetch(`${dashboardUrl}/api/projects/add`, {
                method: 'POST',
                headers,
                body: JSON.stringify({ projectPath }),
            });

            if (response.ok) {
                const data = await response.json() as { projectId: string };
                registeredProjects.push({ dashboardUrl, projectId: data.projectId });
                console.error(`[${this.config.name}] Registered with dashboard: ${dashboardUrl}`);
            } else {
                console.error(`[${this.config.name}] Failed to register with dashboard: ${response.status}`);
            }
        } catch (error) {
            console.error(`[${this.config.name}] Dashboard registration failed:`, error instanceof Error ? error.message : error);
        }
    }

    getSnapshotManager(): SnapshotManager {
        return this.snapshotManager;
    }

    getSyncManager(): SyncManager {
        return this.syncManager;
    }
}

/**
 * Cleanup function to unregister from all dashboards on exit
 */
export async function cleanupDashboardRegistrations(apiKey?: string): Promise<void> {
    for (const { dashboardUrl, projectId } of registeredProjects) {
        try {
            const headers: Record<string, string> = {};
            if (apiKey) {
                headers['Authorization'] = `Bearer ${apiKey}`;
            }
            await fetch(`${dashboardUrl}/api/projects/${projectId}`, {
                method: 'DELETE',
                headers,
            });
        } catch {
            // Ignore cleanup errors
        }
    }
}
