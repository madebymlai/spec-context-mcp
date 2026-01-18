/**
 * Chat message for LLM conversation.
 */
export interface ChatMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}

/**
 * Chat completion response from LLM.
 */
export interface ChatResponse {
    content: string;
    model: string;
    usage?: {
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
    };
}

/**
 * Provider interface for LLM chat completions.
 */
export interface ChatProvider {
    /**
     * Send messages to the LLM and get a response.
     * @param messages - Array of chat messages
     * @param options - Optional configuration (temperature, max tokens, etc.)
     */
    chat(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResponse>;
}

/**
 * Options for chat completion requests.
 */
export interface ChatOptions {
    temperature?: number;
    maxTokens?: number;
    jsonMode?: boolean;
    /** Provider-specific options (e.g., reasoning for DeepSeek) */
    providerOptions?: {
        /** Enable reasoning mode for supported models (e.g., DeepSeek V3.2) */
        reasoning?: boolean;
    };
}
