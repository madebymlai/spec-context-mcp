import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFactId, type SessionFact } from './types.js';
import { GraphSessionFactStore } from './graph-session-fact-store.js';
import type { ISQLiteFactAdapter } from './sqlite-fact-adapter.js';

interface AdapterMockSetup {
  readonly localFacts?: ReadonlyArray<SessionFact>;
  readonly globalFacts?: ReadonlyArray<SessionFact>;
}

function buildFact(input: {
  subject: string;
  relation: string;
  object: string;
  sourceTaskId: string;
  at: string;
  tags?: SessionFact['tags'];
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
    confidence: 1,
  };
}

function createAdapterMock(setup: AdapterMockSetup = {}): ISQLiteFactAdapter {
  return {
    initialize: vi.fn(),
    insertFacts: vi.fn(),
    invalidateFact: vi.fn(),
    loadValidFacts: vi.fn().mockReturnValue(setup.localFacts ?? []),
    loadValidGlobalFacts: vi.fn().mockReturnValue(setup.globalFacts ?? []),
    pruneExpired: vi.fn().mockReturnValue(0),
    getStats: vi.fn().mockReturnValue({
      totalFacts: 0,
      validFacts: 0,
      globalFacts: 0,
      localFacts: 0,
      entities: 0,
    }),
    close: vi.fn(),
  };
}

describe('GraphSessionFactStore', () => {
  let localFact: SessionFact;
  let globalFact: SessionFact;

  beforeEach(() => {
    localFact = buildFact({
      subject: 'src/core/session/graph-session-fact-store.ts',
      relation: 'modified_by',
      object: 'task:3',
      sourceTaskId: '3',
      at: '2026-02-27T01:00:00.000Z',
      tags: ['file_change'],
    });
    globalFact = buildFact({
      subject: 'package.json',
      relation: 'depends_on',
      object: 'graphology',
      sourceTaskId: '1',
      at: '2026-02-26T00:00:00.000Z',
      tags: ['dependency'],
    });
  });

  it('loads local and global facts into the graph on construction', () => {
    const adapter = createAdapterMock({ localFacts: [localFact], globalFacts: [globalFact] });

    const store = new GraphSessionFactStore(adapter, 'session-knowledge-graph');

    expect(adapter.loadValidFacts).toHaveBeenCalledWith('session-knowledge-graph');
    expect(adapter.loadValidGlobalFacts).toHaveBeenCalledTimes(1);
    expect(store.count()).toBe(2);
    expect(store.getValid().map(fact => fact.id).sort()).toEqual([globalFact.id, localFact.id].sort());

    const graph = store.getGraph();
    expect(graph.hasNode(localFact.subject)).toBe(true);
    expect(graph.hasNode(localFact.object)).toBe(true);
    expect(graph.hasEdge(localFact.id)).toBe(true);
    expect(graph.getNodeAttribute('task:3', 'entityType')).toBe('task');
    expect(graph.getNodeAttribute('src/core/session/graph-session-fact-store.ts', 'entityType')).toBe('file');
    expect(graph.getNodeAttribute('graphology', 'entityType')).toBe('concept');
  });

  it('adds a fact with write-through to sqlite and auto-invalidates matching relation', () => {
    const olderFact = buildFact({
      subject: 'src/core/session/index.ts',
      relation: 'modified_by',
      object: 'task:1',
      sourceTaskId: '1',
      at: '2026-02-20T00:00:00.000Z',
      tags: ['file_change'],
    });
    const adapter = createAdapterMock({ localFacts: [olderFact] });
    const store = new GraphSessionFactStore(adapter, 'session-knowledge-graph');

    const replacement = buildFact({
      subject: 'src/core/session/index.ts',
      relation: 'modified_by',
      object: 'task:3',
      sourceTaskId: '3',
      at: '2026-02-27T00:00:00.000Z',
      tags: ['file_change'],
    });

    store.add([replacement]);

    expect(adapter.invalidateFact).toHaveBeenCalledWith(olderFact.id, expect.any(Date));
    expect(adapter.insertFacts).toHaveBeenCalledWith([
      {
        ...replacement,
        specName: 'session-knowledge-graph',
        scope: 'local',
      },
    ]);
    expect(store.getValid()).toEqual([replacement]);
    expect(store.getFactById(replacement.id)).toEqual(replacement);
    expect(store.getFactById(olderFact.id)).toBeUndefined();
    expect(store.getFactsForEntity('src/core/session/index.ts')).toEqual([replacement]);
  });

  it('invalidates subject+relation facts and removes graph edges', () => {
    const adapter = createAdapterMock({ localFacts: [localFact] });
    const store = new GraphSessionFactStore(adapter, 'session-knowledge-graph');

    store.invalidate(localFact.subject, localFact.relation);

    expect(adapter.invalidateFact).toHaveBeenCalledWith(localFact.id, expect.any(Date));
    expect(store.count()).toBe(0);
    expect(store.getValid()).toEqual([]);
    expect(store.getGraph().hasEdge(localFact.id)).toBe(false);
  });

  it('filters by tags and compacts oldest valid facts', () => {
    const adapter = createAdapterMock();
    const store = new GraphSessionFactStore(adapter, 'session-knowledge-graph');

    const first = buildFact({
      subject: 'task:1',
      relation: 'summary',
      object: 'first',
      sourceTaskId: '1',
      at: '2026-02-20T00:00:00.000Z',
      tags: ['decision'],
    });
    const second = buildFact({
      subject: 'task:2',
      relation: 'summary',
      object: 'second',
      sourceTaskId: '2',
      at: '2026-02-21T00:00:00.000Z',
      tags: ['test'],
    });
    const third = buildFact({
      subject: 'task:3',
      relation: 'summary',
      object: 'third',
      sourceTaskId: '3',
      at: '2026-02-22T00:00:00.000Z',
      tags: ['decision'],
    });

    store.add([first, second, third]);

    expect(store.getValidByTags(['decision']).map(fact => fact.id).sort()).toEqual([first.id, third.id].sort());

    store.compact(2);

    expect(store.count()).toBe(2);
    expect(store.getFactById(first.id)).toBeUndefined();
    expect(store.getFactById(second.id)).toEqual(second);
    expect(store.getFactById(third.id)).toEqual(third);
  });

  it('returns graph stats with persistence availability', () => {
    const adapter = createAdapterMock({ localFacts: [localFact], globalFacts: [globalFact] });
    adapter.getStats = vi.fn().mockReturnValue({
      totalFacts: 7,
      validFacts: 2,
      globalFacts: 1,
      localFacts: 1,
      entities: 4,
    });
    (
      adapter as ISQLiteFactAdapter & {
        isPersistenceAvailable: () => boolean;
      }
    ).isPersistenceAvailable = vi.fn().mockReturnValue(true);
    const store = new GraphSessionFactStore(adapter, 'session-knowledge-graph');

    const stats = store.getStats();

    expect(stats).toEqual({
      totalFacts: 7,
      validFacts: 2,
      entities: 4,
      persistenceAvailable: true,
    });
  });
});
