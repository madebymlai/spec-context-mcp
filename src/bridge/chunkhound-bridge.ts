/**
 * ChunkHound Bridge - Spawns ChunkHound Python process and forwards MCP tool calls.
 *
 * Features:
 * - Auto-indexes project on startup (if not already indexed)
 * - Auto-generates .chunkhound.json config before first index
 * - Forwards `search` and `code_research` tools to ChunkHound
 * - After initial index, ChunkHound auto-syncs with file watching
 */

import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { EventEmitter } from 'events';

// ESM equivalent of __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface ChunkHoundConfig {
    pythonPath: string;
    voyageaiApiKey?: string;
}

export interface SearchArgs {
    type: 'semantic' | 'regex';
    query: string;
    path?: string;
    page_size?: number;
    offset?: number;
}

export interface CodeResearchArgs {
    query: string;
    path?: string;
}

interface JsonRpcRequest {
    jsonrpc: '2.0';
    id: number;
    method: string;
    params?: unknown;
}

interface JsonRpcResponse {
    jsonrpc: '2.0';
    id: number;
    result?: unknown;
    error?: {
        code: number;
        message: string;
        data?: unknown;
    };
}

export class ChunkHoundBridge extends EventEmitter {
    private process: ChildProcess | null = null;
    private config: ChunkHoundConfig;
    private projectPath: string;
    private requestId = 0;
    private pendingRequests = new Map<number, {
        resolve: (value: unknown) => void;
        reject: (error: Error) => void;
    }>();
    private buffer = '';
    private initialized = false;
    private initPromise: Promise<void> | null = null;
    private scanComplete = false;

    constructor(config: ChunkHoundConfig, projectPath: string) {
        super();
        this.config = config;
        this.projectPath = projectPath;
    }

    /**
     * Start the ChunkHound subprocess and initialize
     */
    async start(): Promise<void> {
        if (this.initPromise) {
            return this.initPromise;
        }

        this.initPromise = this._start();
        return this.initPromise;
    }

    private async _start(): Promise<void> {
        // Ensure .chunkhound.json exists
        await this.ensureConfig();

        // Start the MCP server subprocess
        // ChunkHound auto-indexes during server initialization
        await this.startMcpServer();

        this.initialized = true;
    }

    /**
     * Ensure .chunkhound.json config exists in project root
     */
    private async ensureConfig(): Promise<void> {
        const configPath = path.join(this.projectPath, '.chunkhound.json');

        if (fs.existsSync(configPath)) {
            console.error('[ChunkHound Bridge] Config already exists at', configPath);
            return;
        }

        // Try to get API key from: 1) constructor config, 2) env var, 3) spec-context-mcp's own config
        let apiKey = this.config.voyageaiApiKey || process.env.VOYAGEAI_API_KEY || '';

        if (!apiKey) {
            // Fallback: read from spec-context-mcp's .chunkhound.json
            const specContextRoot = path.resolve(__dirname, '..', '..');
            const specContextConfig = path.join(specContextRoot, '.chunkhound.json');
            if (fs.existsSync(specContextConfig)) {
                try {
                    const configData = JSON.parse(fs.readFileSync(specContextConfig, 'utf-8'));
                    apiKey = configData?.embedding?.api_key || '';
                    if (apiKey) {
                        console.error('[ChunkHound Bridge] Using API key from spec-context-mcp config');
                    }
                } catch {
                    // Ignore parse errors
                }
            }
        }

        const config = {
            embedding: {
                provider: 'voyageai',
                api_key: apiKey,
            },
            llm: {
                provider: 'claude-code-cli',
            },
            database: {
                provider: 'duckdb',
            },
        };

        if (!config.embedding.api_key) {
            console.error('[ChunkHound Bridge] WARNING: VOYAGEAI_API_KEY not set. Semantic search will not work.');
        }

        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
        console.error('[ChunkHound Bridge] Created .chunkhound.json at', configPath);
    }

    /**
     * Start the MCP server subprocess
     */
    private async startMcpServer(): Promise<void> {
        const pythonPath = this.config.pythonPath;

        // Get the spec-context-mcp root (parent of src/bridge)
        const specContextRoot = path.resolve(__dirname, '..', '..');

        this.process = spawn(pythonPath, ['-m', 'chunkhound.mcp_server.stdio'], {
            cwd: this.projectPath,
            env: {
                ...process.env,
                PYTHONPATH: specContextRoot,
            },
            stdio: ['pipe', 'pipe', 'pipe'],
        });

        this.process.stdout?.on('data', (data) => {
            this.handleStdout(data.toString());
        });

        this.process.stderr?.on('data', (data) => {
            const msg = data.toString().trim();
            // ChunkHound logs to stderr (MCP requirement)
            console.error('[ChunkHound]', msg);
            // Detect scan completion from log messages
            if (msg.includes('Background scan completed') || msg.includes('scan_completed_at')) {
                this.scanComplete = true;
            }
        });

        this.process.on('close', (code) => {
            console.error('[ChunkHound Bridge] Process exited with code', code);
            this.process = null;
            this.initialized = false;

            // Reject all pending requests
            for (const [id, { reject }] of this.pendingRequests) {
                reject(new Error('ChunkHound process exited'));
            }
            this.pendingRequests.clear();
        });

        this.process.on('error', (err) => {
            console.error('[ChunkHound Bridge] Process error:', err);
        });

        // Wait for initialize response
        await this.initialize();
    }

