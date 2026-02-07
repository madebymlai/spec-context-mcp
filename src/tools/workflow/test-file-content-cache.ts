import { readFile, stat } from 'fs/promises';
import type { FileContentCacheTelemetry, IFileContentCache } from '../../core/cache/file-content-cache.js';

interface TestFileContentCacheEntry {
  content: string;
  mtimeMs: number;
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code?: unknown }).code === 'ENOENT';
}

export class TestFileContentCache implements IFileContentCache {
  private readonly entries = new Map<string, TestFileContentCacheEntry>();
  private readonly telemetry: FileContentCacheTelemetry = {
    hits: 0,
    misses: 0,
    errors: 0,
    namespaces: {},
  };

  async get(filePath: string, options?: { namespace?: string }): Promise<string | null> {
    const namespace = options?.namespace ?? 'default';
    const namespaceTelemetry = this.ensureNamespace(namespace);
    let mtimeMs: number;

    try {
      const fileStat = await stat(filePath);
      mtimeMs = fileStat.mtimeMs;
    } catch (error) {
      if (isNotFoundError(error)) {
        this.entries.delete(filePath);
        this.telemetry.misses += 1;
        namespaceTelemetry.misses += 1;
        return null;
      }
      this.entries.delete(filePath);
      this.telemetry.errors += 1;
      namespaceTelemetry.errors += 1;
      throw error;
    }

    const existing = this.entries.get(filePath);
    if (existing && existing.mtimeMs === mtimeMs) {
      this.telemetry.hits += 1;
      namespaceTelemetry.hits += 1;
      return existing.content;
    }

    const content = await readFile(filePath, 'utf8');
    this.entries.set(filePath, { content, mtimeMs });
    this.telemetry.misses += 1;
    namespaceTelemetry.misses += 1;
    return content;
  }

  getFingerprint(filePath: string): { mtimeMs: number } | null {
    const entry = this.entries.get(filePath);
    if (!entry) {
      return null;
    }
    return { mtimeMs: entry.mtimeMs };
  }

  getTelemetry(): FileContentCacheTelemetry {
    return {
      hits: this.telemetry.hits,
      misses: this.telemetry.misses,
      errors: this.telemetry.errors,
      namespaces: Object.fromEntries(
        Object.entries(this.telemetry.namespaces).map(([key, value]) => [
          key,
          { ...value },
        ])
      ),
    };
  }

  invalidate(filePath: string): void {
    this.entries.delete(filePath);
  }

  clear(): void {
    this.entries.clear();
  }

  private ensureNamespace(namespace: string): { hits: number; misses: number; errors: number } {
    if (!this.telemetry.namespaces[namespace]) {
      this.telemetry.namespaces[namespace] = { hits: 0, misses: 0, errors: 0 };
    }
    return this.telemetry.namespaces[namespace];
  }
}
