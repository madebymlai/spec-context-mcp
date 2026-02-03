import fastify, { FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import fastifyCors from '@fastify/cors';
import { join, dirname, basename, resolve } from 'path';
import { readFile } from 'fs/promises';
import { promises as fs } from 'fs';
import { fileURLToPath } from 'url';
import open from 'open';
import { WebSocket } from 'ws';
import { validateAndCheckPort, DASHBOARD_HEALTH_MESSAGE } from './utils.js';
import { parseTasksFromMarkdown } from '../core/workflow/task-parser.js';
import { ProjectManager } from './project-manager.js';
import { JobScheduler } from './job-scheduler.js';
import { DashboardSessionManager } from '../core/workflow/dashboard-session.js';
import {
  getSecurityConfig,
  RateLimiter,
  AuditLogger,
  createSecurityHeadersMiddleware,
  getCorsConfig,
  isLocalhostAddress,
  DEFAULT_SECURITY_CONFIG
} from '../core/workflow/security-utils.js';
import { SecurityConfig } from '../workflow-types.js';
import { AiReviewService, AiReviewModel, AI_REVIEW_MODELS, SpecDocsContext } from './services/ai-review-service.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface WebSocketConnection extends WebSocket {
  projectId?: string;
  isAlive?: boolean;
}

export interface MultiDashboardOptions {
  autoOpen?: boolean;
  port?: number;
  bindAddress?: string; // Network binding address
  allowExternalAccess?: boolean; // Explicit opt-in for non-localhost binding
  security?: Partial<SecurityConfig>; // Security features configuration
}

export class MultiProjectDashboardServer {
  private app: FastifyInstance;
  private projectManager: ProjectManager;
  private jobScheduler: JobScheduler;
  private sessionManager: DashboardSessionManager;
  private options: MultiDashboardOptions;
  private bindAddress: string;
  private allowExternalAccess: boolean;
  private securityConfig: SecurityConfig;
  private rateLimiter?: RateLimiter;
  private auditLogger?: AuditLogger;
  private actualPort: number = 0;
  private clients: Set<WebSocketConnection> = new Set();
  private packageVersion: string = 'unknown';
  private heartbeatInterval?: NodeJS.Timeout;
  private readonly HEARTBEAT_INTERVAL_MS = 30000;
  private readonly HEARTBEAT_TIMEOUT_MS = 10000;
  // Debounce spec broadcasts to coalesce rapid updates
  private pendingSpecBroadcasts: Map<string, NodeJS.Timeout> = new Map();
  private readonly SPEC_BROADCAST_DEBOUNCE_MS = 300;

  constructor(options: MultiDashboardOptions = {}) {
    this.options = options;
    this.projectManager = new ProjectManager();
    this.jobScheduler = new JobScheduler(this.projectManager);
    this.sessionManager = new DashboardSessionManager();

    // Initialize network binding configuration
    this.bindAddress = options.bindAddress || '127.0.0.1';
    this.allowExternalAccess = options.allowExternalAccess || false;

    // Validate network binding security
    if (!isLocalhostAddress(this.bindAddress) && !this.allowExternalAccess) {
      throw new Error(
        `SECURITY ERROR: Binding to '${this.bindAddress}' (non-localhost) requires explicit allowExternalAccess=true. ` +
        'This exposes your dashboard to network access. Use 127.0.0.1 for localhost-only access.'
      );
    }

    // Initialize security features configuration with the actual port
    // This ensures CORS allowedOrigins and CSP are port-aware
    this.securityConfig = getSecurityConfig(options.security, options.port);

    this.app = fastify({ logger: false });
  }

