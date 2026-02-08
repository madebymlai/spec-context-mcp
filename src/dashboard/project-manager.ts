import { EventEmitter } from 'events';
import chokidar, { FSWatcher } from 'chokidar';
import type { ISpecParser } from './parser.js';
import type { SpecChangeEvent } from './watcher.js';
import {
  type ApprovalRequest,
  type ApprovalComment,
  type DocumentSnapshot,
  type DiffResult
} from './approval-storage.js';
import {
  type ProjectRegistryEntry,
  type ProjectInstance
} from '../core/workflow/project-registry.js';
import { PathUtils } from '../core/workflow/path-utils.js';

export interface ProjectRegistryPort {
  cleanupStaleProjects(): Promise<number>;
  getAllProjects(): Promise<ProjectRegistryEntry[]>;
  getRegistryPath(): string;
  getProject(projectPath: string): Promise<ProjectRegistryEntry | null>;
  getProjectById(projectId: string): Promise<ProjectRegistryEntry | null>;
  registerProject(projectPath: string, pid: number, persistent?: boolean): Promise<string>;
  unregisterProjectById(projectId: string): Promise<void>;
}

export interface ProjectWatcherPort {
  start(): Promise<void>;
  stop(): Promise<void>;
  on(event: 'change', listener: (event: SpecChangeEvent) => void): this;
  on(event: 'task-update', listener: (event: Record<string, unknown>) => void): this;
  on(event: 'steering-change', listener: (event: Record<string, unknown>) => void): this;
  removeAllListeners(): this;
}

export interface ProjectApprovalStoragePort {
  start(): Promise<void>;
  stop(): Promise<void>;
  on(event: 'approval-change', listener: () => void): this;
  removeAllListeners(): this;
  getAllPendingApprovals(): Promise<ApprovalRequest[]>;
  getAllApprovals(): Promise<ApprovalRequest[]>;
  getApproval(id: string): Promise<ApprovalRequest | null>;
  updateApproval(
    id: string,
    status: Exclude<ApprovalRequest['status'], 'pending'>,
    response: string,
    annotations?: string,
    comments?: ApprovalComment[]
  ): Promise<void>;
  deleteApproval(id: string): Promise<boolean>;
  getSnapshots(approvalId: string): Promise<DocumentSnapshot[]>;
  getSnapshot(approvalId: string, version: number): Promise<DocumentSnapshot | null>;
  compareSnapshots(approvalId: string, fromVersion: number, toVersion: number | 'current'): Promise<DiffResult>;
  captureSnapshot(approvalId: string, trigger: 'initial' | 'revision_requested' | 'approved' | 'manual'): Promise<void>;
}

export interface ProjectArchiveServicePort {
  archiveSpec(specName: string): Promise<void>;
  unarchiveSpec(specName: string): Promise<void>;
}

export interface ProjectComponentFactory {
  createParser(projectPath: string): ISpecParser;
  createWatcher(projectPath: string, parser: ISpecParser): ProjectWatcherPort;
  createApprovalStorage(translatedPath: string, originalPath: string): ProjectApprovalStoragePort;
  createArchiveService(projectPath: string): ProjectArchiveServicePort;
}

export interface ProjectContext {
  projectId: string;
  projectPath: string;
  originalProjectPath: string;
  projectName: string;
  instances: ProjectInstance[];
  parser: ISpecParser;
  watcher: ProjectWatcherPort;
  approvalStorage: ProjectApprovalStoragePort;
  archiveService: ProjectArchiveServicePort;
  autoApproveMode: boolean;
}

export interface ProjectManagerDependencies {
  registry: ProjectRegistryPort;
  componentFactory: ProjectComponentFactory;
}

export interface ProjectManagerErrorEvent {
  stage: 'registry_sync' | 'registry_watcher';
  error: unknown;
}

export class ProjectManager extends EventEmitter {
  private readonly registry: ProjectRegistryPort;
  private readonly componentFactory: ProjectComponentFactory;
  private projects: Map<string, ProjectContext> = new Map();
  private registryWatcher?: FSWatcher;

  constructor(dependencies: ProjectManagerDependencies) {
    super();
    this.registry = dependencies.registry;
    this.componentFactory = dependencies.componentFactory;
  }

  async initialize(): Promise<void> {
    await this.registry.cleanupStaleProjects();
    await this.loadProjectsFromRegistry();
    this.startRegistryWatcher();
  }

  private async loadProjectsFromRegistry(): Promise<void> {
    const entries = await this.registry.getAllProjects();
    for (const entry of entries) {
      if (!this.projects.has(entry.projectId)) {
        await this.addProject(entry);
      }
    }
  }

