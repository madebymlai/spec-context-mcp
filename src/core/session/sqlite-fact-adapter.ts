import Database from 'better-sqlite3';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { SessionFact, SessionFactTag } from './types.js';

export const ENTITY_TYPES = ['task', 'file', 'concept'] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

export const FACT_SCOPES = ['local', 'global'] as const;
export type FactScope = (typeof FACT_SCOPES)[number];

export interface StoredSessionFact extends SessionFact {
  readonly specName: string;
  readonly scope: FactScope;
}

export interface SQLiteFactRow {
  readonly id: string;
  readonly subject: string;
  readonly relation: string;
  readonly object: string;
  readonly tagsJson: string;
  readonly validFrom: string;
  readonly validTo: string | null;
  readonly sourceTaskId: string;
  readonly sourceRole: 'implementer' | 'reviewer';
  readonly confidence: number;
  readonly specName: string;
  readonly scope: FactScope;
}

export interface SQLiteFactAdapterStats {
  readonly totalFacts: number;
  readonly validFacts: number;
  readonly globalFacts: number;
  readonly localFacts: number;
  readonly entities: number;
}

export interface ISQLiteFactAdapter {
  initialize(): void;
  insertFacts(facts: ReadonlyArray<StoredSessionFact>): void;
  invalidateFact(factId: string, invalidatedAt?: Date): void;
  loadValidFacts(specName?: string): SessionFact[];
  loadValidGlobalFacts(): SessionFact[];
  pruneExpired(maxAgeDays: number): number;
  getStats(): SQLiteFactAdapterStats;
  close(): void;
}

export const SQLITE_SCHEMA_VERSION = 1;

export const SQL_CREATE_SCHEMA_VERSION_TABLE = `
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
)`;

export const SQL_CREATE_ENTITIES_TABLE = `
CREATE TABLE IF NOT EXISTS entities (
  entity_key TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('task', 'file', 'concept')),
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL
)`;

export const SQL_CREATE_FACTS_TABLE = `
CREATE TABLE IF NOT EXISTS facts (
  id TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  relation TEXT NOT NULL,
  object TEXT NOT NULL,
  tags_json TEXT NOT NULL,
  valid_from TEXT NOT NULL,
  valid_to TEXT,
  source_task_id TEXT NOT NULL,
  source_role TEXT NOT NULL CHECK (source_role IN ('implementer', 'reviewer')),
  confidence REAL NOT NULL,
  spec_name TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('local', 'global'))
)`;

export const SQL_CREATE_FACTS_FTS_TABLE = `
CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5 (
  fact_id UNINDEXED,
  subject,
  relation,
  object,
  tags
)`;

export const SQL_CREATE_FACTS_VALID_TO_INDEX =
  'CREATE INDEX IF NOT EXISTS idx_facts_valid_to ON facts(valid_to)';
export const SQL_CREATE_FACTS_SUBJECT_INDEX =
  'CREATE INDEX IF NOT EXISTS idx_facts_subject ON facts(subject)';
export const SQL_CREATE_FACTS_OBJECT_INDEX =
  'CREATE INDEX IF NOT EXISTS idx_facts_object ON facts(object)';
export const SQL_CREATE_FACTS_SPEC_NAME_INDEX =
  'CREATE INDEX IF NOT EXISTS idx_facts_spec_name ON facts(spec_name)';
export const SQL_CREATE_FACTS_SCOPE_INDEX =
  'CREATE INDEX IF NOT EXISTS idx_facts_scope ON facts(scope)';
export const SQL_CREATE_FACTS_SOURCE_TASK_ID_INDEX =
  'CREATE INDEX IF NOT EXISTS idx_facts_source_task_id ON facts(source_task_id)';

export const SQLITE_SCHEMA_STATEMENTS = [
  SQL_CREATE_SCHEMA_VERSION_TABLE,
  SQL_CREATE_ENTITIES_TABLE,
  SQL_CREATE_FACTS_TABLE,
  SQL_CREATE_FACTS_FTS_TABLE,
  SQL_CREATE_FACTS_VALID_TO_INDEX,
  SQL_CREATE_FACTS_SUBJECT_INDEX,
  SQL_CREATE_FACTS_OBJECT_INDEX,
  SQL_CREATE_FACTS_SPEC_NAME_INDEX,
  SQL_CREATE_FACTS_SCOPE_INDEX,
  SQL_CREATE_FACTS_SOURCE_TASK_ID_INDEX,
] as const;

export const SQL_INSERT_SCHEMA_VERSION = `
INSERT INTO schema_version (version, applied_at)
VALUES (?, ?)
ON CONFLICT(version) DO UPDATE SET applied_at = excluded.applied_at`;

export const SQL_INSERT_ENTITY = `
INSERT INTO entities (entity_key, entity_type, first_seen, last_seen)
VALUES (?, ?, ?, ?)
ON CONFLICT(entity_key) DO UPDATE SET
  entity_type = excluded.entity_type,
  first_seen = MIN(first_seen, excluded.first_seen),
  last_seen = MAX(last_seen, excluded.last_seen)`;