  async start() {
    // Security warning if binding to non-localhost address
    if (!isLocalhostAddress(this.bindAddress)) {
      console.error('');
      console.error('═══════════════════════════════════════════════════════════');
      console.error(`SECURITY WARNING: Dashboard binding to ${this.bindAddress}`);
      console.error('This exposes your dashboard to network-based attacks!');
      console.error('Recommendation: Use 127.0.0.1 for localhost-only access');
      console.error('═══════════════════════════════════════════════════════════');
      console.error('');
    }

    // Display security status
    console.error('Security Configuration:');
    console.error(`   - Bind Address: ${this.bindAddress}`);
    console.error(`   - Rate Limiting: ${this.securityConfig.rateLimitEnabled ? 'ENABLED' : 'DISABLED'}`);
    console.error(`   - Audit Logging: ${this.securityConfig.auditLogEnabled ? 'ENABLED' : 'DISABLED'}`);
    console.error(`   - CORS: ${this.securityConfig.corsEnabled ? 'ENABLED' : 'DISABLED'}`);
    console.error(`   - Allowed Origins: ${this.securityConfig.allowedOrigins.join(', ')}`);
    console.error('');

    // Fetch package version once at startup (can be disabled via env)
    const disableVersionCheck = ['1', 'true', 'yes']
      .includes((process.env.SPEC_CONTEXT_DISABLE_VERSION_CHECK || '').trim().toLowerCase());
    const loadLocalVersion = async (): Promise<string | null> => {
      try {
        const packageJsonPath = join(__dirname, '..', '..', 'package.json');
        const packageJsonContent = await readFile(packageJsonPath, 'utf-8');
        const packageJson = JSON.parse(packageJsonContent) as { version?: string };
        return packageJson.version || null;
      } catch {
        return null;
      }
    };

    if (!disableVersionCheck) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 2000);
        const response = await fetch('https://registry.npmjs.org/spec-context-mcp/latest', {
          signal: controller.signal,
        });
        clearTimeout(timeout);
        if (response.ok) {
          const packageInfo = await response.json() as { version?: string };
          this.packageVersion = packageInfo.version || 'unknown';
        }
      } catch {
        // Ignore network errors and fall back to local version.
      }
    }

    if (this.packageVersion === 'unknown') {
      const localVersion = await loadLocalVersion();
      if (localVersion) {
        this.packageVersion = localVersion;
      }
    }

    // Initialize security components
    if (this.securityConfig.rateLimitEnabled) {
      this.rateLimiter = new RateLimiter(this.securityConfig);
    }

    if (this.securityConfig.auditLogEnabled) {
      this.auditLogger = new AuditLogger(this.securityConfig);
      await this.auditLogger.initialize();
    }

    // Initialize project manager
    await this.projectManager.initialize();

    // Initialize job scheduler
    await this.jobScheduler.initialize();

    // Register CORS plugin if enabled
    const corsConfig = getCorsConfig(this.securityConfig);
    if (corsConfig !== false) {
      await this.app.register(fastifyCors, corsConfig as any);
    }

    // Register security middleware (apply to all routes)
    // Pass the actual port for CSP connect-src WebSocket configuration
    this.app.addHook('onRequest', createSecurityHeadersMiddleware(this.options.port));

    if (this.rateLimiter) {
      this.app.addHook('onRequest', this.rateLimiter.middleware());
    }

    if (this.auditLogger) {
      this.app.addHook('onRequest', this.auditLogger.middleware());
    }

    // Register plugins
    await this.app.register(fastifyStatic, {
      root: join(__dirname, 'public'),
      prefix: '/',
    });

    await this.app.register(fastifyWebsocket);

    // WebSocket endpoint for real-time updates
    const self = this;
    await this.app.register(async function (fastify) {
      fastify.get('/ws', { websocket: true }, (socket: WebSocketConnection, req) => {
        const connection = socket;

        // Get projectId from query parameter
        const url = new URL(req.url || '', `http://${req.headers.host}`);
        const projectId = url.searchParams.get('projectId') || undefined;

        connection.projectId = projectId;
        connection.isAlive = true;
        self.clients.add(connection);

        // Handle pong for heartbeat
        socket.on('pong', () => {
          connection.isAlive = true;
        });

        // Send initial state for the requested project
        if (projectId) {
          const project = self.projectManager.getProject(projectId);
          if (project) {
            Promise.all([
              project.parser.getAllSpecs(),
              project.approvalStorage.getAllPendingApprovals()
            ])
              .then(([specs, approvals]) => {
                socket.send(
                  JSON.stringify({
                    type: 'initial',
                    projectId,
                    data: { specs, approvals },
                  })
                );
              })
              .catch((error) => {
                console.error('Error getting initial data:', error);
              });
          }
        }

        // Send projects list
        socket.send(
          JSON.stringify({
            type: 'projects-update',
            data: { projects: self.projectManager.getProjectsList() }
          })
        );

        // Handle client disconnect
        const cleanup = () => {
          self.clients.delete(connection);
          socket.removeAllListeners();
        };

        socket.on('close', cleanup);
        socket.on('error', cleanup);
        socket.on('disconnect', cleanup);
        socket.on('end', cleanup);

        // Handle subscription messages
        socket.on('message', (data) => {
          try {
            const msg = JSON.parse(data.toString());
            if (msg.type === 'subscribe' && msg.projectId) {
              connection.projectId = msg.projectId;

              // Send initial data for new subscription
              const project = self.projectManager.getProject(msg.projectId);
              if (project) {
                Promise.all([
                  project.parser.getAllSpecs(),
                  project.approvalStorage.getAllPendingApprovals()
                ])
                  .then(([specs, approvals]) => {
                    socket.send(
                      JSON.stringify({
                        type: 'initial',
                        projectId: msg.projectId,
                        data: { specs, approvals },
                      })
                    );
                  })
                  .catch((error) => {
                    console.error('Error getting initial data:', error);
                  });
              }
            }
          } catch (error) {
            // Ignore invalid messages
          }
        });
      });
    });

    // Serve Claude icon as favicon
    this.app.get('/favicon.ico', async (request, reply) => {
      return reply.sendFile('claude-icon.svg');
    });

    // Setup project manager event handlers
    this.setupProjectManagerEvents();

    // Register API routes
    this.registerApiRoutes();

    // Validate and set port (always provided by caller)
    if (!this.options.port) {
      throw new Error('Dashboard port must be specified');
    }

    await validateAndCheckPort(this.options.port, this.bindAddress);
    this.actualPort = this.options.port;

    // Start server with configured network binding
    await this.app.listen({
      port: this.actualPort,
      host: this.bindAddress
    });

    // Start WebSocket heartbeat monitoring
    this.startHeartbeat();

    // Register dashboard in the session manager
    const dashboardUrl = `http://localhost:${this.actualPort}`;
    await this.sessionManager.registerDashboard(dashboardUrl, this.actualPort, process.pid);

    // Open browser if requested
    if (this.options.autoOpen) {
      await open(dashboardUrl);
    }

    return dashboardUrl;
  }

  private setupProjectManagerEvents() {
    // Broadcast projects update when projects change
    this.projectManager.on('projects-update', (projects) => {
      this.broadcastToAll({
        type: 'projects-update',
        data: { projects }
      });
    });

    // Broadcast spec changes (debounced per project to coalesce rapid updates)
    this.projectManager.on('spec-change', (event) => {
      const { projectId } = event;

      // Clear existing pending broadcast for this project
      const existingTimeout = this.pendingSpecBroadcasts.get(projectId);
      if (existingTimeout) {
        clearTimeout(existingTimeout);
      }

      // Schedule debounced broadcast
      const timeout = setTimeout(async () => {
        this.pendingSpecBroadcasts.delete(projectId);
        try {
          const project = this.projectManager.getProject(projectId);
          if (project) {
            const specs = await project.parser.getAllSpecs();
            const archivedSpecs = await project.parser.getAllArchivedSpecs();
            this.broadcastToProject(projectId, {
              type: 'spec-update',
              projectId,
              data: { specs, archivedSpecs }
            });
          }
        } catch (error) {
          console.error('Error broadcasting spec changes:', error);
          // Don't propagate error to prevent event system crash
        }
      }, this.SPEC_BROADCAST_DEBOUNCE_MS);

      this.pendingSpecBroadcasts.set(projectId, timeout);
    });

    // Broadcast task updates
    this.projectManager.on('task-update', (event) => {
      const { projectId, specName } = event;
      this.broadcastTaskUpdate(projectId, specName);
    });

    // Broadcast steering changes
    this.projectManager.on('steering-change', async (event) => {
      try {
        const { projectId, steeringStatus } = event;
        this.broadcastToProject(projectId, {
          type: 'steering-update',
          projectId,
          data: steeringStatus
        });
      } catch (error) {
        console.error('Error broadcasting steering changes:', error);
        // Don't propagate error to prevent event system crash
      }
    });

    // Broadcast approval changes
    this.projectManager.on('approval-change', async (event) => {
      try {
        const { projectId } = event;
        const project = this.projectManager.getProject(projectId);
        if (project) {
          const approvals = await project.approvalStorage.getAllPendingApprovals();
          this.broadcastToProject(projectId, {
            type: 'approval-update',
            projectId,
            data: approvals
          });
        }
      } catch (error) {
        console.error('Error broadcasting approval changes:', error);
        // Don't propagate error to prevent event system crash
      }
    });
  }

  private registerApiRoutes() {
    // Health check endpoint (used by utils.ts to detect running dashboard)
    this.app.get('/health', async () => {
      return { message: DASHBOARD_HEALTH_MESSAGE };
    });

    // Projects list
    this.app.get('/api/projects/list', async () => {
      return this.projectManager.getProjectsList();
    });

    // Add project manually
    this.app.post('/api/projects/add', async (request, reply) => {
      const { projectPath } = request.body as { projectPath: string };
      if (!projectPath) {
        return reply.code(400).send({ error: 'projectPath is required' });
      }
      try {
        const projectId = await this.projectManager.addProjectByPath(projectPath);
        return { projectId, success: true };
      } catch (error: any) {
        return reply.code(500).send({ error: error.message });
      }
    });

    // Remove project
    this.app.delete('/api/projects/:projectId', async (request, reply) => {
      const { projectId } = request.params as { projectId: string };
      try {
        await this.projectManager.removeProjectById(projectId);
        return { success: true };
      } catch (error: any) {
        return reply.code(500).send({ error: error.message });
      }
    });

    // Project info
    this.app.get('/api/projects/:projectId/info', async (request, reply) => {
      const { projectId } = request.params as { projectId: string };
      const project = this.projectManager.getProject(projectId);
      if (!project) {
        return reply.code(404).send({ error: 'Project not found' });
      }

      const steeringStatus = await project.parser.getProjectSteeringStatus();
      return {
        projectId,
        projectName: project.projectName,
        projectPath: project.originalProjectPath,  // Return original path for display
        steering: steeringStatus,
        version: this.packageVersion
      };
    });

    // Specs list
    this.app.get('/api/projects/:projectId/specs', async (request, reply) => {
      const { projectId } = request.params as { projectId: string };
      const project = this.projectManager.getProject(projectId);
      if (!project) {
        return reply.code(404).send({ error: 'Project not found' });
      }
      return await project.parser.getAllSpecs();
    });

    // Archived specs list
    this.app.get('/api/projects/:projectId/specs/archived', async (request, reply) => {
      const { projectId } = request.params as { projectId: string };
      const project = this.projectManager.getProject(projectId);
      if (!project) {
        return reply.code(404).send({ error: 'Project not found' });
      }
      return await project.parser.getAllArchivedSpecs();
    });

    // Get spec details
    this.app.get('/api/projects/:projectId/specs/:name', async (request, reply) => {
      const { projectId, name } = request.params as { projectId: string; name: string };
      const project = this.projectManager.getProject(projectId);
      if (!project) {
        return reply.code(404).send({ error: 'Project not found' });
      }
      const spec = await project.parser.getSpec(name);
      if (!spec) {
        return reply.code(404).send({ error: 'Spec not found' });
      }
      return spec;
    });

    // Get all spec documents
    this.app.get('/api/projects/:projectId/specs/:name/all', async (request, reply) => {
      const { projectId, name } = request.params as { projectId: string; name: string };
      const project = this.projectManager.getProject(projectId);
      if (!project) {
        return reply.code(404).send({ error: 'Project not found' });
      }

      const specDir = join(project.projectPath, '.spec-context', 'specs', name);
      const documents = ['requirements', 'design', 'tasks'];
      const result: Record<string, { content: string; lastModified: string } | null> = {};

      for (const doc of documents) {
        const docPath = join(specDir, `${doc}.md`);
        try {
          const content = await readFile(docPath, 'utf-8');
          const stats = await fs.stat(docPath);
          result[doc] = {
            content,
            lastModified: stats.mtime.toISOString()
          };
        } catch {
          result[doc] = null;
        }
      }

      return result;
    });

    // Get all archived spec documents
    this.app.get('/api/projects/:projectId/specs/:name/all/archived', async (request, reply) => {
      const { projectId, name } = request.params as { projectId: string; name: string };
      const project = this.projectManager.getProject(projectId);
      if (!project) {
        return reply.code(404).send({ error: 'Project not found' });
      }

      // Use archive path instead of active specs path
      const specDir = join(project.projectPath, '.spec-context', 'archive', 'specs', name);
      const documents = ['requirements', 'design', 'tasks'];
      const result: Record<string, { content: string; lastModified: string } | null> = {};

      for (const doc of documents) {
        const docPath = join(specDir, `${doc}.md`);
        try {
          const content = await readFile(docPath, 'utf-8');
          const stats = await fs.stat(docPath);
          result[doc] = {
            content,
            lastModified: stats.mtime.toISOString()
          };
        } catch {
          result[doc] = null;
        }
      }

      return result;
    });

    // Save spec document
    this.app.put('/api/projects/:projectId/specs/:name/:document', async (request, reply) => {
      const { projectId, name, document } = request.params as { projectId: string; name: string; document: string };
      const { content } = request.body as { content: string };
      const project = this.projectManager.getProject(projectId);

      if (!project) {
        return reply.code(404).send({ error: 'Project not found' });
      }

      const allowedDocs = ['requirements', 'design', 'tasks'];
      if (!allowedDocs.includes(document)) {
        return reply.code(400).send({ error: 'Invalid document type' });
      }

      if (typeof content !== 'string') {
        return reply.code(400).send({ error: 'Content must be a string' });
      }

      const docPath = join(project.projectPath, '.spec-context', 'specs', name, `${document}.md`);

      try {
        const specDir = join(project.projectPath, '.spec-context', 'specs', name);
        await fs.mkdir(specDir, { recursive: true });
        await fs.writeFile(docPath, content, 'utf-8');
        return { success: true, message: 'Document saved successfully' };
      } catch (error: any) {
        return reply.code(500).send({ error: `Failed to save document: ${error.message}` });
      }
    });

    // Archive spec
    this.app.post('/api/projects/:projectId/specs/:name/archive', async (request, reply) => {
      const { projectId, name } = request.params as { projectId: string; name: string };
      const project = this.projectManager.getProject(projectId);

      if (!project) {
        return reply.code(404).send({ error: 'Project not found' });
      }

      try {
        await project.archiveService.archiveSpec(name);
        return { success: true, message: `Spec '${name}' archived successfully` };
      } catch (error: any) {
        return reply.code(400).send({ error: error.message });
      }
    });

    // Unarchive spec
    this.app.post('/api/projects/:projectId/specs/:name/unarchive', async (request, reply) => {
      const { projectId, name } = request.params as { projectId: string; name: string };
      const project = this.projectManager.getProject(projectId);

      if (!project) {
        return reply.code(404).send({ error: 'Project not found' });
      }

      try {
        await project.archiveService.unarchiveSpec(name);
        return { success: true, message: `Spec '${name}' unarchived successfully` };
      } catch (error: any) {
        return reply.code(400).send({ error: error.message });
      }
    });

    // Get approvals
    this.app.get('/api/projects/:projectId/approvals', async (request, reply) => {
      const { projectId } = request.params as { projectId: string };
      const project = this.projectManager.getProject(projectId);
      if (!project) {
        return reply.code(404).send({ error: 'Project not found' });
      }
      return await project.approvalStorage.getAllPendingApprovals();
    });

    // Get auto-approve mode (project-level)
    this.app.get('/api/projects/:projectId/approvals/auto-approve', async (request, reply) => {
      const { projectId } = request.params as { projectId: string };
      const project = this.projectManager.getProject(projectId);
      if (!project) {
        return reply.code(404).send({ error: 'Project not found' });
      }
      return { enabled: project.autoApproveMode === true };
    });

    // Set auto-approve mode (project-level)
    this.app.put('/api/projects/:projectId/approvals/auto-approve', async (request, reply) => {
      const { projectId } = request.params as { projectId: string };
      const { enabled } = request.body as { enabled?: boolean };
      const project = this.projectManager.getProject(projectId);

      if (!project) {
        return reply.code(404).send({ error: 'Project not found' });
      }

      if (typeof enabled !== 'boolean') {
        return reply.code(400).send({ error: 'enabled must be a boolean' });
      }

      project.autoApproveMode = enabled;

      // If enabling, immediately resolve any currently pending approvals to unblock wait-for-approval calls.
      let autoApprovedCount = 0;
      if (enabled) {
        try {
          const pending = await project.approvalStorage.getAllPendingApprovals();
          for (const a of pending) {
            try {
              await project.approvalStorage.updateApproval(
                a.id,
                'approved',
                'Auto-approved by dashboard auto-approve mode'
              );
              autoApprovedCount += 1;
            } catch (error) {
              console.error(`Failed to auto-approve approval ${a.id}:`, error);
            }
          }
        } catch (error) {
          console.error('Failed to auto-approve pending approvals:', error);
        }
      }

      return { enabled: project.autoApproveMode, autoApprovedCount };
    });

    // Get approval content
    this.app.get('/api/projects/:projectId/approvals/:id/content', async (request, reply) => {
      const { projectId, id } = request.params as { projectId: string; id: string };
      const project = this.projectManager.getProject(projectId);
      if (!project) {
        return reply.code(404).send({ error: 'Project not found' });
      }

      try {
        const approval = await project.approvalStorage.getApproval(id);
        if (!approval || !approval.filePath) {
          return reply.code(404).send({ error: 'Approval not found or no file path' });
        }

        const candidates: string[] = [];
        const p = approval.filePath;
        candidates.push(join(project.projectPath, p));
        if (p.startsWith('/') || p.match(/^[A-Za-z]:[\\\/]/)) {
          candidates.push(p);
        }
        if (!p.includes('.spec-context')) {
          candidates.push(join(project.projectPath, '.spec-context', p));
        }

        let content: string | null = null;
        let resolvedPath: string | null = null;
        for (const candidate of candidates) {
          try {
            const data = await fs.readFile(candidate, 'utf-8');
            content = data;
            resolvedPath = candidate;
            break;
          } catch {
            // try next candidate
          }
        }

        if (content == null) {
          return reply.code(500).send({ error: `Failed to read file at any known location for ${approval.filePath}` });
        }

        return { content, filePath: resolvedPath || approval.filePath };
      } catch (error: any) {
        return reply.code(500).send({ error: `Failed to read file: ${error.message}` });
      }
    });

    // Approval actions (approve, reject, needs-revision)
    this.app.post('/api/projects/:projectId/approvals/:id/:action', async (request, reply) => {
      const { projectId, id, action } = request.params as { projectId: string; id: string; action: string };
      const { response, annotations, comments } = request.body as {
        response: string;
        annotations?: string;
        comments?: any[];
      };

      const project = this.projectManager.getProject(projectId);
      if (!project) {
        return reply.code(404).send({ error: 'Project not found' });
      }

      const validActions = ['approve', 'reject', 'needs-revision'];
      if (!validActions.includes(action)) {
        return reply.code(400).send({ error: 'Invalid action' });
      }

      // Convert action name to status value
      const actionToStatus: Record<string, 'approved' | 'rejected' | 'needs-revision'> = {
        'approve': 'approved',
        'reject': 'rejected',
        'needs-revision': 'needs-revision'
      };
      const status = actionToStatus[action];

      try {
        await project.approvalStorage.updateApproval(id, status, response, annotations, comments);
        return { success: true };
      } catch (error: any) {
        return reply.code(404).send({ error: error.message });
      }
    });

    // Wait for approval resolution (long-poll endpoint for MCP tool)
    this.app.get('/api/projects/:projectId/approvals/:id/wait', async (request, reply) => {
      const { projectId, id } = request.params as { projectId: string; id: string };
      const { timeout, autoDelete } = request.query as { timeout?: string; autoDelete?: string };
      const project = this.projectManager.getProject(projectId);

      if (!project) {
        return reply.code(404).send({ error: 'Project not found' });
      }

      const timeoutMs = Math.min(parseInt(timeout || '600000', 10), 1800000); // Default 10 minutes, max 30 minutes
      const shouldAutoDelete = autoDelete !== 'false'; // Default true

      // Check current status first
      const AUTO_APPROVE_RESPONSE = 'Auto-approved by dashboard auto-approve mode';

      let approval = await project.approvalStorage.getApproval(id);
      if (!approval) {
        return reply.code(404).send({ error: 'Approval not found' });
      }

      // Auto-approve if enabled and still pending
      if (project.autoApproveMode && approval.status === 'pending') {
        try {
          await project.approvalStorage.updateApproval(id, 'approved', AUTO_APPROVE_RESPONSE);
          approval = await project.approvalStorage.getApproval(id);
        } catch (error) {
          console.error('Failed to auto-approve approval:', error);
        }
      }

      if (!approval) {
        return reply.code(404).send({ error: 'Approval not found' });
      }

      // If already resolved, return immediately
      if (approval.status !== 'pending') {
        const result = {
          resolved: true,
          status: approval.status,
          response: approval.response,
          annotations: approval.annotations,
          comments: approval.comments,
          respondedAt: approval.respondedAt,
          autoDeleted: false
        };

        // Auto-delete if requested
        if (shouldAutoDelete) {
          try {
            await project.approvalStorage.deleteApproval(id);
            result.autoDeleted = true;
          } catch (deleteError) {
            // Log but don't fail - approval was resolved
            console.error('Failed to auto-delete approval:', deleteError);
          }
        }

        return result;
      }

      // Set up long-poll: wait for approval-change event or timeout
      return new Promise((resolve) => {
        let resolved = false;
        let timeoutHandle: NodeJS.Timeout;
        let checkInterval: NodeJS.Timeout;

        const cleanup = () => {
          if (timeoutHandle) clearTimeout(timeoutHandle);
          if (checkInterval) clearInterval(checkInterval);
        };

        const checkAndRespond = async () => {
          if (resolved) return;

          try {
            let currentApproval = await project.approvalStorage.getApproval(id);
            if (!currentApproval) {
              resolved = true;
              cleanup();
              resolve({ resolved: true, status: 'deleted', error: 'Approval was deleted' });
              return;
            }

            // Auto-approve while waiting if the project mode is enabled
            if (project.autoApproveMode && currentApproval.status === 'pending') {
              try {
                await project.approvalStorage.updateApproval(id, 'approved', AUTO_APPROVE_RESPONSE);
                currentApproval = await project.approvalStorage.getApproval(id);
              } catch (error) {
                console.error('Failed to auto-approve approval while waiting:', error);
              }
            }

            if (!currentApproval) {
              resolved = true;
              cleanup();
              resolve({ resolved: true, status: 'deleted', error: 'Approval was deleted' });
              return;
            }

            if (currentApproval.status !== 'pending') {
              resolved = true;
              cleanup();

              const result: any = {
                resolved: true,
                status: currentApproval.status,
                response: currentApproval.response,
                annotations: currentApproval.annotations,
                comments: currentApproval.comments,
                respondedAt: currentApproval.respondedAt,
                autoDeleted: false
              };

              // Auto-delete if requested
              if (shouldAutoDelete) {
                try {
                  await project.approvalStorage.deleteApproval(id);
                  result.autoDeleted = true;
                } catch (deleteError) {
                  console.error('Failed to auto-delete approval:', deleteError);
                }
              }

              resolve(result);
            }
          } catch (error) {
            // Continue waiting on error
          }
        };

        // Poll every 500ms for changes (file watcher triggers approval-change event)
        checkInterval = setInterval(checkAndRespond, 500);

        // Timeout handler
        timeoutHandle = setTimeout(() => {
          if (!resolved) {
            resolved = true;
            cleanup();
            resolve({
              resolved: false,
              status: 'pending',
              timeout: true,
              message: 'Timeout waiting for approval resolution'
            });
          }
        }, timeoutMs);

        // Handle client disconnect
        request.raw.on('close', () => {
          if (!resolved) {
            resolved = true;
            cleanup();
          }
        });
      });
    });

    // Get all snapshots for an approval
    this.app.get('/api/projects/:projectId/approvals/:id/snapshots', async (request, reply) => {
      const { projectId, id } = request.params as { projectId: string; id: string };
      const project = this.projectManager.getProject(projectId);
      if (!project) {
        return reply.code(404).send({ error: 'Project not found' });
      }
      try {
        const snapshots = await project.approvalStorage.getSnapshots(id);
        return snapshots;
      } catch (error: any) {
        return reply.code(500).send({ error: `Failed to get snapshots: ${error.message}` });
      }
    });

    // Get specific snapshot version for an approval
    this.app.get('/api/projects/:projectId/approvals/:id/snapshots/:version', async (request, reply) => {
      const { projectId, id, version } = request.params as { projectId: string; id: string; version: string };
      const project = this.projectManager.getProject(projectId);
      if (!project) {
        return reply.code(404).send({ error: 'Project not found' });
      }
      try {
        const versionNum = parseInt(version, 10);
        if (isNaN(versionNum)) {
          return reply.code(400).send({ error: 'Invalid version number' });
        }

        const snapshot = await project.approvalStorage.getSnapshot(id, versionNum);
        if (!snapshot) {
          return reply.code(404).send({ error: `Snapshot version ${version} not found` });
        }

        return snapshot;
      } catch (error: any) {
        return reply.code(500).send({ error: `Failed to get snapshot: ${error.message}` });
      }
    });

    // Get diff between two versions or between version and current
    this.app.get('/api/projects/:projectId/approvals/:id/diff', async (request, reply) => {
      const { projectId, id } = request.params as { projectId: string; id: string };
      const { from, to } = request.query as { from?: string; to?: string };
      const project = this.projectManager.getProject(projectId);
      if (!project) {
        return reply.code(404).send({ error: 'Project not found' });
      }

      if (!from) {
        return reply.code(400).send({ error: 'from parameter is required' });
      }

      try {
        const fromVersion = parseInt(from, 10);
        if (isNaN(fromVersion)) {
          return reply.code(400).send({ error: 'Invalid from version number' });
        }

        let toVersion: number | 'current';
        if (to === 'current' || to === undefined) {
          toVersion = 'current';
        } else {
          const toVersionNum = parseInt(to, 10);
          if (isNaN(toVersionNum)) {
            return reply.code(400).send({ error: 'Invalid to version number' });
          }
          toVersion = toVersionNum;
        }

        const diff = await project.approvalStorage.compareSnapshots(id, fromVersion, toVersion);
        return diff;
      } catch (error: any) {
        return reply.code(500).send({ error: `Failed to compute diff: ${error.message}` });
      }
    });

    // Manual snapshot capture
    this.app.post('/api/projects/:projectId/approvals/:id/snapshot', async (request, reply) => {
      const { projectId, id } = request.params as { projectId: string; id: string };
      const project = this.projectManager.getProject(projectId);
      if (!project) {
        return reply.code(404).send({ error: 'Project not found' });
      }
      try {
        await project.approvalStorage.captureSnapshot(id, 'manual');
        return { success: true, message: 'Snapshot captured successfully' };
      } catch (error: any) {
        return reply.code(500).send({ error: `Failed to capture snapshot: ${error.message}` });
      }
    });

    // AI Review endpoint - request AI analysis of approval document
    this.app.post('/api/projects/:projectId/approvals/:id/ai-review', async (request, reply) => {
      const { projectId, id } = request.params as { projectId: string; id: string };
      const { model } = request.body as { model?: string };

      const project = this.projectManager.getProject(projectId);
      if (!project) {
        return reply.code(404).send({ error: 'Project not found' });
      }

      // Validate model parameter
      const validModels = Object.keys(AI_REVIEW_MODELS);
      const selectedModel: AiReviewModel = validModels.includes(model || '')
        ? (model as AiReviewModel)
        : 'deepseek-v3';

      // Get OpenRouter API key from environment
      const apiKey = process.env.OPENROUTER_API_KEY;
      if (!apiKey) {
        return reply.code(500).send({
          error: 'AI review not configured. OPENROUTER_API_KEY environment variable is not set.'
        });
      }

      try {
        // Get approval and read document content
        const approval = await project.approvalStorage.getApproval(id);
        if (!approval || !approval.filePath) {
          return reply.code(404).send({ error: 'Approval not found or no file path' });
        }

        // Try multiple candidate paths (same logic as /content endpoint)
        const candidates: string[] = [];
        const p = approval.filePath;
        candidates.push(join(project.projectPath, p));
        if (p.startsWith('/') || p.match(/^[A-Za-z]:[\\\/]/)) {
          candidates.push(p);
        }
        if (!p.includes('.spec-context')) {
          candidates.push(join(project.projectPath, '.spec-context', p));
        }

        let content: string | null = null;
        for (const candidate of candidates) {
          try {
            content = await readFile(candidate, 'utf-8');
            break;
          } catch {
            // try next candidate
          }
        }

        if (content == null) {
          return reply.code(500).send({
            error: `Failed to read document at any known location for ${approval.filePath}`
          });
        }

        // Load steering docs for context (if they exist)
        const steeringDocs: { product?: string; tech?: string; structure?: string } = {};
        const steeringPath = join(project.projectPath, '.spec-context', 'steering');
        try {
          steeringDocs.product = await readFile(join(steeringPath, 'product.md'), 'utf-8');
        } catch { /* optional */ }
        try {
          steeringDocs.tech = await readFile(join(steeringPath, 'tech.md'), 'utf-8');
        } catch { /* optional */ }
        try {
          steeringDocs.structure = await readFile(join(steeringPath, 'structure.md'), 'utf-8');
        } catch { /* optional */ }

        // Load previous spec documents for context (if reviewing design or tasks)
        const specDocsContext: SpecDocsContext = {};
        if (approval.category === 'spec' && approval.categoryName) {
          const specPath = join(project.projectPath, '.spec-context', 'specs', approval.categoryName);
          const filePath = approval.filePath.toLowerCase();

          // If reviewing design.md, load requirements.md
          // If reviewing tasks.md, load requirements.md and design.md
          if (filePath.includes('design.md') || filePath.includes('tasks.md')) {
            try {
              specDocsContext.requirements = await readFile(join(specPath, 'requirements.md'), 'utf-8');
            } catch { /* optional */ }
          }
          if (filePath.includes('tasks.md')) {
            try {
              specDocsContext.design = await readFile(join(specPath, 'design.md'), 'utf-8');
            } catch { /* optional */ }
          }
        }

        // Call AI review service with steering context and spec docs
        const reviewService = new AiReviewService(apiKey);
        const suggestions = await reviewService.reviewDocument(content, selectedModel, steeringDocs, specDocsContext);

        return {
          success: true,
          model: selectedModel,
          suggestions
        };
      } catch (error: any) {
        console.error('AI review failed:', error);
        return reply.code(500).send({
          error: `AI review failed: ${error.message}`
        });
      }
    });

    // Get steering document
    this.app.get('/api/projects/:projectId/steering/:name', async (request, reply) => {
      const { projectId, name } = request.params as { projectId: string; name: string };
      const project = this.projectManager.getProject(projectId);

      if (!project) {
        return reply.code(404).send({ error: 'Project not found' });
      }

      const allowedDocs = ['product', 'tech', 'structure'];
      if (!allowedDocs.includes(name)) {
        return reply.code(400).send({ error: 'Invalid steering document name' });
      }

      const docPath = join(project.projectPath, '.spec-context', 'steering', `${name}.md`);

      try {
        const content = await readFile(docPath, 'utf-8');
        const stats = await fs.stat(docPath);
        return {
          content,
          lastModified: stats.mtime.toISOString()
        };
      } catch {
        return {
          content: '',
          lastModified: new Date().toISOString()
        };
      }
    });

    // Save steering document
    this.app.put('/api/projects/:projectId/steering/:name', async (request, reply) => {
      const { projectId, name } = request.params as { projectId: string; name: string };
      const { content } = request.body as { content: string };
      const project = this.projectManager.getProject(projectId);

      if (!project) {
        return reply.code(404).send({ error: 'Project not found' });
      }

      const allowedDocs = ['product', 'tech', 'structure'];
      if (!allowedDocs.includes(name)) {
        return reply.code(400).send({ error: 'Invalid steering document name' });
      }

      if (typeof content !== 'string') {
        return reply.code(400).send({ error: 'Content must be a string' });
      }

      const steeringDir = join(project.projectPath, '.spec-context', 'steering');
      const docPath = join(steeringDir, `${name}.md`);

      try {
        await fs.mkdir(steeringDir, { recursive: true });
        await fs.writeFile(docPath, content, 'utf-8');
        return { success: true, message: 'Steering document saved successfully' };
      } catch (error: any) {
        return reply.code(500).send({ error: `Failed to save steering document: ${error.message}` });
      }
    });

    // Get task progress
    this.app.get('/api/projects/:projectId/specs/:name/tasks/progress', async (request, reply) => {
      const { projectId, name } = request.params as { projectId: string; name: string };
      const project = this.projectManager.getProject(projectId);

      if (!project) {
        return reply.code(404).send({ error: 'Project not found' });
      }

      try {
        const spec = await project.parser.getSpec(name);
        if (!spec || !spec.phases.tasks.exists) {
          return reply.code(404).send({ error: 'Spec or tasks not found' });
        }

        const tasksPath = join(project.projectPath, '.spec-context', 'specs', name, 'tasks.md');
        const tasksContent = await readFile(tasksPath, 'utf-8');
        const parseResult = parseTasksFromMarkdown(tasksContent);

        const totalTasks = parseResult.summary.total;
        const completedTasks = parseResult.summary.completed;
        const progress = totalTasks > 0 ? (completedTasks / totalTasks) * 100 : 0;

        return {
          total: totalTasks,
          completed: completedTasks,
          inProgress: parseResult.inProgressTask,
          progress: progress,
          taskList: parseResult.tasks,
          lastModified: spec.phases.tasks.lastModified || spec.lastModified
        };
      } catch (error: any) {
        return reply.code(500).send({ error: `Failed to get task progress: ${error.message}` });
      }
    });

    // Update task status
    this.app.put('/api/projects/:projectId/specs/:name/tasks/:taskId/status', async (request, reply) => {
      const { projectId, name, taskId } = request.params as { projectId: string; name: string; taskId: string };
      const { status } = request.body as { status: 'pending' | 'in-progress' | 'completed' };
      const project = this.projectManager.getProject(projectId);

      if (!project) {
        return reply.code(404).send({ error: 'Project not found' });
      }

      if (!status || !['pending', 'in-progress', 'completed'].includes(status)) {
        return reply.code(400).send({ error: 'Invalid status. Must be pending, in-progress, or completed' });
      }

      try {
        const tasksPath = join(project.projectPath, '.spec-context', 'specs', name, 'tasks.md');

        let tasksContent: string;
        try {
          tasksContent = await readFile(tasksPath, 'utf-8');
        } catch (error: any) {
          if (error.code === 'ENOENT') {
            return reply.code(404).send({ error: 'Tasks file not found' });
          }
          throw error;
        }

        const parseResult = parseTasksFromMarkdown(tasksContent);
        const task = parseResult.tasks.find(t => t.id === taskId);

        if (!task) {
          return reply.code(404).send({ error: `Task ${taskId} not found` });
        }

        if (task.status === status) {
          return {
            success: true,
            message: `Task ${taskId} already has status ${status}`,
            task: { ...task, status }
          };
        }

        const { updateTaskStatus } = await import('../core/workflow/task-parser.js');
        const updatedContent = updateTaskStatus(tasksContent, taskId, status);

        if (updatedContent === tasksContent) {
          return reply.code(500).send({ error: `Failed to update task ${taskId} in markdown content` });
        }

        await fs.writeFile(tasksPath, updatedContent, 'utf-8');

        this.broadcastTaskUpdate(projectId, name);

        return {
          success: true,
          message: `Task ${taskId} status updated to ${status}`,
          task: { ...task, status }
        };
      } catch (error: any) {
        return reply.code(500).send({ error: `Failed to update task status: ${error.message}` });
      }
    });

    // Project-specific changelog endpoint
    this.app.get('/api/projects/:projectId/changelog/:version', async (request, reply) => {
      const { version } = request.params as { version: string };

      try {
        const changelogPath = join(__dirname, '..', '..', 'CHANGELOG.md');
        const content = await readFile(changelogPath, 'utf-8');

        // Extract the section for the requested version
        const versionRegex = new RegExp(`## \\[${version}\\][^]*?(?=## \\[|$)`, 'i');
        const match = content.match(versionRegex);

        if (!match) {
          return reply.code(404).send({ error: `Changelog for version ${version} not found` });
        }

        return { content: match[0].trim() };
      } catch (error: any) {
        if (error.code === 'ENOENT') {
          return reply.code(404).send({ error: 'Changelog file not found' });
        }
        return reply.code(500).send({ error: `Failed to fetch changelog: ${error.message}` });
      }
    });

    // Global changelog endpoint
    this.app.get('/api/changelog/:version', async (request, reply) => {
      const { version } = request.params as { version: string };

      try {
        const changelogPath = join(__dirname, '..', '..', 'CHANGELOG.md');
        const content = await readFile(changelogPath, 'utf-8');

        // Extract the section for the requested version
        const versionRegex = new RegExp(`## \\[${version}\\][^]*?(?=## \\[|$)`, 'i');
        const match = content.match(versionRegex);

        if (!match) {
          return reply.code(404).send({ error: `Changelog for version ${version} not found` });
        }

        return { content: match[0].trim() };
      } catch (error: any) {
        if (error.code === 'ENOENT') {
          return reply.code(404).send({ error: 'Changelog file not found' });
        }
        return reply.code(500).send({ error: `Failed to fetch changelog: ${error.message}` });
      }
    });

    // Global settings endpoints

    // Get all automation jobs
    this.app.get('/api/jobs', async () => {
      return await this.jobScheduler.getAllJobs();
    });

    // Create a new automation job
    this.app.post('/api/jobs', async (request, reply) => {
      const job = request.body as any;

      if (!job.id || !job.name || !job.type || job.config === undefined || !job.schedule) {
        return reply.code(400).send({ error: 'Missing required fields: id, name, type, config, schedule' });
      }

      try {
        await this.jobScheduler.addJob({
          id: job.id,
          name: job.name,
          type: job.type,
          enabled: job.enabled !== false,
          config: job.config,
          schedule: job.schedule,
          createdAt: new Date().toISOString()
        });
        return { success: true, message: 'Job created successfully' };
      } catch (error: any) {
        return reply.code(400).send({ error: error.message });
      }
    });

    // Get a specific automation job
    this.app.get('/api/jobs/:jobId', async (request, reply) => {
      const { jobId } = request.params as { jobId: string };
      const settingsManager = new (await import('./settings-manager.js')).SettingsManager();

      try {
        const job = await settingsManager.getJob(jobId);
        if (!job) {
          return reply.code(404).send({ error: 'Job not found' });
        }
        return job;
      } catch (error: any) {
        return reply.code(500).send({ error: error.message });
      }
    });

    // Update an automation job
    this.app.put('/api/jobs/:jobId', async (request, reply) => {
      const { jobId } = request.params as { jobId: string };
      const updates = request.body as any;

      try {
        await this.jobScheduler.updateJob(jobId, updates);
        return { success: true, message: 'Job updated successfully' };
      } catch (error: any) {
        return reply.code(400).send({ error: error.message });
      }
    });

    // Delete an automation job
    this.app.delete('/api/jobs/:jobId', async (request, reply) => {
      const { jobId } = request.params as { jobId: string };

      try {
        await this.jobScheduler.deleteJob(jobId);
        return { success: true, message: 'Job deleted successfully' };
      } catch (error: any) {
        return reply.code(400).send({ error: error.message });
      }
    });

    // Manually run a job
    this.app.post('/api/jobs/:jobId/run', async (request, reply) => {
      const { jobId } = request.params as { jobId: string };

      try {
        const result = await this.jobScheduler.runJobManually(jobId);
        return result;
      } catch (error: any) {
        return reply.code(400).send({ error: error.message });
      }
    });

    // Get job execution history
    this.app.get('/api/jobs/:jobId/history', async (request, reply) => {
      const { jobId } = request.params as { jobId: string };
      const { limit } = request.query as { limit?: string };

      try {
        const history = await this.jobScheduler.getJobExecutionHistory(jobId, parseInt(limit || '50'));
        return history;
      } catch (error: any) {
        return reply.code(500).send({ error: error.message });
      }
    });

    // Get job statistics
    this.app.get('/api/jobs/:jobId/stats', async (request, reply) => {
      const { jobId } = request.params as { jobId: string };

      try {
        const stats = await this.jobScheduler.getJobStats(jobId);
        return stats;
      } catch (error: any) {
        return reply.code(500).send({ error: error.message });
      }
    });
  }

  private broadcastToAll(message: any) {
    const messageStr = JSON.stringify(message);
    this.clients.forEach((connection) => {
      try {
        if (connection.readyState === WebSocket.OPEN) {
          connection.send(messageStr);
        }
      } catch (error) {
        console.error('Error broadcasting to client:', error);
        this.scheduleConnectionCleanup(connection);
      }
    });
  }

  private broadcastToProject(projectId: string, message: any) {
    const messageStr = JSON.stringify(message);
    this.clients.forEach((connection) => {
      try {
        if (connection.readyState === WebSocket.OPEN && connection.projectId === projectId) {
          connection.send(messageStr);
        }
      } catch (error) {
        console.error('Error broadcasting to project client:', error);
        this.scheduleConnectionCleanup(connection);
      }
    });
  }

  private scheduleConnectionCleanup(connection: WebSocketConnection) {
    // Use setImmediate to avoid modifying Set during iteration
    setImmediate(() => {
      try {
        this.clients.delete(connection);
        connection.removeAllListeners();
        if (connection.readyState === WebSocket.OPEN) {
          connection.close();
        }
      } catch {
        // Ignore cleanup errors
      }
    });
  }

  private startHeartbeat() {
    this.heartbeatInterval = setInterval(() => {
      this.clients.forEach((connection) => {
        if (connection.readyState === WebSocket.OPEN) {
          try {
            // Mark as waiting for pong
            connection.isAlive = false;
            connection.ping();
          } catch {
            this.scheduleConnectionCleanup(connection);
          }
        }
      });

      // Check for dead connections after timeout
      setTimeout(() => {
        this.clients.forEach((connection) => {
          if (connection.isAlive === false) {
            console.error('Connection did not respond to heartbeat, cleaning up');
            this.scheduleConnectionCleanup(connection);
          }
        });
      }, this.HEARTBEAT_TIMEOUT_MS);
    }, this.HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = undefined;
    }
  }

  private async broadcastTaskUpdate(projectId: string, specName: string) {
    try {
      const project = this.projectManager.getProject(projectId);
      if (!project) return;

      const tasksPath = join(project.projectPath, '.spec-context', 'specs', specName, 'tasks.md');
      const tasksContent = await readFile(tasksPath, 'utf-8');
      const parseResult = parseTasksFromMarkdown(tasksContent);

      this.broadcastToProject(projectId, {
        type: 'task-status-update',
        projectId,
        data: {
          specName,
          taskList: parseResult.tasks,
          summary: parseResult.summary,
          inProgress: parseResult.inProgressTask
        }
      });
    } catch (error) {
      console.error('Error broadcasting task update:', error);
    }
  }

  async stop() {
    // Stop heartbeat monitoring
    this.stopHeartbeat();

    // Clear pending spec broadcasts
    for (const timeout of this.pendingSpecBroadcasts.values()) {
      clearTimeout(timeout);
    }
    this.pendingSpecBroadcasts.clear();

    // Close all WebSocket connections
    this.clients.forEach((connection) => {
      try {
        connection.removeAllListeners();
        if (connection.readyState === WebSocket.OPEN) {
          connection.close();
        }
      } catch (error) {
        // Ignore cleanup errors
      }
    });
    this.clients.clear();

    // Stop job scheduler
    await this.jobScheduler.shutdown();

    // Stop project manager
    await this.projectManager.stop();

    // Close the Fastify server
    await this.app.close();

    // Unregister from the session manager
    try {
      await this.sessionManager.unregisterDashboard();
    } catch (error) {
      // Ignore cleanup errors
    }
  }

  getUrl(): string {
    return `http://localhost:${this.actualPort}`;
  }
}
