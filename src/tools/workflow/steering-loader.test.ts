import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getSteeringDocs, getMissingSteeringDocs } from './steering-loader.js';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { TestFileContentCache } from './test-file-content-cache.js';

describe('steering-loader', () => {
  let testDir: string;
  let steeringDir: string;

  beforeEach(() => {
    // Create temp test directory
    testDir = join(tmpdir(), `steering-loader-test-${Date.now()}`);
    steeringDir = join(testDir, '.spec-context', 'steering');
    mkdirSync(steeringDir, { recursive: true });
  });

  afterEach(() => {
    // Clean up
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true });
    }
  });

  describe('getSteeringDocs', () => {
    it('returns null when steering directory does not exist', async () => {
      const emptyDir = join(tmpdir(), `empty-${Date.now()}`);
      mkdirSync(emptyDir, { recursive: true });

      const result = await getSteeringDocs(emptyDir, ['tech', 'principles']);
      expect(result).toBeNull();

      rmSync(emptyDir, { recursive: true });
    });

    it('returns null when no requested docs exist', async () => {
      const result = await getSteeringDocs(testDir, ['tech', 'principles']);
      expect(result).toBeNull();
    });

    it('loads only requested docs', async () => {
      writeFileSync(join(steeringDir, 'tech.md'), 'tech content');
      writeFileSync(join(steeringDir, 'product.md'), 'product content');
      writeFileSync(join(steeringDir, 'principles.md'), 'principles content');

      const result = await getSteeringDocs(testDir, ['tech', 'principles']);

      expect(result).toEqual({
        tech: 'tech content',
        principles: 'principles content',
      });
      expect(result?.product).toBeUndefined();
    });

    it('loads all four doc types when requested', async () => {
      writeFileSync(join(steeringDir, 'product.md'), 'product');
      writeFileSync(join(steeringDir, 'tech.md'), 'tech');
      writeFileSync(join(steeringDir, 'structure.md'), 'structure');
      writeFileSync(join(steeringDir, 'principles.md'), 'principles');

      const result = await getSteeringDocs(testDir, ['product', 'tech', 'structure', 'principles']);

      expect(result).toEqual({
        product: 'product',
        tech: 'tech',
        structure: 'structure',
        principles: 'principles',
      });
    });

    it('returns partial result when some docs exist', async () => {
      writeFileSync(join(steeringDir, 'tech.md'), 'tech only');

      const result = await getSteeringDocs(testDir, ['tech', 'principles']);

      expect(result).toEqual({
        tech: 'tech only',
      });
    });

    it('uses file-content cache when provided', async () => {
      writeFileSync(join(steeringDir, 'tech.md'), 'cached tech');
      writeFileSync(join(steeringDir, 'principles.md'), 'cached principles');
      const cache = new TestFileContentCache();

      const first = await getSteeringDocs(testDir, ['tech', 'principles'], cache);
      const second = await getSteeringDocs(testDir, ['tech', 'principles'], cache);

      expect(first).toEqual({
        tech: 'cached tech',
        principles: 'cached principles',
      });
      expect(second).toEqual(first);
      expect(cache.getTelemetry().namespaces.steering?.hits).toBeGreaterThan(0);
      expect(cache.getTelemetry().namespaces.steering?.misses).toBeGreaterThan(0);
    });
  });

  describe('getMissingSteeringDocs', () => {
    it('returns all docs as missing when none exist', async () => {
      const missing = await getMissingSteeringDocs(testDir, ['tech', 'principles']);
      expect(missing).toEqual(['tech', 'principles']);
    });

    it('returns empty array when all required docs exist', async () => {
      writeFileSync(join(steeringDir, 'tech.md'), 'tech');
      writeFileSync(join(steeringDir, 'principles.md'), 'principles');

      const missing = await getMissingSteeringDocs(testDir, ['tech', 'principles']);
      expect(missing).toEqual([]);
    });

    it('returns only missing docs', async () => {
      writeFileSync(join(steeringDir, 'tech.md'), 'tech');

      const missing = await getMissingSteeringDocs(testDir, ['tech', 'principles']);
      expect(missing).toEqual(['principles']);
    });
  });
});