export const SQL_INSERT_FACT = `
INSERT INTO facts (
  id,
  subject,
  relation,
  object,
  tags_json,
  valid_from,
  valid_to,
  source_task_id,
  source_role,
  confidence,
  spec_name,
  scope
)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
  subject = excluded.subject,
  relation = excluded.relation,
  object = excluded.object,
  tags_json = excluded.tags_json,
  valid_from = excluded.valid_from,
  valid_to = excluded.valid_to,
  source_task_id = excluded.source_task_id,
  source_role = excluded.source_role,
  confidence = excluded.confidence,
  spec_name = excluded.spec_name,
  scope = excluded.scope`;

export const SQL_INSERT_FACTS_FTS = `
INSERT INTO facts_fts (fact_id, subject, relation, object, tags)
VALUES (?, ?, ?, ?, ?)`;
export const SQL_DELETE_FACTS_FTS_BY_ID = 'DELETE FROM facts_fts WHERE fact_id = ?';

export const SQL_INVALIDATE_FACT = `
UPDATE facts
SET valid_to = ?
WHERE id = ?`;

export const SQL_SELECT_VALID_FACTS_BY_SPEC = `
SELECT
  id,
  subject,
  relation,
  object,
  tags_json,
  valid_from,
  valid_to,
  source_task_id,
  source_role,
  confidence
FROM facts
WHERE valid_to IS NULL
  AND spec_name = ?`;

export const SQL_SELECT_ALL_VALID_FACTS = `
SELECT
  id,
  subject,
  relation,
  object,
  tags_json,
  valid_from,
  valid_to,
  source_task_id,
  source_role,
  confidence
FROM facts
WHERE valid_to IS NULL`;

export const SQL_SELECT_VALID_GLOBAL_FACTS = `
SELECT
  id,
  subject,
  relation,
  object,
  tags_json,
  valid_from,
  valid_to,
  source_task_id,
  source_role,
  confidence
FROM facts
WHERE valid_to IS NULL
  AND scope = ?`;

export const SQL_PRUNE_EXPIRED_FACTS = `
DELETE FROM facts
WHERE valid_to IS NOT NULL
  AND valid_to < ?`;

export const SQL_COUNT_TOTAL_FACTS = 'SELECT COUNT(*) AS total FROM facts';
export const SQL_COUNT_VALID_FACTS = 'SELECT COUNT(*) AS total FROM facts WHERE valid_to IS NULL';
export const SQL_COUNT_GLOBAL_FACTS = "SELECT COUNT(*) AS total FROM facts WHERE valid_to IS NULL AND scope = 'global'";
export const SQL_COUNT_LOCAL_FACTS = "SELECT COUNT(*) AS total FROM facts WHERE valid_to IS NULL AND scope = 'local'";
export const SQL_COUNT_ENTITIES = 'SELECT COUNT(*) AS total FROM entities';

interface SQLiteSelectedFactRow {
  readonly id: string;
  readonly subject: string;
  readonly relation: string;
  readonly object: string;
  readonly tags_json: string;
  readonly valid_from: string;
  readonly valid_to: string | null;
  readonly source_task_id: string;
  readonly source_role: 'implementer' | 'reviewer';
  readonly confidence: number;
}

interface SQLiteCountRow {
  readonly total: number;
}

function inferEntityType(entityKey: string): EntityType {
  if (entityKey.startsWith('task:')) {
    return 'task';
  }
  if (entityKey.includes('/') || entityKey.includes('\\') || entityKey.includes('.')) {
    return 'file';
  }
  return 'concept';
}

function toSQLiteFactRow(fact: StoredSessionFact): SQLiteFactRow {
  return {
    id: fact.id,
    subject: fact.subject,
    relation: fact.relation,
    object: fact.object,
    tagsJson: JSON.stringify(fact.tags),
    validFrom: fact.validFrom.toISOString(),
    validTo: fact.validTo ? fact.validTo.toISOString() : null,
    sourceTaskId: fact.sourceTaskId,
    sourceRole: fact.sourceRole,
    confidence: fact.confidence,
    specName: fact.specName,
    scope: fact.scope,
  };
}

function toSessionFact(row: SQLiteSelectedFactRow): SessionFact {
  return {
    id: row.id,
    subject: row.subject,
    relation: row.relation,
    object: row.object,
    tags: JSON.parse(row.tags_json) as SessionFactTag[],
    validFrom: new Date(row.valid_from),
    validTo: row.valid_to ? new Date(row.valid_to) : undefined,
    sourceTaskId: row.source_task_id,
    sourceRole: row.source_role,
    confidence: row.confidence,
  };
}

export class SQLiteFactAdapter implements ISQLiteFactAdapter {
  private db: Database.Database | undefined;
  private persistenceAvailable = true;

  constructor(
    private readonly databasePath: string = resolve(process.cwd(), '.spec-context', 'knowledge-graph.db'),
  ) {}

  isPersistenceAvailable(): boolean {
    return this.persistenceAvailable;
  }

