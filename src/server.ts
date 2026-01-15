import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
    ListToolsRequestSchema,
    CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import type { SpecContextConfig } from './config.js';
import { Context } from './core/context.js';
import { QdrantVectorDB } from './core/vectordb/index.js';
import { OpenRouterEmbedding } from './core/embedding/index.js';
import { SimpleCodeSplitter } from './core/splitter/index.js';
import { getTools, handleToolCall } from './tools/index.js';

export class SpecContextServer {
    private server: Server;
    private context: Context;
    private config: SpecContextConfig;

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

        const splitter = new SimpleCodeSplitter();

        this.context = new Context(vectorDb, embedding, splitter);

        // Initialize MCP server
        this.server = new Server(
            {
                name: config.name,
                version: config.version,
            },
            {
                capabilities: {
                    tools: {},
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
    }

    async run(): Promise<void> {
        console.error(`[${this.config.name}] Starting MCP server...`);
        console.error(`[${this.config.name}] Embedding: ${this.config.embeddingModel} (${this.config.embeddingDimension}d)`);
        console.error(`[${this.config.name}] Qdrant: ${this.config.qdrantUrl}`);

        const transport = new StdioServerTransport();
        await this.server.connect(transport);

        console.error(`[${this.config.name}] Server running on stdio`);
    }
}
