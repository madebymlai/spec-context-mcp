import { randomUUID } from 'crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ToolResponse } from '../../workflow-types.js';

let handleToolCall: typeof import('../node-runtime.js').handleToolCall;

async function createTempProject(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'dispatch-runtime-int-'));
}

async function ensureSpecTasks(
  projectPath: string,
  specName: string,
  taskId: string
): Promise<void> {
  const specDir = join(projectPath, '.spec-context', 'specs', specName);
  await mkdir(specDir, { recursive: true });
  await writeFile(
    join(specDir, 'tasks.md'),
    `# Tasks\n\n- [-] ${taskId}. Integration task for ${specName}\n  - _Requirements: 1_\n  - _Prompt: Role: TypeScript Developer | Task: Implement ${taskId}_\n- [ ] ${taskId}.1 Follow-up`,
    'utf8'
  );
}

async function callDispatch(
  projectPath: string,
  args: Record<string, unknown>
): Promise<ToolResponse> {
  const result = await handleToolCall(
    'dispatch-runtime',
    args,
    { projectPath, dashboardUrl: undefined }
  );
  return result as ToolResponse;
}

function findFact(response: ToolResponse, key: string): string | undefined {
  const facts = response.data?.snapshot?.facts as Array<{ k: string; v: string }> | undefined;
  return facts?.find(fact => fact.k === key)?.v;
}

const ORIGINAL_IMPLEMENTER = process.env.SPEC_CONTEXT_IMPLEMENTER;
const ORIGINAL_REVIEWER = process.env.SPEC_CONTEXT_REVIEWER;

describe('dispatch-runtime integration (no mocks)', () => {
  beforeAll(async () => {
    process.env.SPEC_CONTEXT_IMPLEMENTER = process.env.SPEC_CONTEXT_IMPLEMENTER || 'claude';
    process.env.SPEC_CONTEXT_REVIEWER = process.env.SPEC_CONTEXT_REVIEWER || 'codex';
    const module = await import('../node-runtime.js');
    handleToolCall = module.handleToolCall;
  });

  afterAll(() => {
    if (ORIGINAL_IMPLEMENTER === undefined) {
      delete process.env.SPEC_CONTEXT_IMPLEMENTER;
    } else {
      process.env.SPEC_CONTEXT_IMPLEMENTER = ORIGINAL_IMPLEMENTER;
    }

    if (ORIGINAL_REVIEWER === undefined) {
      delete process.env.SPEC_CONTEXT_REVIEWER;
    } else {
      process.env.SPEC_CONTEXT_REVIEWER = ORIGINAL_REVIEWER;
    }
  });

  beforeEach(() => {
    process.env.SPEC_CONTEXT_IMPLEMENTER = 'claude';
    process.env.SPEC_CONTEXT_REVIEWER = 'codex';
  });

  afterEach(() => {
    process.env.SPEC_CONTEXT_IMPLEMENTER = 'claude';
    process.env.SPEC_CONTEXT_REVIEWER = 'codex';
  });

  it('rejects unknown actions with fail-fast error', async () => {
    const projectPath = await createTempProject();
    try {
      const result = await callDispatch(projectPath, {
        action: 'compile_prompt',
        runId: `int-${randomUUID()}`,
      });
      expect(result.success).toBe(false);
      expect(result.message).toContain('action must be one of');
      expect(result.message).toContain('dispatch_and_ingest');
    } finally {
      await rm(projectPath, { recursive: true, force: true });
    }
  });

  it('fails loud for unknown custom provider command', async () => {
    const projectPath = await createTempProject();
    try {
      process.env.SPEC_CONTEXT_IMPLEMENTER = 'custom-provider --json';
      const runId = `int-provider-${randomUUID()}`;
      const taskId = '3.2';
      await ensureSpecTasks(projectPath, 'feature-provider-gate', taskId);

      const init = await callDispatch(projectPath, {
        action: 'init_run',
        runId,
        specName: 'feature-provider-gate',
        taskId,
      });
      expect(init.success).toBe(false);
      expect(init.message).toContain('SPEC_CONTEXT_IMPLEMENTER must reference a known provider');
    } finally {
      await rm(projectPath, { recursive: true, force: true });
    }
  });

  it('init_run succeeds and populates snapshot with dispatch metadata', async () => {
    const projectPath = await createTempProject();
    try {
      const runId = `int-init-${randomUUID()}`;
      const taskId = '1.1';
      await ensureSpecTasks(projectPath, 'feature-init', taskId);

      const init = await callDispatch(projectPath, {
        action: 'init_run',
        runId,
        specName: 'feature-init',
        taskId,
      });
      expect(init.success).toBe(true);
      expect(findFact(init, 'ledger.progress.active_task_id')).toBe(taskId);
      expect(init.data?.selected_provider).toBeTypeOf('string');
      expect(init.data?.classification_level).toBeTypeOf('string');
      expect(findFact(init, 'dispatch_cli')).toBeTypeOf('string');
    } finally {
      await rm(projectPath, { recursive: true, force: true });
    }
  });

  it('get_snapshot and get_telemetry work after init_run', async () => {
    const projectPath = await createTempProject();
    try {
      const runId = `int-snap-${randomUUID()}`;
      const taskId = '2.1';
      await ensureSpecTasks(projectPath, 'feature-snapshot', taskId);

      await callDispatch(projectPath, {
        action: 'init_run',
        runId,
        specName: 'feature-snapshot',
        taskId,
      });

      const snapshot = await callDispatch(projectPath, {
        action: 'get_snapshot',
        runId,
      });
      expect(snapshot.success).toBe(true);
      expect(snapshot.data?.snapshot?.status).toBe('running');
      expect(findFact(snapshot, 'ledger.progress.active_task_id')).toBe(taskId);

      const telemetry = await callDispatch(projectPath, {
        action: 'get_telemetry',
        runId,
      });
      expect(telemetry.success).toBe(true);
      expect(telemetry.data?.dispatch_count).toBeDefined();
    } finally {
      await rm(projectPath, { recursive: true, force: true });
    }
  });

  it('dispatch_and_ingest rejects missing runId', async () => {
    const projectPath = await createTempProject();
    try {
      const result = await callDispatch(projectPath, {
        action: 'dispatch_and_ingest',
        role: 'implementer',
        taskId: '1.1',
      });
      expect(result.success).toBe(false);
      expect(result.message).toContain('requires runId');
    } finally {
      await rm(projectPath, { recursive: true, force: true });
    }
  });

  it('dispatch_and_ingest rejects missing role/taskId', async () => {
    const projectPath = await createTempProject();
    try {
      const result = await callDispatch(projectPath, {
        action: 'dispatch_and_ingest',
        runId: `int-${randomUUID()}`,
        maxOutputTokens: 500,
      });
      expect(result.success).toBe(false);
    } finally {
      await rm(projectPath, { recursive: true, force: true });
    }
  });

  it('dispatch_and_ingest rejects invalid maxOutputTokens', async () => {
    const projectPath = await createTempProject();
    try {
      const result = await callDispatch(projectPath, {
        action: 'dispatch_and_ingest',
        runId: `int-${randomUUID()}`,
        role: 'implementer',
        taskId: '1.1',
        maxOutputTokens: -5,
      });
      expect(result.success).toBe(false);
      expect(result.message).toContain('maxOutputTokens');
    } finally {
      await rm(projectPath, { recursive: true, force: true });
    }
  });
});
