import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { HistoryReducer } from './history-reducer.js';
import type { HistoryReductionResult } from './history-reducer.js';
import type { ChatMessage, HistoryReducerOptions } from './types.js';

function extractFunctionSource(source: string, functionName: string): string {
    const sourceFile = ts.createSourceFile(
        'history-reducer.ts',
        source,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS
    );

    let declaration: ts.FunctionDeclaration | undefined;
    sourceFile.forEachChild(node => {
        if (!ts.isFunctionDeclaration(node) || node.name?.text !== functionName) {
            return;
        }
        declaration = node;
    });

    if (!declaration) {
        throw new Error(`Function ${functionName} not found`);
    }

    return declaration.getText(sourceFile);
}

type MaskObservations = (
    messages: ChatMessage[],
    keepIndices: Set<number>,
    options: { maxObservationChars: number; observationDigestChars?: number }
) => { messages: ChatMessage[]; maskedCount: number; maskedChars: number };

type MaskDispatchObservation = (
    content: string,
    maxChars: number,
    digestChars: number
) => { masked: string; maskedChars: number };

async function loadMaskObservations(): Promise<MaskObservations> {
    const sourcePath = new URL('./history-reducer.ts', import.meta.url);
    const source = readFileSync(sourcePath, 'utf8');
    const normalizeInlineTextFn = extractFunctionSource(source, 'normalizeInlineText');
    const extractObservationDigestFn = extractFunctionSource(source, 'extractObservationDigest');
    const clipTextFn = extractFunctionSource(source, 'clipText');
    const maskDispatchObservationFn = extractFunctionSource(source, 'maskDispatchObservation');
    const maskStandardObservationFn = extractFunctionSource(source, 'maskStandardObservation');
    const maskObservationsFn = extractFunctionSource(source, 'maskObservations');
    const compiled = ts.transpileModule(
        [
            'const DEFAULT_OBSERVATION_DIGEST_CHARS = 48;',
            clipTextFn,
            normalizeInlineTextFn,
            extractObservationDigestFn,
            maskDispatchObservationFn,
            maskStandardObservationFn,
            maskObservationsFn,
            'export { maskObservations };',
        ].join('\n'),
        {
            compilerOptions: {
                target: ts.ScriptTarget.ES2022,
                module: ts.ModuleKind.ES2022,
            },
        }
    ).outputText;

    const module = await import(`data:text/javascript,${encodeURIComponent(compiled)}`);
    return module.maskObservations as MaskObservations;
}

type ClipText = (value: string, maxChars: number) => string;

async function loadClipText(): Promise<ClipText> {
    const sourcePath = new URL('./history-reducer.ts', import.meta.url);
    const source = readFileSync(sourcePath, 'utf8');
    const clipTextFn = extractFunctionSource(source, 'clipText');
    const compiled = ts.transpileModule(
        `${clipTextFn}\nexport { clipText };`,
        {
            compilerOptions: {
                target: ts.ScriptTarget.ES2022,
                module: ts.ModuleKind.ES2022,
            },
        }
    ).outputText;

    const module = await import(`data:text/javascript,${encodeURIComponent(compiled)}`);
    return module.clipText as ClipText;
}

async function loadMaskDispatchObservation(): Promise<MaskDispatchObservation> {
    const sourcePath = new URL('./history-reducer.ts', import.meta.url);
    const source = readFileSync(sourcePath, 'utf8');
    const clipTextFn = extractFunctionSource(source, 'clipText');
    const normalizeInlineTextFn = extractFunctionSource(source, 'normalizeInlineText');
    const extractObservationDigestFn = extractFunctionSource(source, 'extractObservationDigest');
    const maskDispatchObservationFn = extractFunctionSource(source, 'maskDispatchObservation');
    const compiled = ts.transpileModule(
        `${clipTextFn}\n${normalizeInlineTextFn}\n${extractObservationDigestFn}\n${maskDispatchObservationFn}\nexport { maskDispatchObservation };`,
        {
            compilerOptions: {
                target: ts.ScriptTarget.ES2022,
                module: ts.ModuleKind.ES2022,
            },
        }
    ).outputText;

    const module = await import(`data:text/javascript,${encodeURIComponent(compiled)}`);
    return module.maskDispatchObservation as MaskDispatchObservation;
}

