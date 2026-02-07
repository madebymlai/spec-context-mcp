import { join } from 'path';
import { promises as fs } from 'fs';
import { getGlobalDir, getPermissionErrorHelp } from './global-dir.js';

export interface DashboardSessionEntry {
  url: string;
  port: number;
  pid: number;
  startedAt: string;
}

function getErrorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

/**
 * Manages the global dashboard session
 * Stores dashboard connection info in ~/.spec-context-mcp/activeSession.json
 * (or SPEC_WORKFLOW_HOME if set)
 */
export class DashboardSessionManager {
  private sessionDir: string;
  private sessionPath: string;

  constructor() {
    this.sessionDir = getGlobalDir();
    this.sessionPath = join(this.sessionDir, 'activeSession.json');
  }

  /**
   * Ensure the session directory exists
   */
  private async ensureSessionDir(): Promise<void> {
    try {
      await fs.mkdir(this.sessionDir, { recursive: true });
    } catch (error: any) {
      // Directory might already exist, ignore EEXIST errors
      if (error.code === 'EEXIST') {
        return;
      }
      // For permission errors, provide helpful guidance
      if (error.code === 'EACCES' || error.code === 'EPERM') {
        console.error(getPermissionErrorHelp('create directory', this.sessionDir));
        throw error;
      }
      // Re-throw other errors
      throw error;
    }
  }

  /**
   * Read the session file
   */
  private async readSession(): Promise<DashboardSessionEntry | null> {
    await this.ensureSessionDir();

    try {
      const content = await fs.readFile(this.sessionPath, 'utf-8');
      return JSON.parse(content) as DashboardSessionEntry;
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        // File doesn't exist yet
        return null;
      }
      throw error;
    }
  }

  /**
   * Write the session file atomically
   */
  private async writeSession(session: DashboardSessionEntry): Promise<void> {
    await this.ensureSessionDir();

    const content = JSON.stringify(session, null, 2);

    // Write to temporary file first, then rename for atomic operation
    const tempPath = `${this.sessionPath}.tmp`;
    await fs.writeFile(tempPath, content, 'utf-8');
    await fs.rename(tempPath, this.sessionPath);
  }

  /**
   * Check if a process is still running
   */
  private isProcessAlive(pid: number): boolean {
    try {
      // Sending signal 0 checks if process exists without actually sending a signal
      process.kill(pid, 0);
      return true;
    } catch (error) {
      const code = getErrorCode(error);
      if (code === 'ESRCH') {
        return false;
      }
      if (code === 'EPERM') {
        return true;
      }
      throw error;
    }
  }

  /**
   * Register the dashboard session
   */
  async registerDashboard(url: string, port: number, pid: number): Promise<void> {
    const session: DashboardSessionEntry = {
      url,
      port,
      pid,
      startedAt: new Date().toISOString()
    };

    await this.writeSession(session);
  }

  /**
   * Unregister the dashboard session
   */
  async unregisterDashboard(): Promise<void> {
    try {
      await fs.unlink(this.sessionPath);
    } catch (error: any) {
      if (error.code !== 'ENOENT') {
        throw error;
      }
    }
  }

  /**
   * Get the current dashboard session if it's valid
   */
  async getDashboardSession(): Promise<DashboardSessionEntry | null> {
    const session = await this.readSession();

    if (!session) {
      return null;
    }

    // Check if the dashboard process is still alive
    if (!this.isProcessAlive(session.pid)) {
      // Process is dead, clean up
      await this.unregisterDashboard();
      return null;
    }

    return session;
  }

  /**
   * Check if a dashboard is currently running
   */
  async isDashboardRunning(): Promise<boolean> {
    const session = await this.getDashboardSession();
    return session !== null;
  }
}
