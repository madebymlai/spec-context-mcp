import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getImplementerGuideHandler } from './get-implementer-guide.js';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('get-implementer-guide', () => {
  let testDir: string;
  let steeringDir: string;
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.SPEC_CONTEXT_DISCIPLINE;

    testDir = join(tmpdir(), `implementer-guide-test-${Date.now()}`);
    steeringDir = join(testDir, '.spec-context', 'steering');
    mkdirSync(steeringDir, { recursive: true });
  });

  afterEach(() => {
    process.env = originalEnv;
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true });
    }
  });

  const createContext = () => ({
    projectPath: testDir,
    dashboardUrl: 'http://localhost:3000'
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

      const compact = await getImplementerGuideHandler({ mode: 'compact', runId: 'run-1' }, createContext());
      expect(compact.success).toBe(true);
      expect(compact.data?.guideMode).toBe('compact');
      expect(compact.data?.guide).toContain('Implementer Compact Guide');
      expect(compact.data?.guide).toContain('strict contract block');
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
});
