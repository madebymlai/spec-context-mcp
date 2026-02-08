import { promises as fs } from 'fs';
import { basename, join, resolve } from 'path';
import { getGlobalDir, getPermissionErrorHelp } from './global-dir.js';
import {
  generateProjectId,
  type ProjectRegistryEntry,
} from './project-registry.js';

export class ProjectRegistry {
  private registryPath: string;
  private registryDir: string;
  private needsInitialization: boolean = false;

  constructor() {
    this.registryDir = getGlobalDir();
    this.registryPath = join(this.registryDir, 'activeProjects.json');
  }

  private async ensureRegistryDir(): Promise<void> {
    try {
      await fs.mkdir(this.registryDir, { recursive: true });
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error
        ? (error as { code?: unknown }).code
        : undefined;
      if (code === 'EACCES' || code === 'EPERM') {
        console.error(getPermissionErrorHelp('create directory', this.registryDir));
      }
      throw error;
    }
  }

  private async readRegistry(): Promise<Map<string, ProjectRegistryEntry>> {
    await this.ensureRegistryDir();

    try {
      const content = await fs.readFile(this.registryPath, 'utf-8');
      const trimmedContent = content.trim();
      if (!trimmedContent) {
        throw new Error(`Project registry file is empty: ${this.registryPath}`);
      }
      const data = JSON.parse(trimmedContent) as Record<string, ProjectRegistryEntry>;
      for (const entry of Object.values(data)) {
        if (!Array.isArray(entry.instances)) {
          throw new Error(`Invalid project registry schema in ${this.registryPath}: instances must be an array`);
        }
      }
      return new Map(Object.entries(data));
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error
        ? (error as { code?: unknown }).code
        : undefined;
      if (code === 'ENOENT') {
        this.needsInitialization = true;
        return new Map();
      }
      if (error instanceof SyntaxError) {
        throw new Error(`Invalid project registry JSON in ${this.registryPath}: ${error.message}`);
      }
      throw error;
    }
  }

  private async writeRegistry(registry: Map<string, ProjectRegistryEntry>): Promise<void> {
    await this.ensureRegistryDir();

    const data = Object.fromEntries(registry);
    const content = JSON.stringify(data, null, 2);

    const tempPath = `${this.registryPath}.tmp`;
    await fs.writeFile(tempPath, content, 'utf-8');
    await fs.rename(tempPath, this.registryPath);
  }

  private isProcessAlive(pid: number): boolean {
    const hostPrefix = process.env.SPEC_WORKFLOW_HOST_PATH_PREFIX;
    const containerPrefix = process.env.SPEC_WORKFLOW_CONTAINER_PATH_PREFIX;
    if (hostPrefix && containerPrefix) {
      return true;
    }

    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code?: unknown }).code)
        : undefined;
      if (code === 'ESRCH') {
        return false;
      }
      if (code === 'EPERM') {
        return true;
      }
      throw error;
    }
  }

  async registerProject(projectPath: string, pid: number, persistent: boolean = false): Promise<string> {
    const registry = await this.readRegistry();

    const absolutePath = resolve(projectPath);
    const projectId = generateProjectId(absolutePath);
    const projectName = basename(absolutePath);

    const existing = registry.get(projectId);

    if (existing) {
      const liveInstances = existing.instances.filter(i => this.isProcessAlive(i.pid));

      if (!liveInstances.some(i => i.pid === pid)) {
        liveInstances.push({ pid, registeredAt: new Date().toISOString() });
      }

      existing.instances = liveInstances;
      registry.set(projectId, existing);
    } else {
      const entry: ProjectRegistryEntry = {
        projectId,
        projectPath: absolutePath,
        projectName,
        instances: [{ pid, registeredAt: new Date().toISOString() }],
        persistent,
      };
      registry.set(projectId, entry);
    }

    await this.writeRegistry(registry);
    return projectId;
  }

  async unregisterProject(projectPath: string, pid?: number): Promise<void> {
    const registry = await this.readRegistry();
    const absolutePath = resolve(projectPath);
    const projectId = generateProjectId(absolutePath);

    const entry = registry.get(projectId);
    if (!entry) return;

    if (pid !== undefined) {
      entry.instances = entry.instances.filter(i => i.pid !== pid);
      if (entry.instances.length === 0) {
        registry.delete(projectId);
      } else {
        registry.set(projectId, entry);
      }
    } else {
      registry.delete(projectId);
    }

    await this.writeRegistry(registry);
  }

  async unregisterProjectById(projectId: string): Promise<void> {
    const registry = await this.readRegistry();
    registry.delete(projectId);
    await this.writeRegistry(registry);
  }

  async getAllProjects(): Promise<ProjectRegistryEntry[]> {
    const registry = await this.readRegistry();
    return Array.from(registry.values());
  }

  async getActiveProjects(): Promise<ProjectRegistryEntry[]> {
    const registry = await this.readRegistry();
    return Array.from(registry.values()).filter(entry =>
      entry.instances.some(i => this.isProcessAlive(i.pid))
    );
  }

  async getProject(projectPath: string): Promise<ProjectRegistryEntry | null> {
    const registry = await this.readRegistry();
    const absolutePath = resolve(projectPath);
    const projectId = generateProjectId(absolutePath);
    return registry.get(projectId) || null;
  }

  async getProjectById(projectId: string): Promise<ProjectRegistryEntry | null> {
    const registry = await this.readRegistry();
    return registry.get(projectId) || null;
  }

  async cleanupStaleProjects(): Promise<number> {
    const registry = await this.readRegistry();
    let removedInstanceCount = 0;
    let needsWrite = this.needsInitialization;

    for (const [projectId, entry] of registry.entries()) {
      const liveInstances = entry.instances.filter(i => this.isProcessAlive(i.pid));
      const deadCount = entry.instances.length - liveInstances.length;

      if (deadCount > 0) {
        removedInstanceCount += deadCount;
        needsWrite = true;

        if (liveInstances.length === 0 && !entry.persistent) {
          registry.delete(projectId);
        } else {
          entry.instances = liveInstances;
          registry.set(projectId, entry);
        }
      }
    }

    if (needsWrite) {
      await this.writeRegistry(registry);
      this.needsInitialization = false;
    }

    return removedInstanceCount;
  }

  async isProjectRegistered(projectPath: string): Promise<boolean> {
    const registry = await this.readRegistry();
    const absolutePath = resolve(projectPath);
    const projectId = generateProjectId(absolutePath);
    return registry.has(projectId);
  }

  getRegistryPath(): string {
    return this.registryPath;
  }
}
