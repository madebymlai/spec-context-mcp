import type { ChatMessage, HistoryReducerOptions } from './types.js';

export interface HistoryReductionResult {
    messages: ChatMessage[];
    reduced: boolean;
    droppedCount: number;
    invariantStatus: 'ok' | 'fallback';
    maskedCount?: number;
    maskedChars?: number;
    reductionStage?: 'masking' | 'summarization' | 'fallback';
    beforeTokens?: number;
    afterTokens?: number;
    compressionRatio?: number;
    stageUsed?: 'none' | 'masking' | 'summarization' | 'fallback';
}

const DEFAULT_PRESERVE_RECENT = 4;
const DEFAULT_SUMMARY_MAX_CHARS = 1400;
const DEFAULT_MAX_OBSERVATION_CHARS = 80;
const DEFAULT_MIN_OBSERVATION_CHARS = 24;
const DEFAULT_OBSERVATION_DIGEST_CHARS = 48;
const DEFAULT_TOKEN_CHARS_PER_TOKEN = 4;

function contentLength(messages: ChatMessage[]): number {
    return messages.reduce((sum, message) => sum + message.content.length, 0);
}

function estimateTokensFromChars(chars: number, charsPerToken: number): number {
    return Math.ceil(chars / Math.max(1, charsPerToken));
}

function estimateTokens(messages: ChatMessage[], charsPerToken: number): number {
    return estimateTokensFromChars(contentLength(messages), charsPerToken);
}

function clipText(value: string, maxChars: number): string {
    if (maxChars <= 0) {
        return '';
    }
    if (value.length <= maxChars) {
        return value;
    }
    if (maxChars <= 3) {
        return value.slice(0, maxChars);
    }
    return `${value.slice(0, Math.max(0, maxChars - 3))}...`;
}

function normalizeInlineText(value: string): string {
    return value.replace(/\s+/g, ' ').trim();
}

function extractObservationDigest(content: string, maxChars: number): string {
    const normalized = normalizeInlineText(content);
    if (!normalized) {
        return 'empty';
    }

    const taskId = normalized.match(/"task_id"\s*:\s*"([^"]+)"/)?.[1];
    const status = normalized.match(/"status"\s*:\s*"([^"]+)"/)?.[1];
    const assessment = normalized.match(/"assessment"\s*:\s*"([^"]+)"/)?.[1];
    const command = normalized.match(/"command"\s*:\s*"([^"]+)"/)?.[1];
    const digestParts = [
        taskId ? `task_id=${taskId}` : null,
        status ? `status=${status}` : null,
        assessment ? `assessment=${assessment}` : null,
        command ? `cmd=${command}` : null,
    ].filter(Boolean) as string[];

    if (digestParts.length > 0) {
        return clipText(digestParts.join(' '), maxChars);
    }

    return clipText(normalized, maxChars);
}

function maskDispatchObservation(
    content: string,
    maxChars: number,
    digestChars: number
): { masked: string; maskedChars: number } {
    const beginMarker = 'BEGIN_DISPATCH_RESULT';
    const endMarker = 'END_DISPATCH_RESULT';

    const blocks: string[] = [];
    let outsideChars = 0;
    let cursor = 0;

    while (cursor < content.length) {
        const beginIndex = content.indexOf(beginMarker, cursor);
        if (beginIndex < 0) {
            outsideChars += content.length - cursor;
            break;
        }
        outsideChars += Math.max(0, beginIndex - cursor);
        const endIndex = content.indexOf(endMarker, beginIndex + beginMarker.length);
        if (endIndex < 0 || endIndex < beginIndex) {
            blocks.length = 0;
            break;
        }
        const blockEnd = endIndex + endMarker.length;
        blocks.push(content.slice(beginIndex, blockEnd));
        cursor = blockEnd;
    }

    if (blocks.length === 0) {
        const standard = clipText(
            `[observation masked - ${content.length} chars | digest: ${extractObservationDigest(content, digestChars)}]`,
            Math.max(1, Math.min(maxChars, content.length))
        );
        return {
            masked: standard,
            maskedChars: Math.max(0, content.length - standard.length),
        };
    }

    const preservedBlocks = blocks.join('\n');
    if (outsideChars <= 0) {
        return {
            masked: preservedBlocks,
            maskedChars: Math.max(0, content.length - preservedBlocks.length),
        };
    }

    const digest = extractObservationDigest(content, digestChars);
    const placeholder = clipText(
        `[dispatch output masked - ${outsideChars} chars | blocks: ${blocks.length} | digest: ${digest}]`,
        Math.max(1, Math.min(maxChars, outsideChars))
    );
    const withPlaceholder = `${placeholder}\n${preservedBlocks}`;
    const masked = withPlaceholder.length < content.length ? withPlaceholder : preservedBlocks;

    return {
        masked,
        maskedChars: Math.max(0, content.length - masked.length),
    };
}

