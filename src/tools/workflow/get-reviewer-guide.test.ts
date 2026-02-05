import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getReviewerGuideHandler } from './get-reviewer-guide.js';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('get-reviewer-guide', () => {
  let testDir: string;
  let steeringDir: string;
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.SPEC_CONTEXT_DISCIPLINE;

    testDir = join(tmpdir(), `reviewer-guide-test-${Date.now()}`);
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

    it('includes steering docs', async () => {
      const result = await getReviewerGuideHandler({}, createContext());

      expect(result.data?.steering?.tech).toContain('TypeScript');
      expect(result.data?.steering?.principles).toContain('SOLID');
    });

    it('includes search guidance', async () => {
      const result = await getReviewerGuideHandler({}, createContext());

      expect(result.data?.searchGuidance).toContain('Search');
      expect(result.data?.searchGuidance).toContain('Duplicates');
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
});
