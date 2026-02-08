import { access, stat, mkdir } from 'fs/promises';
import { constants } from 'fs';
import { normalize, resolve } from 'path';
import { PathUtils } from './path-utils.js';

export async function validateProjectPath(projectPath: string): Promise<string> {
  try {
    if (!projectPath || typeof projectPath !== 'string') {
      throw new Error('Invalid project path: path must be a non-empty string');
    }

    if (projectPath.includes('..') || projectPath.includes('~')) {
      const normalized = normalize(projectPath);
      const resolved = resolve(normalized);
      const cwd = process.cwd();
      if (normalized.includes('..') && !resolved.startsWith(cwd)) {
        throw new Error(`Path traversal detected: ${projectPath}`);
      }
    }

    const absolutePath = resolve(projectPath);
    const systemPaths = ['/etc', '/usr', '/bin', '/sbin', '/var', '/sys', '/proc'];
    const windowsSystemPaths = ['C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)'];
    const allSystemPaths = process.platform === 'win32' ? windowsSystemPaths : systemPaths;

    for (const sysPath of allSystemPaths) {
      if (absolutePath.toLowerCase().startsWith(sysPath.toLowerCase())) {
        throw new Error(`Access to system directory not allowed: ${absolutePath}`);
      }
    }

    await access(absolutePath, constants.F_OK);
    const stats = await stat(absolutePath);
    if (!stats.isDirectory()) {
      throw new Error(`Project path is not a directory: ${absolutePath}`);
    }

    await access(absolutePath, constants.R_OK | constants.W_OK);
    return absolutePath;
  } catch (error) {
    if (error instanceof Error) {
      if ((error as { code?: unknown }).code === 'ENOENT') {
        throw new Error(`Project path does not exist: ${projectPath}`);
      }
      if ((error as { code?: unknown }).code === 'EACCES') {
        throw new Error(`Permission denied accessing project path: ${projectPath}`);
      }
      throw error;
    }
    throw new Error(`Unknown error validating project path: ${String(error)}`);
  }
}

export async function ensureDirectoryExists(dirPath: string): Promise<void> {
  try {
    await access(dirPath, constants.F_OK);
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'ENOENT') {
      await mkdir(dirPath, { recursive: true });
      return;
    }
    throw error;
  }
}

export async function ensureWorkflowDirectory(projectPath: string): Promise<string> {
  const workflowRoot = PathUtils.getWorkflowRoot(projectPath);
  const directories = [
    workflowRoot,
    PathUtils.getSpecPath(projectPath, ''),
    PathUtils.getArchiveSpecsPath(projectPath),
    PathUtils.getSteeringPath(projectPath),
    PathUtils.getTemplatesPath(projectPath),
    PathUtils.getAgentsPath(projectPath),
    PathUtils.getCommandsPath(projectPath),
  ];

  for (const dir of directories) {
    await ensureDirectoryExists(dir);
  }

  return workflowRoot;
}
