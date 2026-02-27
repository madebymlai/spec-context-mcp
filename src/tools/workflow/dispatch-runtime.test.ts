import { mkdir, rm, writeFile } from 'fs/promises';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { RoutingTable, type ITaskComplexityClassifier } from '../../core/routing/index.js';
import {
  InMemorySessionFactStore,
  KeywordFactRetriever,
  RuleBasedFactExtractor,
} from '../../core/session/index.js';
import { SettingsManager } from '../../dashboard/settings-manager.js';
import { SPEC_WORKFLOW_HOME_ENV } from '../../core/workflow/global-dir.js';

const SPEC_NAME = 'dispatch-task-progress-ledgers';
const SPEC_DIR = join(process.cwd(), '.spec-context', 'specs', SPEC_NAME);

const context = {
  projectPath: process.cwd(),
  dashboardUrl: undefined,
};

const originalEnv = process.env;
let workflowHomeDir: string;
let dispatchRuntimeHandler: (args: Record<string, unknown>, context: any) => Promise<any>;
let standardDispatchRuntimeHandler: (args: Record<string, unknown>, context: any) => Promise<any>;
let dispatchRuntimeToolDefinition: Tool;
let DispatchRuntimeManagerClass: typeof import('./dispatch-runtime.js').DispatchRuntimeManager;
let createNodeDispatchRuntimeManagerDependencies: typeof import('./dispatch-runtime-node.js').createNodeDispatchRuntimeManagerDependencies;
let createDispatchRuntimeHandler: typeof import('./dispatch-runtime.js').createDispatchRuntimeHandler;
let runtimeManager: import('./dispatch-runtime.js').DispatchRuntimeManager;
let dispatchOutputResolver: import('./dispatch-runtime.js').DispatchOutputResolver;

function isDispatchRoleValue(value: string): value is 'implementer' | 'reviewer' {
  return value === 'implementer' || value === 'reviewer';
}

function getErrorCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) {
    return null;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

function parseCompactionAutoArg(value: unknown): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) {
      return true;
    }
    if (['0', 'false', 'no', 'off'].includes(normalized)) {
      return false;
    }
  }
  throw new Error('compile_prompt compactionAuto must be boolean-like');
}

