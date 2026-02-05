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
import * as net from 'net';
import { fileURLToPath } from 'url';
import { EventEmitter } from 'events';
import { EventSource } from 'eventsource';
import { getPackageVersion } from '../core/workflow/constants.js';

// ESM equivalent of __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Port range for ChunkHound servers (31000-31999)
const PORT_RANGE_START = 31000;
const PORT_RANGE_SIZE = 1000;

const HEALTH_PING_TIMEOUT_MS = 2000;
const HEALTH_ENDPOINT_TIMEOUT_MS = 15000;
const HEALTH_READY_TIMEOUT_MS = 60000;
const SSE_CONNECT_TIMEOUT_MS = 30000;
const SSE_POST_TIMEOUT_MS = 30000;

const STARTUP_LOCK_TTL_MS = 2 * 60_000;
const STARTUP_LOCK_POLL_MS = 250;
const EARLY_FAILURE_WAIT_MS = 2000;

interface PythonErrorInfo {
    type: 'module_not_found' | 'import_error' | 'syntax_error' | 'generic';
    module?: string;
    message: string;
    suggestion: string;
}

function parsePythonError(stderr: string): PythonErrorInfo | null {
    // Check for ModuleNotFoundError
    const moduleMatch = stderr.match(/ModuleNotFoundError: No module named ['"]([^'"]+)['"]/);
    if (moduleMatch) {
        const module = moduleMatch[1];
        if (module === 'chunkhound' || module.startsWith('chunkhound.')) {
            return {
                type: 'module_not_found',
                module: 'chunkhound',
                message: `ModuleNotFoundError: No module named '${module}'`,
                suggestion: 'Run: npx spec-context-mcp setup',
            };
        }
        return {
            type: 'module_not_found',
            module,
            message: `ModuleNotFoundError: No module named '${module}'`,
            suggestion: `Install the missing module: pip install ${module}\nOr run: npx spec-context-mcp setup`,
        };
    }

    // Check for ImportError
    const importMatch = stderr.match(/ImportError: ([^\n]+)/);
    if (importMatch) {
        return {
            type: 'import_error',
            message: `ImportError: ${importMatch[1]}`,
            suggestion: 'Run: npx spec-context-mcp setup',
        };
    }

    // Check for SyntaxError (wrong Python version)
    if (stderr.includes('SyntaxError')) {
        return {
            type: 'syntax_error',
            message: 'Python syntax error (possibly wrong Python version)',
            suggestion: 'Ensure Python 3.10+ is installed. Run: npx spec-context-mcp doctor',
        };
    }

    // Check for generic Python errors
    if (stderr.includes('Traceback') || stderr.includes('Error:')) {
        const errorLines = stderr.split('\n').filter(line => line.includes('Error:'));
        const errorMessage = errorLines.length > 0 ? errorLines[errorLines.length - 1] : 'Unknown Python error';
        return {
            type: 'generic',
            message: errorMessage.trim(),
            suggestion: 'Run: npx spec-context-mcp doctor',
        };
    }

    return null;
}

function formatPythonError(errorInfo: PythonErrorInfo): string {
    return `ChunkHound Python Error

${errorInfo.message}

${errorInfo.suggestion}`;
}

function isTimeoutError(error: unknown): boolean {
    if (!error || typeof error !== 'object') {
        return false;
    }
    const maybeError = error as { name?: unknown; message?: unknown };
    const name = typeof maybeError.name === 'string' ? maybeError.name : '';
    if (name === 'TimeoutError' || name === 'AbortError') {
        return true;
    }
    const message = typeof maybeError.message === 'string' ? maybeError.message : '';
    return message.toLowerCase().includes('timeout');
}

function normalizeProjectPath(projectPath?: string): string {
    const resolved = path.resolve(projectPath || process.cwd());
    try {
        return (fs.realpathSync.native ? fs.realpathSync.native(resolved) : fs.realpathSync(resolved));
    } catch {
        return resolved;
    }
}

