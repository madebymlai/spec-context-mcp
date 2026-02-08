import { readFile, stat } from 'fs/promises';
import {
  FileContentCache,
  type FileContentCacheStorage,
} from './file-content-cache.js';

function isFileNotFoundError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code?: unknown }).code === 'ENOENT';
}

export const nodeFileContentCacheStorage: FileContentCacheStorage = {
  async stat(filePath: string) {
    const fileStats = await stat(filePath);
    return { mtimeMs: fileStats.mtimeMs };
  },
  readFile(filePath: string) {
    return readFile(filePath, 'utf-8');
  },
  isFileNotFoundError,
};

export function createNodeFileContentCache(maxEntries = 512): FileContentCache {
  return new FileContentCache(nodeFileContentCacheStorage, maxEntries);
}