    /**
     * Send MCP initialize request
     */
    private async initialize(): Promise<void> {
        const response = await this.sendRequest('initialize', {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: {
                name: 'spec-context-mcp',
                version: '1.0.0',
            },
        });

        console.error('[ChunkHound Bridge] Initialized:', JSON.stringify(response));

        // Send initialized notification
        this.sendNotification('notifications/initialized', {});
    }

    /**
     * Handle stdout data from subprocess
     */
    private handleStdout(data: string): void {
        this.buffer += data;

        // Process complete JSON-RPC messages (newline-delimited)
        const lines = this.buffer.split('\n');
        this.buffer = lines.pop() || '';

        for (const line of lines) {
            if (!line.trim()) continue;

            try {
                const message = JSON.parse(line) as JsonRpcResponse;

                if (message.id !== undefined) {
                    const pending = this.pendingRequests.get(message.id);
                    if (pending) {
                        this.pendingRequests.delete(message.id);
                        if (message.error) {
                            pending.reject(new Error(message.error.message));
                        } else {
                            pending.resolve(message.result);
                        }
                    }
                }
            } catch (err) {
                console.error('[ChunkHound Bridge] Failed to parse response:', line);
            }
        }
    }

    /**
     * Send a JSON-RPC request and wait for response
     */
    private async sendRequest(method: string, params?: unknown): Promise<unknown> {
        if (!this.process?.stdin) {
            throw new Error('ChunkHound process not running');
        }

        const id = ++this.requestId;
        const request: JsonRpcRequest = {
            jsonrpc: '2.0',
            id,
            method,
            params,
        };

        return new Promise((resolve, reject) => {
            this.pendingRequests.set(id, { resolve, reject });

            const message = JSON.stringify(request) + '\n';
            this.process!.stdin!.write(message);

            // Timeout after 60 seconds
            setTimeout(() => {
                if (this.pendingRequests.has(id)) {
                    this.pendingRequests.delete(id);
                    reject(new Error(`Request ${method} timed out`));
                }
            }, 60000);
        });
    }

    /**
     * Send a JSON-RPC notification (no response expected)
     */
    private sendNotification(method: string, params?: unknown): void {
        if (!this.process?.stdin) {
            return;
        }

        const notification = {
            jsonrpc: '2.0',
            method,
            params,
        };

        const message = JSON.stringify(notification) + '\n';
        this.process.stdin.write(message);
    }

    /**
     * Call a ChunkHound tool
     */
    async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
        if (!this.initialized) {
            await this.start();
        }

        const response = await this.sendRequest('tools/call', {
            name,
            arguments: args,
        }) as { content?: Array<{ type: string; text: string }> };

        // Extract text content from MCP response
        if (response?.content && Array.isArray(response.content)) {
            const textContent = response.content.find(c => c.type === 'text');
            if (textContent?.text) {
                try {
                    return JSON.parse(textContent.text);
                } catch {
                    return textContent.text;
                }
            }
        }

        return response;
    }

    /**
     * Search code using ChunkHound
     */
    async search(args: SearchArgs): Promise<unknown> {
        const result = await this.callTool('search', args as unknown as Record<string, unknown>);

        // Show warning while indexing is in progress
        if (!this.scanComplete) {
            const warning = '⚠ INDEXING IN PROGRESS: ChunkHound is indexing files in the background. ' +
                'Results may be incomplete until indexing finishes.';

            if (result && typeof result === 'object') {
                return { ...result as object, warning };
            }
            return { result, warning };
        }

        return result;
    }

    /**
     * Research code using ChunkHound
     */
    async codeResearch(args: CodeResearchArgs): Promise<unknown> {
        return this.callTool('code_research', args as unknown as Record<string, unknown>);
    }

    /**
     * Stop the ChunkHound subprocess
     */
    stop(): void {
        if (this.process) {
            this.process.kill();
            this.process = null;
        }
        this.initialized = false;
        this.initPromise = null;
    }

    /**
     * Check if bridge is healthy
     */
    isHealthy(): boolean {
        return this.process !== null && this.initialized;
    }
}

// Singleton instance
let bridgeInstance: ChunkHoundBridge | null = null;

/**
 * Get or create the ChunkHound bridge singleton
 */
export function getChunkHoundBridge(projectPath?: string): ChunkHoundBridge {
    if (!bridgeInstance) {
        // Default to spec-context-mcp's venv Python which has all dependencies
        const specContextRoot = path.resolve(__dirname, '..', '..');
        const venvPython = path.join(specContextRoot, '.venv', 'bin', 'python');
        const defaultPython = fs.existsSync(venvPython) ? venvPython : 'python3';

        const config: ChunkHoundConfig = {
            pythonPath: process.env.CHUNKHOUND_PYTHON || defaultPython,
            voyageaiApiKey: process.env.VOYAGEAI_API_KEY,
        };
        bridgeInstance = new ChunkHoundBridge(config, projectPath || process.cwd());
    }
    return bridgeInstance;
}

/**
 * Initialize the bridge (call on server startup)
 */
export async function initChunkHoundBridge(projectPath?: string): Promise<ChunkHoundBridge> {
    const bridge = getChunkHoundBridge(projectPath);
    try {
        await bridge.start();
        console.error('[ChunkHound Bridge] Started successfully');
    } catch (err) {
        console.error('[ChunkHound Bridge] Failed to start:', err);
        // Don't throw - workflow tools should still work
    }
    return bridge;
}
