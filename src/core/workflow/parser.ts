import { readdir, readFile, stat } from 'fs/promises';
import { join } from 'path';
import { PathUtils } from './path-utils.js';
import { SpecData, SteeringStatus, PhaseStatus } from '../../workflow-types.js';
import { parseTaskProgress } from './task-parser.js';

function isNotFoundError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code?: unknown }).code === 'ENOENT';
}

export class SpecParser {
  constructor(private projectPath: string) {}

  async getAllSpecs(): Promise<SpecData[]> {
    const specs: SpecData[] = [];
    const specsPath = PathUtils.getSpecPath(this.projectPath, '');
    
    try {
      const entries = await readdir(specsPath, { withFileTypes: true });
      
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const spec = await this.getSpec(entry.name);
          if (spec) {
            specs.push(spec);
          }
        }
      }
    } catch (error) {
      if (isNotFoundError(error)) {
        return [];
      }
      throw error;
    }
    
    return specs;
  }

  async getSpec(name: string): Promise<SpecData | null> {
    const specPath = PathUtils.getSpecPath(this.projectPath, name);
    
    try {
      const stats = await stat(specPath);
      if (!stats.isDirectory()) {
        return null;
      }
      
      // Read all phase files
      const requirements = await this.getPhaseStatus(specPath, 'requirements.md');
      const design = await this.getPhaseStatus(specPath, 'design.md');
      const tasks = await this.getPhaseStatus(specPath, 'tasks.md');
      
      // Parse task progress using unified parser
      let taskProgress = undefined;
      if (tasks.exists) {
        try {
          const tasksContent = await readFile(join(specPath, 'tasks.md'), 'utf-8');
          taskProgress = parseTaskProgress(tasksContent);
        } catch (error) {
          if (!isNotFoundError(error)) {
            throw error;
          }
        }
      }
      
      return {
        name,
        createdAt: stats.birthtime.toISOString(),
        lastModified: stats.mtime.toISOString(),
        phases: {
          requirements,
          design,
          tasks,
          implementation: {
            exists: taskProgress ? taskProgress.completed > 0 : false
          }
        },
        taskProgress
      };
    } catch (error) {
      if (isNotFoundError(error)) {
        return null;
      }
      throw error;
    }
  }


  async getProjectSteeringStatus(): Promise<SteeringStatus> {
    const steeringPath = PathUtils.getSteeringPath(this.projectPath);
    
    try {
      const stats = await stat(steeringPath);
      
      const productExists = await this.fileExists(join(steeringPath, 'product.md'));
      const techExists = await this.fileExists(join(steeringPath, 'tech.md'));
      const structureExists = await this.fileExists(join(steeringPath, 'structure.md'));
      const principlesExists = await this.fileExists(join(steeringPath, 'principles.md'));
      
      return {
        exists: stats.isDirectory(),
        documents: {
          product: productExists,
          tech: techExists,
          structure: structureExists,
          principles: principlesExists,
        },
        lastModified: stats.mtime.toISOString()
      };
    } catch (error) {
      if (isNotFoundError(error)) {
        return {
          exists: false,
          documents: {
            product: false,
            tech: false,
            structure: false,
            principles: false,
          }
        };
      }
      throw error;
    }
  }

  private async getPhaseStatus(basePath: string, filename: string): Promise<PhaseStatus> {
    const filePath = join(basePath, filename);
    
    try {
      const stats = await stat(filePath);
      const content = await readFile(filePath, 'utf-8');
      
      return {
        exists: true,
        lastModified: stats.mtime.toISOString(),
        content
      };
    } catch (error) {
      if (isNotFoundError(error)) {
        return {
          exists: false
        };
      }
      throw error;
    }
  }


  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await stat(filePath);
      return true;
    } catch (error) {
      if (isNotFoundError(error)) {
        return false;
      }
      throw error;
    }
  }
}