function extractNextAction(messages: ChatMessage[]): string | null {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        const message = messages[i];
        if (!message || message.role !== 'assistant') {
            continue;
        }
        const match = message.content.match(/NEXT_ACTION=([a-z_]+)/i);
        if (match && match[1]) {
            return match[1].toLowerCase();
        }
    }
    return null;
}

describe('HistoryReducer', () => {
    it('keeps call/result pairs when reducing', () => {
        const reducer = new HistoryReducer();
        const result = reducer.reduce(
            [
                { role: 'system', content: 'system rules' },
                { role: 'user', content: `old question ${'A'.repeat(400)}` },
                { role: 'assistant', content: 'calling tool', pairId: 't1', pairRole: 'call' },
                { role: 'tool', content: 'tool output', pairId: 't1', pairRole: 'result', toolCallId: 't1' },
                { role: 'user', content: 'latest question' },
            ],
            {
                enabled: true,
                maxInputChars: 140,
                preserveRecentRawTurns: 2,
            }
        );

        const pairMessages = result.messages.filter(message => message.pairId === 't1');
        expect(pairMessages).toHaveLength(2);
    });

    it('includes tagged unresolved and constraint messages in summary', () => {
        const reducer = new HistoryReducer();
        const result = reducer.reduce(
            [
                { role: 'system', content: 'system rules' },
                { role: 'user', content: `old question ${'A'.repeat(400)}` },
                { role: 'user', content: 'Fix the login bug', tags: ['unresolved'] },
                { role: 'user', content: 'Max response time must be under 200ms', tags: ['constraint'] },
                { role: 'user', content: 'latest question' },
            ],
            {
                enabled: true,
                maxInputChars: 450,
                preserveRecentRawTurns: 1,
                summaryMaxChars: 1400,
            }
        );

        expect(result.reduced).toBe(true);
        const summaryMessage = result.messages.find(
            m => m.role === 'system' && m.content.includes('Conversation summary')
        );
        expect(summaryMessage).toBeDefined();
        expect(summaryMessage!.content).toContain('Fix the login bug');
        expect(summaryMessage!.content).toContain('Max response time');
    });

    it('falls back safely when max budget is too small', () => {
        const reducer = new HistoryReducer();
        const result = reducer.reduce(
            [
                { role: 'system', content: 'system instructions' },
                { role: 'user', content: 'A'.repeat(400) },
                { role: 'assistant', content: 'B'.repeat(400) },
                { role: 'user', content: 'latest turn' },
            ],
            {
                enabled: true,
                maxInputChars: 20,
                preserveRecentRawTurns: 1,
            }
        );

        expect(result.invariantStatus).toBe('fallback');
        expect(result.messages.some(message => message.role === 'system')).toBe(true);
        expect(result.messages[result.messages.length - 1]?.content).toContain('latest');
    });

    it('exposes observation-masking config and telemetry types', () => {
        const options = {
            enabled: true,
            maxInputChars: 1000,
            maxInputTokens: 250,
            observationMasking: true,
            maxObservationChars: 80,
            minObservationChars: 24,
            observationDigestChars: 48,
        } satisfies HistoryReducerOptions;

        const reduction: HistoryReductionResult = {
            messages: [],
            reduced: true,
            droppedCount: 0,
            invariantStatus: 'ok',
            maskedCount: 1,
            maskedChars: 42,
            reductionStage: 'masking',
            beforeTokens: 100,
            afterTokens: 40,
            compressionRatio: 0.4,
            stageUsed: 'masking',
        };

        expect(options.observationMasking).toBe(true);
        expect(options.maxInputTokens).toBe(250);
        expect(options.maxObservationChars).toBe(80);
        expect(reduction.reductionStage).toBe('masking');
        expect(reduction.maskedCount).toBe(1);
        expect(reduction.maskedChars).toBe(42);
        expect(reduction.compressionRatio).toBe(0.4);
        expect(reduction.stageUsed).toBe('masking');
    });
});

