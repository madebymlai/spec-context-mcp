import { promises as fs } from 'fs';
import { resolve } from 'path';
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
import type { RuntimeEventEnvelope, StateSnapshot } from '../../core/llm/index.js';
import { getSharedFileContentCacheTelemetry } from '../../core/cache/shared-file-content-cache.js';
import { HeuristicComplexityClassifier } from '../../core/routing/index.js';
import {
  GraphFactRetriever,
  GraphSessionFactStore,
  type GraphSessionFactStoreStats,
  type IFactRetriever,
  InMemorySessionFactStore,
  type ISessionFactStore,
  KeywordFactRetriever,
  RuleBasedFactExtractor,
  type FactQuery,
  type SessionFact,
  type SessionFactTag,
  SQLiteFactAdapter,
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

export class LazySessionKnowledgeGraphRuntime {
  private fallbackStore: ISessionFactStore = new InMemorySessionFactStore();
  private fallbackRetriever: IFactRetriever = new KeywordFactRetriever(this.fallbackStore);
  private activeStore: ISessionFactStore = this.fallbackStore;
  private activeRetriever: IFactRetriever = this.fallbackRetriever;
  private activeAdapter: SQLiteFactAdapter | null = null;
  private runtimeKey: string | null = null;

  runWithFactStore<T>(operation: (store: ISessionFactStore) => T): T {
    try {
      return operation(this.activeStore);
    } catch (error) {
      this.fallbackToInMemory(
        '[dispatch-runtime-node] Graph session store operation failed; falling back to InMemorySessionFactStore.',
        error,
      );
      return operation(this.activeStore);
    }
  }

  runWithFactRetriever<T>(operation: (retriever: IFactRetriever) => T): T {
    try {
      return operation(this.activeRetriever);
    } catch (error) {
      this.fallbackToInMemory(
        '[dispatch-runtime-node] Graph fact retrieval failed; falling back to KeywordFactRetriever.',
        error,
      );
      return operation(this.activeRetriever);
    }
  }

  getFactStoreStats(): GraphSessionFactStoreStats | null {
    const storeWithStats = this.activeStore as ISessionFactStore & {
      getStats?: () => GraphSessionFactStoreStats;
    };
    return storeWithStats.getStats?.() ?? null;
  }

  getLastRetrievalMetrics(): {
    factsRetrieved: number;
    graphHopsUsed: number;
    retrievalTimeMs: number;
    graphNodes: number;
    graphEdges: number;
    persistenceAvailable: boolean;
  } | null {
    const retrieverWithMetrics = this.activeRetriever as IFactRetriever & {
      getLastRetrievalMetrics?: () => {
        factsRetrieved: number;
        graphHopsUsed: number;
        retrievalTimeMs: number;
        graphNodes: number;
        graphEdges: number;
        persistenceAvailable: boolean;
      };
    };
    return retrieverWithMetrics.getLastRetrievalMetrics?.() ?? null;
  }

  initialize(specName: string, projectPath: string): void {
    const runtimeKey = `${resolve(projectPath)}:${specName}`;
    if (this.runtimeKey === runtimeKey && this.activeAdapter !== null) {
      return;
    }

    this.reset();
    this.runtimeKey = runtimeKey;
    const databasePath = resolve(projectPath, '.spec-context', 'knowledge-graph.db');
    const adapter = new SQLiteFactAdapter(databasePath);
    adapter.initialize();
    this.activeAdapter = adapter;

    if (!adapter.isPersistenceAvailable()) {
      this.fallbackToInMemory(
        `[dispatch-runtime-node] SQLite knowledge graph unavailable at "${databasePath}", falling back to InMemorySessionFactStore.`,
      );
      return;
    }

    try {
      const graphStore = new GraphSessionFactStore(adapter, specName);
      this.activeStore = graphStore;
      this.activeRetriever = new GraphFactRetriever(graphStore);
    } catch (error) {
      adapter.close();
      this.activeAdapter = null;
      this.fallbackToInMemory(
        '[dispatch-runtime-node] Graph session runtime initialization failed; falling back to InMemorySessionFactStore.',
        error,
      );
    }
  }

  private reset(): void {
    this.activeAdapter?.close();
    this.activeAdapter = null;
    this.fallbackStore = new InMemorySessionFactStore();
    this.fallbackRetriever = new KeywordFactRetriever(this.fallbackStore);
    this.activeStore = this.fallbackStore;
    this.activeRetriever = this.fallbackRetriever;
  }

  private fallbackToInMemory(message: string, error?: unknown): void {
    this.activeAdapter?.close();
    this.activeAdapter = null;
    this.activeStore = this.fallbackStore;
    this.activeRetriever = this.fallbackRetriever;
    if (error === undefined) {
      console.warn(message);
      return;
    }
    console.warn(message, error);
  }
}

class DelegatingSessionFactStore implements ISessionFactStore {
  constructor(private readonly runtime: LazySessionKnowledgeGraphRuntime) {}

  add(facts: SessionFact[]): void {
    this.runtime.runWithFactStore(store => store.add(facts));
  }

  invalidate(subject: string, relation: string): void {
    this.runtime.runWithFactStore(store => store.invalidate(subject, relation));
  }

  getValid(): SessionFact[] {
    return this.runtime.runWithFactStore(store => store.getValid());
  }

  getValidByTags(tags: SessionFactTag[]): SessionFact[] {
    return this.runtime.runWithFactStore(store => store.getValidByTags(tags));
  }

  count(): number {
    return this.runtime.runWithFactStore(store => store.count());
  }

  compact(maxFacts: number): void {
    this.runtime.runWithFactStore(store => store.compact(maxFacts));
  }

  getStats(): GraphSessionFactStoreStats | null {
    return this.runtime.getFactStoreStats();
  }
}

class DelegatingFactRetriever implements IFactRetriever {
  constructor(private readonly runtime: LazySessionKnowledgeGraphRuntime) {}

  retrieve(query: FactQuery): SessionFact[] {
    return this.runtime.runWithFactRetriever(retriever => retriever.retrieve(query));
  }

  getLastRetrievalMetrics(): {
    factsRetrieved: number;
    graphHopsUsed: number;
    retrievalTimeMs: number;
    graphNodes: number;
    graphEdges: number;
    persistenceAvailable: boolean;
  } | null {
    return this.runtime.getLastRetrievalMetrics();
  }
}

class NodeDispatchRuntimeManager extends DispatchRuntimeManager {
  constructor(
    classifier: HeuristicComplexityClassifier,
    factExtractor: RuleBasedFactExtractor,
    dependencies: DispatchRuntimeManagerDependencies,
    private readonly runtime: LazySessionKnowledgeGraphRuntime,
  ) {
    super(
      classifier,
      new DelegatingSessionFactStore(runtime),
      factExtractor,
      new DelegatingFactRetriever(runtime),
      dependencies,
    );
  }

  override async initRun(
    runId: string,
    specName: string,
    taskId: string,
    projectPath: string,
  ): Promise<StateSnapshot> {
    this.runtime.initialize(specName, projectPath);
    return super.initRun(runId, specName, taskId, projectPath);
  }
}

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

class DeterministicDispatchRunIdFactory implements DispatchRunIdFactory {
  create(specName: string, taskId: string): string {
    return `${specName}:${taskId}`;
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

export async function createNodeDispatchRuntimeHandlerDependencies(): Promise<DispatchRuntimeHandlerDependencies> {
  const sessionRuntime = new LazySessionKnowledgeGraphRuntime();
  const dispatchExecutor: IDispatchExecutor = new NodeDispatchExecutor();
  return {
    runtimeManager: new NodeDispatchRuntimeManager(
      new HeuristicComplexityClassifier(),
      new RuleBasedFactExtractor(),
      createNodeDispatchRuntimeManagerDependencies(),
      sessionRuntime,
    ),
    runIdFactory: new DeterministicDispatchRunIdFactory(),
    outputResolver: new NodeDispatchOutputResolver(),
    dispatchExecutor,
    fileContentCacheTelemetry: getSharedFileContentCacheTelemetry,
  };
}

let nodeDispatchRuntimeDependencies: DispatchRuntimeHandlerDependencies | null = null;
let runtimeHandler: ((args: Record<string, unknown>, context: ToolContext) => Promise<ToolResponse>) | null = null;
let runtimeHandlerPromise: Promise<(args: Record<string, unknown>, context: ToolContext) => Promise<ToolResponse>> | null = null;

async function getRuntimeHandler(): Promise<(args: Record<string, unknown>, context: ToolContext) => Promise<ToolResponse>> {
  if (runtimeHandler) {
    return runtimeHandler;
  }
  if (!runtimeHandlerPromise) {
    runtimeHandlerPromise = (async () => {
      try {
        nodeDispatchRuntimeDependencies = await createNodeDispatchRuntimeHandlerDependencies();
        runtimeHandler = createDispatchRuntimeHandler(nodeDispatchRuntimeDependencies);
        return runtimeHandler;
      } catch (error) {
        // Clear cached promise on bootstrap failure so a later retry can recover
        // after settings are fixed without restarting the process.
        nodeDispatchRuntimeDependencies = null;
        runtimeHandler = null;
        runtimeHandlerPromise = null;
        throw error;
      }
    })();
  }
  return runtimeHandlerPromise;
}

export async function dispatchRuntimeHandler(
  args: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolResponse> {
  try {
    const handler = await getRuntimeHandler();
    return handler(args, context);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      message: `dispatch-runtime initialization failed: ${message}`,
      data: {
        errorCode: 'dispatch_runtime_init_failed',
      },
    };
  }
}
