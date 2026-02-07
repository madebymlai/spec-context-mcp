import { mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileContentCache } from '../../core/cache/file-content-cache.js';
import { specStatusHandler } from './spec-status.js';

describe('spec-status cache integration', () => {
  const testDirs: string[] = [];

  async function createProject(specName: string): Promise<string> {
    const projectPath = join(
      tmpdir(),
      `spec-status-cache-${Date.now()}-${Math.random().toString(16).slice(2)}`
    );
    const specDir = join(projectPath, '.spec-context', 'specs', specName);
    await mkdir(specDir, { recursive: true });
    await writeFile(join(specDir, 'requirements.md'), '# Requirements\n\n- Req 1', 'utf8');
    await writeFile(
      join(specDir, 'tasks.md'),
      '# Tasks\n\n- [ ] 1. Build cache layer\n',
      'utf8'
    );
    testDirs.push(projectPath);
    return projectPath;
  }

  afterEach(async () => {
    await Promise.all(testDirs.splice(0).map(path => rm(path, { recursive: true, force: true })));
  });

  it('uses file-content cache namespace for repeated status checks', async () => {
    const specName = 'cache-hit-spec';
    const projectPath = await createProject(specName);
    const fileContentCache = new FileContentCache();
    const context = { projectPath, fileContentCache };

    const first = await specStatusHandler({ specName }, context);
    const second = await specStatusHandler({ specName }, context);

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(second.data?.taskProgress?.pending).toBe(1);
    expect(fileContentCache.getTelemetry().namespaces['spec-status']?.misses).toBeGreaterThan(0);
    expect(fileContentCache.getTelemetry().namespaces['spec-status']?.hits).toBeGreaterThan(0);
  });

  it('re-parses when tasks.md changes', async () => {
    const specName = 'cache-invalidation-spec';
    const projectPath = await createProject(specName);
    const fileContentCache = new FileContentCache();
    const context = { projectPath, fileContentCache };
    const tasksPath = join(projectPath, '.spec-context', 'specs', specName, 'tasks.md');

    const first = await specStatusHandler({ specName }, context);
    expect(first.success).toBe(true);
    expect(first.data?.taskProgress?.completed).toBe(0);
    expect(first.data?.taskProgress?.pending).toBe(1);

    await new Promise(resolve => setTimeout(resolve, 5));
    await writeFile(tasksPath, '# Tasks\n\n- [x] 1. Build cache layer\n', 'utf8');
    const second = await specStatusHandler({ specName }, context);

    expect(second.success).toBe(true);
    expect(second.data?.taskProgress?.completed).toBe(1);
    expect(second.data?.taskProgress?.pending).toBe(0);
  });

  it('re-parses when spec directory mtime changes', async () => {
    const specName = 'cache-directory-spec';
    const projectPath = await createProject(specName);
    const fileContentCache = new FileContentCache();
    const context = { projectPath, fileContentCache };
    const specDir = join(projectPath, '.spec-context', 'specs', specName);

    const first = await specStatusHandler({ specName }, context);
    expect(first.success).toBe(true);
    const designBefore = (first.data?.phases ?? []).find((phase: { name: string; status: string }) => phase.name === 'Design');
    expect(designBefore?.status).toBe('missing');

    await new Promise(resolve => setTimeout(resolve, 5));
    await writeFile(join(specDir, 'design.md'), '# Design\n\nCache details', 'utf8');
    const second = await specStatusHandler({ specName }, context);

    expect(second.success).toBe(true);
    const designAfter = (second.data?.phases ?? []).find((phase: { name: string; status: string }) => phase.name === 'Design');
    expect(designAfter?.status).toBe('created');
  });
});
