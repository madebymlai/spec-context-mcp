import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getReviewerGuideHandler } from './get-reviewer-guide.js';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { FileContentCache } from '../../core/cache/file-content-cache.js';

describe('get-reviewer-guide', () => {
  let testDir: string;
  let steeringDir: string;
  let fileContentCache: FileContentCache;
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.SPEC_CONTEXT_DISCIPLINE;

    testDir = join(tmpdir(), `reviewer-guide-test-${Date.now()}`);
    steeringDir = join(testDir, '.spec-context', 'steering');
    mkdirSync(steeringDir, { recursive: true });
    fileContentCache = new FileContentCache();
  });

  afterEach(() => {
    process.env = originalEnv;
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true });
    }
  });

  const createContext = () => ({
    projectPath: testDir,
    dashboardUrl: 'http://localhost:3000',
    fileContentCache,
  });

  const createSteeringDocs = () => {
    writeFileSync(join(steeringDir, 'tech.md'), '# Tech Stack\nTypeScript');
    writeFileSync(join(steeringDir, 'principles.md'), '# Principles\nSOLID');
  };

  describe('minimal mode', () => {
    beforeEach(() => {
      process.env.SPEC_CONTEXT_DISCIPLINE = 'minimal';
      createSteeringDocs();
    });

    it('returns error in minimal mode', async () => {
      const result = await getReviewerGuideHandler({}, createContext());

      expect(result.success).toBe(false);
      expect(result.message).toContain('not active in minimal');
    });
  });

  describe('missing steering docs', () => {
    beforeEach(() => {
      process.env.SPEC_CONTEXT_DISCIPLINE = 'full';
    });

    it('fails when tech.md is missing', async () => {
      writeFileSync(join(steeringDir, 'principles.md'), 'principles');

      const result = await getReviewerGuideHandler({}, createContext());

      expect(result.success).toBe(false);
      expect(result.message).toContain('tech.md');
    });

    it('fails when principles.md is missing', async () => {
      writeFileSync(join(steeringDir, 'tech.md'), 'tech');

      const result = await getReviewerGuideHandler({}, createContext());

      expect(result.success).toBe(false);
      expect(result.message).toContain('principles.md');
    });
  });

  describe('full mode', () => {
    beforeEach(() => {
      process.env.SPEC_CONTEXT_DISCIPLINE = 'full';
      createSteeringDocs();
    });

    it('returns success with guide', async () => {
      const result = await getReviewerGuideHandler({}, createContext());

      expect(result.success).toBe(true);
      expect(result.data?.disciplineMode).toBe('full');
      expect(result.meta?.minVisibilityTier).toBe(2);
    });

    it('includes review checklist', async () => {
      const result = await getReviewerGuideHandler({}, createContext());

      expect(result.data?.guide).toContain('Review Checklist');
      expect(result.data?.guide).toContain('Spec Compliance');
      expect(result.data?.guide).toContain('Code Quality');
    });

    it('includes severity levels', async () => {
      const result = await getReviewerGuideHandler({}, createContext());

      expect(result.data?.guide).toContain('Critical');
      expect(result.data?.guide).toContain('Important');
      expect(result.data?.guide).toContain('Minor');
    });

    it('inlines steering docs in guide', async () => {
      const result = await getReviewerGuideHandler({}, createContext());

      expect(result.data?.guide).toContain('TypeScript');
      expect(result.data?.guide).toContain('SOLID');
    });

    it('includes search guidance', async () => {
      const result = await getReviewerGuideHandler({}, createContext());

      expect(result.data?.searchGuidance).toContain('Search');
      expect(result.data?.searchGuidance).toContain('Duplicates');
    });

    it('supports compact mode after caching full guide for a run', async () => {
      const full = await getReviewerGuideHandler({ mode: 'full', runId: 'run-r1' }, createContext());
      expect(full.success).toBe(true);
      expect(full.data?.guideMode).toBe('full');
      expect(full.meta?.minVisibilityTier).toBe(2);

      const compact = await getReviewerGuideHandler({ mode: 'compact', runId: 'run-r1' }, createContext());
      expect(compact.success).toBe(true);
      expect(compact.data?.guideMode).toBe('compact');
      expect(compact.data?.guide).toContain('Reviewer Compact Guide');
      expect(compact.data?.guide).toContain('strict contract block');
      expect(compact.meta).toBeUndefined();
    });

    it('invalidates compact cache when steering docs change', async () => {
      const context = createContext();
      await getReviewerGuideHandler({ mode: 'full', runId: 'run-review-steering-change' }, context);

      const compactBefore = await getReviewerGuideHandler({ mode: 'compact', runId: 'run-review-steering-change' }, context);
      expect(compactBefore.success).toBe(true);
      expect(compactBefore.data?.guideMode).toBe('compact');

      await new Promise(resolve => setTimeout(resolve, 5));
      writeFileSync(join(steeringDir, 'principles.md'), '# Principles\nDDD');

      const compactAfter = await getReviewerGuideHandler({ mode: 'compact', runId: 'run-review-steering-change' }, context);
      expect(compactAfter.success).toBe(true);
      expect(compactAfter.data?.guideMode).toBe('full');
      expect(compactAfter.data?.guide).toContain('DDD');
    });

    it('rejects compact mode without runId', async () => {
      const result = await getReviewerGuideHandler({ mode: 'compact' }, createContext());
      expect(result.success).toBe(false);
      expect(result.message).toContain('requires runId');
    });

    it('rejects compact mode when cache is missing', async () => {
      const result = await getReviewerGuideHandler({ mode: 'compact', runId: 'missing-review-run' }, createContext());
      expect(result.success).toBe(false);
      expect(result.message).toContain('Call get-reviewer-guide with mode:"full" first');
    });
  });

  describe('standard mode', () => {
    beforeEach(() => {
      process.env.SPEC_CONTEXT_DISCIPLINE = 'standard';
      createSteeringDocs();
    });

    it('returns success with correct mode', async () => {
      const result = await getReviewerGuideHandler({}, createContext());

      expect(result.success).toBe(true);
      expect(result.data?.disciplineMode).toBe('standard');
    });

    it('includes review checklist', async () => {
      const result = await getReviewerGuideHandler({}, createContext());

      expect(result.data?.guide).toContain('Review Checklist');
    });
  });

  describe('default mode', () => {
    beforeEach(() => {
      delete process.env.SPEC_CONTEXT_DISCIPLINE;
      createSteeringDocs();
    });

    it('defaults to full mode and works', async () => {
      const result = await getReviewerGuideHandler({}, createContext());

      expect(result.success).toBe(true);
      expect(result.data?.disciplineMode).toBe('full');
    });
  });

  describe('visibility hints', () => {
    beforeEach(() => {
      process.env.SPEC_CONTEXT_DISCIPLINE = 'full';
      createSteeringDocs();
    });

    it('adds minVisibilityTier=2 hint on successful full guide', async () => {
      const result = await getReviewerGuideHandler({ mode: 'full' }, createContext());
      expect(result.success).toBe(true);
      expect(result.meta?.minVisibilityTier).toBe(2);
    });

    it('does not add visibility hint on compact guide', async () => {
      await getReviewerGuideHandler({ mode: 'full', runId: 'rev-esc-run' }, createContext());
      const compact = await getReviewerGuideHandler({ mode: 'compact', runId: 'rev-esc-run' }, createContext());
      expect(compact.success).toBe(true);
      expect(compact.meta).toBeUndefined();
    });

    it('does not add visibility hint on failed guide load', async () => {
      rmSync(join(steeringDir, 'principles.md'));
      const result = await getReviewerGuideHandler({ mode: 'full' }, createContext());
      expect(result.success).toBe(false);
      expect(result.meta).toBeUndefined();
    });
  });
});
