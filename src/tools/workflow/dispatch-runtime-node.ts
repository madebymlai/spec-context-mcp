import { promises as fs } from 'fs';
import { resolve } from 'path';
import { randomUUID } from 'crypto';
import {
  RuntimeEventStream,
  NodeRuntimeEventStorage,
  RuntimeSnapshotStore,
  SchemaRegistry,
  StateProjector,
  InMemoryEventBusAdapter,
  PromptTemplateRegistry,
  PromptPrefixCompiler,
} from '../../core/llm/index.js';
import type { RuntimeEventEnvelope } from '../../core/llm/index.js';
import { getSharedFileContentCacheTelemetry } from '../../core/cache/shared-file-content-cache.js';
import { HeuristicComplexityClassifier, RoutingTable } from '../../core/routing/index.js';
import {
  InMemorySessionFactStore,
  KeywordFactRetriever,
  RuleBasedFactExtractor,
} from '../../core/session/index.js';
import {
  createDispatchRuntimeHandler,
  DispatchRuntimeManager,
  type DispatchRunIdFactory,
  type IDispatchExecutor,
  type DispatchOutputResolver,
  type DispatchRuntimeManagerDependencies,
  type DispatchRuntimeHandlerDependencies,
  type DispatchRuntimePromptCompiler,
  type CompiledDispatchPrompt,
  resolveDispatchCompactionPolicyFromEnv,
  resolveDispatchReviewLoopThresholdFromEnv,
  resolveDispatchStalledThresholdFromEnv,
  DISPATCH_RESULT_MARKERS,
} from './dispatch-runtime.js';
import { NodeDispatchExecutor } from './dispatch-executor.js';
import type { ToolContext, ToolResponse } from '../../workflow-types.js';

const DEFAULT_TOKEN_CHARS_PER_TOKEN = 4;

function buildDispatchGuideInstruction(input: {
  role: 'implementer' | 'reviewer';
  guideMode: 'full' | 'compact';
  runId: string;
}): string {
  const guideToolName = input.role === 'implementer' ? 'get-implementer-guide' : 'get-reviewer-guide';
  if (input.guideMode === 'full') {
    return `Guide policy: first dispatch for this role in run ${input.runId}. Call ${guideToolName} with {"mode":"full","runId":"${input.runId}"} exactly once before coding/reviewing.`;
  }
  return `Guide policy: guide already loaded in this run. Do not reload full guide. Reuse cached rules and call ${guideToolName} with {"mode":"compact","runId":"${input.runId}"} if you need a reminder.`;
}

function buildDispatchDynamicTail(input: {
  runId: string;
  role: 'implementer' | 'reviewer';
  taskPrompt: string;
  taskId: string;
  maxOutputTokens: number;
  deltaPacket: Record<string, unknown>;
  guideMode: 'full' | 'compact';
  guideCacheKey: string;
  sessionContext?: string;
}): string {
  const sections = [
    `Task ID: ${input.taskId}`,
    `Max output tokens: ${input.maxOutputTokens}`,
    `Delta context: ${JSON.stringify(input.deltaPacket)}`,
    `Guide cache key: ${input.guideCacheKey}`,
    buildDispatchGuideInstruction({
      role: input.role,
      guideMode: input.guideMode,
      runId: input.runId,
    }),
  ];
  if (input.sessionContext && input.sessionContext.trim()) {
    sections.push(input.sessionContext.trim());
  }
  sections.push('Task prompt:', input.taskPrompt);
  return sections.join('\n');
}

function estimateTokensFromChars(value: string, charsPerToken = DEFAULT_TOKEN_CHARS_PER_TOKEN): number {
  return Math.ceil(value.length / Math.max(1, charsPerToken));
}

class DispatchPromptCompiler implements DispatchRuntimePromptCompiler {
  private readonly registry = new PromptTemplateRegistry();
  private readonly prefixCompiler = new PromptPrefixCompiler();
  private readonly version = 'v1';

  constructor() {
    this.registry.register({
      templateId: 'dispatch_implementer',
      version: this.version,
      segments: [
        {
          kind: 'system',
          stable: true,
          content: `You are an implementer agent.
Output MUST be exactly one strict dispatch contract block with no prose before or after:
${DISPATCH_RESULT_MARKERS.begin}
<json>
${DISPATCH_RESULT_MARKERS.end}

JSON contract (exact keys, no extras):
- task_id: string
- status: "completed" | "blocked" | "failed"
- summary: string
- files_changed: string[]
- tests: { command: string, passed: boolean, failures?: string[] }[]
- follow_up_actions: string[]

Rules:
- task_id must be a string (not a number)
- Include all required keys even when arrays are empty
- Do not include any keys outside the contract

Valid example:
${DISPATCH_RESULT_MARKERS.begin}
{"task_id":"1","status":"completed","summary":"Done","files_changed":[],"tests":[],"follow_up_actions":[]}
${DISPATCH_RESULT_MARKERS.end}`,
        },
      ],
    });

    this.registry.register({
      templateId: 'dispatch_reviewer',
      version: this.version,
      segments: [
        {
          kind: 'system',
          stable: true,
          content: `You are a reviewer agent.
Output MUST be exactly one strict dispatch contract block with no prose before or after:
${DISPATCH_RESULT_MARKERS.begin}
<json>
${DISPATCH_RESULT_MARKERS.end}

JSON contract (exact keys, no extras):
- task_id: string
- assessment: "approved" | "needs_changes" | "blocked"
- strengths: string[]
- issues: { severity: "critical" | "important" | "minor", file?: string, message: string, fix: string }[]
- required_fixes: string[]

Rules:
- task_id must be a string (not a number)
- Include all required keys even when arrays are empty
- Do not include any keys outside the contract

Valid example:
${DISPATCH_RESULT_MARKERS.begin}
{"task_id":"1","assessment":"approved","strengths":[],"issues":[],"required_fixes":[]}
${DISPATCH_RESULT_MARKERS.end}`,
        },
      ],
    });
  }

