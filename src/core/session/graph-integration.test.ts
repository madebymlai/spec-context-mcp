import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ImplementerResult } from '../../tools/workflow/dispatch-contract-schemas.js';
import { KeywordFactRetriever } from './fact-retriever.js';
import { RuleBasedFactExtractor } from './fact-extractor.js';
import { GraphFactRetriever } from './graph-fact-retriever.js';
import { GraphSessionFactStore } from './graph-session-fact-store.js';
import { SQLiteFactAdapter } from './sqlite-fact-adapter.js';
import type { FactScope, StoredSessionFact } from './sqlite-fact-adapter.js';
import { createFactId, type SessionFact, type SessionFactTag } from './types.js';

const cleanupCallbacks: Array<() => void> = [];

afterEach(() => {
  while (cleanupCallbacks.length > 0) {
    const callback = cleanupCallbacks.pop();
    callback?.();
  }
});

function createTempDirectory(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanupCallbacks.push(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function createTempDatabasePath(prefix: string): string {
  return join(createTempDirectory(prefix), 'knowledge-graph.db');
}

function createAdapter(databasePath: string): SQLiteFactAdapter {
  const adapter = new SQLiteFactAdapter(databasePath);
  adapter.initialize();
  cleanupCallbacks.push(() => {
    adapter.close();
  });
  return adapter;
}

function createFact(input: {
  subject: string;
  relation: string;
  object: string;
  sourceTaskId: string;
  validFrom: string;
  tags?: SessionFactTag[];
  sourceRole?: 'implementer' | 'reviewer';
  confidence?: number;
}): SessionFact {
  return {
    id: createFactId(input.subject, input.relation, input.object),
    subject: input.subject,
    relation: input.relation,
    object: input.object,
    tags: input.tags ?? ['decision'],
    validFrom: new Date(input.validFrom),
    validTo: undefined,
    sourceTaskId: input.sourceTaskId,
    sourceRole: input.sourceRole ?? 'implementer',
    confidence: input.confidence ?? 1,
  };
}

function toStoredFact(fact: SessionFact, specName: string, scope: FactScope): StoredSessionFact {
  return {
    ...fact,
    specName,
    scope,
  };
}

describe('graph session integration', () => {
  it('full pipeline extracts implementer facts then retrieves relevant graph facts', () => {
    const databasePath = createTempDatabasePath('graph-integration-pipeline-');
    const adapter = createAdapter(databasePath);
    const store = new GraphSessionFactStore(adapter, 'spec-pipeline');
    const retriever = new GraphFactRetriever(store);
    const extractor = new RuleBasedFactExtractor();

    const result: ImplementerResult = {
      task_id: '1',
      status: 'completed',
      summary: 'Implemented retrieval improvements in graph retriever',
      files_changed: ['src/core/session/graph-fact-retriever.ts'],
      tests: [{ command: 'npm test -- src/core/session --run', passed: true }],
      follow_up_actions: ['Add integration coverage'],
    };

    store.add(extractor.extractFromImplementer(result, '1'));

    const retrieved = retriever.retrieve({
      taskDescription: 'update src/core/session/graph-fact-retriever.ts behavior',
      taskId: '2',
      tags: undefined,
      maxFacts: 20,
      maxTokens: 1000,
    });

    expect(retrieved.length).toBeGreaterThan(0);
    expect(retrieved.some(fact => fact.subject === 'src/core/session/graph-fact-retriever.ts')).toBe(true);
  });

  it('persists facts and loads them in a new graph store from the same sqlite file', () => {
    const databasePath = createTempDatabasePath('graph-integration-roundtrip-');
    const writerAdapter = createAdapter(databasePath);
    const writerStore = new GraphSessionFactStore(writerAdapter, 'spec-roundtrip');

    const factA = createFact({
      subject: 'src/a.ts',
      relation: 'modified_by',
      object: 'task:1',
      sourceTaskId: '1',
      validFrom: '2026-02-27T00:00:00.000Z',
      tags: ['file_change'],
    });
    const factB = createFact({
      subject: 'task:1',
      relation: 'summary',
      object: 'round trip validation',
      sourceTaskId: '1',
      validFrom: '2026-02-27T01:00:00.000Z',
      tags: ['decision'],
    });

    writerStore.add([factA, factB]);
    writerAdapter.close();

    const readerAdapter = createAdapter(databasePath);
    const readerStore = new GraphSessionFactStore(readerAdapter, 'spec-roundtrip');
    const readerRetriever = new GraphFactRetriever(readerStore);

    const loadedIds = new Set(readerStore.getValid().map(fact => fact.id));
    expect(loadedIds.has(factA.id)).toBe(true);
    expect(loadedIds.has(factB.id)).toBe(true);

    const retrieved = readerRetriever.retrieve({
      taskDescription: 'change src/a.ts and validate round trip',
      taskId: '2',
      tags: undefined,
      maxFacts: 10,
      maxTokens: 500,
    });
    expect(retrieved.map(fact => fact.id)).toContain(factA.id);
  });

  it('enforces cross-spec isolation while still loading global facts', () => {
    const databasePath = createTempDatabasePath('graph-integration-isolation-');
    const adapter = createAdapter(databasePath);

    const specAStore = new GraphSessionFactStore(adapter, 'spec-A');
    const localSpecAFact = createFact({
      subject: 'src/spec-a.ts',
      relation: 'modified_by',
      object: 'task:10',
      sourceTaskId: '10',
      validFrom: '2026-02-27T00:00:00.000Z',
      tags: ['file_change'],
    });
    specAStore.add([localSpecAFact]);

    const specBStore = new GraphSessionFactStore(adapter, 'spec-B');
    const localSpecBFact = createFact({
      subject: 'src/spec-b.ts',
      relation: 'modified_by',
      object: 'task:20',
      sourceTaskId: '20',
      validFrom: '2026-02-27T01:00:00.000Z',
      tags: ['file_change'],
    });
    specBStore.add([localSpecBFact]);

    const globalFact = createFact({
      subject: 'package.json',
      relation: 'depends_on',
      object: 'graphology',
      sourceTaskId: '30',
      validFrom: '2026-02-27T02:00:00.000Z',
      tags: ['dependency'],
    });
    adapter.insertFacts([toStoredFact(globalFact, 'shared', 'global')]);

    const reloadedSpecAStore = new GraphSessionFactStore(adapter, 'spec-A');
    const reloadedRetriever = new GraphFactRetriever(reloadedSpecAStore);

    const visibleFactIds = new Set(reloadedSpecAStore.getValid().map(fact => fact.id));
    expect(visibleFactIds.has(localSpecAFact.id)).toBe(true);
    expect(visibleFactIds.has(localSpecBFact.id)).toBe(false);
    expect(visibleFactIds.has(globalFact.id)).toBe(true);

    const retrieved = reloadedRetriever.retrieve({
      taskDescription: 'update package.json and src/spec-a.ts',
      taskId: '40',
      tags: undefined,
      maxFacts: 10,
      maxTokens: 500,
    });

    expect(retrieved.map(fact => fact.id)).not.toContain(localSpecBFact.id);
    expect(retrieved.map(fact => fact.id)).toContain(globalFact.id);
  });

  it('invalidates older facts temporally while retaining them in sqlite history', () => {
    const databasePath = createTempDatabasePath('graph-integration-invalidation-');
    const adapter = createAdapter(databasePath);
    const store = new GraphSessionFactStore(adapter, 'spec-temporal');

    const oldFact = createFact({
      subject: 'src/service.ts',
      relation: 'modified_by',
      object: 'task:1',
      sourceTaskId: '1',
      validFrom: '2026-02-20T00:00:00.000Z',
      tags: ['file_change'],
    });
    const newFact = createFact({
      subject: 'src/service.ts',
      relation: 'modified_by',
      object: 'task:2',
      sourceTaskId: '2',
      validFrom: '2026-02-21T00:00:00.000Z',
      tags: ['file_change'],
    });

    store.add([oldFact]);
    store.add([newFact]);

    const validIds = store.getValid().map(fact => fact.id);
    expect(validIds).toEqual([newFact.id]);

    const db = new Database(databasePath);
    cleanupCallbacks.push(() => {
      db.close();
    });
    const rows = db
      .prepare<[string, string], { id: string; valid_to: string | null }>(
        'SELECT id, valid_to FROM facts WHERE subject = ? AND relation = ? ORDER BY valid_from ASC',
      )
      .all('src/service.ts', 'modified_by');

    expect(rows).toHaveLength(2);
    expect(rows[0].id).toBe(oldFact.id);
    expect(rows[0].valid_to).not.toBeNull();
    expect(rows[1].id).toBe(newFact.id);
    expect(rows[1].valid_to).toBeNull();
  });

  it('finds chained facts via graph traversal that keyword-only retrieval misses', () => {
    const databasePath = createTempDatabasePath('graph-integration-traversal-');
    const adapter = createAdapter(databasePath);
    const store = new GraphSessionFactStore(adapter, 'spec-traversal');
    const graphRetriever = new GraphFactRetriever(store, { maxHops: 2 });
    const keywordRetriever = new KeywordFactRetriever(store);

    const factAB = createFact({
      subject: 'module-alpha',
      relation: 'depends_on',
      object: 'module-beta',
      sourceTaskId: '1',
      validFrom: '2020-01-01T00:00:00.000Z',
      tags: ['dependency'],
      confidence: 0.05,
    });
    const factBC = createFact({
      subject: 'module-beta',
      relation: 'depends_on',
      object: 'module-gamma',
      sourceTaskId: '2',
      validFrom: '2026-02-27T00:00:00.000Z',
      tags: ['dependency'],
      confidence: 1,
    });
    store.add([factAB, factBC]);

    const query = {
      taskDescription: 'refactor module-alpha behavior',
      taskId: '9',
      tags: undefined,
      maxFacts: 1,
      maxTokens: 100,
    };

    const graphFacts = graphRetriever.retrieve(query);
    const keywordFacts = keywordRetriever.retrieve(query);

    expect(graphFacts).toHaveLength(1);
    expect(graphFacts[0].id).toBe(factBC.id);
    expect(graphFacts[0].object).toBe('module-gamma');

    expect(keywordFacts).toHaveLength(1);
    expect(keywordFacts[0].id).toBe(factAB.id);
  });

  it('falls back to keyword scoring with identical results when no graph entities match', () => {
    const databasePath = createTempDatabasePath('graph-integration-keyword-fallback-');
    const adapter = createAdapter(databasePath);
    const store = new GraphSessionFactStore(adapter, 'spec-fallback');
    const graphRetriever = new GraphFactRetriever(store);
    const keywordRetriever = new KeywordFactRetriever(store);

    store.add([
      createFact({
        subject: 'src/core/session/fact-retriever.ts',
        relation: 'modified_by',
        object: 'task:3',
        sourceTaskId: '3',
        validFrom: '2026-02-27T00:00:00.000Z',
        tags: ['file_change'],
      }),
      createFact({
        subject: 'docs/notes.md',
        relation: 'summary',
        object: 'integration test notes',
        sourceTaskId: '4',
        validFrom: '2026-02-27T01:00:00.000Z',
        tags: ['decision'],
      }),
    ]);

    const query = {
      taskDescription: 'quasar nebula hypernova',
      taskId: '10',
      tags: undefined,
      maxFacts: 10,
      maxTokens: 200,
    };

    expect(graphRetriever.retrieve(query)).toEqual(keywordRetriever.retrieve(query));
  });

  it('compacts in-memory graph edges while sqlite keeps full fact history', () => {
    const databasePath = createTempDatabasePath('graph-integration-compaction-');
    const adapter = createAdapter(databasePath);
    const store = new GraphSessionFactStore(adapter, 'spec-compaction');

    const facts: SessionFact[] = [];
    for (let index = 0; index < 12; index += 1) {
      facts.push(createFact({
        subject: `task:${index}`,
        relation: 'summary',
        object: `fact-${index}`,
        sourceTaskId: String(index),
        validFrom: new Date(2026, 1, 1, index, 0, 0).toISOString(),
        tags: ['decision'],
      }));
    }
    store.add(facts);

    const oldestFact = facts[0];
    expect(store.count()).toBe(12);
    expect(adapter.getStats().totalFacts).toBe(12);

    store.compact(4);

    expect(store.count()).toBe(4);
    expect(store.getValid().map(fact => fact.id)).not.toContain(oldestFact.id);
    expect(adapter.getStats().totalFacts).toBe(12);

    const db = new Database(databasePath);
    cleanupCallbacks.push(() => {
      db.close();
    });
    const persistedCount = db.prepare<[], { total: number }>('SELECT COUNT(*) AS total FROM facts').get()!.total;
    const oldestPersisted = db
      .prepare<[string], { total: number }>('SELECT COUNT(*) AS total FROM facts WHERE id = ?')
      .get(oldestFact.id)!.total;

    expect(persistedCount).toBe(12);
    expect(oldestPersisted).toBe(1);
  });

  it('degrades gracefully to working in-memory behavior when sqlite init fails', () => {
    const invalidDatabasePath = createTempDirectory('graph-integration-invalid-path-');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    cleanupCallbacks.push(() => {
      warnSpy.mockRestore();
    });

    const adapter = new SQLiteFactAdapter(invalidDatabasePath);
    adapter.initialize();

    expect(adapter.isPersistenceAvailable()).toBe(false);
    expect(warnSpy).toHaveBeenCalled();

    const store = new GraphSessionFactStore(adapter, 'spec-memory-fallback');
    const retriever = new GraphFactRetriever(store);
    const fact = createFact({
      subject: 'src/fallback.ts',
      relation: 'modified_by',
      object: 'task:77',
      sourceTaskId: '77',
      validFrom: '2026-02-27T00:00:00.000Z',
      tags: ['file_change'],
    });
    store.add([fact]);

    const retrieved = retriever.retrieve({
      taskDescription: 'edit src/fallback.ts',
      taskId: '88',
      tags: undefined,
      maxFacts: 10,
      maxTokens: 200,
    });

    expect(store.count()).toBe(1);
    expect(retrieved.map(item => item.id)).toContain(fact.id);
    expect(adapter.getStats().totalFacts).toBe(0);
  });
});
