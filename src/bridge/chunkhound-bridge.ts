/**
 * ChunkHound Bridge - Connects to ChunkHound HTTP server for code search.
 *
 * Features:
 * - Auto-starts ChunkHound HTTP server if not running
 * - Uses deterministic port based on project path (allows multiple projects)
 * - Multiple Claude sessions share the same server per project
 * - Falls back to stdio mode if HTTP fails
 */

import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { fileURLToPath } from 'url';
import { EventEmitter } from 'events';
import { EventSource } from 'eventsource';

// ESM equivalent of __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Port range for ChunkHound servers (31000-31999)
const PORT_RANGE_START = 31000;
const PORT_RANGE_SIZE = 1000;

export interface ChunkHoundConfig {
    pythonPath: string;
    voyageaiApiKey?: string;
    preferHttp?: boolean;  // Default true - use HTTP mode for multi-session support
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

/**
 * Calculate deterministic port for a project path
 */
function getPortForProject(projectPath: string): number {
    const hash = crypto.createHash('md5').update(projectPath).digest('hex');
    const hashNum = parseInt(hash.substring(0, 8), 16);
    return PORT_RANGE_START + (hashNum % PORT_RANGE_SIZE);
}

/**
 * Check if a server is running on the given port
 */
async function isServerRunning(port: number): Promise<boolean> {
    try {
        const response = await fetch(`http://localhost:${port}/health`, {
            method: 'GET',
            signal: AbortSignal.timeout(2000),
        });
        return response.ok;
    } catch {
        return false;
    }
}

/**
 * SSE Client for MCP protocol
 */
class SseClient {
    private port: number;
    private sessionId: string | null = null;
    private messageEndpoint: string | null = null;
    private requestId = 0;
    private pendingRequests = new Map<number, {
        resolve: (value: unknown) => void;
        reject: (error: Error) => void;
    }>();
    private eventSource: EventSource | null = null;
    private connected = false;
    private connectPromise: Promise<void> | null = null;

    constructor(port: number) {
        this.port = port;
    }

    async connect(): Promise<void> {
        if (this.connected) return;
        if (this.connectPromise) return this.connectPromise;

        this.connectPromise = this._connect();
        return this.connectPromise;
    }

    private async _connect(): Promise<void> {
        return new Promise((resolve, reject) => {
            const url = `http://localhost:${this.port}/sse`;
            console.error(`[SSE Client] Connecting to ${url}`);

            // Use native EventSource
            this.eventSource = new EventSource(url);

            this.eventSource.onopen = () => {
                console.error('[SSE Client] Connection opened');
            };

            this.eventSource.onerror = (err: Event) => {
                console.error('[SSE Client] Connection error:', err);
                if (!this.connected) {
                    reject(new Error('SSE connection failed'));
                }
            };

            // @ts-ignore - EventSource types are limited
            this.eventSource.addEventListener('endpoint', (event: MessageEvent) => {
                // Server sends the message endpoint
                this.messageEndpoint = `http://localhost:${this.port}${event.data}`;
                console.error(`[SSE Client] Message endpoint: ${this.messageEndpoint}`);
                this.connected = true;
                resolve();
            });

            this.eventSource.onmessage = (event: MessageEvent) => {
                try {
                    const message = JSON.parse(event.data) as JsonRpcResponse;
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
                    console.error('[SSE Client] Failed to parse message:', event.data);
                }
            };

            // Timeout after 10 seconds
            setTimeout(() => {
                if (!this.connected) {
                    this.eventSource?.close();
                    reject(new Error('SSE connection timeout'));
                }
            }, 10000);
        });
    }

    async sendRequest(method: string, params?: unknown, timeoutMs = 120000): Promise<unknown> {
        if (!this.connected || !this.messageEndpoint) {
            await this.connect();
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

            fetch(this.messageEndpoint!, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(request),
            }).catch(err => {
                this.pendingRequests.delete(id);
                reject(err);
            });

            setTimeout(() => {
                if (this.pendingRequests.has(id)) {
                    this.pendingRequests.delete(id);
                    reject(new Error(`Request ${method} timed out`));
                }
            }, timeoutMs);
        });
    }

    close(): void {
        this.eventSource?.close();
        this.eventSource = null;
        this.connected = false;
        this.connectPromise = null;
        this.messageEndpoint = null;

        for (const [id, { reject }] of this.pendingRequests) {
            reject(new Error('Connection closed'));
        }
        this.pendingRequests.clear();
    }

    isConnected(): boolean {
        return this.connected;
    }
}

// Cache of SSE clients per port
const sseClients = new Map<number, SseClient>();

function getSseClient(port: number): SseClient {
    let client = sseClients.get(port);
    if (!client) {
        client = new SseClient(port);
        sseClients.set(port, client);
    }
    return client;
}