describe('HistoryReducer observation masking pipeline', () => {
    it('masks old observations while preserving agent actions', () => {
        const reducer = new HistoryReducer();
        const oldResult = `old tool output ${'A'.repeat(500)}`;
        const messages: ChatMessage[] = [
            { role: 'system', content: 'system rules' },
            { role: 'user', content: 'first request' },
            { role: 'assistant', content: 'run old tool', pairId: 'old', pairRole: 'call' },
            { role: 'tool', content: oldResult, pairId: 'old', pairRole: 'result', toolCallId: 'old' },
            { role: 'assistant', content: 'old reasoning preserved' },
            { role: 'assistant', content: 'run recent tool', pairId: 'recent', pairRole: 'call' },
            { role: 'tool', content: 'recent tool output', pairId: 'recent', pairRole: 'result', toolCallId: 'recent' },
            { role: 'user', content: 'latest turn' },
        ];

        const result = reducer.reduce(messages, {
            enabled: true,
            maxInputChars: 320,
            preserveRecentRawTurns: 3,
            maxObservationChars: 80,
        });

        expect(result.reduced).toBe(true);
        expect(result.reductionStage).toBe('masking');
        expect(result.maskedCount).toBe(1);
        expect(result.maskedChars).toBeGreaterThan(0);

        const oldCall = result.messages.find(message => message.pairId === 'old' && message.pairRole === 'call');
        const oldMaskedResult = result.messages.find(message => message.pairId === 'old' && message.pairRole === 'result');
        expect(oldCall?.content).toBe('run old tool');
        expect(oldMaskedResult?.content).toContain('[observation masked');
        expect(oldMaskedResult?.toolCallId).toBe('old');
    });

    it('does not keep a legacy no-masking branch when observationMasking is false', () => {
        const reducer = new HistoryReducer();
        const result = reducer.reduce(
            [
                { role: 'system', content: 'rules' },
                { role: 'assistant', content: 'call old tool', pairId: 'p1', pairRole: 'call' },
                { role: 'tool', content: `tool output ${'A'.repeat(400)}`, pairId: 'p1', pairRole: 'result', toolCallId: 'p1' },
                { role: 'assistant', content: 'recent' },
                { role: 'user', content: 'latest' },
            ],
            {
                enabled: true,
                maxInputChars: 180,
                preserveRecentRawTurns: 2,
                observationMasking: false,
            }
        );

        expect(result.maskedCount).toBeGreaterThan(0);
        expect(result.messages.some(message => message.content.includes('[observation masked'))).toBe(true);
        expect(result.stageUsed).toBeDefined();
    });

    it('falls through to summarization when masking is insufficient', () => {
        const reducer = new HistoryReducer();
        const result = reducer.reduce(
            [
                { role: 'system', content: 'rules' },
                { role: 'user', content: `old requirement ${'A'.repeat(250)}` },
                { role: 'assistant', content: 'run old tool', pairId: 'p1', pairRole: 'call' },
                { role: 'tool', content: `tool output ${'B'.repeat(300)}`, pairId: 'p1', pairRole: 'result', toolCallId: 'p1' },
                { role: 'assistant', content: `analysis ${'C'.repeat(250)}`, tags: ['constraint'] },
                { role: 'user', content: 'latest turn' },
            ],
            {
                enabled: true,
                maxInputChars: 260,
                preserveRecentRawTurns: 1,
                summaryMaxChars: 120,
                maxObservationChars: 60,
            }
        );

        expect(result.reductionStage).toBe('summarization');
        expect(result.maskedCount).toBe(1);
        expect(
            result.messages.some(message =>
                message.role === 'system' && message.content.includes('Conversation summary (contract)')
            )
        ).toBe(true);
    });

    it('preserves dispatch result structured blocks while masking surrounding output', () => {
        const reducer = new HistoryReducer();
        const prelude = 'verbose prelude logs '.repeat(30);
        const trailing = 'verbose trailing logs '.repeat(30);
        const dispatchOutput = [
            prelude,
            'BEGIN_DISPATCH_RESULT',
            '{"task_id":"2.1","status":"completed","summary":"ok","files_changed":[],"tests":[{"command":"npm test","passed":true}],"follow_up_actions":[]}',
            'END_DISPATCH_RESULT',
            trailing,
        ].join('\n');

        const result = reducer.reduce(
            [
                { role: 'system', content: 'rules' },
                { role: 'assistant', content: 'call dispatch', pairId: 'd1', pairRole: 'call' },
                { role: 'tool', content: dispatchOutput, pairId: 'd1', pairRole: 'result', toolCallId: 'd1' },
                { role: 'user', content: 'latest' },
            ],
            {
                enabled: true,
                maxInputChars: 380,
                preserveRecentRawTurns: 1,
                maxObservationChars: 40,
            }
        );

        expect(result.reductionStage).toBe('masking');
        const maskedDispatch = result.messages.find(message => message.pairId === 'd1' && message.pairRole === 'result');
        expect(maskedDispatch).toBeDefined();
        expect(maskedDispatch?.content).toContain('BEGIN_DISPATCH_RESULT');
        expect(maskedDispatch?.content).toContain('END_DISPATCH_RESULT');
        expect(maskedDispatch?.content).toContain('"task_id":"2.1"');
        expect(maskedDispatch?.content).not.toContain('verbose prelude logs');
        expect(maskedDispatch?.content).not.toContain('verbose trailing logs');
    });

    it('maintains pair invariants after masking', () => {
        const reducer = new HistoryReducer();
        const result = reducer.reduce(
            [
                { role: 'system', content: 'rules' },
                { role: 'assistant', content: 'call 1', pairId: 'p1', pairRole: 'call' },
                { role: 'tool', content: `result 1 ${'X'.repeat(260)}`, pairId: 'p1', pairRole: 'result', toolCallId: 'p1' },
                { role: 'assistant', content: 'call 2', pairId: 'p2', pairRole: 'call' },
                { role: 'tool', content: `result 2 ${'Y'.repeat(240)}`, pairId: 'p2', pairRole: 'result', toolCallId: 'p2' },
                { role: 'user', content: 'latest' },
            ],
            {
                enabled: true,
                maxInputChars: 260,
                preserveRecentRawTurns: 1,
                maxObservationChars: 60,
            }
        );

        const pairRoles = new Map<string, Set<'call' | 'result'>>();
        for (const message of result.messages) {
            if (!message.pairId || !message.pairRole) {
                continue;
            }
            const roles = pairRoles.get(message.pairId) ?? new Set<'call' | 'result'>();
            roles.add(message.pairRole);
            pairRoles.set(message.pairId, roles);
        }

        for (const roles of pairRoles.values()) {
            expect(roles.has('call')).toBe(true);
            expect(roles.has('result')).toBe(true);
        }
    });

    it('uses maxObservationChars for non-dispatch placeholders', () => {
        const reducer = new HistoryReducer();
        const result = reducer.reduce(
            [
                { role: 'system', content: 'rules' },
                { role: 'assistant', content: 'call old', pairId: 'p1', pairRole: 'call' },
                { role: 'tool', content: 'Z'.repeat(200), pairId: 'p1', pairRole: 'result', toolCallId: 'p1' },
                { role: 'user', content: 'latest turn' },
            ],
            {
                enabled: true,
                maxInputChars: 120,
                preserveRecentRawTurns: 1,
                maxObservationChars: 16,
            }
        );

        const masked = result.messages.find(message => message.pairId === 'p1' && message.pairRole === 'result');
        expect(masked).toBeDefined();
        expect(masked!.content.length).toBeLessThanOrEqual(16);
        expect(result.maskedCount).toBe(1);
        expect(result.maskedChars).toBeGreaterThan(0);
    });

    it('uses maxInputTokens as the reduction trigger budget', () => {
        const reducer = new HistoryReducer();
        const result = reducer.reduce(
            [
                { role: 'system', content: 'rules' },
                { role: 'assistant', content: 'call old', pairId: 'p1', pairRole: 'call' },
                { role: 'tool', content: 'A'.repeat(500), pairId: 'p1', pairRole: 'result', toolCallId: 'p1' },
                { role: 'assistant', content: 'decision: dispatch_reviewer' },
                { role: 'user', content: 'latest' },
            ],
            {
                enabled: true,
                maxInputChars: 99999,
                maxInputTokens: 60,
                preserveRecentRawTurns: 1,
                maxObservationChars: 60,
            }
        );

        expect(result.reduced).toBe(true);
        expect(result.beforeTokens).toBeGreaterThan(60);
        expect(result.afterTokens).toBeLessThanOrEqual(60);
    });

    it('adapts masking strength under tighter deficit', () => {
        const reducer = new HistoryReducer();
        const baseMessages: ChatMessage[] = [
            { role: 'system', content: 'rules' },
            { role: 'assistant', content: 'call old', pairId: 'p1', pairRole: 'call' },
            { role: 'tool', content: 'A'.repeat(800), pairId: 'p1', pairRole: 'result', toolCallId: 'p1' },
            { role: 'assistant', content: 'call old 2', pairId: 'p2', pairRole: 'call' },
            { role: 'tool', content: 'B'.repeat(800), pairId: 'p2', pairRole: 'result', toolCallId: 'p2' },
            { role: 'user', content: 'latest' },
        ];

        const relaxed = reducer.reduce(baseMessages, {
            enabled: true,
            maxInputChars: 99999,
            maxInputTokens: 220,
            preserveRecentRawTurns: 1,
            maxObservationChars: 80,
            minObservationChars: 16,
        });
        const strict = reducer.reduce(baseMessages, {
            enabled: true,
            maxInputChars: 99999,
            maxInputTokens: 80,
            preserveRecentRawTurns: 1,
            maxObservationChars: 80,
            minObservationChars: 16,
        });

        const relaxedMasked = relaxed.messages.find(message => message.pairId === 'p1' && message.pairRole === 'result');
        const strictMasked = strict.messages.find(message => message.pairId === 'p1' && message.pairRole === 'result');
        expect(relaxedMasked).toBeDefined();
        expect(strictMasked).toBeDefined();
        expect(strictMasked!.content.length).toBeLessThanOrEqual(relaxedMasked!.content.length);
    });

    it('keeps decision cues stable under aggressive masking (guardrail replay)', () => {
        const reducer = new HistoryReducer();
        const trace: ChatMessage[] = [
            { role: 'system', content: 'rules' },
            { role: 'assistant', content: 'called tool alpha', pairId: 'p1', pairRole: 'call' },
            { role: 'tool', content: 'very large output '.repeat(140), pairId: 'p1', pairRole: 'result', toolCallId: 'p1' },
            { role: 'assistant', content: 'NEXT_ACTION=dispatch_reviewer because implementation completed' },
            { role: 'user', content: 'continue' },
        ];

        const moderate = reducer.reduce(trace, {
            enabled: true,
            maxInputChars: 99999,
            maxInputTokens: 180,
            preserveRecentRawTurns: 1,
            maxObservationChars: 90,
            minObservationChars: 24,
        });
        const aggressive = reducer.reduce(trace, {
            enabled: true,
            maxInputChars: 99999,
            maxInputTokens: 80,
            preserveRecentRawTurns: 1,
            maxObservationChars: 40,
            minObservationChars: 12,
        });

        const moderateDecision = moderate.messages.find(m => m.role === 'assistant' && m.content.includes('NEXT_ACTION='));
        const aggressiveDecision = aggressive.messages.find(m => m.role === 'assistant' && m.content.includes('NEXT_ACTION='));
        expect(moderateDecision?.content).toContain('NEXT_ACTION=dispatch_reviewer');
        expect(aggressiveDecision?.content).toContain('NEXT_ACTION=dispatch_reviewer');
    });

    it('quality guardrail replay keeps next-action stable with masking on/off', () => {
        const reducer = new HistoryReducer();
        const traces: Array<{ name: string; expectedNextAction: string; messages: ChatMessage[] }> = [
            {
                name: 'implementation completed',
                expectedNextAction: 'dispatch_reviewer',
                messages: [
                    { role: 'system', content: 'rules' },
                    { role: 'assistant', content: 'call implementer', pairId: 'p1', pairRole: 'call' },
                    { role: 'tool', content: 'very large output '.repeat(120), pairId: 'p1', pairRole: 'result', toolCallId: 'p1' },
                    { role: 'assistant', content: 'NEXT_ACTION=dispatch_reviewer because implementation completed' },
                    { role: 'user', content: 'continue' },
                ],
            },
            {
                name: 'implementation blocked',
                expectedNextAction: 'retry_implementer_with_constraints',
                messages: [
                    { role: 'system', content: 'rules' },
                    { role: 'assistant', content: 'call implementer', pairId: 'p2', pairRole: 'call' },
                    { role: 'tool', content: 'stderr dump '.repeat(140), pairId: 'p2', pairRole: 'result', toolCallId: 'p2' },
                    { role: 'assistant', content: 'NEXT_ACTION=retry_implementer_with_constraints waiting on missing dependency' },
                    { role: 'user', content: 'continue' },
                ],
            },
            {
                name: 'reviewer blocked',
                expectedNextAction: 'halt_and_escalate',
                messages: [
                    { role: 'system', content: 'rules' },
                    { role: 'assistant', content: 'call reviewer', pairId: 'p3', pairRole: 'call' },
                    { role: 'tool', content: 'review logs '.repeat(150), pairId: 'p3', pairRole: 'result', toolCallId: 'p3' },
                    { role: 'assistant', content: 'NEXT_ACTION=halt_and_escalate review policy violation' },
                    { role: 'user', content: 'continue' },
                ],
            },
        ];

        for (const trace of traces) {
            const baseline = reducer.reduce(trace.messages, {
                enabled: false,
                maxInputChars: 99999,
            });
            const maskingOn = reducer.reduce(trace.messages, {
                enabled: true,
                maxInputChars: 99999,
                maxInputTokens: 120,
                preserveRecentRawTurns: 1,
                observationMasking: true,
                maxObservationChars: 48,
                minObservationChars: 12,
            });
            const maskingOff = reducer.reduce(trace.messages, {
                enabled: true,
                maxInputChars: 99999,
                maxInputTokens: 120,
                preserveRecentRawTurns: 1,
                observationMasking: false,
                maxObservationChars: 48,
                minObservationChars: 12,
            });

            const baselineAction = extractNextAction(baseline.messages);
            const maskingOnAction = extractNextAction(maskingOn.messages);
            const maskingOffAction = extractNextAction(maskingOff.messages);

            expect(baselineAction, `${trace.name} baseline`).toBe(trace.expectedNextAction);
            expect(maskingOnAction, `${trace.name} masking on`).toBe(trace.expectedNextAction);
            expect(maskingOffAction, `${trace.name} masking off`).toBe(trace.expectedNextAction);
            expect(maskingOnAction, `${trace.name} on/off parity`).toBe(maskingOffAction);
            expect(maskingOn.beforeTokens, `${trace.name} token accounting`).toBeGreaterThan(120);
            expect(maskingOn.afterTokens, `${trace.name} masked token reduction`).toBeLessThan(maskingOn.beforeTokens ?? Number.MAX_SAFE_INTEGER);
        }
    });
});

