import { promises as fs } from 'fs';
import { PathUtils } from './path-utils.js';

function isNotFoundError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code?: unknown }).code === 'ENOENT';
}

export class SpecArchiveService {
  private projectPath: string;

  constructor(projectPath: string) {
    // Path should already be translated by caller (ProjectManager)
    this.projectPath = projectPath;
  }

  async archiveSpec(specName: string): Promise<void> {
    const activeSpecPath = PathUtils.getSpecPath(this.projectPath, specName);
    const archiveSpecPath = PathUtils.getArchiveSpecPath(this.projectPath, specName);

    // Verify the active spec exists
    try {
      await fs.access(activeSpecPath);
    } catch (error) {
      if (isNotFoundError(error)) {
        throw new Error(`Spec '${specName}' not found in active specs`);
      }
      throw error;
    }

    // Verify the archive destination doesn't already exist
    try {
      await fs.access(archiveSpecPath);
      throw new Error(`Spec '${specName}' already exists in archive`);
    } catch (error) {
      if (!isNotFoundError(error)) {
        throw error;
      }
    }

    try {
      // Ensure archive directory structure exists
      await fs.mkdir(PathUtils.getArchiveSpecsPath(this.projectPath), { recursive: true });
      
      // Move the entire spec directory to archive
      await fs.rename(activeSpecPath, archiveSpecPath);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to archive spec '${specName}': ${errorMessage}`);
    }
  }

  async unarchiveSpec(specName: string): Promise<void> {
    const archiveSpecPath = PathUtils.getArchiveSpecPath(this.projectPath, specName);
    const activeSpecPath = PathUtils.getSpecPath(this.projectPath, specName);

    // Verify the archived spec exists
    try {
      await fs.access(archiveSpecPath);
    } catch (error) {
      if (isNotFoundError(error)) {
        throw new Error(`Spec '${specName}' not found in archive`);
      }
      throw error;
    }

    // Verify the active destination doesn't already exist
    try {
      await fs.access(activeSpecPath);
      throw new Error(`Spec '${specName}' already exists in active specs`);
    } catch (error) {
      if (!isNotFoundError(error)) {
        throw error;
      }
    }

    try {
      // Ensure active specs directory exists
      await fs.mkdir(PathUtils.getSpecPath(this.projectPath, ''), { recursive: true });
      
      // Move the entire spec directory back to active
      await fs.rename(archiveSpecPath, activeSpecPath);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to unarchive spec '${specName}': ${errorMessage}`);
    }
  }

  async isSpecActive(specName: string): Promise<boolean> {
    try {
      await fs.access(PathUtils.getSpecPath(this.projectPath, specName));
      return true;
    } catch (error) {
      if (isNotFoundError(error)) {
        return false;
      }
      throw error;
    }
  }

  async isSpecArchived(specName: string): Promise<boolean> {
    try {
      await fs.access(PathUtils.getArchiveSpecPath(this.projectPath, specName));
      return true;
    } catch (error) {
      if (isNotFoundError(error)) {
        return false;
      }
      throw error;
    }
  }

  async getSpecLocation(specName: string): Promise<'active' | 'archived' | 'not-found'> {
    const isActive = await this.isSpecActive(specName);
    if (isActive) return 'active';

    const isArchived = await this.isSpecArchived(specName);
    if (isArchived) return 'archived';

    return 'not-found';
  }
}