export class ChunkHoundBridge extends EventEmitter {
    private process: ChildProcess | null = null;
    private config: ChunkHoundConfig;
    private projectPath: string;
    private port: number;
    private requestId = 0;
    private pendingRequests = new Map<number, {
        resolve: (value: unknown) => void;
        reject: (error: Error) => void;
    }>();
    private buffer = '';
    private initialized = false;
    private initPromise: Promise<void> | null = null;
    private scanComplete = false;
    private useHttpMode = false;

    constructor(config: ChunkHoundConfig, projectPath: string) {
        super();
        this.config = config;
        this.projectPath = projectPath;
        this.port = getPortForProject(projectPath);
        console.error(`[ChunkHound Bridge] Project: ${projectPath} → Port: ${this.port}`);
    }

    /**
     * Start the ChunkHound connection
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

        // Try HTTP mode first (preferred for multi-session)
        if (this.config.preferHttp !== false) {
            const httpSuccess = await this.tryHttpMode();
            if (httpSuccess) {
                this.useHttpMode = true;
                this.initialized = true;
                console.error('[ChunkHound Bridge] Connected via HTTP');
                return;
            }
        }

        // Fall back to stdio mode
        console.error('[ChunkHound Bridge] Falling back to stdio mode');
        await this.startStdioServer();
        this.initialized = true;
    }

    /**
     * Try to connect via HTTP, starting server if needed
     */
    private async tryHttpMode(): Promise<boolean> {
        // Check if server is already running
        if (await isServerRunning(this.port)) {
            console.error(`[ChunkHound Bridge] Server already running on port ${this.port}`);
            // Check if scan is complete via health endpoint
            await this.checkScanStatus();
            await this.initializeHttp();
            return true;
        }

        // Try to start the HTTP server
        console.error(`[ChunkHound Bridge] Starting HTTP server on port ${this.port}...`);

        try {
            await this.startHttpServer();

            // Wait for server to be ready (up to 30 seconds)
            for (let i = 0; i < 60; i++) {
                await new Promise(resolve => setTimeout(resolve, 500));
                if (await isServerRunning(this.port)) {
                    await this.initializeHttp();
                    return true;
                }
            }

            console.error('[ChunkHound Bridge] HTTP server failed to start in time');
            return false;
        } catch (err) {
            console.error('[ChunkHound Bridge] Failed to start HTTP server:', err);
            return false;
        }
    }

    /**
     * Start ChunkHound as SSE server (detached, survives session end)
     */
    private async startHttpServer(): Promise<void> {
        const pythonPath = this.config.pythonPath;
        const specContextRoot = path.resolve(__dirname, '..', '..');

        // Start detached so it survives session end
        // Note: path is positional, not --path
        const serverProcess = spawn(pythonPath, [
            '-m', 'chunkhound.mcp_server.sse',
            this.projectPath,
            '--port', String(this.port),
            '--host', 'localhost',
        ], {
            cwd: this.projectPath,
            env: {
                ...process.env,
                PYTHONPATH: specContextRoot,
            },
            detached: true,
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        // Log output but don't wait for it
        serverProcess.stdout?.on('data', (data) => {
            console.error('[ChunkHound SSE]', data.toString().trim());
        });
        serverProcess.stderr?.on('data', (data) => {
            const msg = data.toString().trim();
            console.error('[ChunkHound SSE]', msg);
            if (msg.includes('Background scan completed') || msg.includes('scan_completed_at')) {
                this.scanComplete = true;
            }
        });

        // Unref so Node can exit even if server is running
        serverProcess.unref();

        // Store reference for cleanup if needed
        this.process = serverProcess;
    }

    /**
     * Initialize SSE connection (send MCP initialize)
     */
    private async initializeHttp(): Promise<void> {
        const client = getSseClient(this.port);
        await client.connect();

        const response = await client.sendRequest('initialize', {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: {
                name: 'spec-context-mcp',
                version: '1.0.0',
            },
        });

        console.error('[ChunkHound Bridge] SSE initialized:', JSON.stringify(response));

        // Note: notifications/initialized doesn't need a response, skip it for SSE
        // The server is already initialized at this point
    }

    /**
     * Check scan status via health endpoint
     */
    private async checkScanStatus(): Promise<void> {
        try {
            const response = await fetch(`http://localhost:${this.port}/health`, {
                signal: AbortSignal.timeout(2000),
            });
            if (response.ok) {
                const health = await response.json() as { scan_progress?: { scan_completed_at?: string } };
                if (health.scan_progress?.scan_completed_at) {
                    this.scanComplete = true;
                    console.error('[ChunkHound Bridge] Scan already complete');
                }
            }
        } catch {
            // Ignore errors, assume not complete
        }
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
     * Start the MCP server subprocess (stdio mode fallback)
     */
    private async startStdioServer(): Promise<void> {
        const pythonPath = this.config.pythonPath;
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
            console.error('[ChunkHound]', msg);
            if (msg.includes('Background scan completed') || msg.includes('scan_completed_at')) {
                this.scanComplete = true;
            }
        });

        this.process.on('close', (code) => {
            console.error('[ChunkHound Bridge] Process exited with code', code);
            this.process = null;
            this.initialized = false;
            this.initPromise = null;

            for (const [id, { reject }] of this.pendingRequests) {
                reject(new Error('ChunkHound process exited'));
            }
            this.pendingRequests.clear();
        });

        this.process.on('error', (err) => {
            console.error('[ChunkHound Bridge] Process error:', err);
        });

        await this.initializeStdio();
    }

    /**
     * Send MCP initialize request (stdio mode)
     */
    private async initializeStdio(): Promise<void> {
        const response = await this.sendStdioRequest('initialize', {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: {
                name: 'spec-context-mcp',
                version: '1.0.0',
            },
        });

        console.error('[ChunkHound Bridge] Stdio initialized:', JSON.stringify(response));
        this.sendStdioNotification('notifications/initialized', {});
    }

    /**
     * Handle stdout data from subprocess (stdio mode)
     */
    private handleStdout(data: string): void {
        this.buffer += data;

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
     * Send a JSON-RPC request (stdio mode)
     */
    private async sendStdioRequest(method: string, params?: unknown): Promise<unknown> {
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

            setTimeout(() => {
                if (this.pendingRequests.has(id)) {
                    this.pendingRequests.delete(id);
                    reject(new Error(`Request ${method} timed out`));
                }
            }, 120000);
        });
    }