function maskStandardObservation(
    content: string,
    maxChars: number,
    digestChars: number
): { masked: string; maskedChars: number } {
    const digest = extractObservationDigest(content, digestChars);
    const masked = clipText(
        `[observation masked - ${content.length} chars | digest: ${digest}]`,
        Math.max(1, Math.min(maxChars, content.length))
    );
    return {
        masked,
        maskedChars: Math.max(0, content.length - masked.length),
    };
}

function maskObservations(
    messages: ChatMessage[],
    keepIndices: Set<number>,
    options: { maxObservationChars: number; observationDigestChars?: number }
): { messages: ChatMessage[]; maskedCount: number; maskedChars: number } {
    let maskedCount = 0;
    let maskedChars = 0;
    const digestChars = options.observationDigestChars ?? DEFAULT_OBSERVATION_DIGEST_CHARS;

    const nextMessages = messages.map((message, index) => {
        if (keepIndices.has(index) || message.pairRole !== 'result' || message.role !== 'tool') {
            return { ...message };
        }

        const hasDispatchMarkers = message.content.includes('BEGIN_DISPATCH_RESULT')
            && message.content.includes('END_DISPATCH_RESULT');
        const masked = hasDispatchMarkers
            ? maskDispatchObservation(message.content, options.maxObservationChars, digestChars)
            : maskStandardObservation(message.content, options.maxObservationChars, digestChars);
        if (masked.masked === message.content) {
            return { ...message };
        }

        maskedCount += 1;
        maskedChars += masked.maskedChars;

        return {
            ...message,
            content: masked.masked,
        };
    });

    return {
        messages: nextMessages,
        maskedCount,
        maskedChars,
    };
}

function resolveTokenBudget(options: HistoryReducerOptions): { maxInputTokens: number; tokenCharsPerToken: number } {
    const tokenCharsPerToken = options.tokenCharsPerToken ?? DEFAULT_TOKEN_CHARS_PER_TOKEN;
    const maxInputTokens = options.maxInputTokens ?? estimateTokensFromChars(
        Math.max(1, options.maxInputChars),
        tokenCharsPerToken
    );
    return {
        maxInputTokens: Math.max(1, maxInputTokens),
        tokenCharsPerToken: Math.max(1, tokenCharsPerToken),
    };
}

function computeAdaptiveMaskChars(
    messages: ChatMessage[],
    keep: Set<number>,
    options: {
        baseMaxObservationChars: number;
        minObservationChars: number;
        maxInputTokens: number;
        beforeTokens: number;
    }
): number {
    const candidates = messages.filter(
        (message, index) => !keep.has(index) && message.role === 'tool' && message.pairRole === 'result'
    );
    if (candidates.length === 0) {
        return options.baseMaxObservationChars;
    }

    const deficit = Math.max(0, options.beforeTokens - options.maxInputTokens);
    if (deficit <= 0) {
        return options.baseMaxObservationChars;
    }

    const effectiveMinObservationChars = Math.min(options.minObservationChars, options.baseMaxObservationChars);
    const pressure = Math.min(1, deficit / Math.max(1, options.maxInputTokens));
    const scarcity = candidates.length <= 2 ? 1 : 0.75;
    const adjusted = Math.round(
        options.baseMaxObservationChars - (
            (options.baseMaxObservationChars - effectiveMinObservationChars) * pressure * scarcity
        )
    );

    return Math.max(effectiveMinObservationChars, Math.min(options.baseMaxObservationChars, adjusted));
}

function uniqueLines(lines: string[]): string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const line of lines) {
        const normalized = line.trim();
        if (!normalized || seen.has(normalized)) {
            continue;
        }
        seen.add(normalized);
        result.push(normalized);
    }
    return result;
}

