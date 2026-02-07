import { mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileContentCache } from './file-content-cache.js';

describe('file-content-cache', () => {
  const testDirs: string[] = [];

  async function createTempDir(name: string): Promise<string> {
    const dir = join(tmpdir(), `file-content-cache-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    await mkdir(dir, { recursive: true });
    testDirs.push(dir);
    return dir;
  }

  afterEach(async () => {
    await Promise.all(testDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
  });

  it('records miss then hit for unchanged file', async () => {
    const dir = await createTempDir('hit');
    const filePath = join(dir, 'a.txt');
    await writeFile(filePath, 'alpha', 'utf8');
    const cache = new FileContentCache();

    const first = await cache.get(filePath, { namespace: 'steering' });
    const second = await cache.get(filePath, { namespace: 'steering' });

    expect(first).toBe('alpha');
    expect(second).toBe('alpha');
    expect(cache.getTelemetry()).toMatchObject({
      hits: 1,
      misses: 1,
      errors: 0,
      namespaces: {
        steering: {
          hits: 1,
          misses: 1,
          errors: 0,
        },
      },
    });
  });

  it('re-reads and updates cache when mtime changes', async () => {
    const dir = await createTempDir('mtime');
    const filePath = join(dir, 'a.txt');
    await writeFile(filePath, 'v1', 'utf8');
    const cache = new FileContentCache();

    const first = await cache.get(filePath, { namespace: 'spec-status' });
    const fp1 = cache.getFingerprint(filePath);
    await new Promise(resolve => setTimeout(resolve, 5));
    await writeFile(filePath, 'v2', 'utf8');
    const second = await cache.get(filePath, { namespace: 'spec-status' });
    const fp2 = cache.getFingerprint(filePath);

    expect(first).toBe('v1');
    expect(second).toBe('v2');
    expect(fp1).not.toBeNull();
    expect(fp2).not.toBeNull();
    expect(fp1?.mtimeMs).not.toBe(fp2?.mtimeMs);
    expect(cache.getTelemetry().namespaces['spec-status']?.misses).toBe(2);
  });

  it('returns null and records miss for file-not-found', async () => {
    const dir = await createTempDir('enoent');
    const filePath = join(dir, 'missing.txt');
    const cache = new FileContentCache();

    const value = await cache.get(filePath, { namespace: 'guide' });

    expect(value).toBeNull();
    expect(cache.getTelemetry()).toMatchObject({
      hits: 0,
      misses: 1,
      errors: 0,
      namespaces: {
        guide: {
          hits: 0,
          misses: 1,
          errors: 0,
        },
      },
    });
  });

  it('returns null and records error for non-readable path', async () => {
    const dir = await createTempDir('error');
    const cache = new FileContentCache();

    const value = await cache.get(dir, { namespace: 'guide' });

    expect(value).toBeNull();
    expect(cache.getTelemetry().errors).toBe(1);
    expect(cache.getTelemetry().namespaces['guide']?.errors).toBe(1);
  });

  it('supports invalidate and clear', async () => {
    const dir = await createTempDir('invalidate');
    const filePath = join(dir, 'a.txt');
    await writeFile(filePath, 'hello', 'utf8');
    const cache = new FileContentCache();

    await cache.get(filePath);
    expect(cache.getFingerprint(filePath)).not.toBeNull();

    cache.invalidate(filePath);
    expect(cache.getFingerprint(filePath)).toBeNull();

    await cache.get(filePath);
    expect(cache.getFingerprint(filePath)).not.toBeNull();

    cache.clear();
    expect(cache.getFingerprint(filePath)).toBeNull();
  });

  it('evicts oldest entries when maxEntries is reached', async () => {
    const dir = await createTempDir('evict');
    const fileA = join(dir, 'a.txt');
    const fileB = join(dir, 'b.txt');
    const fileC = join(dir, 'c.txt');
    await writeFile(fileA, 'a', 'utf8');
    await writeFile(fileB, 'b', 'utf8');
    await writeFile(fileC, 'c', 'utf8');
    const cache = new FileContentCache(2);

    await cache.get(fileA);
    await cache.get(fileB);
    expect(cache.getFingerprint(fileA)).not.toBeNull();
    expect(cache.getFingerprint(fileB)).not.toBeNull();

    await cache.get(fileC);
    expect(cache.getFingerprint(fileA)).toBeNull();
    expect(cache.getFingerprint(fileB)).not.toBeNull();
    expect(cache.getFingerprint(fileC)).not.toBeNull();
  });
});
