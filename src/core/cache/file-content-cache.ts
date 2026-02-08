import { setBoundedMapEntry } from './bounded-map.js';

export interface FileContentFingerprint {
  mtimeMs: number;
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
}

export interface IFileContentCache {
  get(filePath: string, options?: { namespace?: string }): Promise<string | null>;
  getFingerprint(filePath: string): FileContentFingerprint | null;
  getTelemetry(): FileContentCacheTelemetry;
  invalidate(filePath: string): void;
  clear(): void;
}

export interface FileContentCacheStorage {
  stat(filePath: string): Promise<FileContentFingerprint>;
  readFile(filePath: string): Promise<string>;
  isFileNotFoundError(error: unknown): boolean;
}

export function areFileFingerprintsEqual(
  left: FileContentFingerprint | null,
  right: FileContentFingerprint | null
): boolean {
  if (!left && !right) {
    return true;
  }
  if (!left || !right) {
    return false;
  }
  return left.mtimeMs === right.mtimeMs;
}

export class FileContentCache implements IFileContentCache {
  private readonly entries = new Map<string, FileContentCacheEntry>();
  private readonly namespaceTelemetry = new Map<string, FileContentCacheNamespaceTelemetry>();
  private readonly maxEntries: number;
  private readonly storage: FileContentCacheStorage;
  private hits = 0;
  private misses = 0;
  private errors = 0;

  constructor(storage: FileContentCacheStorage, maxEntries = 512) {
    this.storage = storage;
    this.maxEntries = Math.max(1, Math.floor(maxEntries));
  }

  async get(filePath: string, options?: { namespace?: string }): Promise<string | null> {
    const namespace = options?.namespace ?? 'default';
    const existing = this.entries.get(filePath);

    let mtimeMs: number;
    try {
      const fileStats = await this.storage.stat(filePath);
      mtimeMs = fileStats.mtimeMs;
    } catch (error) {
      if (this.storage.isFileNotFoundError(error)) {
        this.recordMiss(namespace);
        this.entries.delete(filePath);
        return null;
      }
      this.recordError(namespace);
      this.entries.delete(filePath);
      throw error;
    }

    if (existing && existing.fingerprint.mtimeMs === mtimeMs) {
      this.recordHit(namespace);
      return existing.content;
    }

    let content: string;
    try {
      content = await this.storage.readFile(filePath);
    } catch (error) {
      if (this.storage.isFileNotFoundError(error)) {
        this.recordMiss(namespace);
        this.entries.delete(filePath);
        return null;
      }
      this.recordError(namespace);
      this.entries.delete(filePath);
      throw error;
    }

    setBoundedMapEntry(this.entries, filePath, {
      content,
      fingerprint: { mtimeMs },
    }, this.maxEntries);
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