  initialize(): void {
    if (this.db) {
      return;
    }

    let openedDb: Database.Database | undefined;
    try {
      this.ensureDatabaseFile();
      openedDb = new Database(this.databasePath);
      const db = openedDb;
      db.pragma('journal_mode = WAL');

      const initializeSchema = db.transaction(() => {
        for (const statement of SQLITE_SCHEMA_STATEMENTS) {
          db.prepare(statement).run();
        }
        db.prepare(SQL_INSERT_SCHEMA_VERSION).run(SQLITE_SCHEMA_VERSION, new Date().toISOString());
      });

      initializeSchema();
      this.db = db;
      this.persistenceAvailable = true;
    } catch (error) {
      openedDb?.close();
      this.db = undefined;
      this.persistenceAvailable = false;
      console.warn(`[SQLiteFactAdapter] Persistence unavailable at "${this.databasePath}"`, error);
    }
  }

  insertFacts(facts: ReadonlyArray<StoredSessionFact>): void {
    const db = this.db;
    if (!db || facts.length === 0) {
      return;
    }

    const insertFactsTransaction = db.transaction((batch: ReadonlyArray<StoredSessionFact>) => {
      const insertEntity = db.prepare(SQL_INSERT_ENTITY);
      const insertFact = db.prepare(SQL_INSERT_FACT);
      const insertFactFts = db.prepare(SQL_INSERT_FACTS_FTS);
      const deleteFactFtsById = db.prepare(SQL_DELETE_FACTS_FTS_BY_ID);

      for (const fact of batch) {
        const row = toSQLiteFactRow(fact);
        insertEntity.run(row.subject, inferEntityType(row.subject), row.validFrom, row.validFrom);
        insertEntity.run(row.object, inferEntityType(row.object), row.validFrom, row.validFrom);
        insertFact.run(
          row.id,
          row.subject,
          row.relation,
          row.object,
          row.tagsJson,
          row.validFrom,
          row.validTo,
          row.sourceTaskId,
          row.sourceRole,
          row.confidence,
          row.specName,
          row.scope,
        );
        deleteFactFtsById.run(row.id);
        insertFactFts.run(row.id, row.subject, row.relation, row.object, row.tagsJson);
      }
    });

    insertFactsTransaction(facts);
  }

  invalidateFact(factId: string, invalidatedAt?: Date): void {
    const db = this.db;
    if (!db) {
      return;
    }
    db.prepare(SQL_INVALIDATE_FACT).run((invalidatedAt ?? new Date()).toISOString(), factId);
  }

  loadValidFacts(specName?: string): SessionFact[] {
    const db = this.db;
    if (!db) {
      return [];
    }

    if (specName) {
      const rows = db.prepare<[string], SQLiteSelectedFactRow>(SQL_SELECT_VALID_FACTS_BY_SPEC).all(specName);
      return rows.map(toSessionFact);
    }

    const rows = db.prepare<[], SQLiteSelectedFactRow>(SQL_SELECT_ALL_VALID_FACTS).all();
    return rows.map(toSessionFact);
  }

  loadValidGlobalFacts(): SessionFact[] {
    const db = this.db;
    if (!db) {
      return [];
    }
    const rows = db.prepare<[FactScope], SQLiteSelectedFactRow>(SQL_SELECT_VALID_GLOBAL_FACTS).all('global');
    return rows.map(toSessionFact);
  }

  pruneExpired(maxAgeDays: number): number {
    const db = this.db;
    if (!db) {
      return 0;
    }

    const threshold = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString();
    const result = db.prepare<[string]>(SQL_PRUNE_EXPIRED_FACTS).run(threshold);
    return result.changes;
  }

  getStats(): SQLiteFactAdapterStats {
    const db = this.db;
    if (!db) {
      return {
        totalFacts: 0,
        validFacts: 0,
        globalFacts: 0,
        localFacts: 0,
        entities: 0,
      };
    }

    return {
      totalFacts: this.count(db, SQL_COUNT_TOTAL_FACTS),
      validFacts: this.count(db, SQL_COUNT_VALID_FACTS),
      globalFacts: this.count(db, SQL_COUNT_GLOBAL_FACTS),
      localFacts: this.count(db, SQL_COUNT_LOCAL_FACTS),
      entities: this.count(db, SQL_COUNT_ENTITIES),
    };
  }

  close(): void {
    this.db?.close();
    this.db = undefined;
  }

  private ensureDatabaseFile(): void {
    mkdirSync(dirname(this.databasePath), { recursive: true });
    if (existsSync(this.databasePath)) {
      if (statSync(this.databasePath).isDirectory()) {
        throw new Error(`Database path must be a file: ${this.databasePath}`);
      }
    } else {
      const fd = openSync(this.databasePath, 'w', 0o600);
      closeSync(fd);
    }
    chmodSync(this.databasePath, 0o600);
  }

  private count(db: Database.Database, sql: string): number {
    const row = db.prepare<[], SQLiteCountRow>(sql).get();
    return row!.total;
  }
}