describe('maskObservations (internal)', () => {
    it('masks only result messages outside keepIndices and preserves metadata', async () => {
        const maskObservations = await loadMaskObservations();
        const oldObservation = `tool output ${'A'.repeat(80)}`;
        const keptObservation = `keep me ${'B'.repeat(40)}`;
        const messages: ChatMessage[] = [
            { role: 'system', content: 'system instructions' },
            { role: 'assistant', content: 'tool call', pairId: 'p1', pairRole: 'call', toolCallId: 'call-1' },
            {
                role: 'tool',
                content: oldObservation,
                pairId: 'p1',
                pairRole: 'result',
                toolCallId: 'call-1',
                name: 'shell',
                tags: ['observation'],
            },
            {
                role: 'tool',
                content: keptObservation,
                pairId: 'p2',
                pairRole: 'result',
                toolCallId: 'call-2',
                name: 'shell',
                tags: ['keep'],
            },
        ];
        const before = structuredClone(messages);

        const result = maskObservations(messages, new Set([3]), { maxObservationChars: 120, observationDigestChars: 48 });
        const placeholderPrefix = `[observation masked - ${oldObservation.length} chars`;

        expect(result.messages).not.toBe(messages);
        expect(messages).toEqual(before);
        expect(result.messages[0]).toEqual(messages[0]);
        expect(result.messages[1]).toEqual(messages[1]);
        expect(result.messages[2]?.content).toContain(placeholderPrefix);
        expect(result.messages[3]).toEqual(messages[3]);
        expect(result.maskedCount).toBe(1);
        expect(result.maskedChars).toBeGreaterThan(0);
    });

    it('never masks assistant/user/system messages', async () => {
        const maskObservations = await loadMaskObservations();
        const messages: ChatMessage[] = [
            { role: 'system', content: 'rules', pairId: 'sys', pairRole: 'result' },
            { role: 'user', content: 'request', pairId: 'usr', pairRole: 'result' },
            { role: 'assistant', content: 'response', pairId: 'ast', pairRole: 'result' },
            { role: 'tool', content: 'tool output', pairId: 'p1', pairRole: 'result' },
        ];

        const result = maskObservations(messages, new Set([3]), { maxObservationChars: 120, observationDigestChars: 48 });

        expect(result.messages).toEqual(messages);
        expect(result.maskedCount).toBe(0);
        expect(result.maskedChars).toBe(0);
    });

    it('clips placeholder to maxObservationChars', async () => {
        const maskObservations = await loadMaskObservations();
        const original = 'X'.repeat(120);
        const messages: ChatMessage[] = [{ role: 'tool', content: original, pairId: 'p1', pairRole: 'result' }];

        const result = maskObservations(messages, new Set<number>(), { maxObservationChars: 24, observationDigestChars: 48 });
        expect(result.messages[0]?.content.length).toBeLessThanOrEqual(24);
        expect(result.maskedCount).toBe(1);
        expect(result.maskedChars).toBeGreaterThan(0);
    });
});