function buildSummary(messages: ChatMessage[], maxChars: number): string {
    const userMessages = messages.filter(message => message.role === 'user').map(message => message.content.trim());
    const firstObjective = userMessages[0] ?? 'Not specified.';

    const unresolved = uniqueLines(
        messages
            .filter(message => message.tags?.includes('unresolved'))
            .map(message => message.content.replace(/\s+/g, ' ').trim())
    ).slice(0, 6);

    const toolOutcomes = uniqueLines(
        messages
            .filter(message => message.pairRole === 'result')
            .map(message => message.content.replace(/\s+/g, ' ').trim())
    ).slice(0, 6);

    const constraints = uniqueLines(
        messages
            .filter(message => message.tags?.includes('constraint'))
            .map(message => message.content.replace(/\s+/g, ' ').trim())
    ).slice(0, 8);

    const summary = [
        'Conversation summary (contract):',
        `- Objective: ${clipText(firstObjective, 220)}`,
        `- Unresolved tasks: ${unresolved.length > 0 ? unresolved.map(line => clipText(line, 120)).join('; ') : 'None captured.'}`,
        `- Key tool outcomes: ${toolOutcomes.length > 0 ? toolOutcomes.map(line => clipText(line, 120)).join('; ') : 'No tool outcomes captured.'}`,
        `- Current constraints: ${constraints.length > 0 ? constraints.map(line => clipText(line, 120)).join('; ') : 'No constraints captured.'}`,
    ].join('\n');

    return clipText(summary, maxChars);
}

function collectPairGroups(messages: ChatMessage[]): Map<string, number[]> {
    const groups = new Map<string, number[]>();
    messages.forEach((message, index) => {
        if (!message.pairId || !message.pairRole) {
            return;
        }
        const existing = groups.get(message.pairId);
        if (existing) {
            existing.push(index);
            return;
        }
        groups.set(message.pairId, [index]);
    });
    return groups;
}

function includePairMates(keep: Set<number>, pairGroups: Map<string, number[]>): void {
    let changed = true;
    while (changed) {
        changed = false;
        for (const indices of pairGroups.values()) {
            const hasAny = indices.some(index => keep.has(index));
            if (!hasAny) {
                continue;
            }
            for (const index of indices) {
                if (!keep.has(index)) {
                    keep.add(index);
                    changed = true;
                }
            }
        }
    }
}

function hasPairInvariantViolation(messages: ChatMessage[]): boolean {
    const groups = new Map<string, Set<string>>();
    for (const message of messages) {
        if (!message.pairId || !message.pairRole) {
            continue;
        }
        const roles = groups.get(message.pairId) ?? new Set<string>();
        roles.add(message.pairRole);
        groups.set(message.pairId, roles);
    }

    for (const roles of groups.values()) {
        if (!roles.has('call') || !roles.has('result')) {
            return true;
        }
    }

    return false;
}

function truncationFallback(
    messages: ChatMessage[],
    preserveRecentRawTurns: number
): HistoryReductionResult {
    const keep = new Set<number>();
    messages.forEach((message, index) => {
        if (message.role === 'system') {
            keep.add(index);
        }
    });

    const nonSystemIndices = messages
        .map((message, index) => ({ message, index }))
        .filter(entry => entry.message.role !== 'system')
        .map(entry => entry.index);

    for (const index of nonSystemIndices.slice(-preserveRecentRawTurns)) {
        keep.add(index);
    }

    includePairMates(keep, collectPairGroups(messages));

    const reducedMessages = messages.filter((_, index) => keep.has(index));
    return {
        messages: reducedMessages,
        reduced: reducedMessages.length !== messages.length,
        droppedCount: messages.length - reducedMessages.length,
        invariantStatus: 'fallback',
    };
}

export class HistoryReducer {
    private withTelemetry(
        result: HistoryReductionResult,
        beforeTokens: number,
        tokenCharsPerToken: number,
        stage: 'none' | 'masking' | 'summarization' | 'fallback',
        maskedCount: number,
        maskedChars: number
    ): HistoryReductionResult {
        const afterTokens = estimateTokens(result.messages, tokenCharsPerToken);
        const compressionRatio = beforeTokens > 0 ? afterTokens / beforeTokens : 1;
        return {
            ...result,
            maskedCount,
            maskedChars,
            reductionStage: stage === 'none' ? result.reductionStage : stage,
            stageUsed: stage,
            beforeTokens,
            afterTokens,
            compressionRatio,
        };
    }

