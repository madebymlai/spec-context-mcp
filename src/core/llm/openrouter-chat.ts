import OpenAI from 'openai';
import type { ChatProvider, ChatMessage, ChatResponse, ChatOptions } from './types.js';

export interface OpenRouterChatConfig {
    apiKey: string;
    defaultModel?: string;
    timeout?: number;
}

/**
 * OpenRouter-based chat provider using the OpenAI SDK.
 * Supports multiple models via OpenRouter's unified API.
 */
export class OpenRouterChat implements ChatProvider {
    private client: OpenAI;
    private defaultModel: string;
    private timeout: number;

    constructor(config: OpenRouterChatConfig) {
        this.client = new OpenAI({
            apiKey: config.apiKey,
            baseURL: 'https://openrouter.ai/api/v1',
        });
        this.defaultModel = config.defaultModel || 'deepseek/deepseek-chat';
        this.timeout = config.timeout || 60000;
    }

    async chat(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResponse> {
        const requestOptions: OpenAI.ChatCompletionCreateParams & { provider?: Record<string, unknown> } = {
            model: this.defaultModel,
            messages: messages.map(m => ({
                role: m.role,
                content: m.content,
            })),
            temperature: options?.temperature ?? 0.7,
            max_tokens: options?.maxTokens ?? 4096,
        };

        // Enable JSON mode if requested
        if (options?.jsonMode) {
            requestOptions.response_format = { type: 'json_object' };
        }

        // Pass provider-specific options (e.g., reasoning for DeepSeek)
        if (options?.providerOptions) {
            requestOptions.provider = {};
            if (options.providerOptions.reasoning !== undefined) {
                requestOptions.provider.reasoning = options.providerOptions.reasoning;
            }
        }

        const response = await this.client.chat.completions.create(requestOptions, {
            timeout: this.timeout,
        });

        const choice = response.choices[0];
        if (!choice || !choice.message?.content) {
            throw new Error('No response content from LLM');
        }

        return {
            content: choice.message.content,
            model: response.model,
            usage: response.usage ? {
                promptTokens: response.usage.prompt_tokens,
                completionTokens: response.usage.completion_tokens,
                totalTokens: response.usage.total_tokens,
            } : undefined,
        };
    }

    /**
     * Chat with a specific model (overrides default).
     */
    async chatWithModel(
        model: string,
        messages: ChatMessage[],
        options?: ChatOptions
    ): Promise<ChatResponse> {
        const originalModel = this.defaultModel;
        this.defaultModel = model;
        try {
            return await this.chat(messages, options);
        } finally {
            this.defaultModel = originalModel;
        }
    }
}