describe('dispatch-runtime tool', () => {
  beforeAll(async () => {
    process.env = { ...originalEnv };
    workflowHomeDir = join(tmpdir(), `dispatch-runtime-test-wfhome-${Date.now()}-${Math.random()}`);
    await fs.mkdir(workflowHomeDir, { recursive: true });
    process.env[SPEC_WORKFLOW_HOME_ENV] = workflowHomeDir;

    const manager = new SettingsManager();
    await manager.updateRuntimeSettings({ implementer: 'claude', reviewer: 'codex' });

    const [coreModule, nodeModule] = await Promise.all([
      import('./dispatch-runtime.js'),
      import('./dispatch-runtime-node.js'),
    ]);
    createDispatchRuntimeHandler = coreModule.createDispatchRuntimeHandler;
    dispatchRuntimeToolDefinition = coreModule.dispatchRuntimeTool;
    DispatchRuntimeManagerClass = coreModule.DispatchRuntimeManager;
    createNodeDispatchRuntimeManagerDependencies = nodeModule.createNodeDispatchRuntimeManagerDependencies;
    const dependencies = await nodeModule.createNodeDispatchRuntimeHandlerDependencies();
    runtimeManager = dependencies.runtimeManager;
    dispatchOutputResolver = dependencies.outputResolver;
    standardDispatchRuntimeHandler = createDispatchRuntimeHandler(dependencies);
    dispatchRuntimeHandler = async (args, toolContext) => {
      const action = String(args.action || '').trim();

      if (action === 'compile_prompt') {
        const runId = String(args.runId || '').trim();
        const taskId = String(args.taskId || '').trim();
        const roleRaw = String(args.role || '').trim();
        if (!runId || !taskId || !isDispatchRoleValue(roleRaw)) {
          return {
            success: false,
            message: 'compile_prompt requires runId, role (implementer|reviewer), and taskId',
          };
        }

        const maxOutputTokens = Number(args.maxOutputTokens ?? 1200);
        if (!Number.isFinite(maxOutputTokens) || maxOutputTokens <= 0) {
          return {
            success: false,
            message: 'compile_prompt requires positive maxOutputTokens',
          };
        }

        try {
          const compiled = await runtimeManager.compilePrompt({
            runId,
            role: roleRaw,
            taskId,
            projectPath: toolContext.projectPath,
            taskPrompt: typeof args.taskPrompt === 'string' ? args.taskPrompt.trim() : undefined,
            maxOutputTokens,
            compactionContext: Array.isArray(args.compactionContext)
              ? args.compactionContext
                .filter(item => typeof item === 'string')
                .map(item => item.trim())
                .filter(Boolean)
              : undefined,
            compactionPromptOverride: typeof args.compactionPromptOverride === 'string'
              ? args.compactionPromptOverride.trim()
              : undefined,
            compactionAuto: parseCompactionAutoArg(args.compactionAuto),
          });
          return {
            success: true,
            message: 'Dispatch prompt compiled',
            data: compiled,
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return {
            success: false,
            message,
            data: {
              runId,
              role: roleRaw,
              taskId,
              errorCode: getErrorCode(error),
            },
          };
        }
      }

      if (action === 'ingest_output') {
        const runId = String(args.runId || '').trim();
        const taskId = String(args.taskId || '').trim();
        const roleRaw = String(args.role || '').trim();
        if (!runId || !taskId || !isDispatchRoleValue(roleRaw)) {
          return {
            success: false,
            message: 'ingest_output requires runId, role (implementer|reviewer), and taskId',
          };
        }

        const maxOutputTokens = args.maxOutputTokens === undefined
          ? undefined
          : Number(args.maxOutputTokens);
        if (maxOutputTokens !== undefined && (!Number.isFinite(maxOutputTokens) || maxOutputTokens <= 0)) {
          return {
            success: false,
            message: 'ingest_output requires positive maxOutputTokens when provided',
          };
        }

        const outputContent = await dispatchOutputResolver.resolve({
          outputContent: args.outputContent,
          outputFilePath: args.outputFilePath,
          projectPath: toolContext.projectPath,
        });

        try {
          const ingested = await runtimeManager.ingestOutput({
            runId,
            role: roleRaw,
            taskId,
            outputContent,
            maxOutputTokens,
          });
          return {
            success: true,
            message: 'Dispatch output ingested',
            data: ingested,
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const errorCode = getErrorCode(error);
          if (
            errorCode === 'marker_missing'
            || errorCode === 'json_parse_failed'
            || errorCode === 'schema_invalid'
          ) {
            const snapshot = await runtimeManager.recordTerminalContractFailure({
              runId,
              role: roleRaw,
              taskId,
              errorCode,
              errorMessage: message,
            });
            return {
              success: false,
              message,
              data: {
                runId,
                role: roleRaw,
                taskId,
                errorCode,
                nextAction: 'halt_schema_invalid_terminal',
                snapshot,
              },
            };
          }
          return {
            success: false,
            message,
            data: {
              runId,
              role: roleRaw,
              taskId,
              errorCode,
            },
          };
        }
      }

      return standardDispatchRuntimeHandler(args, toolContext);
    };

    await mkdir(SPEC_DIR, { recursive: true });
    await writeFile(
      join(SPEC_DIR, 'tasks.md'),
      `# Tasks

- [-] 1. Root compile task
  - _Requirements: 1_
  - _Prompt: Role: TypeScript Developer | Task: Implement root compile task_
- [ ] 1.1 Init task fixture
  - _Requirements: 1_
  - _Prompt: Role: TypeScript Developer | Task: Implement task 1.1_
- [ ] 2.1 Implementer fixture
  - _Requirements: 1_
  - _Prompt: Role: TypeScript Developer | Task: Implement task 2.1_
- [ ] 2.9 Stalled fixture
  - _Requirements: 1_
  - _Prompt: Role: TypeScript Developer | Task: Implement task 2.9_
- [ ] 3.1 Reviewer fixture
  - _Requirements: 1_
  - _Prompt: Role: TypeScript Developer | Task: Implement task 3.1_
- [ ] 4.1 Snapshot fixture
  - _Requirements: 1_
  - _Prompt: Role: TypeScript Developer | Task: Implement task 4.1_
- [ ] 5.1 Terminal fixture
  - _Requirements: 1_
  - _Prompt: Role: TypeScript Developer | Task: Implement task 5.1_
- [ ] 6.1 Provider gate fixture
  - _Requirements: 1_
  - _Prompt: Role: TypeScript Developer | Task: Implement task 6.1_
- [ ] 8.1 Simple routing fixture
  - _Requirements: 1_
  - _Prompt: Role: TypeScript Developer | Task: Fix typo in README.md_
- [ ] 9.1 Classifier fallback fixture
  - _Requirements: 1_
  - _Prompt: Role: TypeScript Developer | Task: Implement task 9.1_
- [ ] 10.1 Missing prompt fixture
  - _Requirements: 1_
`,
      'utf8'
    );
  });

  afterAll(async () => {
    await rm(SPEC_DIR, { recursive: true, force: true });
    process.env = originalEnv;
    await fs.rm(workflowHomeDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    const manager = new SettingsManager();
    await manager.updateRuntimeSettings({
      implementer: 'claude',
      reviewer: 'codex',
      implementerModelSimple: null as any,
      implementerModelComplex: null as any,
      reviewerModelSimple: null as any,
      reviewerModelComplex: null as any,
    });
  });

  afterEach(async () => {
  });

  it('returns typed error when init_run cannot find tasks.md', async () => {
    const result = await dispatchRuntimeHandler(
      {
        action: 'init_run',
        runId: 'test-run-missing-tasks',
        specName: 'spec-that-does-not-exist',
        taskId: '1',
      },
      context
    );

    expect(result.success).toBe(false);
    expect(result.data?.errorCode).toBe('progress_ledger_missing_tasks');
  });

  it('rejects removed split actions at parser boundary', async () => {
    const compileResult = await standardDispatchRuntimeHandler(
      {
        action: 'compile_prompt',
        runId: 'prod-mode-compile',
        role: 'implementer',
        taskId: '1.1',
        maxOutputTokens: 400,
      },
      context
    );
    const ingestResult = await standardDispatchRuntimeHandler(
      {
        action: 'ingest_output',
        runId: 'prod-mode-ingest',
        role: 'implementer',
        taskId: '1.1',
        outputContent: 'BEGIN_DISPATCH_RESULT\\n{}\\nEND_DISPATCH_RESULT',
      },
      context
    );

    expect(compileResult.success).toBe(false);
    expect(String(compileResult.message)).toContain('action must be one of');
    expect(ingestResult.success).toBe(false);
    expect(String(ingestResult.message)).toContain('action must be one of');
  });

  it('tool schema includes resume_run and documents interrupted-session resumption', () => {
    const inputSchema = dispatchRuntimeToolDefinition.inputSchema as {
      properties?: { action?: { enum?: string[] } };
    };
    const actionEnum = inputSchema.properties?.action?.enum;

    expect(actionEnum).toContain('resume_run');
    expect(String(dispatchRuntimeToolDefinition.description)).toContain('resume interrupted sessions');
  });

  it('rejects compile_prompt when run is not initialized', async () => {
    const result = await dispatchRuntimeHandler(
      {
        action: 'compile_prompt',
        runId: 'missing-run-compile',
        role: 'implementer',
        taskId: '9.1',
        taskPrompt: 'Implement missing run check',
        maxOutputTokens: 400,
      },
      context
    );

    expect(result.success).toBe(false);
    expect(result.message).toContain('run_not_initialized');
    expect(result.data?.errorCode).toBe('run_not_initialized');
  });

  it('rejects ingest_output when run is not initialized', async () => {
    const result = await dispatchRuntimeHandler(
      {
        action: 'ingest_output',
        runId: 'missing-run-ingest',
        role: 'implementer',
        taskId: '9.2',
        outputContent: `BEGIN_DISPATCH_RESULT
{"task_id":"9.2","status":"completed","summary":"Done","files_changed":[],"tests":[{"command":"npm test --run","passed":true}],"follow_up_actions":[]}
END_DISPATCH_RESULT`,
      },
      context
    );

    expect(result.success).toBe(false);
    expect(result.message).toContain('run_not_initialized');
    expect(result.data?.errorCode).toBe('run_not_initialized');
  });

  it('rejects compile_prompt when taskId does not match initialized run task', async () => {
    await dispatchRuntimeHandler(
      {
        action: 'init_run',
        runId: 'test-run-mismatch-compile',
        specName: SPEC_NAME,
        taskId: '10.1',
      },
      context
    );

    const result = await dispatchRuntimeHandler(
      {
        action: 'compile_prompt',
        runId: 'test-run-mismatch-compile',
        role: 'implementer',
        taskId: '10.2',
        taskPrompt: 'Wrong task id prompt',
        maxOutputTokens: 400,
      },
      context
    );

    expect(result.success).toBe(false);
    expect(result.message).toContain('run_task_mismatch');
    expect(result.data?.errorCode).toBe('run_task_mismatch');
  });

  it('fails fast when compile_prompt relies on ledger and current task has no _Prompt', async () => {
    await dispatchRuntimeHandler(
      {
        action: 'init_run',
        runId: 'test-run-missing-ledger-prompt',
        specName: SPEC_NAME,
        taskId: '10.1',
      },
      context
    );

    const result = await dispatchRuntimeHandler(
      {
        action: 'compile_prompt',
        runId: 'test-run-missing-ledger-prompt',
        role: 'implementer',
        taskId: '10.1',
        maxOutputTokens: 400,
      },
      context
    );

    expect(result.success).toBe(false);
    expect(result.data?.errorCode).toBe('progress_ledger_incomplete');
    expect(result.message).toContain('missing_task_prompt');
  });

  it('dry run: compile_prompt loads _Prompt from ledger when taskPrompt is omitted', async () => {
    await dispatchRuntimeHandler(
      {
        action: 'init_run',
        runId: 'test-run-ledger-prompt-load',
        specName: SPEC_NAME,
        taskId: '1.1',
      },
      context
    );

    const result = await dispatchRuntimeHandler(
      {
        action: 'compile_prompt',
        runId: 'test-run-ledger-prompt-load',
        role: 'implementer',
        taskId: '1.1',
        maxOutputTokens: 400,
      },
      context
    );

    expect(result.success).toBe(true);
    expect(String(result.data?.prompt)).toContain('Task 1.1: Init task fixture');
    expect(String(result.data?.prompt)).toContain('Role: TypeScript Developer | Task: Implement task 1.1');
  });

  it('rejects ingest_output when taskId does not match initialized run task', async () => {
    await dispatchRuntimeHandler(
      {
        action: 'init_run',
        runId: 'test-run-mismatch-ingest',
        specName: SPEC_NAME,
        taskId: '11.1',
      },
      context
    );

    const result = await dispatchRuntimeHandler(
      {
        action: 'ingest_output',
        runId: 'test-run-mismatch-ingest',
        role: 'implementer',
        taskId: '11.2',
        outputContent: `BEGIN_DISPATCH_RESULT
{"task_id":"11.2","status":"completed","summary":"Done","files_changed":[],"tests":[{"command":"npm test --run","passed":true}],"follow_up_actions":[]}
END_DISPATCH_RESULT`,
      },
      context
    );

    expect(result.success).toBe(false);
    expect(result.message).toContain('run_task_mismatch');
    expect(result.data?.errorCode).toBe('run_task_mismatch');
  });

  it('initializes a run and returns snapshot state', async () => {
    const result = await dispatchRuntimeHandler(
      {
        action: 'init_run',
        runId: 'test-run-init',
        specName: SPEC_NAME,
        taskId: '1.1',
      },
      context
    );

    expect(result.success).toBe(true);
    expect(result.data?.runId).toBe('test-run-init');
    expect(result.data?.snapshot?.goal).toContain('dispatch_task');
    expect(result.data?.classification_level).toBeTypeOf('string');
    expect(result.data?.selected_provider).toBeTypeOf('string');
    const facts = (result.data?.snapshot?.facts ?? []) as Array<{ k: string; v: string }>;
    expect(facts.find(fact => fact.k === 'dispatch_cli')?.v).toBeTypeOf('string');
  });

  it('classifies simple tasks and selects the mapped provider during init_run', async () => {
    const manager = new SettingsManager();
    await manager.updateRuntimeSettings({ implementerModelSimple: 'sonnet-4.5' });

    const result = await dispatchRuntimeHandler(
      {
        action: 'init_run',
        runId: 'test-run-init-simple-routing',
        specName: SPEC_NAME,
        taskId: '8.1',
      },
      context
    );

    expect(result.success).toBe(true);
    expect(result.data?.classification_level).toBe('simple');
    expect(result.data?.selected_provider).toBe('codex');
    const facts = (result.data?.snapshot?.facts ?? []) as Array<{ k: string; v: string }>;
    expect(facts.find(fact => fact.k === 'classification_level')?.v).toBe('simple');
    expect(facts.find(fact => fact.k === 'selected_provider')?.v).toBe('codex');
    expect(facts.find(fact => fact.k === 'dispatch_cli')?.v).toContain('--model sonnet-4.5');
    expect(facts.find(fact => fact.k === 'classification_features')?.v).toContain('keyword_match');
  });

  it('throws when classifier strategy throws', async () => {
    const classifier: ITaskComplexityClassifier = {
      classify: () => {
        throw new Error('classifier failure');
      },
    };
    const factStore = new InMemorySessionFactStore();
    const manager = new DispatchRuntimeManagerClass(
      classifier,
      new RoutingTable({
        simple: 'codex',
        complex: 'claude',
      }),
      factStore,
      new RuleBasedFactExtractor(),
      new KeywordFactRetriever(factStore),
      createNodeDispatchRuntimeManagerDependencies(),
    );

    await expect(
      manager.initRun(
        'test-run-classifier-fallback',
        SPEC_NAME,
        '9.1',
        context.projectPath
      )
    ).rejects.toThrow('classifier failure');
  });

  it('ingests implementer output using strict JSON contract', async () => {
    await dispatchRuntimeHandler(
      {
        action: 'init_run',
        runId: 'test-run-implementer',
        specName: SPEC_NAME,
        taskId: '2.1',
      },
      context
    );

    const result = await dispatchRuntimeHandler(
      {
        action: 'ingest_output',
        runId: 'test-run-implementer',
        role: 'implementer',
        taskId: '2.1',
        outputContent: `BEGIN_DISPATCH_RESULT
{"task_id":"2.1","status":"completed","summary":"Done","files_changed":["src/a.ts"],"tests":[{"command":"npm test --run","passed":true}],"follow_up_actions":[]}
END_DISPATCH_RESULT`,
        maxOutputTokens: 400,
      },
      context
    );

    expect(result.success).toBe(true);
    expect(result.data?.nextAction).toBe('dispatch_reviewer');
    expect(result.data?.result?.status).toBe('completed');
  });

  it('tracks stalled counters and resets after progress', async () => {
    const runId = 'test-run-stalled-counters';
    const taskId = '2.9';
    await dispatchRuntimeHandler(
      {
        action: 'init_run',
        runId,
        specName: SPEC_NAME,
        taskId,
      },
      context
    );

    const blockedOnce = await dispatchRuntimeHandler(
      {
        action: 'ingest_output',
        runId,
        role: 'implementer',
        taskId,
        outputContent: `BEGIN_DISPATCH_RESULT
{"task_id":"${taskId}","status":"blocked","summary":"Need dependency","files_changed":[],"tests":[{"command":"npm test --run","passed":false}],"follow_up_actions":["wait for dependency"]}
END_DISPATCH_RESULT`,
      },
      context
    );
    const blockedFacts = (blockedOnce.data?.snapshot?.facts ?? []) as Array<{ k: string; v: string }>;
    expect(blockedFacts.find(fact => fact.k === 'ledger.task.stalled_count')?.v).toBe('1');
    expect(blockedFacts.find(fact => fact.k === 'ledger.task.stalled_flagged')?.v).toBe('false');

    const blockedTwice = await dispatchRuntimeHandler(
      {
        action: 'ingest_output',
        runId,
        role: 'reviewer',
        taskId,
        outputContent: `BEGIN_DISPATCH_RESULT
{"task_id":"${taskId}","assessment":"blocked","strengths":[],"issues":[{"severity":"important","message":"Still blocked","fix":"Resolve dependency"}],"required_fixes":["Resolve dependency"]}
END_DISPATCH_RESULT`,
      },
      context
    );
    const blockedTwiceFacts = (blockedTwice.data?.snapshot?.facts ?? []) as Array<{ k: string; v: string }>;
    expect(blockedTwiceFacts.find(fact => fact.k === 'ledger.task.stalled_count')?.v).toBe('2');
    expect(blockedTwiceFacts.find(fact => fact.k === 'ledger.task.stalled_flagged')?.v).toBe('true');
    expect(blockedTwiceFacts.find(fact => fact.k === 'ledger.task.replan_hint')?.v).toContain('Stalled');

    const recovered = await dispatchRuntimeHandler(
      {
        action: 'ingest_output',
        runId,
        role: 'implementer',
        taskId,
        outputContent: `BEGIN_DISPATCH_RESULT
{"task_id":"${taskId}","status":"completed","summary":"Dependency fixed","files_changed":[],"tests":[{"command":"npm test --run","passed":true}],"follow_up_actions":[]}
END_DISPATCH_RESULT`,
      },
      context
    );
    const recoveredFacts = (recovered.data?.snapshot?.facts ?? []) as Array<{ k: string; v: string }>;
    expect(recoveredFacts.find(fact => fact.k === 'ledger.task.stalled_count')?.v).toBe('0');
    expect(recoveredFacts.find(fact => fact.k === 'ledger.task.stalled_flagged')?.v).toBe('false');
  });

  it('escalates when reviewer repeats identical needs_changes feedback', async () => {
    const runId = 'test-run-review-loop-escalation';
    const taskId = '3.1';
    const reviewerPayload = `BEGIN_DISPATCH_RESULT
{"task_id":"${taskId}","assessment":"needs_changes","strengths":[],"issues":[{"severity":"important","file":"src/tools/workflow/dispatch-runtime.ts","message":"Missing regression test","fix":"Add a regression test"}],"required_fixes":["Add a regression test"]}
END_DISPATCH_RESULT`;

    await dispatchRuntimeHandler(
      {
        action: 'init_run',
        runId,
        specName: SPEC_NAME,
        taskId,
      },
      context
    );

    const first = await dispatchRuntimeHandler(
      {
        action: 'ingest_output',
        runId,
        role: 'reviewer',
        taskId,
        outputContent: reviewerPayload,
      },
      context
    );
    expect(first.success).toBe(true);
    expect(first.data?.nextAction).toBe('dispatch_implementer_fixes');
    const firstFacts = (first.data?.snapshot?.facts ?? []) as Array<{ k: string; v: string }>;
    expect(firstFacts.find(fact => fact.k === 'ledger.task.review_loop_same_issue_count')?.v).toBe('1');
    expect(firstFacts.find(fact => fact.k === 'ledger.task.review_loop_flagged')?.v).toBe('false');

    const second = await dispatchRuntimeHandler(
      {
        action: 'ingest_output',
        runId,
        role: 'reviewer',
        taskId,
        outputContent: reviewerPayload,
      },
      context
    );
    expect(second.success).toBe(true);
    expect(second.data?.nextAction).toBe('halt_and_escalate');
    const secondFacts = (second.data?.snapshot?.facts ?? []) as Array<{ k: string; v: string }>;
    expect(secondFacts.find(fact => fact.k === 'ledger.task.review_loop_same_issue_count')?.v).toBe('2');
    expect(secondFacts.find(fact => fact.k === 'ledger.task.review_loop_flagged')?.v).toBe('true');
  });

  it('rejects invalid reviewer schema', async () => {
    await dispatchRuntimeHandler(
      {
        action: 'init_run',
        runId: 'test-run-reviewer-invalid',
        specName: SPEC_NAME,
        taskId: '3.1',
      },
      context
    );

    const result = await dispatchRuntimeHandler(
      {
        action: 'ingest_output',
        runId: 'test-run-reviewer-invalid',
        role: 'reviewer',
        taskId: '3.1',
        outputContent: `BEGIN_DISPATCH_RESULT
{"task_id":"3.1","assessment":"approved"}
END_DISPATCH_RESULT`,
      },
      context
    );

    expect(result.success).toBe(false);
    expect(result.data?.errorCode).toBe('schema_invalid');
    expect(result.data?.nextAction).toBe('halt_schema_invalid_terminal');
    expect(result.data?.snapshot?.status).toBe('failed');
  });

  it('treats schema-invalid output as terminal on first attempt', async () => {
    await dispatchRuntimeHandler(
      {
        action: 'init_run',
        runId: 'test-run-schema-terminal',
        specName: SPEC_NAME,
        taskId: '5.1',
      },
      context
    );

    const invalidPayload = `BEGIN_DISPATCH_RESULT
{"task_id":"5.1","assessment":"approved"}
END_DISPATCH_RESULT`;

    const first = await dispatchRuntimeHandler(
      {
        action: 'ingest_output',
        runId: 'test-run-schema-terminal',
        role: 'reviewer',
        taskId: '5.1',
        outputContent: invalidPayload,
      },
      context
    );
    const second = await dispatchRuntimeHandler(
      {
        action: 'ingest_output',
        runId: 'test-run-schema-terminal',
        role: 'reviewer',
        taskId: '5.1',
        outputContent: invalidPayload,
      },
      context
    );

    expect(first.success).toBe(false);
    expect(first.data?.errorCode).toBe('schema_invalid');
    expect(first.data?.nextAction).toBe('halt_schema_invalid_terminal');
    expect(second.success).toBe(false);
    expect(second.data?.errorCode).toBe('schema_invalid');
    expect(second.data?.nextAction).toBe('halt_schema_invalid_terminal');
  });

  it('fails loud when implementer provider command is not canonical', async () => {
    const manager = new SettingsManager();
    await manager.updateRuntimeSettings({ implementer: 'custom-provider --json' });

    const result = await dispatchRuntimeHandler(
      {
        action: 'init_run',
        runId: 'test-run-unsupported-provider',
        specName: SPEC_NAME,
        taskId: '6.1',
      },
      context
    );

    expect(result.success).toBe(false);
    expect(result.message).toContain('must reference a known provider');
  });

  it('accepts dispatch contract with preamble before begin marker', async () => {
    await dispatchRuntimeHandler(
      {
        action: 'init_run',
        runId: 'test-run-prose-preamble',
        specName: SPEC_NAME,
        taskId: '2.1',
      },
      context
    );

    const result = await dispatchRuntimeHandler(
      {
        action: 'ingest_output',
        runId: 'test-run-prose-preamble',
        role: 'implementer',
        taskId: '2.1',
        outputContent: `Some prose first
BEGIN_DISPATCH_RESULT
{"task_id":"2.1","status":"completed","summary":"Done","files_changed":[],"tests":[{"command":"npm test --run","passed":true}],"follow_up_actions":[]}
END_DISPATCH_RESULT`,
      },
      context
    );

    expect(result.success).toBe(true);
    expect(result.data?.result?.status).toBe('completed');
    expect(result.data?.nextAction).toBe('dispatch_reviewer');
  });

  it('accepts dispatch contract with epilogue after end marker', async () => {
    await dispatchRuntimeHandler(
      {
        action: 'init_run',
        runId: 'test-run-prose-epilogue',
        specName: SPEC_NAME,
        taskId: '2.1',
      },
      context
    );

    const result = await dispatchRuntimeHandler(
      {
        action: 'ingest_output',
        runId: 'test-run-prose-epilogue',
        role: 'implementer',
        taskId: '2.1',
        outputContent: `BEGIN_DISPATCH_RESULT
{"task_id":"2.1","status":"completed","summary":"Done","files_changed":[],"tests":[{"command":"npm test --run","passed":true}],"follow_up_actions":[]}
END_DISPATCH_RESULT
trailing prose`,
      },
      context
    );

    expect(result.success).toBe(true);
    expect(result.data?.result?.status).toBe('completed');
    expect(result.data?.nextAction).toBe('dispatch_reviewer');
  });

  it('accepts dispatch contract with both preamble and epilogue text', async () => {
    await dispatchRuntimeHandler(
      {
        action: 'init_run',
        runId: 'test-run-prose-both',
        specName: SPEC_NAME,
        taskId: '2.1',
      },
      context
    );

    const result = await dispatchRuntimeHandler(
      {
        action: 'ingest_output',
        runId: 'test-run-prose-both',
        role: 'implementer',
        taskId: '2.1',
        outputContent: `Some prose first
BEGIN_DISPATCH_RESULT
{"task_id":"2.1","status":"completed","summary":"Done","files_changed":[],"tests":[{"command":"npm test --run","passed":true}],"follow_up_actions":[]}
END_DISPATCH_RESULT
trailing prose`,
      },
      context
    );

    expect(result.success).toBe(true);
    expect(result.data?.result?.status).toBe('completed');
    expect(result.data?.nextAction).toBe('dispatch_reviewer');
  });

  it('fails with marker_missing when begin marker is missing', async () => {
    await dispatchRuntimeHandler(
      {
        action: 'init_run',
        runId: 'test-run-marker-missing',
        specName: SPEC_NAME,
        taskId: '2.1',
      },
      context
    );

    const result = await dispatchRuntimeHandler(
      {
        action: 'ingest_output',
        runId: 'test-run-marker-missing',
        role: 'implementer',
        taskId: '2.1',
        outputContent: `{"task_id":"2.1","status":"completed","summary":"Done","files_changed":[],"tests":[{"command":"npm test --run","passed":true}],"follow_up_actions":[]}
END_DISPATCH_RESULT`,
      },
      context
    );

    expect(result.success).toBe(false);
    expect(result.data?.errorCode).toBe('marker_missing');
  });

  it('fails with marker_missing when marker count is duplicated', async () => {
    await dispatchRuntimeHandler(
      {
        action: 'init_run',
        runId: 'test-run-marker-duplicate',
        specName: SPEC_NAME,
        taskId: '2.1',
      },
      context
    );

    const result = await dispatchRuntimeHandler(
      {
        action: 'ingest_output',
        runId: 'test-run-marker-duplicate',
        role: 'implementer',
        taskId: '2.1',
        outputContent: `BEGIN_DISPATCH_RESULT
BEGIN_DISPATCH_RESULT
{"task_id":"2.1","status":"completed","summary":"Done","files_changed":[],"tests":[{"command":"npm test --run","passed":true}],"follow_up_actions":[]}
END_DISPATCH_RESULT`,
      },
      context
    );

    expect(result.success).toBe(false);
    expect(result.data?.errorCode).toBe('marker_missing');
  });

  it('compiles dispatch prompt with stable hashes and delta packet', async () => {
    await dispatchRuntimeHandler(
      {
        action: 'init_run',
        runId: 'test-run-compile',
        specName: SPEC_NAME,
        taskId: '1',
      },
      context
    );

    const result = await dispatchRuntimeHandler(
      {
        action: 'compile_prompt',
        runId: 'test-run-compile',
        role: 'implementer',
        taskId: '1',
        taskPrompt: 'Implement parser changes',
        maxOutputTokens: 800,
      },
      context
    );

    expect(result.success).toBe(true);
    expect(result.data?.stablePrefixHash).toHaveLength(64);
    expect(result.data?.fullPromptHash).toHaveLength(64);
    expect(result.data?.maxOutputTokens).toBe(800);
    expect(result.data?.guideMode).toBe('full');
    expect(result.data?.guideCacheKey).toBe('implementer:test-run-compile');
    expect(result.data?.deltaPacket?.guide_mode).toBe('full');
    expect(result.data?.dispatchCommand?.command).toBeTypeOf('string');
    expect(Array.isArray(result.data?.dispatchCommand?.args)).toBe(true);
    expect(result.data?.dispatchCommand?.display).toBeTypeOf('string');
    expect(result.data?.contractOutputPath).toBeTypeOf('string');
    expect(result.data?.contractOutputPath).toContain('spec-context-dispatch-implementer-test-run-compile-1.contract.log');
    expect(result.data?.debugOutputPath).toBeTypeOf('string');
    expect(result.data?.debugOutputPath).toContain('spec-context-dispatch-implementer-test-run-compile-1.debug.log');
    const implementerPrompt = String(result.data?.prompt ?? '');
    expect(implementerPrompt).toContain('"follow_up_actions"');
    expect(implementerPrompt).toContain('"tests"');
    expect(implementerPrompt).toContain('no extras');

    const second = await dispatchRuntimeHandler(
      {
        action: 'compile_prompt',
        runId: 'test-run-compile',
        role: 'implementer',
        taskId: '1',
        taskPrompt: 'Implement parser changes again',
        maxOutputTokens: 800,
      },
      context
    );
    expect(second.success).toBe(true);
    expect(second.data?.guideMode).toBe('compact');
    expect(second.data?.deltaPacket?.guide_mode).toBe('compact');
  });

  it('returns role-specific dispatchCommand with complexity model flags', async () => {
    const manager = new SettingsManager();
    await manager.updateRuntimeSettings({ reviewerModelSimple: 'codex-5.3' });

    await dispatchRuntimeHandler(
      {
        action: 'init_run',
        runId: 'test-run-compile-reviewer-cli-tier',
        specName: SPEC_NAME,
        taskId: '8.1',
      },
      context
    );

    const compile = await dispatchRuntimeHandler(
      {
        action: 'compile_prompt',
        runId: 'test-run-compile-reviewer-cli-tier',
        role: 'reviewer',
        taskId: '8.1',
        taskPrompt: 'Review simple routing fixture',
        maxOutputTokens: 700,
      },
      context
    );

    expect(compile.success).toBe(true);
    expect(compile.data?.dispatchCommand?.command).toBe('codex');
    expect(compile.data?.dispatchCommand?.args).toEqual(expect.arrayContaining(['exec', '--sandbox', 'read-only']));
    expect(compile.data?.dispatchCommand?.args).toContain('codex-5.3');
    const reviewerPrompt = String(compile.data?.prompt ?? '');
    expect(reviewerPrompt).toContain('"required_fixes"');
    expect(reviewerPrompt).toContain('"issues"');
    expect(reviewerPrompt).toContain('"assessment"');
  });

  it('keeps stable prefix hash constant and preserves explicit task prompt override', async () => {
    const runId = 'test-run-stable-hash-dynamic-tail';
    const taskId = '1';
    await dispatchRuntimeHandler(
      {
        action: 'init_run',
        runId,
        specName: SPEC_NAME,
        taskId,
      },
      context
    );

    const firstPrompt = 'Implement parser changes';
    const first = await dispatchRuntimeHandler(
      {
        action: 'compile_prompt',
        runId,
        role: 'implementer',
        taskId,
        taskPrompt: firstPrompt,
        maxOutputTokens: 800,
      },
      context
    );

    const secondPrompt = 'Implement parser follow-up';
    const second = await dispatchRuntimeHandler(
      {
        action: 'compile_prompt',
        runId,
        role: 'implementer',
        taskId,
        taskPrompt: secondPrompt,
        maxOutputTokens: 800,
      },
      context
    );

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(first.data?.stablePrefixHash).toBe(second.data?.stablePrefixHash);
    expect(first.data?.fullPromptHash).not.toBe(second.data?.fullPromptHash);

    const promptText = String(second.data?.prompt ?? '');
    expect((promptText.match(/Task prompt:/g) ?? []).length).toBe(1);
    expect(promptText.endsWith(`Task prompt:\n${secondPrompt}`)).toBe(true);
  });

  it('changes stable prefix hash when dispatch role changes', async () => {
    const runId = 'test-run-stable-hash-role-switch';
    const taskId = '1';
    await dispatchRuntimeHandler(
      {
        action: 'init_run',
        runId,
        specName: SPEC_NAME,
        taskId,
      },
      context
    );

    const implementer = await dispatchRuntimeHandler(
      {
        action: 'compile_prompt',
        runId,
        role: 'implementer',
        taskId,
        taskPrompt: 'Implement role-sensitive behavior',
        maxOutputTokens: 800,
      },
      context
    );
    const reviewer = await dispatchRuntimeHandler(
      {
        action: 'compile_prompt',
        runId,
        role: 'reviewer',
        taskId,
        taskPrompt: 'Review role-sensitive behavior',
        maxOutputTokens: 800,
      },
      context
    );

    expect(implementer.success).toBe(true);
    expect(reviewer.success).toBe(true);
    expect(implementer.data?.stablePrefixHash).not.toBe(reviewer.data?.stablePrefixHash);
  });

  it('compacts overflowed prompts when auto compaction is enabled', async () => {
    const runId = 'test-run-compaction-auto';
    const taskId = '1';
    await dispatchRuntimeHandler(
      {
        action: 'init_run',
        runId,
        specName: SPEC_NAME,
        taskId,
      },
      context
    );

    const oversizedPrompt = `Implement task ${taskId}\n${'MUST preserve branch-critical constraints and strict JSON output.\n'.repeat(1200)}`;
    const result = await dispatchRuntimeHandler(
      {
        action: 'compile_prompt',
        runId,
        role: 'implementer',
        taskId,
        taskPrompt: oversizedPrompt,
        maxOutputTokens: 800,
        compactionAuto: true,
        compactionContext: ['Preserve task_id', 'Preserve output contract markers'],
      },
      context
    );

    expect(result.success).toBe(true);
    expect(result.data?.compactionApplied).toBe(true);
    expect(result.data?.compactionStage).not.toBe('none');
    expect(Number(result.data?.promptTokensAfter)).toBeLessThanOrEqual(Number(result.data?.promptTokenBudget));
    expect(String(result.data?.prompt)).toContain(`Task ID: ${taskId}`);
    expect(String(result.data?.prompt)).toContain('BEGIN_DISPATCH_RESULT');

    const trace = result.data?.compactionTrace as Array<{ promptTokens: number }> | undefined;
    expect(Array.isArray(trace)).toBe(true);
    expect((trace?.length ?? 0)).toBeGreaterThan(1);
    for (let i = 1; i < (trace?.length ?? 0); i += 1) {
      expect((trace as Array<{ promptTokens: number }>)[i].promptTokens).toBeLessThanOrEqual(
        (trace as Array<{ promptTokens: number }>)[i - 1].promptTokens
      );
    }

    const snapshot = await dispatchRuntimeHandler(
      {
        action: 'get_snapshot',
        runId,
      },
      context
    );
    const facts = (snapshot.data?.snapshot?.facts ?? []) as Array<{ k: string; v: string }>;
    expect(facts.find(fact => fact.k === 'dispatch_compacted:implementer')?.v).toBe('true');
    expect(facts.find(fact => fact.k === 'dispatch_compaction_stage:implementer')?.v).toBeTruthy();
  });

  it('returns terminal overflow error when auto compaction is disabled', async () => {
    const runId = 'test-run-compaction-terminal';
    const taskId = '1';
    await dispatchRuntimeHandler(
      {
        action: 'init_run',
        runId,
        specName: SPEC_NAME,
        taskId,
      },
      context
    );

    const oversizedPrompt = `Implement task ${taskId}\n${'MUST preserve branch-critical constraints and strict JSON output.\n'.repeat(1200)}`;
    const result = await dispatchRuntimeHandler(
      {
        action: 'compile_prompt',
        runId,
        role: 'implementer',
        taskId,
        taskPrompt: oversizedPrompt,
        maxOutputTokens: 800,
        compactionAuto: false,
      },
      context
    );

    expect(result.success).toBe(false);
    expect(result.message).toContain('dispatch_prompt_overflow_terminal');
    expect(result.data?.errorCode).toBe('dispatch_prompt_overflow_terminal');
  });

  it('resume_run returns run_not_found when snapshot is missing', async () => {
    const result = await dispatchRuntimeHandler(
      {
        action: 'resume_run',
        specName: SPEC_NAME,
        taskId: '4.1',
      },
      context
    );

    expect(result.success).toBe(false);
    expect(result.data?.errorCode).toBe('run_not_found');
  });

  it('resume_run returns snapshot and resumption prompt for an initialized run', async () => {
    const specName = 'resume-runtime-happy-path';
    const taskId = '1';
    const runId = `${specName}:${taskId}`;
    const specDir = join(process.cwd(), '.spec-context', 'specs', specName);
    await mkdir(specDir, { recursive: true });
    await writeFile(
      join(specDir, 'tasks.md'),
      `# Tasks

- [-] ${taskId}. Resume runtime happy path
  - _Requirements: 1_
  - _Prompt: Role: TypeScript Developer | Task: Validate resume_run success_`,
      'utf8'
    );

    await dispatchRuntimeHandler(
      {
        action: 'init_run',
        specName,
        taskId,
      },
      context
    );

    const result = await dispatchRuntimeHandler(
      {
        action: 'resume_run',
        specName,
        taskId,
      },
      context
    );

    expect(result.success).toBe(true);
    expect(result.message).toBe('Run resumed from snapshot');
    expect(result.data?.runId).toBe(runId);
    expect(result.data?.snapshot?.run_id).toBe(runId);
    expect(result.data?.stale).toBe(false);
    expect(String(result.data?.resumptionPrompt)).toContain('Task progress:');

    await rm(specDir, { recursive: true, force: true });
  });

  it('resume_run marks stale when tasks.md changed since snapshot', async () => {
    const specName = 'resume-runtime-stale-path';
    const taskId = '1';
    const runId = `${specName}:${taskId}`;
    const specDir = join(process.cwd(), '.spec-context', 'specs', specName);
    const tasksPath = join(specDir, 'tasks.md');
    await mkdir(specDir, { recursive: true });
    await writeFile(
      tasksPath,
      `# Tasks

- [-] ${taskId}. Resume runtime stale path
  - _Requirements: 1_
  - _Prompt: Role: TypeScript Developer | Task: Validate resume_run stale detection_`,
      'utf8'
    );

    await dispatchRuntimeHandler(
      {
        action: 'init_run',
        specName,
        taskId,
      },
      context
    );

    await writeFile(
      tasksPath,
      `# Tasks

- [x] ${taskId}. Resume runtime stale path
  - _Requirements: 1_
  - _Prompt: Role: TypeScript Developer | Task: Validate resume_run stale detection_`,
      'utf8'
    );

    const result = await dispatchRuntimeHandler(
      {
        action: 'resume_run',
        specName,
        taskId,
      },
      context
    );

    expect(result.success).toBe(true);
    expect(result.data?.runId).toBe(runId);
    expect(result.data?.stale).toBe(true);

    await rm(specDir, { recursive: true, force: true });
  });

  it('returns snapshot for existing run', async () => {
    await dispatchRuntimeHandler(
      {
        action: 'init_run',
        runId: 'test-run-snapshot',
        specName: SPEC_NAME,
        taskId: '4.1',
      },
      context
    );

    const result = await dispatchRuntimeHandler(
      {
        action: 'get_snapshot',
        runId: 'test-run-snapshot',
      },
      context
    );

    expect(result.success).toBe(true);
    expect(result.data?.snapshot?.run_id).toBe('test-run-snapshot');
  });

  it('records graph retrieval telemetry fields in runtime snapshot', async () => {
    const classifier: ITaskComplexityClassifier = {
      classify: () => ({
        level: 'complex',
        confidence: 1,
        features: [],
        classifierId: 'test-classifier',
      }),
    };
    const fakeStore = {
      add: vi.fn(),
      invalidate: vi.fn(),
      getValid: vi.fn().mockReturnValue([]),
      getValidByTags: vi.fn().mockReturnValue([]),
      count: vi.fn().mockReturnValue(0),
      compact: vi.fn(),
      getStats: vi.fn().mockReturnValue({
        totalFacts: 21,
        validFacts: 8,
        entities: 5,
        persistenceAvailable: true,
      }),
    };
    const fakeRetriever = {
      retrieve: vi.fn().mockReturnValue([]),
      getLastRetrievalMetrics: vi.fn().mockReturnValue({
        factsRetrieved: 3,
        graphHopsUsed: 2,
        retrievalTimeMs: 4,
        graphNodes: 5,
        graphEdges: 8,
        persistenceAvailable: true,
      }),
    };
    const manager = new DispatchRuntimeManagerClass(
      classifier,
      new RoutingTable({
        simple: 'codex',
        complex: 'claude',
      }),
      fakeStore as any,
      new RuleBasedFactExtractor(),
      fakeRetriever as any,
      createNodeDispatchRuntimeManagerDependencies(),
    );
    const runId = 'test-run-telemetry-graph';

    await manager.initRun(runId, SPEC_NAME, '1.1', context.projectPath);
    await manager.compilePrompt({
      runId,
      role: 'implementer',
      taskId: '1.1',
      projectPath: context.projectPath,
      maxOutputTokens: 400,
      taskPrompt: 'Implement task 1.1',
    });

    const telemetry = manager.getTelemetrySnapshot();

    expect(telemetry.factsRetrieved).toBe(3);
    expect(telemetry.graphHopsUsed).toBe(2);
    expect(telemetry.retrievalTimeMs).toBe(4);
    expect(telemetry.graphNodes).toBe(5);
    expect(telemetry.graphEdges).toBe(8);
    expect(telemetry.persistenceAvailable).toBe(true);
  });
});

describe('pruneDeltaPacket', () => {
  let pruneDeltaPacket: (deltaPacket: Record<string, unknown>) => Record<string, unknown>;

  beforeAll(async () => {
    const mod = await import('./dispatch-runtime.js');
    pruneDeltaPacket = mod.pruneDeltaPacket;
  });

  it('preserves ledger_reviewer_issues through compaction', () => {
    const issues = [
      { severity: 'critical', message: 'Missing validation', file: 'src/api.ts' },
    ];
    const result = pruneDeltaPacket({
      task_id: 'test',
      ledger_reviewer_issues: issues,
    });
    expect(result.ledger_reviewer_issues).toEqual(issues);
  });

  it('preserves ledger_required_fixes through compaction', () => {
    const fixes = ['Add tests', 'Fix linting'];
    const result = pruneDeltaPacket({
      task_id: 'test',
      ledger_required_fixes: fixes,
    });
    expect(result.ledger_required_fixes).toEqual(fixes);
  });

  it('preserves ledger_failure_evidence through compaction without clipping', () => {
    const longEvidence = 'A'.repeat(500);
    const result = pruneDeltaPacket({
      task_id: 'test',
      ledger_failure_evidence: longEvidence,
    });
    expect(result.ledger_failure_evidence).toBe(longEvidence);
    expect((result.ledger_failure_evidence as string).length).toBe(500);
  });

  it('clips regular string fields to MAX_DELTA_VALUE_CHARS', () => {
    const longSummary = 'B'.repeat(500);
    const result = pruneDeltaPacket({
      task_id: 'test',
      ledger_summary: longSummary,
    });
    expect((result.ledger_summary as string).length).toBeLessThan(500);
  });
});

describe('extractAcceptanceCriteria', () => {
  let extractAcceptanceCriteria: (content: string) => string[];

  beforeAll(async () => {
    const mod = await import('./dispatch-runtime.js');
    extractAcceptanceCriteria = mod.extractAcceptanceCriteria;
  });

  it('extracts WHEN...SHALL lines from template format', () => {
    const content = `## Requirements
### Requirement 1
#### Acceptance Criteria
1. WHEN user logs in THEN system SHALL create session
2. IF token expired THEN system SHALL redirect to login`;
    const result = extractAcceptanceCriteria(content);
    expect(result).toEqual([
      '1. WHEN user logs in THEN system SHALL create session',
      '2. IF token expired THEN system SHALL redirect to login',
    ]);
  });

  it('extracts unnumbered criteria lines', () => {
    const content = 'WHEN event fires THEN system SHALL respond';
    expect(extractAcceptanceCriteria(content)).toEqual([
      'WHEN event fires THEN system SHALL respond',
    ]);
  });

  it('is case-insensitive', () => {
    const content = 'when something happens then system shall do something';
    expect(extractAcceptanceCriteria(content)).toHaveLength(1);
  });

  it('returns empty array for no matches', () => {
    const content = `## Requirements
Some description without acceptance criteria.
- bullet point`;
    expect(extractAcceptanceCriteria(content)).toEqual([]);
  });

  it('returns empty array for empty string', () => {
    expect(extractAcceptanceCriteria('')).toEqual([]);
  });

  it('ignores lines with WHEN but no SHALL', () => {
    const content = 'WHEN something happens THEN it does something';
    expect(extractAcceptanceCriteria(content)).toEqual([]);
  });
});

describe('filterComplianceFacts', () => {
  let filterComplianceFacts: (facts: Array<{ k: string; v: string; confidence: number }>) => {
    taskOutcomes: string[];
    filesChanged: string[];
  };

  beforeAll(async () => {
    const mod = await import('./dispatch-runtime.js');
    filterComplianceFacts = mod.filterComplianceFacts;
  });

  it('filters task outcomes and file changes from mixed facts', () => {
    const facts = [
      { k: 'task:1 completed_with', v: 'approved', confidence: 1 },
      { k: 'task:1 reviewed_as', v: 'approved', confidence: 1 },
      { k: 'src/foo.ts modified_by', v: 'task:1', confidence: 1 },
      { k: 'spec_name', v: 'test-spec', confidence: 1 },
      { k: 'classification_level', v: 'complex', confidence: 0.8 },
    ];
    const result = filterComplianceFacts(facts);
    expect(result.taskOutcomes).toEqual([
      'task:1 completed_with: approved',
      'task:1 reviewed_as: approved',
    ]);
    expect(result.filesChanged).toEqual([
      'src/foo.ts modified_by: task:1',
    ]);
  });

  it('returns empty arrays when no matching facts', () => {
    const facts = [
      { k: 'spec_name', v: 'test', confidence: 1 },
      { k: 'task_id', v: '1', confidence: 1 },
    ];
    const result = filterComplianceFacts(facts);
    expect(result.taskOutcomes).toEqual([]);
    expect(result.filesChanged).toEqual([]);
  });

  it('returns empty arrays for empty input', () => {
    const result = filterComplianceFacts([]);
    expect(result.taskOutcomes).toEqual([]);
    expect(result.filesChanged).toEqual([]);
  });
});
