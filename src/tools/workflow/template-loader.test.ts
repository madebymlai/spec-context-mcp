import { describe, it, expect } from 'vitest';
import {
  buildBundledTemplatePath,
  collectSteeringTemplateFingerprints,
  collectTemplateFingerprints,
  getSteeringTemplates,
  getSpecTemplates,
  hasSteeringTemplateFingerprintMismatch,
  hasTemplateFingerprintMismatch,
} from './template-loader.js';
import { TestFileContentCache } from './test-file-content-cache.js';

describe('template-loader', () => {
  describe('getSpecTemplates', () => {
    it('loads server-bundled templates', async () => {
      const result = await getSpecTemplates(['requirements']);

      expect(result?.requirements?.source).toBe('server');
      expect(result?.requirements?.path).toBe(buildBundledTemplatePath('requirements'));
      expect(result?.requirements?.content.length).toBeGreaterThan(0);
    });

    it('loads only requested template types', async () => {
      const result = await getSpecTemplates(['tasks']);

      expect(result?.tasks).toBeDefined();
      expect(result?.design).toBeUndefined();
      expect(result?.requirements).toBeUndefined();
    });

    it('uses file-content cache namespace for server templates', async () => {
      const cache = new TestFileContentCache();

      const first = await getSpecTemplates(['requirements'], cache);
      const second = await getSpecTemplates(['requirements'], cache);

      expect(first).toEqual(second);
      expect(cache.getTelemetry().namespaces['templates.server']?.hits).toBeGreaterThan(0);
      expect(cache.getTelemetry().namespaces['templates.server']?.misses).toBeGreaterThan(0);
    });
  });

  describe('getSteeringTemplates', () => {
    it('loads server-bundled steering templates', async () => {
      const result = await getSteeringTemplates(['product']);

      expect(result?.product?.source).toBe('server');
      expect(result?.product?.path).toBe(buildBundledTemplatePath('product'));
      expect(result?.product?.content.length).toBeGreaterThan(0);
    });

    it('loads only requested steering template types', async () => {
      const result = await getSteeringTemplates(['principles']);

      expect(result?.principles).toBeDefined();
      expect(result?.tech).toBeUndefined();
      expect(result?.product).toBeUndefined();
    });

    it('uses file-content cache namespace for steering templates', async () => {
      const cache = new TestFileContentCache();

      const first = await getSteeringTemplates(['tech'], cache);
      const second = await getSteeringTemplates(['tech'], cache);

      expect(first).toEqual(second);
      expect(cache.getTelemetry().namespaces['templates.server']?.hits).toBeGreaterThan(0);
      expect(cache.getTelemetry().namespaces['templates.server']?.misses).toBeGreaterThan(0);
    });
  });

  describe('fingerprints', () => {
    it('collects fingerprints after templates are cached', async () => {
      const cache = new TestFileContentCache();
      await getSpecTemplates(['requirements', 'design'], cache);

      const fingerprints = collectTemplateFingerprints(['requirements', 'design'], cache);

      expect(fingerprints.requirements).toBeDefined();
      expect(fingerprints.design).toBeDefined();
    });

    it('returns false when fingerprints match', async () => {
      const cache = new TestFileContentCache();
      await getSpecTemplates(['requirements', 'design'], cache);
      const fingerprints = collectTemplateFingerprints(['requirements', 'design'], cache);

      const mismatch = hasTemplateFingerprintMismatch({
        templates: ['requirements', 'design'],
        previous: fingerprints,
        fileContentCache: cache,
      });

      expect(mismatch).toBe(false);
    });

    it('returns true when previous fingerprint set is incomplete', async () => {
      const cache = new TestFileContentCache();
      await getSpecTemplates(['requirements'], cache);

      const mismatch = hasTemplateFingerprintMismatch({
        templates: ['requirements'],
        previous: {},
        fileContentCache: cache,
      });

      expect(mismatch).toBe(true);
    });

    it('collects steering template fingerprints after templates are cached', async () => {
      const cache = new TestFileContentCache();
      await getSteeringTemplates(['product', 'tech'], cache);

      const fingerprints = collectSteeringTemplateFingerprints(['product', 'tech'], cache);

      expect(fingerprints.product).toBeDefined();
      expect(fingerprints.tech).toBeDefined();
    });

    it('returns false when steering template fingerprints match', async () => {
      const cache = new TestFileContentCache();
      await getSteeringTemplates(['product', 'tech'], cache);
      const fingerprints = collectSteeringTemplateFingerprints(['product', 'tech'], cache);

      const mismatch = hasSteeringTemplateFingerprintMismatch({
        templates: ['product', 'tech'],
        previous: fingerprints,
        fileContentCache: cache,
      });

      expect(mismatch).toBe(false);
    });
  });
});
