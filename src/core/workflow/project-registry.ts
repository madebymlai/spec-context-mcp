import { createHash } from 'crypto';

export interface ProjectInstance {
  pid: number;
  registeredAt: string;
}

export interface ProjectRegistryEntry {
  projectId: string;
  projectPath: string;
  projectName: string;
  instances: ProjectInstance[];
  persistent?: boolean;
}

/**
 * Generate a stable projectId from an absolute path
 * Uses SHA-1 hash encoded as base64url
 */
export function generateProjectId(absolutePath: string): string {
  const hash = createHash('sha1').update(absolutePath).digest('base64url');
  return hash.substring(0, 16);
}
