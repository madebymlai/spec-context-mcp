import { describe, it, expect } from 'vitest';
import {
  buildBundledTemplatePath,
  collectTemplateFingerprints,
  getSpecTemplates,
  hasTemplateFingerprintMismatch,
} from './template-loader.js';
import { FileContentCache } from '../../core/cache/file-content-cache.js';

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
      const cache = new FileContentCache();

      const first = await getSpecTemplates(['requirements'], cache);
      const second = await getSpecTemplates(['requirements'], cache);

      expect(first).toEqual(second);
      expect(cache.getTelemetry().namespaces['templates.server']?.hits).toBeGreaterThan(0);
      expect(cache.getTelemetry().namespaces['templates.server']?.misses).toBeGreaterThan(0);
    });
  });

  describe('fingerprints', () => {
    it('collects fingerprints after templates are cached', async () => {
      const cache = new FileContentCache();
      await getSpecTemplates(['requirements', 'design'], cache);

      const fingerprints = collectTemplateFingerprints(['requirements', 'design'], cache);

      expect(fingerprints.requirements).toBeDefined();
      expect(fingerprints.design).toBeDefined();
    });

    it('returns false when fingerprints match', async () => {
      const cache = new FileContentCache();
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
      const cache = new FileContentCache();
      await getSpecTemplates(['requirements'], cache);

      const mismatch = hasTemplateFingerprintMismatch({
        templates: ['requirements'],
        previous: {},
        fileContentCache: cache,
      });

      expect(mismatch).toBe(true);
    });
  });
});
