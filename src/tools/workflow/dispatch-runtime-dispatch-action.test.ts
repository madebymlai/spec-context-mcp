import { mkdir, readFile, rm, writeFile } from 'fs/promises';
import { resolve } from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RoutingTable } from '../../core/routing/index.js';
import {
  InMemorySessionFactStore,
  KeywordFactRetriever,
  RuleBasedFactExtractor,
} from '../../core/session/index.js';
import type { ToolContext } from '../../workflow-types.js';
import {
  createDispatchRuntimeHandler,
  DispatchRuntimeManager,
  type DispatchExecutorInput,
  type DispatchExecutorResult,
  type IDispatchExecutor,
} from './dispatch-runtime.js';
import { createNodeDispatchRuntimeManagerDependencies } from './dispatch-runtime-node.js';

const SPEC_NAME = 'dispatch-action-spec';
const SPEC_DIR = resolve(process.cwd(), '.spec-context', 'specs', SPEC_NAME);

const context: ToolContext = {
  projectPath: process.cwd(),
  dashboardUrl: undefined,
};

class StaticRunIdFactory {
  create(specName: string, taskId: string): string {
    return `${specName}:${taskId}:run`;
  }
}

class FileOutputResolver {
  async resolve(args: {
    outputContent: unknown;
    outputFilePath: unknown;
    projectPath: string;
  }): Promise<string> {
    const inlineOutput = String(args.outputContent || '').trim();
    if (inlineOutput) {
      return inlineOutput;
    }
    const outputFilePath = String(args.outputFilePath || '').trim();
    if (!outputFilePath) {
      return '';
    }
    const filePath = outputFilePath.startsWith('/')
      ? outputFilePath
      : resolve(args.projectPath, outputFilePath);
    return readFile(filePath, 'utf-8');
  }
}

class FakeDispatchExecutor implements IDispatchExecutor {
  constructor(
    private readonly handler: (input: DispatchExecutorInput) => Promise<DispatchExecutorResult>
  ) {}

  execute(input: DispatchExecutorInput): Promise<DispatchExecutorResult> {
    return this.handler(input);
  }
}

function createHandler(executor: IDispatchExecutor) {
  const factStore = new InMemorySessionFactStore();
  const runtimeManager = new DispatchRuntimeManager(
    new (class {
      classify() {
        return {
          level: 'complex' as const,
          confidence: 1,
          features: [],
          classifierId: 'test-classifier',
        };
      }
    })(),
    new RoutingTable({ simple: 'codex', complex: 'claude' }),
    factStore,
    new RuleBasedFactExtractor(),
    new KeywordFactRetriever(factStore),
    createNodeDispatchRuntimeManagerDependencies(),
  );

  return createDispatchRuntimeHandler({
    runtimeManager,
    runIdFactory: new StaticRunIdFactory(),
    outputResolver: new FileOutputResolver(),
    dispatchExecutor: executor,
    fileContentCacheTelemetry: () => ({}),
  });
}

describe('dispatch-runtime dispatch_and_ingest', () => {
  beforeAll(async () => {
    process.env.SPEC_CONTEXT_IMPLEMENTER = 'claude';
    process.env.SPEC_CONTEXT_REVIEWER = 'codex';
    await mkdir(SPEC_DIR, { recursive: true });
    await writeFile(
      resolve(SPEC_DIR, 'tasks.md'),
      `# Tasks

- [-] 1. Dispatch action fixture
  - _Requirements: 1_
  - _Prompt: Role: TypeScript Developer | Task: Implement dispatch fixture`,
      'utf8'
    );
  });

  afterAll(async () => {
    await rm(SPEC_DIR, { recursive: true, force: true });
  });

  it('runs compile + execute + ingest as one action', async () => {
    const handler = createHandler(new FakeDispatchExecutor(async input => {
      await writeFile(
        input.contractOutputPath,
        `BEGIN_DISPATCH_RESULT
{"task_id":"1","status":"completed","summary":"Done","files_changed":[],"tests":[],"follow_up_actions":[]}
END_DISPATCH_RESULT`,
        'utf8'
      );
      await writeFile(input.debugOutputPath, '', 'utf8');
      return {
        exitCode: 0,
        signal: null,
        durationMs: 1,
        contractOutputPath: input.contractOutputPath,
        debugOutputPath: input.debugOutputPath,
      };
    }));

    await handler(
      {
        action: 'init_run',
        runId: 'dispatch-action-success',
        specName: SPEC_NAME,
        taskId: '1',
      },
      context
    );

    const result = await handler(
      {
        action: 'dispatch_and_ingest',
        runId: 'dispatch-action-success',
        role: 'implementer',
        taskId: '1',
        maxOutputTokens: 1200,
      },
      context
    );

    expect(result.success).toBe(true);
    expect(result.data?.nextAction).toBe('dispatch_reviewer');
    expect(result.data?.result?.status).toBe('completed');
    expect(result.data?.execution?.exitCode).toBe(0);
  });

  it('fails loud when executor exits non-zero', async () => {
    const handler = createHandler(new FakeDispatchExecutor(async input => {
      await writeFile(input.contractOutputPath, '', 'utf8');
      await writeFile(input.debugOutputPath, 'failure', 'utf8');
      return {
        exitCode: 1,
        signal: null,
        durationMs: 1,
        contractOutputPath: input.contractOutputPath,
        debugOutputPath: input.debugOutputPath,
      };
    }));

    await handler(
      {
        action: 'init_run',
        runId: 'dispatch-action-failure',
        specName: SPEC_NAME,
        taskId: '1',
      },
      context
    );

    const result = await handler(
      {
        action: 'dispatch_and_ingest',
        runId: 'dispatch-action-failure',
        role: 'implementer',
        taskId: '1',
        maxOutputTokens: 1200,
      },
      context
    );

    expect(result.success).toBe(false);
    expect(result.data?.errorCode).toBe('dispatch_execution_failed');
  });

  it('fails loud when executor produces no contract output', async () => {
    const handler = createHandler(new FakeDispatchExecutor(async input => {
      await writeFile(input.contractOutputPath, '', 'utf8');
      await writeFile(input.debugOutputPath, '', 'utf8');
      return {
        exitCode: 0,
        signal: null,
        durationMs: 1,
        contractOutputPath: input.contractOutputPath,
        debugOutputPath: input.debugOutputPath,
      };
    }));

    await handler(
      {
        action: 'init_run',
        runId: 'dispatch-action-empty-output',
        specName: SPEC_NAME,
        taskId: '1',
      },
      context
    );

    const result = await handler(
      {
        action: 'dispatch_and_ingest',
        runId: 'dispatch-action-empty-output',
        role: 'implementer',
        taskId: '1',
        maxOutputTokens: 1200,
      },
      context
    );

    expect(result.success).toBe(false);
    expect(result.data?.errorCode).toBe('dispatch_output_missing');
  });
});