async function canConnectTcp(port: number, timeoutMs = 500): Promise<boolean> {
    return await new Promise<boolean>((resolve) => {
        const socket = new net.Socket();
        let settled = false;
        const finish = (result: boolean) => {
            if (settled) return;
            settled = true;
            socket.destroy();
            resolve(result);
        };

        socket.setTimeout(timeoutMs);
        socket.once('connect', () => finish(true));
        socket.once('timeout', () => finish(false));
        socket.once('error', () => finish(false));
        socket.connect(port, '127.0.0.1');
    });
}

async function waitForTcpListening(port: number, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await canConnectTcp(port)) {
            return;
        }
        await new Promise(resolve => setTimeout(resolve, STARTUP_LOCK_POLL_MS));
    }
    throw new Error(`ChunkHound HTTP server did not start listening on port ${port} in time`);
}

type StartupLock = { path: string; fd: number | null; acquired: boolean };

function tryAcquireStartupLock(projectPath: string, port: number): StartupLock {
    const lockDir = path.join(projectPath, '.chunkhound');
    try {
        fs.mkdirSync(lockDir, { recursive: true });
    } catch {
        // Ignore; if we can't create lock dir, we fall back to best-effort startup without lock.
        return { path: '', fd: null, acquired: true };
    }

    const lockPath = path.join(lockDir, `sse-start-${port}.lock`);
    const now = Date.now();

    const openExclusive = (): number => fs.openSync(lockPath, 'wx');
    const writeLockFile = (fd: number, recovered = false) => {
        const payload = JSON.stringify({
            pid: process.pid,
            port,
            created_at: new Date().toISOString(),
            recovered,
        });
        fs.writeFileSync(fd, payload);
    };

    try {
        const fd = openExclusive();
        writeLockFile(fd);
        return { path: lockPath, fd, acquired: true };
    } catch (err) {
        const code = err && typeof err === 'object' ? (err as { code?: unknown }).code : undefined;
        if (code !== 'EEXIST') {
            throw err;
        }

        // Stale lock recovery: if the file is old, assume the starter crashed and retry.
        try {
            const stat = fs.statSync(lockPath);
            if (now - stat.mtimeMs > STARTUP_LOCK_TTL_MS) {
                fs.unlinkSync(lockPath);
                const fd = openExclusive();
                writeLockFile(fd, true);
                return { path: lockPath, fd, acquired: true };
            }
        } catch {
            // Ignore and treat as not acquired.
        }

        return { path: lockPath, fd: null, acquired: false };
    }
}

function releaseStartupLock(lock: StartupLock): void {
    if (!lock.acquired) {
        return;
    }
    if (lock.fd !== null) {
        try {
            fs.closeSync(lock.fd);
        } catch {
            // Ignore
        }
    }
    if (lock.path) {
        try {
            fs.unlinkSync(lock.path);
        } catch {
            // Ignore
        }
    }
}

