import type { FileContentCacheTelemetry, IFileContentCache } from './file-content-cache.js';
import { createNodeFileContentCache } from './file-content-cache-node.js';

const sharedFileContentCache = createNodeFileContentCache();

export function getSharedFileContentCache(): IFileContentCache {
  return sharedFileContentCache;
}

export function getSharedFileContentCacheTelemetry(): FileContentCacheTelemetry {
  return sharedFileContentCache.getTelemetry();
}
