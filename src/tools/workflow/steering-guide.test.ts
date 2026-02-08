import { describe, it, expect } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { steeringGuideHandler } from './steering-guide.js';
import { TestFileContentCache } from './test-file-content-cache.js';

describe('steering-guide', () => {
  const createContext = () => ({
    projectPath: join(tmpdir(), 'test'),
    dashboardUrl: 'http://localhost:3000',
    fileContentCache: new TestFileContentCache(),
  });

  it('returns success with guide content', async () => {
    const result = await steeringGuideHandler({}, createContext());

    expect(result.success).toBe(true);
    expect(result.message).toContain('Steering workflow guide loaded');
    expect(result.data?.guide).toContain('Steering Workflow');
  });

  it('includes injected steering templates', async () => {
    const result = await steeringGuideHandler({}, createContext());
    const templates = result.data?.templates;

    expect(templates?.product?.content.length).toBeGreaterThan(0);
    expect(templates?.tech?.content.length).toBeGreaterThan(0);
    expect(templates?.structure?.content.length).toBeGreaterThan(0);
    expect(templates?.principles?.content.length).toBeGreaterThan(0);
    expect(templates?.principles?.path).toContain('principles-template.md');
  });
});