describe('maskDispatchObservation (internal)', () => {
    it('preserves dispatch block and masks surrounding content', async () => {
        const maskDispatchObservation = await loadMaskDispatchObservation();
        const content = [
            'prefix logs',
            'BEGIN_DISPATCH_RESULT',
            '{"task_id":"3.1","assessment":"approved","strengths":[],"issues":[],"required_fixes":[]}',
            'END_DISPATCH_RESULT',
            'suffix logs',
        ].join('\n');

        const result = maskDispatchObservation(content, 40, 48);

        expect(result.masked).toContain('BEGIN_DISPATCH_RESULT');
        expect(result.masked).toContain('END_DISPATCH_RESULT');
        expect(result.masked).toContain('"task_id":"3.1"');
        expect(result.masked).not.toContain('prefix logs');
        expect(result.masked).not.toContain('suffix logs');
        expect(result.maskedChars).toBeGreaterThan(0);
    });

    it('falls back to standard observation masking when delimiters are missing', async () => {
        const maskDispatchObservation = await loadMaskDispatchObservation();
        const content = `plain tool output ${'X'.repeat(120)}`;

        const result = maskDispatchObservation(content, 80, 48);

        expect(result.masked).toContain('[observation masked');
        expect(result.masked).not.toContain('BEGIN_DISPATCH_RESULT');
        expect(result.maskedChars).toBeGreaterThan(0);
    });

    it('preserves multiple dispatch result blocks and masks all prose outside', async () => {
        const maskDispatchObservation = await loadMaskDispatchObservation();
        const content = [
            'prose prelude',
            'BEGIN_DISPATCH_RESULT',
            '{"task_id":"1.1","status":"completed"}',
            'END_DISPATCH_RESULT',
            'middle prose',
            'BEGIN_DISPATCH_RESULT',
            '{"task_id":"1.2","status":"blocked"}',
            'END_DISPATCH_RESULT',
            'epilogue prose',
        ].join('\n');

        const result = maskDispatchObservation(content, 60, 48);

        expect(result.masked).toContain('"task_id":"1.1"');
        expect(result.masked).toContain('"task_id":"1.2"');
        expect(result.masked).not.toContain('prose prelude');
        expect(result.masked).not.toContain('middle prose');
        expect(result.masked).not.toContain('epilogue prose');
        expect(result.maskedChars).toBeGreaterThan(0);
    });
});

describe('clipText (internal)', () => {
    it('returns value unchanged when within maxChars', async () => {
        const clipText = await loadClipText();
        expect(clipText('hello', 10)).toBe('hello');
        expect(clipText('hello', 5)).toBe('hello');
    });

    it('truncates with ellipsis when value exceeds maxChars', async () => {
        const clipText = await loadClipText();
        expect(clipText('hello world', 8)).toBe('hello...');
    });

    it('returns empty string when maxChars is 0 or negative', async () => {
        const clipText = await loadClipText();
        expect(clipText('hello', 0)).toBe('');
        expect(clipText('hello', -1)).toBe('');
    });

    it('returns raw slice when maxChars is 3 or less', async () => {
        const clipText = await loadClipText();
        expect(clipText('hello', 3)).toBe('hel');
        expect(clipText('hello', 2)).toBe('he');
        expect(clipText('hello', 1)).toBe('h');
    });

    it('handles empty string input', async () => {
        const clipText = await loadClipText();
        expect(clipText('', 10)).toBe('');
        expect(clipText('', 0)).toBe('');
    });
});
