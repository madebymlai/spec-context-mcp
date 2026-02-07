import OpenAI from 'openai';
import { BudgetGuard } from './budget-guard.js';
import { HistoryReducer } from './history-reducer.js';
import { InterceptionLayer } from './interception-layer.js';
import {
  OpenRouterChat,
  type OpenRouterChatConfig,
  type OpenRouterClient,
  type OpenRouterChatDependencies,
  type ProviderChatRequest,
} from './openrouter-chat.js';
import { PromptPrefixCompiler } from './prompt-prefix-compiler.js';
import { ProviderCacheAdapterFactory } from './provider-cache-adapter.js';
import { createRuntimeTelemetryMeter } from './telemetry-meter.js';

class OpenRouterSdkClient implements OpenRouterClient {
  private readonly client: OpenAI;

  constructor(apiKey: string) {
    this.client = new OpenAI({
      apiKey,
      baseURL: 'https://openrouter.ai/api/v1',
    });
  }

  createChatCompletion(
    requestOptions: ProviderChatRequest,
    options: { timeout: number },
  ) {
    return this.client.chat.completions.create(requestOptions, options) as Promise<OpenAI.Chat.Completions.ChatCompletion>;
  }
}

export function createNodeOpenRouterChatDependencies(config: OpenRouterChatConfig): OpenRouterChatDependencies {
  const provider = config.provider ?? 'openrouter';
  return {
    client: new OpenRouterSdkClient(config.apiKey),
    interceptionLayer: new InterceptionLayer(),
    historyReducer: new HistoryReducer(),
    budgetGuard: new BudgetGuard(),
    promptPrefixCompiler: new PromptPrefixCompiler(),
    cacheAdapter: config.cacheAdapter ?? ProviderCacheAdapterFactory.create(provider),
    telemetryMeter: config.telemetryMeter ?? createRuntimeTelemetryMeter(),
  };
}

export function createOpenRouterChat(config: OpenRouterChatConfig): OpenRouterChat {
  return new OpenRouterChat(config, createNodeOpenRouterChatDependencies(config));
}
