import { describe, it, expect } from 'vitest';
import { getBrainstormGuideHandler } from './get-brainstorm-guide.js';
import { tmpdir } from 'os';
import { join } from 'path';

describe('get-brainstorm-guide', () => {
  const createContext = () => ({
    projectPath: join(tmpdir(), 'test'),
    dashboardUrl: 'http://localhost:3000'
  });

  it('returns success', async () => {
    const result = await getBrainstormGuideHandler({}, createContext());

    expect(result.success).toBe(true);
    expect(result.message).toContain('Brainstorm guide loaded');
  });

  it('includes brainstorming methodology', async () => {
    const result = await getBrainstormGuideHandler({}, createContext());

    expect(result.data?.guide).toContain('Brainstorming Guide');
    expect(result.data?.guide).toContain('Understanding the Idea');
    expect(result.data?.guide).toContain('Exploring Approaches');
  });

  it('includes question-driven exploration', async () => {
    const result = await getBrainstormGuideHandler({}, createContext());

    expect(result.data?.guide).toContain('One question at a time');
    expect(result.data?.guide).toContain('Ask questions one at a time');
  });

  it('includes multiple choice preference', async () => {
    const result = await getBrainstormGuideHandler({}, createContext());

    expect(result.data?.guide).toContain('Multiple choice');
    expect(result.data?.guide).toContain('Prefer multiple choice');
  });

  it('includes 2-3 options guidance', async () => {
    const result = await getBrainstormGuideHandler({}, createContext());

    expect(result.data?.guide).toContain('2-3');
    expect(result.data?.guide).toContain('Option A');
    expect(result.data?.guide).toContain('Option B');
  });

  it('includes when to proceed to spec', async () => {
    const result = await getBrainstormGuideHandler({}, createContext());

    expect(result.data?.guide).toContain('Proceed to Formal Spec');
    expect(result.data?.guide).toContain('Keep Brainstorming');
  });

  it('does NOT include steering docs', async () => {
    const result = await getBrainstormGuideHandler({}, createContext());

    expect(result.data?.steering).toBeUndefined();
  });

  it('does NOT include search guidance', async () => {
    const result = await getBrainstormGuideHandler({}, createContext());

    expect(result.data?.searchGuidance).toBeUndefined();
  });

  it('includes next steps', async () => {
    const result = await getBrainstormGuideHandler({}, createContext());

    expect(result.nextSteps).toBeDefined();
    expect(result.nextSteps?.length).toBeGreaterThan(0);
  });
});