export interface ChunkHoundConfig {
    pythonPath: string;
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
            signal: AbortSignal.timeout(HEALTH_PING_TIMEOUT_MS),
        });
        if (response.ok) {
            return true;
        }
        return await canConnectTcp(port);
    } catch (err) {
        // If /health is slow (CPU/IO bound) we still want to treat the server as
        // "running" so we don't start a second process (DuckDB lock conflict).
        if (isTimeoutError(err)) {
            return await canConnectTcp(port);
        }
        return await canConnectTcp(port);
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
    private readonly connectTimeoutMs = SSE_CONNECT_TIMEOUT_MS;

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

            const postTimeoutMs = Math.min(SSE_POST_TIMEOUT_MS, timeoutMs);
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
            await this.ensureHttpServerReady(HEALTH_READY_TIMEOUT_MS);
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

        throw new Error(`ChunkHound HTTP server failed to start in time

The server did not respond on port ${this.port} within ${timeoutMs / 1000} seconds.

Possible causes:
  - Python dependencies not installed
  - Port ${this.port} in use by another process
  - ChunkHound crashed during startup

Run: npx spec-context-mcp doctor`);
    }

    private async startHttpServerOnce(): Promise<void> {
        if (this.httpStartPromise) {
            return this.httpStartPromise;
        }

        this.httpStartPromise = (async () => {
            const lock = tryAcquireStartupLock(this.projectPath, this.port);

            // Another process is already starting the server for this project+port.
            // Wait for the TCP port to come up instead of racing and causing a
            // DuckDB file-lock conflict.
            if (!lock.acquired) {
                console.error(`[ChunkHound Bridge] Another session is starting the server; waiting for port ${this.port}...`);
                await waitForTcpListening(this.port, HEALTH_READY_TIMEOUT_MS);
                return;
            }

            try {
                await this.startHttpServer();
                await waitForTcpListening(this.port, HEALTH_READY_TIMEOUT_MS);
            } finally {
                releaseStartupLock(lock);
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

        // Capture stderr for early failure detection
        let stderrBuffer = '';
        let earlyExitCode: number | null = null;
        let earlyExitHandled = false;

        // Log output but don't wait for it
        serverProcess.stdout?.on('data', (data) => {
            console.error('[ChunkHound SSE]', data.toString().trim());
        });
        serverProcess.stderr?.on('data', (data) => {
            const msg = data.toString().trim();
            stderrBuffer += data.toString();
            console.error('[ChunkHound SSE]', msg);
            if (msg.includes('Background scan completed') || msg.includes('scan_completed_at')) {
                this.scanComplete = true;
            }
        });

        // Check for early exit (immediate failure)
        serverProcess.on('exit', (code) => {
            if (!earlyExitHandled) {
                earlyExitCode = code;
            }
        });

        // Wait briefly to catch immediate failures
        await new Promise<void>((resolve, reject) => {
            const checkTimer = setTimeout(() => {
                earlyExitHandled = true;
                if (earlyExitCode !== null && earlyExitCode !== 0) {
                    // Process died immediately - parse error and provide helpful message
                    const errorInfo = parsePythonError(stderrBuffer);
                    if (errorInfo) {
                        reject(new Error(formatPythonError(errorInfo)));
                    } else {
                        reject(new Error(`ChunkHound failed to start (exit code ${earlyExitCode})

${stderrBuffer.trim() || 'No error output captured'}

Run: npx spec-context-mcp doctor`));
                    }
                } else {
                    resolve();
                }
            }, EARLY_FAILURE_WAIT_MS);

            serverProcess.on('error', (err) => {
                clearTimeout(checkTimer);
                earlyExitHandled = true;
                if (err.message.includes('ENOENT')) {
                    reject(new Error(`Python not found: ${pythonPath}

Run: npx spec-context-mcp setup`));
                } else {
                    reject(new Error(`Failed to start ChunkHound: ${err.message}

Run: npx spec-context-mcp doctor`));
                }
            });
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
                    version: getPackageVersion('1.0.0'),
                },
            });

            console.error('[ChunkHound Bridge] SSE initialized:', JSON.stringify(response));
            await this.waitForHealthReady(HEALTH_READY_TIMEOUT_MS);
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
                signal: AbortSignal.timeout(HEALTH_ENDPOINT_TIMEOUT_MS),
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
                version: getPackageVersion('1.0.0'),
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
                        await this.waitForHealthReady(HEALTH_READY_TIMEOUT_MS);
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
            const remainingMs = deadline - Date.now();
            const requestTimeoutMs = Math.min(HEALTH_ENDPOINT_TIMEOUT_MS, Math.max(1, remainingMs));
            try {
                const response = await fetch(`http://localhost:${this.port}/health`, {
                    signal: AbortSignal.timeout(requestTimeoutMs),
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
        throw new Error(`ChunkHound server on port ${this.port} did not report initialized in time`);
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
                signal: AbortSignal.timeout(HEALTH_ENDPOINT_TIMEOUT_MS),
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
        // callTool handles initialization, reconnection, and retry logic.
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
        const normalizedPath = normalizeProjectPath(projectPath);
        const bridge = bridgeInstances.get(normalizedPath);
        if (bridge) {
            bridge.stop();
            bridgeInstances.delete(normalizedPath);
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
    const resolvedPath = normalizeProjectPath(projectPath);

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
