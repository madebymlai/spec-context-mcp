import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFactId } from './types.js';
import type { SessionFact, SessionFactTag } from './types.js';
import {
  ENTITY_TYPES,
  FACT_SCOPES,
  ISQLiteFactAdapter,
  SQLITE_SCHEMA_STATEMENTS,
  SQLITE_SCHEMA_VERSION,
  SQLiteFactAdapter,
  type FactScope,
  type StoredSessionFact,
} from './sqlite-fact-adapter.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sqlite-fact-adapter-'));
  tempDirs.push(dir);
  return dir;
}

function buildStoredFact(input: {
  subject: string;
  relation: string;
  object: string;
  tags: SessionFactTag[];
  sourceTaskId: string;
  validFrom: string;
  specName: string;
  scope: FactScope;
  sourceRole?: 'implementer' | 'reviewer';
  confidence?: number;
}): StoredSessionFact {
  return {
    id: createFactId(input.subject, input.relation, input.object),
    subject: input.subject,
    relation: input.relation,
    object: input.object,
    tags: input.tags,
    validFrom: new Date(input.validFrom),
    validTo: undefined,
    sourceTaskId: input.sourceTaskId,
    sourceRole: input.sourceRole ?? 'implementer',
    confidence: input.confidence ?? 1,
    specName: input.specName,
    scope: input.scope,
  };
}

function sanitizeFact(fact: SessionFact): SessionFact {
  return {
    id: fact.id,
    subject: fact.subject,
    relation: fact.relation,
    object: fact.object,
    validFrom: fact.validFrom,
    validTo: fact.validTo,
    sourceTaskId: fact.sourceTaskId,
    sourceRole: fact.sourceRole,
    confidence: fact.confidence,
    tags: [...fact.tags],
  };
}

describe('sqlite-fact-adapter schema contract', () => {
  it('defines the supported entity and fact scope types', () => {
    expect(ENTITY_TYPES).toEqual(['task', 'file', 'concept']);
    expect(FACT_SCOPES).toEqual(['local', 'global']);
  });

  it('defines schema statements for tables, indexes, and FTS', () => {
    const schema = SQLITE_SCHEMA_STATEMENTS.join('\n');

    expect(schema).toContain('CREATE TABLE IF NOT EXISTS schema_version');
    expect(schema).toContain('CREATE TABLE IF NOT EXISTS entities');
    expect(schema).toContain('CREATE TABLE IF NOT EXISTS facts');
    expect(schema).toContain('CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5');
    expect(schema).toContain('CREATE INDEX IF NOT EXISTS idx_facts_valid_to ON facts(valid_to)');
    expect(schema).toContain('CREATE INDEX IF NOT EXISTS idx_facts_subject ON facts(subject)');
    expect(schema).toContain('CREATE INDEX IF NOT EXISTS idx_facts_object ON facts(object)');
    expect(schema).toContain('CREATE INDEX IF NOT EXISTS idx_facts_spec_name ON facts(spec_name)');
    expect(schema).toContain('CREATE INDEX IF NOT EXISTS idx_facts_scope ON facts(scope)');
    expect(schema).toContain('CREATE INDEX IF NOT EXISTS idx_facts_source_task_id ON facts(source_task_id)');
    expect(SQLITE_SCHEMA_VERSION).toBe(1);
  });

  it('exposes the expected adapter interface surface', () => {
    const adapter: ISQLiteFactAdapter = {
      initialize: () => undefined,
      insertFacts: (_facts: ReadonlyArray<StoredSessionFact>) => undefined,
      invalidateFact: (_factId: string, _invalidatedAt?: Date) => undefined,
      loadValidFacts: (_specName?: string) => [],
      loadValidGlobalFacts: () => [],
      pruneExpired: (_maxAgeDays: number) => 0,
      getStats: () => ({
        totalFacts: 0,
        validFacts: 0,
        globalFacts: 0,
        localFacts: 0,
        entities: 0,
      }),
      close: () => undefined,
    };

    expect(typeof adapter.initialize).toBe('function');
    expect(typeof adapter.close).toBe('function');
  });
});

