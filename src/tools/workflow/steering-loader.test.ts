import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getSteeringDocs, getMissingSteeringDocs } from './steering-loader.js';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

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
    it('returns null when steering directory does not exist', () => {
      const emptyDir = join(tmpdir(), `empty-${Date.now()}`);
      mkdirSync(emptyDir, { recursive: true });

      const result = getSteeringDocs(emptyDir, ['tech', 'principles']);
      expect(result).toBeNull();

      rmSync(emptyDir, { recursive: true });
    });

    it('returns null when no requested docs exist', () => {
      const result = getSteeringDocs(testDir, ['tech', 'principles']);
      expect(result).toBeNull();
    });

    it('loads only requested docs', () => {
      writeFileSync(join(steeringDir, 'tech.md'), 'tech content');
      writeFileSync(join(steeringDir, 'product.md'), 'product content');
      writeFileSync(join(steeringDir, 'principles.md'), 'principles content');

      const result = getSteeringDocs(testDir, ['tech', 'principles']);

      expect(result).toEqual({
        tech: 'tech content',
        principles: 'principles content',
      });
      expect(result?.product).toBeUndefined();
    });

    it('loads all four doc types when requested', () => {
      writeFileSync(join(steeringDir, 'product.md'), 'product');
      writeFileSync(join(steeringDir, 'tech.md'), 'tech');
      writeFileSync(join(steeringDir, 'structure.md'), 'structure');
      writeFileSync(join(steeringDir, 'principles.md'), 'principles');

      const result = getSteeringDocs(testDir, ['product', 'tech', 'structure', 'principles']);

      expect(result).toEqual({
        product: 'product',
        tech: 'tech',
        structure: 'structure',
        principles: 'principles',
      });
    });

    it('returns partial result when some docs exist', () => {
      writeFileSync(join(steeringDir, 'tech.md'), 'tech only');

      const result = getSteeringDocs(testDir, ['tech', 'principles']);

      expect(result).toEqual({
        tech: 'tech only',
      });
    });
  });

  describe('getMissingSteeringDocs', () => {
    it('returns all docs as missing when none exist', () => {
      const missing = getMissingSteeringDocs(testDir, ['tech', 'principles']);
      expect(missing).toEqual(['tech', 'principles']);
    });

    it('returns empty array when all required docs exist', () => {
      writeFileSync(join(steeringDir, 'tech.md'), 'tech');
      writeFileSync(join(steeringDir, 'principles.md'), 'principles');

      const missing = getMissingSteeringDocs(testDir, ['tech', 'principles']);
      expect(missing).toEqual([]);
    });

    it('returns only missing docs', () => {
      writeFileSync(join(steeringDir, 'tech.md'), 'tech');

      const missing = getMissingSteeringDocs(testDir, ['tech', 'principles']);
      expect(missing).toEqual(['principles']);
    });
  });
});