    /**
     * Send a JSON-RPC notification (stdio mode)
     */
    private sendStdioNotification(method: string, params?: unknown): void {
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
     * Send request using appropriate transport
     */
    private async sendRequest(method: string, params?: unknown): Promise<unknown> {
        if (this.useHttpMode) {
            const client = getSseClient(this.port);
            return client.sendRequest(method, params);
        } else {
            return this.sendStdioRequest(method, params);
        }
    }

    /**
     * Call a ChunkHound tool
     */
    async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
        if (!this.initialized) {
            await this.start();
        }

        console.error(`[ChunkHound Bridge] Calling tool: ${name}`);
        const startTime = Date.now();

        const response = await this.sendRequest('tools/call', {
            name,
            arguments: args,
        }) as { content?: Array<{ type: string; text: string }> };

        console.error(`[ChunkHound Bridge] Tool ${name} completed in ${Date.now() - startTime}ms`);

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
     * Stop the ChunkHound subprocess (only affects stdio mode)
     * HTTP servers are left running for other sessions
     */
    stop(): void {
        if (this.process && !this.useHttpMode) {
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
        if (this.useHttpMode) {
            // For HTTP mode, we're healthy if initialized
            // The server runs independently
            return this.initialized;
        }
        return this.process !== null && this.initialized;
    }

    /**
     * Get the port being used
     */
    getPort(): number {
        return this.port;
    }
}

// Singleton instances per project
const bridgeInstances = new Map<string, ChunkHoundBridge>();

/**
 * Reset the singleton for a project
 */
export function resetChunkHoundBridge(projectPath?: string): void {
    if (projectPath) {
        const bridge = bridgeInstances.get(projectPath);
        if (bridge) {
            bridge.stop();
            bridgeInstances.delete(projectPath);
        }
    } else {
        // Reset all
        for (const [path, bridge] of bridgeInstances) {
            bridge.stop();
            bridgeInstances.delete(path);
        }
    }
}

/**
 * Get or create the ChunkHound bridge for a project.
 * Each project gets its own bridge instance and port.
 */
export function getChunkHoundBridge(projectPath?: string): ChunkHoundBridge {
    const resolvedPath = projectPath || process.cwd();

    // Check if existing bridge is healthy
    const existing = bridgeInstances.get(resolvedPath);
    if (existing) {
        if (existing.isHealthy()) {
            return existing;
        }
        console.error('[ChunkHound Bridge] Existing bridge unhealthy, resetting...');
        existing.stop();
        bridgeInstances.delete(resolvedPath);
    }

    // Create new bridge
    const specContextRoot = path.resolve(__dirname, '..', '..');
    const venvPython = path.join(specContextRoot, '.venv', 'bin', 'python');
    const defaultPython = fs.existsSync(venvPython) ? venvPython : 'python3';

    const config: ChunkHoundConfig = {
        pythonPath: process.env.CHUNKHOUND_PYTHON || defaultPython,
        voyageaiApiKey: process.env.VOYAGEAI_API_KEY,
        preferHttp: true,  // Default to HTTP mode for multi-session support
    };

    const bridge = new ChunkHoundBridge(config, resolvedPath);
    bridgeInstances.set(resolvedPath, bridge);

    return bridge;
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
    }
    return bridge;
}
