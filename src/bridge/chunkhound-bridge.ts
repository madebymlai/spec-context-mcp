/**
 * ChunkHound Bridge - Connects to ChunkHound HTTP server for code search.
 *
 * Features:
 * - Auto-starts ChunkHound HTTP server if not running
 * - Uses deterministic port based on project path (allows multiple projects)
 * - Multiple Claude sessions share the same server per project
 * - Uses HTTP/SSE only (no stdio fallback)
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
    private readonly connectTimeoutMs = 10000;

    constructor(port: number) {
        this.port = port;
    }

    async connect(): Promise<void> {
        if (this.connected) return;
        if (this.connectPromise) return this.connectPromise;

        this.connectPromise = this._connect().catch((err) => {
            this.connectPromise = null;
            throw err;
        });
        return this.connectPromise;
    }

    private clearConnectionState(clearPromise = true): void {
        this.eventSource?.close();
        this.eventSource = null;
        this.connected = false;
        this.messageEndpoint = null;
        if (clearPromise) {
            this.connectPromise = null;
        }
    }

    private rejectPending(error: Error): void {
        for (const [id, { reject }] of this.pendingRequests) {
            reject(error);
        }
        this.pendingRequests.clear();
    }

    private handleDisconnect(error: Error): void {
        this.clearConnectionState(true);
        this.rejectPending(error);
    }

    private async _connect(): Promise<void> {
        return new Promise((resolve, reject) => {
            const url = `http://localhost:${this.port}/sse`;
            console.error(`[SSE Client] Connecting to ${url}`);

            let settled = false;
            const safeResolve = () => {
                if (settled) return;
                settled = true;
                resolve();
            };
            const safeReject = (error: Error) => {
                if (settled) return;
                settled = true;
                reject(error);
            };

            if (this.pendingRequests.size > 0) {
                this.rejectPending(new Error('SSE reconnecting'));
            }
            this.clearConnectionState(false);

            // Use native EventSource
            this.eventSource = new EventSource(url);

            this.eventSource.onopen = () => {
                console.error('[SSE Client] Connection opened');
            };

            this.eventSource.onerror = (err: Event) => {
                console.error('[SSE Client] Connection error:', err);
                const error = new Error('SSE connection failed');
                if (!this.connected) {
                    this.handleDisconnect(error);
                    safeReject(error);
                    return;
                }
                this.handleDisconnect(error);
            };

            // @ts-ignore - EventSource types are limited
            this.eventSource.addEventListener('endpoint', (event: MessageEvent) => {
                // Server sends the message endpoint
                this.messageEndpoint = `http://localhost:${this.port}${event.data}`;
                console.error(`[SSE Client] Message endpoint: ${this.messageEndpoint}`);
                this.connected = true;
                safeResolve();
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
                    const error = new Error('SSE connection timeout');
                    this.handleDisconnect(error);
                    safeReject(error);
                }
            }, this.connectTimeoutMs);
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

            const postTimeoutMs = Math.min(10000, timeoutMs);
            const controller = new AbortController();
            const postTimeout = setTimeout(() => controller.abort(), postTimeoutMs);

            fetch(this.messageEndpoint!, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(request),
                signal: controller.signal,
            }).catch(err => {
                this.pendingRequests.delete(id);
                const error = err instanceof Error ? err : new Error('SSE request failed');
                this.handleDisconnect(error);
                reject(error);
            }).finally(() => {
                clearTimeout(postTimeout);
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
        this.handleDisconnect(new Error('Connection closed'));
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
    private lastScanStatusCheck = 0;
    private readonly scanStatusCheckIntervalMs = 5000;
    private httpStartPromise: Promise<void> | null = null;
    private httpInitPromise: Promise<void> | null = null;
    private reconnectPromise: Promise<void> | null = null;

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

        this.initPromise = this._start().catch(err => {
            this.initialized = false;
            this.initPromise = null;
            throw err;
        });
        return this.initPromise;
    }

    private async _start(): Promise<void> {
        // Ensure .chunkhound.json exists
        await this.ensureConfig();
        await this.ensureHttpConnected();
        this.initialized = true;
        console.error('[ChunkHound Bridge] Connected via HTTP');
    }

    /**
     * Ensure HTTP server is running and SSE connection initialized.
     */
    private async ensureHttpConnected(): Promise<void> {
        const client = getSseClient(this.port);
        if (client.isConnected() && this.initialized) {
            return;
        }

        if (this.httpInitPromise) {
            return this.httpInitPromise;
        }

        this.httpInitPromise = (async () => {
            await this.ensureHttpServerReady(30000);
            await this.initializeHttp();
            this.initialized = true;
        })().finally(() => {
            this.httpInitPromise = null;
        });

        return this.httpInitPromise;
    }

    /**
     * Ensure HTTP server is healthy, starting it if needed.
     */
    private async ensureHttpServerReady(timeoutMs: number): Promise<void> {
        if (await isServerRunning(this.port)) {
            console.error(`[ChunkHound Bridge] Server already running on port ${this.port}`);
            await this.checkScanStatus();
            return;
        }

        console.error(`[ChunkHound Bridge] Starting HTTP server on port ${this.port}...`);
        await this.startHttpServerOnce();

        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, 500));
            if (await isServerRunning(this.port)) {
                await this.checkScanStatus();
                return;
            }
        }

        throw new Error('ChunkHound HTTP server failed to start in time');
    }

    private async startHttpServerOnce(): Promise<void> {
        if (this.httpStartPromise) {
            return this.httpStartPromise;
        }

        this.httpStartPromise = (async () => {
            try {
                await this.startHttpServer();
            } catch (err) {
                this.httpStartPromise = null;
                throw err;
            }
        })().finally(() => {
            this.httpStartPromise = null;
        });

        return this.httpStartPromise;
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
        try {
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
            await this.waitForHealthReady(10000);
        } catch (err) {
            client.close();
            this.initialized = false;
            throw err;
        }

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
     * Legacy stdio mode (no longer used)
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
    private async sendStdioRequest(method: string, params?: unknown, timeoutMs = 120000): Promise<unknown> {
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
            }, timeoutMs);
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
     * Send request over HTTP/SSE transport
     */
    private async sendRequest(method: string, params?: unknown, timeoutMs = 120000): Promise<unknown> {
        const client = getSseClient(this.port);
        return client.sendRequest(method, params, timeoutMs);
    }

    /**
     * Call a ChunkHound tool
     */
    async callTool(name: string, args: Record<string, unknown>, timeoutMs?: number): Promise<unknown> {
        if (!this.initialized) {
            await this.start();
        } else {
            await this.ensureHttpConnected();
        }

        try {
            return await this.callToolOnce(name, args, timeoutMs);
        } catch (err) {
            console.error(`[ChunkHound Bridge] Tool ${name} failed; reconnecting and retrying...`, err);
            await this.recoverHttpTransport(err);
            return this.callToolOnce(name, args, timeoutMs);
        }
    }

    private async callToolOnce(name: string, args: Record<string, unknown>, timeoutMs?: number): Promise<unknown> {
        console.error(`[ChunkHound Bridge] Calling tool: ${name}`);
        const startTime = Date.now();

        const response = await this.sendRequest('tools/call', {
            name,
            arguments: args,
        }, timeoutMs) as { content?: Array<{ type: string; text: string }> };

        console.error(`[ChunkHound Bridge] Tool ${name} completed in ${Date.now() - startTime}ms`);

        if (response?.content && Array.isArray(response.content)) {
            const textContent = response.content.find(c => c.type === 'text');
            if (textContent?.text) {
                try {
                    const parsed = JSON.parse(textContent.text) as any;

                    // Retry once if SSE server received request before initialization
                    if (
                        parsed &&
                        (parsed.error?.message?.includes('Received request before initialization') ||
                            parsed.error?.includes?.('Invalid request parameters') ||
                            (parsed.success === false && typeof parsed.error === 'string' &&
                                parsed.error.includes('Invalid request parameters')))
                    ) {
                        console.error('[ChunkHound Bridge] Server not initialized; waiting for health and retrying...');
                        await this.waitForHealthReady(10000);
                        const retryResponse = await this.sendRequest('tools/call', {
                            name,
                            arguments: args,
                        }, timeoutMs) as { content?: Array<{ type: string; text: string }> };

                        const retryText = retryResponse?.content?.find(c => c.type === 'text')?.text;
                        if (retryText) {
                            try {
                                return JSON.parse(retryText);
                            } catch {
                                return retryText;
                            }
                        }
                        return retryResponse;
                    }

                    return parsed;
                } catch {
                    return textContent.text;
                }
            }
        }

        return response;
    }

    private async recoverHttpTransport(reason: unknown): Promise<void> {
        if (this.reconnectPromise) {
            return this.reconnectPromise;
        }

        this.reconnectPromise = (async () => {
            const message = reason instanceof Error ? reason.message : String(reason);
            console.error(`[ChunkHound Bridge] Reconnecting HTTP transport after error: ${message}`);
            const client = getSseClient(this.port);
            client.close();
            this.initialized = false;
            this.initPromise = null;
            this.httpInitPromise = null;
            await this.ensureHttpConnected();
        })().finally(() => {
            this.reconnectPromise = null;
        });

        return this.reconnectPromise;
    }

    /**
     * Wait until SSE server health reports initialized or timeout.
     */
    private async waitForHealthReady(timeoutMs: number): Promise<void> {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            try {
                const response = await fetch(`http://localhost:${this.port}/health`, {
                    signal: AbortSignal.timeout(2000),
                });
                if (response.ok) {
                    const health = await response.json() as { initialized?: boolean; scan_progress?: { scan_completed_at?: string } };
                    if (health.initialized) {
                        if (health.scan_progress?.scan_completed_at) {
                            this.scanComplete = true;
                        }
                        return;
                    }
                }
            } catch {
                // Ignore and retry
            }
            await new Promise(resolve => setTimeout(resolve, 500));
        }
    }

    /**
     * Refresh scan status from health endpoint.
     */
    private async refreshScanStatus(): Promise<void> {
        if (this.scanComplete) {
            return;
        }

        const now = Date.now();
        if (now - this.lastScanStatusCheck < this.scanStatusCheckIntervalMs) {
            return;
        }
        this.lastScanStatusCheck = now;

        try {
            const response = await fetch(`http://localhost:${this.port}/health`, {
                signal: AbortSignal.timeout(2000),
            });
            if (response.ok) {
                const health = await response.json() as { scan_progress?: { scan_completed_at?: string } };
                if (health.scan_progress?.scan_completed_at) {
                    this.scanComplete = true;
                }
            }
        } catch {
            // Ignore health check failures; we'll retry later
        }
    }

    /**
     * Search code using ChunkHound
     */
    async search(args: SearchArgs): Promise<unknown> {
        await this.waitForHealthReady(10000);
        const result = await this.callTool('search', args as unknown as Record<string, unknown>);

        await this.refreshScanStatus();

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
        const timeoutMs = 180000; // 3 minutes
        return this.callTool('code_research', args as unknown as Record<string, unknown>, timeoutMs);
    }

    /**
     * Stop the bridge connection
     * HTTP servers are left running for other sessions
     */
    stop(): void {
        getSseClient(this.port).close();
        this.process = null;
        this.initialized = false;
        this.initPromise = null;
        this.httpInitPromise = null;
        this.reconnectPromise = null;
    }

    /**
     * Check if bridge is healthy
     */
    isHealthy(): boolean {
        return this.initialized && getSseClient(this.port).isConnected();
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