    reduce(messages: ChatMessage[], options: HistoryReducerOptions): HistoryReductionResult {
        if (!options.enabled || messages.length <= 2) {
            return this.withTelemetry({
                messages,
                reduced: false,
                droppedCount: 0,
                invariantStatus: 'ok',
            }, 0, DEFAULT_TOKEN_CHARS_PER_TOKEN, 'none', 0, 0);
        }

        const { maxInputTokens, tokenCharsPerToken } = resolveTokenBudget(options);
        const beforeTokens = estimateTokens(messages, tokenCharsPerToken);

        if (beforeTokens <= maxInputTokens) {
            return this.withTelemetry({
                messages,
                reduced: false,
                droppedCount: 0,
                invariantStatus: 'ok',
            }, beforeTokens, tokenCharsPerToken, 'none', 0, 0);
        }

        const preserveRecentRawTurns = options.preserveRecentRawTurns ?? DEFAULT_PRESERVE_RECENT;
        const summaryMaxChars = options.summaryMaxChars ?? DEFAULT_SUMMARY_MAX_CHARS;
        const baseMaxObservationChars = options.maxObservationChars ?? DEFAULT_MAX_OBSERVATION_CHARS;
        const minObservationChars = options.minObservationChars ?? DEFAULT_MIN_OBSERVATION_CHARS;
        const observationDigestChars = options.observationDigestChars ?? DEFAULT_OBSERVATION_DIGEST_CHARS;
        const pairGroups = collectPairGroups(messages);
        const keep = new Set<number>();

        messages.forEach((message, index) => {
            if (message.role === 'system') {
                keep.add(index);
            }
        });

        const nonSystemIndices = messages
            .map((message, index) => ({ message, index }))
            .filter(entry => entry.message.role !== 'system')
            .map(entry => entry.index);

        for (const index of nonSystemIndices.slice(-preserveRecentRawTurns)) {
            keep.add(index);
        }

        includePairMates(keep, pairGroups);

        const adaptiveMaxObservationChars = computeAdaptiveMaskChars(messages, keep, {
            baseMaxObservationChars,
            minObservationChars,
            maxInputTokens,
            beforeTokens,
        });
        const stageOne = maskObservations(messages, keep, {
            maxObservationChars: adaptiveMaxObservationChars,
            observationDigestChars,
        });
        const stageOneMessages = stageOne.messages;

        if (hasPairInvariantViolation(stageOneMessages)) {
            const fallback = truncationFallback(stageOneMessages, preserveRecentRawTurns);
            return this.withTelemetry({
                ...fallback,
                reductionStage: 'fallback',
            }, beforeTokens, tokenCharsPerToken, 'fallback', stageOne.maskedCount, stageOne.maskedChars);
        }

        if (estimateTokens(stageOneMessages, tokenCharsPerToken) <= maxInputTokens) {
            return this.withTelemetry({
                messages: stageOneMessages,
                reduced: stageOne.maskedCount > 0,
                droppedCount: 0,
                invariantStatus: 'ok',
                reductionStage: 'masking',
            }, beforeTokens, tokenCharsPerToken, 'masking', stageOne.maskedCount, stageOne.maskedChars);
        }

        const summarySource = stageOneMessages.filter(
            (message, index) => !keep.has(index) && message.role !== 'system'
        );
        const summaryNeeded = summarySource.length > 0;
        const summaryMessage = summaryNeeded
            ? {
                  role: 'system' as const,
                  content: buildSummary(summarySource, summaryMaxChars),
              }
            : null;

        const reducedMessages = stageOneMessages.filter((_, index) => keep.has(index));
        const withSummary = summaryMessage ? [summaryMessage, ...reducedMessages] : reducedMessages;

        if (!hasPairInvariantViolation(withSummary) && estimateTokens(withSummary, tokenCharsPerToken) <= maxInputTokens) {
            return this.withTelemetry({
                messages: withSummary,
                reduced: true,
                droppedCount: stageOneMessages.length - reducedMessages.length,
                invariantStatus: 'ok',
                reductionStage: 'summarization',
            }, beforeTokens, tokenCharsPerToken, 'summarization', stageOne.maskedCount, stageOne.maskedChars);
        }

        const fallback = truncationFallback(stageOneMessages, preserveRecentRawTurns);
        return this.withTelemetry({
            ...fallback,
            reductionStage: 'fallback',
        }, beforeTokens, tokenCharsPerToken, 'fallback', stageOne.maskedCount, stageOne.maskedChars);
    }
}
