import { createHash } from 'crypto';
import { readFile, stat } from 'fs/promises';

export interface FileContentFingerprint {
  mtimeMs: number;
  hash: string;
}

export interface FileContentCacheNamespaceTelemetry {
  hits: number;
  misses: number;
  errors: number;
}

export interface FileContentCacheTelemetry {
  hits: number;
  misses: number;
  errors: number;
  namespaces: Record<string, FileContentCacheNamespaceTelemetry>;
}

interface FileContentCacheEntry {
  content: string;
  fingerprint: FileContentFingerprint;
  cachedAt: number;
}

export interface IFileContentCache {
  get(filePath: string, options?: { namespace?: string }): Promise<string | null>;
  getFingerprint(filePath: string): FileContentFingerprint | null;
  getTelemetry(): FileContentCacheTelemetry;
  invalidate(filePath: string): void;
  clear(): void;
}

function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

export class FileContentCache implements IFileContentCache {
  private readonly entries = new Map<string, FileContentCacheEntry>();
  private readonly namespaceTelemetry = new Map<string, FileContentCacheNamespaceTelemetry>();
  private hits = 0;
  private misses = 0;
  private errors = 0;

  async get(filePath: string, options?: { namespace?: string }): Promise<string | null> {
    const namespace = options?.namespace ?? 'default';
    const existing = this.entries.get(filePath);

    let mtimeMs: number;
    try {
      const fileStats = await stat(filePath);
      mtimeMs = fileStats.mtimeMs;
    } catch (error) {
      if (isFileNotFoundError(error)) {
        this.recordMiss(namespace);
      } else {
        this.recordError(namespace);
      }
      this.entries.delete(filePath);
      return null;
    }

    if (existing && existing.fingerprint.mtimeMs === mtimeMs) {
      this.recordHit(namespace);
      return existing.content;
    }

    let content: string;
    try {
      content = await readFile(filePath, 'utf-8');
    } catch (error) {
      if (isFileNotFoundError(error)) {
        this.recordMiss(namespace);
      } else {
        this.recordError(namespace);
      }
      this.entries.delete(filePath);
      return null;
    }

    let hash: string;
    try {
      hash = hashContent(content);
    } catch {
      this.recordError(namespace);
      this.entries.delete(filePath);
      return null;
    }

    this.entries.set(filePath, {
      content,
      fingerprint: { mtimeMs, hash },
      cachedAt: Date.now(),
    });
    this.recordMiss(namespace);
    return content;
  }

  getFingerprint(filePath: string): FileContentFingerprint | null {
    const entry = this.entries.get(filePath);
    if (!entry) {
      return null;
    }
    return { ...entry.fingerprint };
  }

  getTelemetry(): FileContentCacheTelemetry {
    const namespaces: Record<string, FileContentCacheNamespaceTelemetry> = {};
    for (const [key, value] of this.namespaceTelemetry.entries()) {
      namespaces[key] = { ...value };
    }
    return {
      hits: this.hits,
      misses: this.misses,
      errors: this.errors,
      namespaces,
    };
  }

  invalidate(filePath: string): void {
    this.entries.delete(filePath);
  }

  clear(): void {
    this.entries.clear();
  }

  private recordHit(namespace: string): void {
    this.hits += 1;
    const telemetry = this.ensureNamespaceTelemetry(namespace);
    telemetry.hits += 1;
  }

  private recordMiss(namespace: string): void {
    this.misses += 1;
    const telemetry = this.ensureNamespaceTelemetry(namespace);
    telemetry.misses += 1;
  }

  private recordError(namespace: string): void {
    this.errors += 1;
    const telemetry = this.ensureNamespaceTelemetry(namespace);
    telemetry.errors += 1;
  }

  private ensureNamespaceTelemetry(namespace: string): FileContentCacheNamespaceTelemetry {
    const telemetry = this.namespaceTelemetry.get(namespace);
    if (telemetry) {
      return telemetry;
    }
    const created: FileContentCacheNamespaceTelemetry = {
      hits: 0,
      misses: 0,
      errors: 0,
    };
    this.namespaceTelemetry.set(namespace, created);
    return created;
  }
}

function isFileNotFoundError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code?: string }).code === 'ENOENT';
}
