import type { ChatMessage, HistoryReducerOptions } from './types.js';

export interface HistoryReductionResult {
    messages: ChatMessage[];
    reduced: boolean;
    droppedCount: number;
    invariantStatus: 'ok' | 'fallback';
    maskedCount?: number;
    maskedChars?: number;
    reductionStage?: 'masking' | 'summarization' | 'fallback';
}

const DEFAULT_PRESERVE_RECENT = 4;
const DEFAULT_SUMMARY_MAX_CHARS = 1400;
const DEFAULT_MAX_OBSERVATION_CHARS = 80;

function contentLength(messages: ChatMessage[]): number {
    return messages.reduce((sum, message) => sum + message.content.length, 0);
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

function maskDispatchObservation(content: string, maxChars: number): { masked: string; maskedChars: number } {
    const beginMarker = 'BEGIN_DISPATCH_RESULT';
    const endMarker = 'END_DISPATCH_RESULT';

    const beginIndex = content.indexOf(beginMarker);
    const endIndex = beginIndex >= 0
        ? content.indexOf(endMarker, beginIndex + beginMarker.length)
        : -1;

    if (beginIndex < 0 || endIndex < 0 || endIndex < beginIndex) {
        const standard = clipText(
            `[observation masked — ${content.length} chars]`,
            Math.max(1, Math.min(maxChars, content.length))
        );
        return {
            masked: standard,
            maskedChars: Math.max(0, content.length - standard.length),
        };
    }

    const blockEnd = endIndex + endMarker.length;
    const preservedBlock = content.slice(beginIndex, blockEnd);
    const outsideLength = beginIndex + (content.length - blockEnd);
    if (outsideLength <= 0) {
        return {
            masked: preservedBlock,
            maskedChars: Math.max(0, content.length - preservedBlock.length),
        };
    }

    const placeholder = clipText(
        `[dispatch output masked — ${outsideLength} chars]`,
        Math.max(1, Math.min(maxChars, outsideLength))
    );
    const withPlaceholder = `${placeholder}\n${preservedBlock}`;
    const masked = withPlaceholder.length < content.length
        ? withPlaceholder
        : preservedBlock;

    return {
        masked,
        maskedChars: Math.max(0, content.length - masked.length),
    };
}

function maskStandardObservation(content: string, maxChars: number): { masked: string; maskedChars: number } {
    const masked = clipText(
        `[observation masked — ${content.length} chars]`,
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
    options: { maxObservationChars: number }
): { messages: ChatMessage[]; maskedCount: number; maskedChars: number } {
    let maskedCount = 0;
    let maskedChars = 0;

    const nextMessages = messages.map((message, index) => {
        if (keepIndices.has(index) || message.pairRole !== 'result' || message.role !== 'tool') {
            return { ...message };
        }

        const hasDispatchMarkers = message.content.includes('BEGIN_DISPATCH_RESULT')
            && message.content.includes('END_DISPATCH_RESULT');
        const masked = hasDispatchMarkers
            ? maskDispatchObservation(message.content, options.maxObservationChars)
            : maskStandardObservation(message.content, options.maxObservationChars);
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
    reduce(messages: ChatMessage[], options: HistoryReducerOptions): HistoryReductionResult {
        if (!options.enabled || options.maxInputChars <= 0 || messages.length <= 2) {
            return {
                messages,
                reduced: false,
                droppedCount: 0,
                invariantStatus: 'ok',
            };
        }

        if (contentLength(messages) <= options.maxInputChars) {
            return {
                messages,
                reduced: false,
                droppedCount: 0,
                invariantStatus: 'ok',
            };
        }

        const preserveRecentRawTurns = options.preserveRecentRawTurns ?? DEFAULT_PRESERVE_RECENT;
        const summaryMaxChars = options.summaryMaxChars ?? DEFAULT_SUMMARY_MAX_CHARS;
        const observationMasking = options.observationMasking ?? true;
        const maxObservationChars = options.maxObservationChars ?? DEFAULT_MAX_OBSERVATION_CHARS;
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

        const stageOne = observationMasking
            ? maskObservations(messages, keep, { maxObservationChars })
            : { messages: messages.map(message => ({ ...message })), maskedCount: 0, maskedChars: 0 };
        const stageOneMessages = stageOne.messages;

        if (observationMasking && hasPairInvariantViolation(stageOneMessages)) {
            const fallback = truncationFallback(stageOneMessages, preserveRecentRawTurns);
            return {
                ...fallback,
                maskedCount: stageOne.maskedCount,
                maskedChars: stageOne.maskedChars,
                reductionStage: 'fallback',
            };
        }

        if (observationMasking && contentLength(stageOneMessages) <= options.maxInputChars) {
            return {
                messages: stageOneMessages,
                reduced: stageOne.maskedCount > 0,
                droppedCount: 0,
                invariantStatus: 'ok',
                maskedCount: stageOne.maskedCount,
                maskedChars: stageOne.maskedChars,
                reductionStage: 'masking',
            };
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

        if (!hasPairInvariantViolation(withSummary) && contentLength(withSummary) <= options.maxInputChars) {
            return {
                messages: withSummary,
                reduced: true,
                droppedCount: stageOneMessages.length - reducedMessages.length,
                invariantStatus: 'ok',
                maskedCount: stageOne.maskedCount,
                maskedChars: stageOne.maskedChars,
                reductionStage: 'summarization',
            };
        }

        const fallback = truncationFallback(stageOneMessages, preserveRecentRawTurns);
        return {
            ...fallback,
            maskedCount: stageOne.maskedCount,
            maskedChars: stageOne.maskedChars,
            reductionStage: 'fallback',
        };
    }
}
