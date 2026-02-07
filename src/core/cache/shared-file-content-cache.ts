import type { FileContentCacheTelemetry, IFileContentCache } from './file-content-cache.js';
import { FileContentCache } from './file-content-cache.js';

const sharedFileContentCache = new FileContentCache();

export function getSharedFileContentCache(): IFileContentCache {
  return sharedFileContentCache;
}

export function getSharedFileContentCacheTelemetry(): FileContentCacheTelemetry {
  return sharedFileContentCache.getTelemetry();
}