  private startRegistryWatcher(): void {
    const registryPath = this.registry.getRegistryPath();
    this.registryWatcher = chokidar.watch(registryPath, {
      ignoreInitial: true,
      persistent: true,
      ignorePermissionErrors: true
    });

    const syncWithRegistry = () => {
      void this.syncWithRegistry().catch((error) => {
        this.emitProjectManagerError({ stage: 'registry_sync', error });
      });
    };

    this.registryWatcher.on('change', syncWithRegistry);
    this.registryWatcher.on('add', syncWithRegistry);
    this.registryWatcher.on('error', (error: unknown) => {
      this.emitProjectManagerError({ stage: 'registry_watcher', error });
    });
  }

  private emitProjectManagerError(event: ProjectManagerErrorEvent): void {
    console.error(`Project manager error (${event.stage}):`, event.error);
    this.emit('project-manager-error', event);
  }

  private async syncWithRegistry(): Promise<void> {
    const entries = await this.registry.getAllProjects();
    const registryIds = new Set(entries.map((entry) => entry.projectId));
    const currentIds = new Set(this.projects.keys());

    for (const entry of entries) {
      if (!currentIds.has(entry.projectId)) {
        await this.addProject(entry);
        continue;
      }
      const project = this.projects.get(entry.projectId);
      if (project) {
        project.instances = entry.instances;
      }
    }

    for (const projectId of currentIds) {
      if (!registryIds.has(projectId)) {
        await this.removeProject(projectId);
      }
    }

    this.emit('projects-update', this.getProjectsList());
  }

  private async addProject(entry: ProjectRegistryEntry): Promise<void> {
    const translatedPath = PathUtils.translatePath(entry.projectPath);
    const parser = this.componentFactory.createParser(translatedPath);
    const watcher = this.componentFactory.createWatcher(translatedPath, parser);
    const approvalStorage = this.componentFactory.createApprovalStorage(translatedPath, entry.projectPath);
    const archiveService = this.componentFactory.createArchiveService(translatedPath);

    await watcher.start();
    await approvalStorage.start();

    watcher.on('change', (event) => {
      this.emit('spec-change', { projectId: entry.projectId, ...event });
    });
    watcher.on('task-update', (event) => {
      this.emit('task-update', { projectId: entry.projectId, ...event });
    });
    watcher.on('steering-change', (event) => {
      this.emit('steering-change', { projectId: entry.projectId, ...event });
    });
    approvalStorage.on('approval-change', () => {
      this.emit('approval-change', { projectId: entry.projectId });
    });

    const context: ProjectContext = {
      projectId: entry.projectId,
      projectPath: translatedPath,
      originalProjectPath: entry.projectPath,
      projectName: entry.projectName,
      instances: entry.instances,
      parser,
      watcher,
      approvalStorage,
      archiveService,
      autoApproveMode: false
    };

    this.projects.set(entry.projectId, context);
    console.error(`Project added: ${entry.projectName} (${entry.projectId})`);
    this.emit('project-added', entry.projectId);
  }

  private async removeProject(projectId: string): Promise<void> {
    const context = this.projects.get(projectId);
    if (!context) {
      return;
    }

    await context.watcher.stop();
    await context.approvalStorage.stop();
    context.watcher.removeAllListeners();
    context.approvalStorage.removeAllListeners();

    this.projects.delete(projectId);
    console.error(`Project removed: ${context.projectName} (${projectId})`);
    this.emit('project-removed', projectId);
  }

  getProject(projectId: string): ProjectContext | undefined {
    return this.projects.get(projectId);
  }

  getAllProjects(): ProjectContext[] {
    return Array.from(this.projects.values());
  }

  getProjectsList(): Array<{
    projectId: string;
    projectName: string;
    projectPath: string;
    instances: ProjectInstance[];
    isActive: boolean;
  }> {
    return Array.from(this.projects.values()).map((project) => ({
      projectId: project.projectId,
      projectName: project.projectName,
      projectPath: project.originalProjectPath,
      instances: project.instances,
      isActive: project.instances.some((instance) => instance.pid > 0)
    }));
  }

  async addProjectByPath(projectPath: string): Promise<string> {
    const entry = await this.registry.getProject(projectPath);
    if (entry) {
      if (!this.projects.has(entry.projectId)) {
        await this.addProject(entry);
      }
      return entry.projectId;
    }

    const projectId = await this.registry.registerProject(projectPath, 0, true);
    const newEntry = await this.registry.getProjectById(projectId);
    if (newEntry) {
      await this.addProject(newEntry);
    }

    return projectId;
  }

  async removeProjectById(projectId: string): Promise<void> {
    await this.removeProject(projectId);
    await this.registry.unregisterProjectById(projectId);
  }

  async stop(): Promise<void> {
    if (this.registryWatcher) {
      this.registryWatcher.removeAllListeners();
      await this.registryWatcher.close();
      this.registryWatcher = undefined;
    }

    const projectIds = Array.from(this.projects.keys());
    for (const projectId of projectIds) {
      await this.removeProject(projectId);
    }

    this.removeAllListeners();
  }
}
