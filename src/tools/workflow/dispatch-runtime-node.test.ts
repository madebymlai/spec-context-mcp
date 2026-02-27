import { mkdir, mkdtemp, rm, stat, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsManager } from '../../dashboard/settings-manager.js';
import { SPEC_WORKFLOW_HOME_ENV } from '../../core/workflow/global-dir.js';
import { createFactId, type SessionFact } from '../../core/session/index.js';
import type { ToolContext } from '../../workflow-types.js';

const originalEnv = process.env;
let workflowHomeDir: string;
let projectPath: string;
let context: ToolContext;

async function writeTasksFile(specName: string, taskId: string): Promise<void> {
  const specDir = join(projectPath, '.spec-context', 'specs', specName);
  await mkdir(specDir, { recursive: true });
  await writeFile(
    join(specDir, 'tasks.md'),
    `# Tasks

- [-] ${taskId}. Runtime initialization test task
  - _Requirements: 1_
  - _Prompt: Role: TypeScript Developer | Task: Validate dispatch runtime initialization_`,
    'utf8'
  );
}

describe('dispatch-runtime-node initialization recovery', () => {
  beforeEach(async () => {
    vi.resetModules();
    process.env = { ...originalEnv };
    workflowHomeDir = await mkdtemp(join(tmpdir(), 'dispatch-runtime-node-home-'));
    projectPath = await mkdtemp(join(tmpdir(), 'dispatch-runtime-node-project-'));
    process.env[SPEC_WORKFLOW_HOME_ENV] = workflowHomeDir;
    context = { projectPath, dashboardUrl: undefined };
  });

  afterEach(async () => {
    process.env = originalEnv;
    await Promise.all([
      rm(workflowHomeDir, { recursive: true, force: true }),
      rm(projectPath, { recursive: true, force: true }),
    ]);
  });

  it('returns a structured initialization error when providers are missing', async () => {
    const { dispatchRuntimeHandler } = await import('./dispatch-runtime-node.js');
    const manager = new SettingsManager();
    await manager.updateRuntimeSettings({
      implementer: null as any,
      reviewer: null as any,
    });
    await writeTasksFile('runtime-init-missing-provider', '1');

    const result = await dispatchRuntimeHandler(
      {
        action: 'init_run',
        runId: 'runtime-init-fails',
        specName: 'runtime-init-missing-provider',
        taskId: '1',
      },
      context
    );

    expect(result.success).toBe(false);
    expect(result.message).toContain('dispatch-runtime initialization failed');
    expect(result.message).toContain('set reviewer in dashboard settings');
    expect(result.data?.errorCode).toBe('dispatch_runtime_init_failed');
  });

  it('recovers after initial bootstrap failure once settings are fixed', async () => {
    const { dispatchRuntimeHandler } = await import('./dispatch-runtime-node.js');
    const manager = new SettingsManager();
    await manager.updateRuntimeSettings({
      implementer: null as any,
      reviewer: null as any,
    });
    await writeTasksFile('runtime-init-recovers', '1');

    const first = await dispatchRuntimeHandler(
      {
        action: 'init_run',
        runId: 'runtime-init-first-failure',
        specName: 'runtime-init-recovers',
        taskId: '1',
      },
      context
    );
    expect(first.success).toBe(false);
    expect(first.message).toContain('dispatch-runtime initialization failed');

    await manager.updateRuntimeSettings({
      implementer: 'codex',
      reviewer: 'codex',
    });

    const second = await dispatchRuntimeHandler(
      {
        action: 'init_run',
        runId: 'runtime-init-second-success',
        specName: 'runtime-init-recovers',
        taskId: '1',
      },
      context
    );
    expect(second.success).toBe(true);
    expect(second.message).toBe('Dispatch runtime initialized');
  });

  it('initializes SQLite persistence in project .spec-context on first init_run', async () => {
    const { dispatchRuntimeHandler } = await import('./dispatch-runtime-node.js');
    const manager = new SettingsManager();
    await manager.updateRuntimeSettings({
      implementer: 'codex',
      reviewer: 'codex',
    });
    await writeTasksFile('runtime-init-graph-store', '1');

    const result = await dispatchRuntimeHandler(
      {
        action: 'init_run',
        runId: 'runtime-init-graph-store',
        specName: 'runtime-init-graph-store',
        taskId: '1',
      },
      context
    );

    expect(result.success).toBe(true);
    const knowledgeGraphStat = await stat(join(projectPath, '.spec-context', 'knowledge-graph.db'));
    expect(knowledgeGraphStat.isFile()).toBe(true);
  });

  it('falls back to in-memory session store when SQLite initialization fails', async () => {
    const { dispatchRuntimeHandler } = await import('./dispatch-runtime-node.js');
    const manager = new SettingsManager();
    await manager.updateRuntimeSettings({
      implementer: 'codex',
      reviewer: 'codex',
    });
    await writeTasksFile('runtime-init-sqlite-fallback', '1');
    await mkdir(join(projectPath, '.spec-context', 'knowledge-graph.db'), { recursive: true });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await dispatchRuntimeHandler(
        {
          action: 'init_run',
          runId: 'runtime-init-sqlite-fallback',
          specName: 'runtime-init-sqlite-fallback',
          taskId: '1',
        },
        context
      );

      expect(result.success).toBe(true);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('falling back to InMemorySessionFactStore')
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('re-initializes session graph per spec and preserves spec isolation', async () => {
    const { LazySessionKnowledgeGraphRuntime } = await import('./dispatch-runtime-node.js');
    const runtime = new LazySessionKnowledgeGraphRuntime();
    const fact: SessionFact = {
      id: createFactId('src/spec-a.ts', 'modified_by', 'task:1'),
      subject: 'src/spec-a.ts',
      relation: 'modified_by',
      object: 'task:1',
      tags: ['file_change'],
      validFrom: new Date('2026-02-27T00:00:00.000Z'),
      validTo: undefined,
      sourceTaskId: '1',
      sourceRole: 'implementer',
      confidence: 1,
    };

    runtime.initialize('runtime-spec-a', projectPath);
    runtime.runWithFactStore(store => store.add([fact]));
    expect(runtime.runWithFactStore(store => store.count())).toBe(1);

    runtime.initialize('runtime-spec-b', projectPath);
    expect(runtime.runWithFactStore(store => store.count())).toBe(0);

    runtime.initialize('runtime-spec-a', projectPath);
    expect(runtime.runWithFactStore(store => store.count())).toBe(1);
  });
});
