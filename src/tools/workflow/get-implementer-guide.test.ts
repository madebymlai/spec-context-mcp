import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getImplementerGuideHandler } from './get-implementer-guide.js';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { TestFileContentCache } from './test-file-content-cache.js';

describe('get-implementer-guide', () => {
  let testDir: string;
  let steeringDir: string;
  let fileContentCache: TestFileContentCache;
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.SPEC_CONTEXT_DISCIPLINE;

    testDir = join(tmpdir(), `implementer-guide-test-${Date.now()}`);
    steeringDir = join(testDir, '.spec-context', 'steering');
    mkdirSync(steeringDir, { recursive: true });
    fileContentCache = new TestFileContentCache();
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

  describe('missing steering docs', () => {
    it('fails when tech.md is missing', async () => {
      writeFileSync(join(steeringDir, 'principles.md'), 'principles');

      const result = await getImplementerGuideHandler({}, createContext());

      expect(result.success).toBe(false);
      expect(result.message).toContain('tech.md');
    });

    it('fails when principles.md is missing', async () => {
      writeFileSync(join(steeringDir, 'tech.md'), 'tech');

      const result = await getImplementerGuideHandler({}, createContext());

      expect(result.success).toBe(false);
      expect(result.message).toContain('principles.md');
    });

    it('fails when both are missing', async () => {
      const result = await getImplementerGuideHandler({}, createContext());

      expect(result.success).toBe(false);
      expect(result.message).toContain('tech.md');
      expect(result.message).toContain('principles.md');
    });
  });

  describe('full mode', () => {
    beforeEach(() => {
      process.env.SPEC_CONTEXT_DISCIPLINE = 'full';
      createSteeringDocs();
    });

    it('returns success with guide', async () => {
      const result = await getImplementerGuideHandler({}, createContext());

      expect(result.success).toBe(true);
      expect(result.data?.disciplineMode).toBe('full');
      expect(result.meta?.minVisibilityTier).toBe(2);
    });

    it('includes TDD rules in full mode', async () => {
      const result = await getImplementerGuideHandler({}, createContext());

      expect(result.data?.guide).toContain('Test-Driven Development');
      expect(result.data?.guide).toContain('Red-Green-Refactor');
    });

    it('includes verification rules', async () => {
      const result = await getImplementerGuideHandler({}, createContext());

      expect(result.data?.guide).toContain('Verification Before Completion');
    });

    it('includes feedback handling', async () => {
      const result = await getImplementerGuideHandler({}, createContext());

      expect(result.data?.guide).toContain('Handling Code Review Feedback');
    });

    it('includes steering docs', async () => {
      const result = await getImplementerGuideHandler({}, createContext());

      expect(result.data?.steering?.tech).toContain('TypeScript');
      expect(result.data?.steering?.principles).toContain('SOLID');
    });

    it('includes search guidance', async () => {
      const result = await getImplementerGuideHandler({}, createContext());

      expect(result.data?.searchGuidance).toContain('Search');
    });

    it('supports compact mode after caching full guide for a run', async () => {
      const full = await getImplementerGuideHandler({ mode: 'full', runId: 'run-1' }, createContext());
      expect(full.success).toBe(true);
      expect(full.data?.guideMode).toBe('full');
      expect(full.meta?.minVisibilityTier).toBe(2);

      const compact = await getImplementerGuideHandler({ mode: 'compact', runId: 'run-1' }, createContext());
      expect(compact.success).toBe(true);
      expect(compact.data?.guideMode).toBe('compact');
      expect(compact.data?.guide).toContain('Implementer Compact Guide');
      expect(compact.data?.guide).toContain('strict contract block');
      expect(compact.meta).toBeUndefined();
    });

    it('invalidates compact cache when steering docs change', async () => {
      const context = createContext();
      await getImplementerGuideHandler({ mode: 'full', runId: 'run-steering-change' }, context);

      const compactBefore = await getImplementerGuideHandler({ mode: 'compact', runId: 'run-steering-change' }, context);
      expect(compactBefore.success).toBe(true);
      expect(compactBefore.data?.guideMode).toBe('compact');

      await new Promise(resolve => setTimeout(resolve, 5));
      writeFileSync(join(steeringDir, 'tech.md'), '# Tech Stack\nRust');

      const compactAfter = await getImplementerGuideHandler({ mode: 'compact', runId: 'run-steering-change' }, context);
      expect(compactAfter.success).toBe(true);
      expect(compactAfter.data?.guideMode).toBe('full');
      expect(compactAfter.data?.steering?.tech).toContain('Rust');
    });

    it('rejects compact mode without runId', async () => {
      const result = await getImplementerGuideHandler({ mode: 'compact' }, createContext());
      expect(result.success).toBe(false);
      expect(result.message).toContain('requires runId');
    });

    it('rejects compact mode when cache is missing', async () => {
      const result = await getImplementerGuideHandler({ mode: 'compact', runId: 'missing-run' }, createContext());
      expect(result.success).toBe(false);
      expect(result.message).toContain('Call get-implementer-guide with mode:"full" first');
    });
  });

  describe('standard mode', () => {
    beforeEach(() => {
      process.env.SPEC_CONTEXT_DISCIPLINE = 'standard';
      createSteeringDocs();
    });

    it('returns success with correct mode', async () => {
      const result = await getImplementerGuideHandler({}, createContext());

      expect(result.success).toBe(true);
      expect(result.data?.disciplineMode).toBe('standard');
    });

    it('does NOT include TDD rules', async () => {
      const result = await getImplementerGuideHandler({}, createContext());

      expect(result.data?.guide).not.toContain('Test-Driven Development');
    });

    it('includes verification rules', async () => {
      const result = await getImplementerGuideHandler({}, createContext());

      expect(result.data?.guide).toContain('Verification Before Completion');
    });

    it('includes feedback handling', async () => {
      const result = await getImplementerGuideHandler({}, createContext());

      expect(result.data?.guide).toContain('Handling Code Review Feedback');
    });
  });

  describe('minimal mode', () => {
    beforeEach(() => {
      process.env.SPEC_CONTEXT_DISCIPLINE = 'minimal';
      createSteeringDocs();
    });

    it('returns success with correct mode', async () => {
      const result = await getImplementerGuideHandler({}, createContext());

      expect(result.success).toBe(true);
      expect(result.data?.disciplineMode).toBe('minimal');
    });

    it('does NOT include TDD rules', async () => {
      const result = await getImplementerGuideHandler({}, createContext());

      expect(result.data?.guide).not.toContain('Test-Driven Development');
    });

    it('includes verification rules', async () => {
      const result = await getImplementerGuideHandler({}, createContext());

      expect(result.data?.guide).toContain('Verification Before Completion');
    });
  });

  describe('default mode', () => {
    beforeEach(() => {
      delete process.env.SPEC_CONTEXT_DISCIPLINE;
      createSteeringDocs();
    });

    it('defaults to full mode', async () => {
      const result = await getImplementerGuideHandler({}, createContext());

      expect(result.data?.disciplineMode).toBe('full');
      expect(result.data?.guide).toContain('Test-Driven Development');
    });
  });

  describe('visibility hints', () => {
    beforeEach(() => {
      process.env.SPEC_CONTEXT_DISCIPLINE = 'full';
      createSteeringDocs();
    });

    it('adds minVisibilityTier=2 hint on successful full guide', async () => {
      const result = await getImplementerGuideHandler({ mode: 'full' }, createContext());
      expect(result.success).toBe(true);
      expect(result.meta?.minVisibilityTier).toBe(2);
    });

    it('does not add visibility hint on compact guide', async () => {
      await getImplementerGuideHandler({ mode: 'full', runId: 'esc-run' }, createContext());
      const compact = await getImplementerGuideHandler({ mode: 'compact', runId: 'esc-run' }, createContext());
      expect(compact.success).toBe(true);
      expect(compact.meta).toBeUndefined();
    });

    it('does not add visibility hint on failed guide load', async () => {
      rmSync(join(steeringDir, 'tech.md'));
      const result = await getImplementerGuideHandler({ mode: 'full' }, createContext());
      expect(result.success).toBe(false);
      expect(result.meta).toBeUndefined();
    });
  });
});
