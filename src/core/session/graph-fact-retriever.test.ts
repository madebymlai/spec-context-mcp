import { describe, expect, it, vi } from 'vitest';
import { GraphSessionFactStore } from './graph-session-fact-store.js';
import { KeywordFactRetriever } from './fact-retriever.js';
import type { ISQLiteFactAdapter } from './sqlite-fact-adapter.js';
import { createFactId, type SessionFact, type SessionFactTag } from './types.js';
import { GraphFactRetriever } from './graph-fact-retriever.js';

function buildFact(input: {
  subject: string;
  relation: string;
  object: string;
  sourceTaskId: string;
  at: string;
  confidence?: number;
  tags?: SessionFactTag[];
}): SessionFact {
  return {
    id: createFactId(input.subject, input.relation, input.object),
    subject: input.subject,
    relation: input.relation,
    object: input.object,
    tags: input.tags ?? ['decision'],
    validFrom: new Date(input.at),
    validTo: undefined,
    sourceTaskId: input.sourceTaskId,
    sourceRole: 'implementer',
    confidence: input.confidence ?? 1,
  };
}

function createAdapterMock(initialFacts: ReadonlyArray<SessionFact> = []): ISQLiteFactAdapter {
  return {
    initialize: vi.fn(),
    insertFacts: vi.fn(),
    invalidateFact: vi.fn(),
    loadValidFacts: vi.fn().mockReturnValue(initialFacts),
    loadValidGlobalFacts: vi.fn().mockReturnValue([]),
    pruneExpired: vi.fn().mockReturnValue(0),
    getStats: vi.fn().mockReturnValue({
      totalFacts: initialFacts.length,
      validFacts: initialFacts.length,
      globalFacts: 0,
      localFacts: initialFacts.length,
      entities: 0,
    }),
    close: vi.fn(),
  };
}

describe('GraphFactRetriever', () => {
  it('retrieves related facts by graph traversal up to max hops', () => {
    const factAB = buildFact({
      subject: 'src/parser.ts',
      relation: 'imports',
      object: 'utils/tokenizer.ts',
      sourceTaskId: '1',
      at: '2026-02-20T00:00:00.000Z',
      tags: ['dependency'],
    });
    const factBC = buildFact({
      subject: 'utils/tokenizer.ts',
      relation: 'calls',
      object: 'normalizeInput',
      sourceTaskId: '2',
      at: '2026-02-21T00:00:00.000Z',
      tags: ['decision'],
    });
    const adapter = createAdapterMock([factAB, factBC]);
    (
      adapter as ISQLiteFactAdapter & {
        isPersistenceAvailable: () => boolean;
      }
    ).isPersistenceAvailable = vi.fn().mockReturnValue(true);
    const store = new GraphSessionFactStore(adapter, 'session-knowledge-graph');
    const retriever = new GraphFactRetriever(store, { maxHops: 2 });

    const facts = retriever.retrieve({
      taskDescription: 'fix parser behavior',
      taskId: '99',
      tags: undefined,
      maxFacts: 10,
      maxTokens: 500,
    });
    const metrics = retriever.getLastRetrievalMetrics();

    expect(facts.map(fact => fact.id)).toEqual([factAB.id, factBC.id]);
    expect(metrics.factsRetrieved).toBe(2);
    expect(metrics.graphHopsUsed).toBe(1);
    expect(metrics.retrievalTimeMs).toBeGreaterThanOrEqual(0);
    expect(metrics.graphNodes).toBe(3);
    expect(metrics.graphEdges).toBe(2);
    expect(metrics.persistenceAvailable).toBe(true);
  });

  it('falls back to keyword retrieval with identical behavior when no entity matches', () => {
    const factOne = buildFact({
      subject: 'src/core/session/fact-retriever.ts',
      relation: 'modified_by',
      object: 'task:2 keyword retriever scoring',
      sourceTaskId: '2',
      at: '2026-02-20T00:00:00.000Z',
      tags: ['file_change'],
    });
    const factTwo = buildFact({
      subject: 'docs/notes.md',
      relation: 'summary',
      object: 'minor docs update',
      sourceTaskId: '1',
      at: '2026-02-21T00:00:00.000Z',
      tags: ['decision'],
    });
    const adapter = createAdapterMock([factOne, factTwo]);
    const store = new GraphSessionFactStore(adapter, 'session-knowledge-graph');
    const graphRetriever = new GraphFactRetriever(store);
    const keywordRetriever = new KeywordFactRetriever(store);
    const query = {
      taskDescription: 'galaxy nebula quasar',
      taskId: '8',
      tags: undefined,
      maxFacts: 10,
      maxTokens: 500,
    };

    const graphFacts = graphRetriever.retrieve(query);
    const keywordFacts = keywordRetriever.retrieve(query);
    const metrics = graphRetriever.getLastRetrievalMetrics();

    expect(graphFacts).toEqual(keywordFacts);
    expect(metrics.factsRetrieved).toBe(graphFacts.length);
    expect(metrics.graphHopsUsed).toBe(0);
    expect(metrics.retrievalTimeMs).toBeGreaterThanOrEqual(0);
  });

  it('excludes same-task facts and applies tag filtering', () => {
    const keep = buildFact({
      subject: 'task:1',
      relation: 'summary',
      object: 'shared architectural decision',
      sourceTaskId: '1',
      at: '2026-02-20T00:00:00.000Z',
      tags: ['decision'],
    });
    const sameTask = buildFact({
      subject: 'task:7',
      relation: 'summary',
      object: 'current task detail',
      sourceTaskId: '7',
      at: '2026-02-21T00:00:00.000Z',
      tags: ['decision'],
    });
    const wrongTag = buildFact({
      subject: 'task:9',
      relation: 'summary',
      object: 'testing note',
      sourceTaskId: '9',
      at: '2026-02-22T00:00:00.000Z',
      tags: ['test'],
    });
    const adapter = createAdapterMock([keep, sameTask, wrongTag]);
    const store = new GraphSessionFactStore(adapter, 'session-knowledge-graph');
    const retriever = new GraphFactRetriever(store);

    const facts = retriever.retrieve({
      taskDescription: 'update task summary',
      taskId: '7',
      tags: ['decision'],
      maxFacts: 10,
      maxTokens: 500,
    });

    expect(facts).toEqual([keep]);
  });

  it('enforces greedy token budget inclusion', () => {
    const first = buildFact({
      subject: 'src/core/session/very-long-file-name-one.ts',
      relation: 'modified_by',
      object: 'task:1 very long object text to consume token budget quickly',
      sourceTaskId: '1',
      at: '2026-02-20T00:00:00.000Z',
      tags: ['file_change'],
    });
    const second = buildFact({
      subject: 'src/core/session/very-long-file-name-two.ts',
      relation: 'modified_by',
      object: 'task:2 very long object text to consume token budget quickly',
      sourceTaskId: '2',
      at: '2026-02-21T00:00:00.000Z',
      tags: ['file_change'],
    });
    const adapter = createAdapterMock([first, second]);
    const store = new GraphSessionFactStore(adapter, 'session-knowledge-graph');
    const retriever = new GraphFactRetriever(store);

    const facts = retriever.retrieve({
      taskDescription: 'update very long file name',
      taskId: '9',
      tags: undefined,
      maxFacts: 10,
      maxTokens: 40,
    });

    expect(facts).toHaveLength(1);
    expect(facts[0]).toEqual(second);
  });
});