  compile(input: {
    runId: string;
    role: 'implementer' | 'reviewer';
    taskPrompt: string;
    taskId: string;
    maxOutputTokens: number;
    deltaPacket: Record<string, unknown>;
    guideMode: 'full' | 'compact';
    guideCacheKey: string;
    sessionContext?: string;
    tokenCharsPerToken?: number;
  }): CompiledDispatchPrompt {
    const templateId = input.role === 'implementer' ? 'dispatch_implementer' : 'dispatch_reviewer';
    const dynamicTail = buildDispatchDynamicTail(input);
    const compiled = this.registry.compile(templateId, this.version, dynamicTail);
    const prefixCompile = this.prefixCompiler.compile({
      model: `${input.role}-dispatch`,
      messages: [
        { role: 'system', content: compiled.stablePrefix },
        { role: 'user', content: dynamicTail },
      ],
      jsonMode: true,
      dynamicTailMessages: 1,
    });

    return {
      prompt: compiled.text,
      stablePrefixHash: prefixCompile.stablePrefixHash,
      fullPromptHash: prefixCompile.cacheKey,
      deltaPacket: input.deltaPacket,
      maxOutputTokens: input.maxOutputTokens,
      guideMode: input.guideMode,
      guideCacheKey: input.guideCacheKey,
      promptTokens: estimateTokensFromChars(compiled.text, input.tokenCharsPerToken ?? DEFAULT_TOKEN_CHARS_PER_TOKEN),
    };
  }
}

class UuidDispatchRunIdFactory implements DispatchRunIdFactory {
  create(specName: string, taskId: string): string {
    return `${specName}:${taskId}:${randomUUID()}`;
  }
}

class NodeDispatchOutputResolver implements DispatchOutputResolver {
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
    return fs.readFile(filePath, 'utf-8');
  }
}

export function createNodeDispatchRuntimeManagerDependencies(): DispatchRuntimeManagerDependencies {
  return {
    eventStream: new RuntimeEventStream({ storage: new NodeRuntimeEventStorage() }),
    snapshotStore: new RuntimeSnapshotStore(),
    schemaRegistry: new SchemaRegistry(),
    stateProjector: new StateProjector(),
    eventBus: new InMemoryEventBusAdapter<RuntimeEventEnvelope>(),
    promptCompiler: new DispatchPromptCompiler(),
    compactionPolicy: resolveDispatchCompactionPolicyFromEnv(),
    stalledThreshold: resolveDispatchStalledThresholdFromEnv(),
    reviewLoopThreshold: resolveDispatchReviewLoopThresholdFromEnv(),
  };
}

export function createNodeDispatchRuntimeHandlerDependencies(): DispatchRuntimeHandlerDependencies {
  const factStore = new InMemorySessionFactStore();
  const dispatchExecutor: IDispatchExecutor = new NodeDispatchExecutor();
  return {
    runtimeManager: new DispatchRuntimeManager(
      new HeuristicComplexityClassifier(),
      RoutingTable.fromEnvOrDefault(),
      factStore,
      new RuleBasedFactExtractor(),
      new KeywordFactRetriever(factStore),
      createNodeDispatchRuntimeManagerDependencies(),
    ),
    runIdFactory: new UuidDispatchRunIdFactory(),
    outputResolver: new NodeDispatchOutputResolver(),
    dispatchExecutor,
    fileContentCacheTelemetry: getSharedFileContentCacheTelemetry,
  };
}

let nodeDispatchRuntimeDependencies: DispatchRuntimeHandlerDependencies | null = null;
let runtimeHandler: ((args: Record<string, unknown>, context: ToolContext) => Promise<ToolResponse>) | null = null;

function getRuntimeHandler(): (args: Record<string, unknown>, context: ToolContext) => Promise<ToolResponse> {
  if (!runtimeHandler) {
    nodeDispatchRuntimeDependencies = createNodeDispatchRuntimeHandlerDependencies();
    runtimeHandler = createDispatchRuntimeHandler(nodeDispatchRuntimeDependencies);
  }
  return runtimeHandler;
}

export async function dispatchRuntimeHandler(
  args: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolResponse> {
  return getRuntimeHandler()(args, context);
}