describe('SQLiteFactAdapter', () => {
  it('initializes schema, enables WAL mode, and creates database with 0600 permissions', () => {
    const tempDir = createTempDir();
    const dbPath = join(tempDir, 'knowledge-graph.db');
    const adapter = new SQLiteFactAdapter(dbPath);

    adapter.initialize();

    const mode = statSync(dbPath).mode & 0o777;
    expect(mode).toBe(0o600);

    const db = new Database(dbPath);
    try {
      const journalMode = db.pragma('journal_mode', { simple: true });
      expect(journalMode).toBe('wal');

      const row = db
        .prepare<[number], { count: number }>(
          'SELECT COUNT(*) AS count FROM schema_version WHERE version = ?',
        )
        .get(SQLITE_SCHEMA_VERSION);
      expect(row).toBeDefined();
      expect(row!.count).toBe(1);
    } finally {
      db.close();
      adapter.close();
    }
  });

  it('round-trips facts and supports filtering, invalidation, pruning, and stats', () => {
    const tempDir = createTempDir();
    const dbPath = join(tempDir, 'knowledge-graph.db');
    const adapter = new SQLiteFactAdapter(dbPath);
    adapter.initialize();

    const localFact = buildStoredFact({
      subject: 'src/core/session/sqlite-fact-adapter.ts',
      relation: 'modified_by',
      object: 'task:2',
      tags: ['file_change', 'decision'],
      sourceTaskId: '2',
      validFrom: '2026-02-27T00:00:00.000Z',
      specName: 'session-knowledge-graph',
      scope: 'local',
    });
    const globalFact = buildStoredFact({
      subject: 'package.json',
      relation: 'depends_on',
      object: 'better-sqlite3',
      tags: ['dependency'],
      sourceTaskId: '1',
      validFrom: '2026-02-26T00:00:00.000Z',
      specName: 'session-knowledge-graph',
      scope: 'global',
    });

    adapter.insertFacts([localFact, globalFact]);

    expect(adapter.loadValidFacts('session-knowledge-graph').map(sanitizeFact)).toEqual([
      sanitizeFact(localFact),
      sanitizeFact(globalFact),
    ]);
    expect(adapter.loadValidFacts().map(sanitizeFact)).toEqual([
      sanitizeFact(localFact),
      sanitizeFact(globalFact),
    ]);
    expect(adapter.loadValidGlobalFacts().map(sanitizeFact)).toEqual([sanitizeFact(globalFact)]);

    const invalidatedAt = new Date('2024-01-01T00:00:00.000Z');
    adapter.invalidateFact(localFact.id, invalidatedAt);
    expect(adapter.loadValidFacts('session-knowledge-graph').map(sanitizeFact)).toEqual([sanitizeFact(globalFact)]);

    const deleted = adapter.pruneExpired(30);
    expect(deleted).toBe(1);

    expect(adapter.getStats()).toEqual({
      totalFacts: 1,
      validFacts: 1,
      globalFacts: 1,
      localFacts: 0,
      entities: 4,
    });

    adapter.close();
  });

  it('upserts when inserting an existing fact id instead of throwing unique constraint errors', () => {
    const tempDir = createTempDir();
    const dbPath = join(tempDir, 'knowledge-graph.db');
    const adapter = new SQLiteFactAdapter(dbPath);
    adapter.initialize();

    const original = buildStoredFact({
      subject: 'src/core/session/sqlite-fact-adapter.ts',
      relation: 'modified_by',
      object: 'task:2',
      tags: ['file_change'],
      sourceTaskId: '2',
      validFrom: '2026-02-27T00:00:00.000Z',
      specName: 'session-knowledge-graph',
      scope: 'local',
    });
    const refreshed = {
      ...original,
      sourceTaskId: '99',
      validFrom: new Date('2026-02-28T00:00:00.000Z'),
      confidence: 0.7,
    };

    adapter.insertFacts([original]);
    adapter.insertFacts([refreshed]);

    const loaded = adapter.loadValidFacts('session-knowledge-graph');
    expect(loaded).toHaveLength(1);
    expect(loaded[0].id).toBe(original.id);
    expect(loaded[0].sourceTaskId).toBe('99');
    expect(loaded[0].confidence).toBe(0.7);

    const db = new Database(dbPath);
    try {
      const ftsCount = db
        .prepare<[string], { total: number }>('SELECT COUNT(*) AS total FROM facts_fts WHERE fact_id = ?')
        .get(original.id);
      expect(ftsCount?.total).toBe(1);
    } finally {
      db.close();
      adapter.close();
    }
  });

  it('degrades gracefully when the database cannot be opened', () => {
    const tempDir = createTempDir();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const adapter = new SQLiteFactAdapter(tempDir);

    adapter.initialize();

    expect(adapter.isPersistenceAvailable()).toBe(false);
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(adapter.loadValidFacts()).toEqual([]);
    expect(adapter.loadValidGlobalFacts()).toEqual([]);
    expect(adapter.pruneExpired(30)).toBe(0);
    expect(adapter.getStats()).toEqual({
      totalFacts: 0,
      validFacts: 0,
      globalFacts: 0,
      localFacts: 0,
      entities: 0,
    });

    adapter.close();
    warnSpy.mockRestore();
  });
});
