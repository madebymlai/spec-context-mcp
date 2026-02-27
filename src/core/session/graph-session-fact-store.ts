import { DirectedGraph } from 'graphology';
import type { ISQLiteFactAdapter, StoredSessionFact } from './sqlite-fact-adapter.js';
import type { EntityType, FactScope } from './sqlite-fact-adapter.js';
import type { ISessionFactStore, SessionFact, SessionFactTag } from './types.js';

interface EntityNodeAttributes {
  readonly entityType: EntityType;
  readonly firstSeen: Date;
  readonly lastSeen: Date;
}

interface FactEdgeAttributes {
  readonly fact: SessionFact;
}

export interface GraphSessionFactStoreStats {
  readonly totalFacts: number;
  readonly validFacts: number;
  readonly entities: number;
  readonly persistenceAvailable: boolean;
}

function inferEntityType(entityKey: string): EntityType {
  if (entityKey.startsWith('task:')) {
    return 'task';
  }

  if (entityKey.includes('/') || entityKey.includes('\\') || /\.[a-z0-9]+$/i.test(entityKey)) {
    return 'file';
  }

  return 'concept';
}

function inferFactScope(_fact: SessionFact): FactScope {
  return 'local';
}

function toStoredFact(fact: SessionFact, specName: string): StoredSessionFact {
  return {
    ...fact,
    specName,
    scope: inferFactScope(fact),
  };
}

export class GraphSessionFactStore implements ISessionFactStore {
  private readonly graph = new DirectedGraph<EntityNodeAttributes, FactEdgeAttributes>();
  private totalFacts = 0;
  private readonly persistenceAvailable: boolean;

  constructor(
    private readonly adapter: ISQLiteFactAdapter,
    private readonly specName: string,
  ) {
    const adapterStats = this.adapter.getStats();
    this.totalFacts = adapterStats.totalFacts;
    this.persistenceAvailable = this.resolvePersistenceAvailability();
    const localFacts = this.adapter.loadValidFacts(specName);
    const globalFacts = this.adapter.loadValidGlobalFacts();
    this.loadInitialFacts(localFacts, globalFacts);
  }

  add(facts: SessionFact[]): void {
    const insertedFacts: StoredSessionFact[] = [];

    for (const fact of facts) {
      this.invalidateMatchingFacts(fact.subject, fact.relation, new Date());
      this.upsertEntityNode(fact.subject, fact.validFrom);
      this.upsertEntityNode(fact.object, fact.validFrom);
      this.upsertEdge(fact);
      insertedFacts.push(toStoredFact(fact, this.specName));
    }

    this.adapter.insertFacts(insertedFacts);
    this.totalFacts += insertedFacts.length;
  }

  invalidate(subject: string, relation: string): void {
    this.invalidateMatchingFacts(subject, relation, new Date());
  }

  getValid(): SessionFact[] {
    return this.graph.mapEdges((_edgeKey, attributes) => attributes.fact);
  }

  getValidByTags(tags: SessionFactTag[]): SessionFact[] {
    const tagSet = new Set(tags);
    return this.getValid().filter(fact => fact.tags.some(tag => tagSet.has(tag)));
  }

  count(): number {
    return this.graph.size;
  }

  compact(maxFacts: number): void {
    if (maxFacts < 0) {
      return;
    }
    if (this.graph.size <= maxFacts) {
      return;
    }

    const oldestFactsFirst = this.getValid().sort(
      (left, right) => left.validFrom.valueOf() - right.validFrom.valueOf(),
    );
    const removeCount = this.graph.size - maxFacts;

    for (let index = 0; index < removeCount; index += 1) {
      const fact = oldestFactsFirst[index];
      this.graph.dropEdge(fact.id);
    }
  }

  getGraph(): DirectedGraph<EntityNodeAttributes, FactEdgeAttributes> {
    return this.graph;
  }

  getFactById(factId: string): SessionFact | undefined {
    if (!this.graph.hasEdge(factId)) {
      return undefined;
    }
    return this.graph.getEdgeAttribute(factId, 'fact');
  }

  getFactsForEntity(entityKey: string): SessionFact[] {
    if (!this.graph.hasNode(entityKey)) {
      return [];
    }

    const incidentEdgeKeys = this.graph.edges(entityKey);
    return incidentEdgeKeys.map(edgeKey => this.graph.getEdgeAttribute(edgeKey, 'fact'));
  }

  getStats(): GraphSessionFactStoreStats {
    return {
      totalFacts: this.totalFacts,
      validFacts: this.graph.size,
      entities: this.graph.order,
      persistenceAvailable: this.persistenceAvailable,
    };
  }

  private loadInitialFacts(localFacts: ReadonlyArray<SessionFact>, globalFacts: ReadonlyArray<SessionFact>): void {
    const uniqueFacts = new Map<string, SessionFact>();

    for (const fact of localFacts) {
      uniqueFacts.set(fact.id, fact);
    }
    for (const fact of globalFacts) {
      uniqueFacts.set(fact.id, fact);
    }

    for (const fact of uniqueFacts.values()) {
      this.upsertEntityNode(fact.subject, fact.validFrom);
      this.upsertEntityNode(fact.object, fact.validFrom);
      this.upsertEdge(fact);
    }
  }

  private invalidateMatchingFacts(subject: string, relation: string, invalidatedAt: Date): void {
    if (!this.graph.hasNode(subject)) {
      return;
    }

    const outboundEdges = this.graph.outboundEdges(subject);
    for (const edgeKey of outboundEdges) {
      const fact = this.graph.getEdgeAttribute(edgeKey, 'fact');
      if (fact.relation !== relation) {
        continue;
      }

      const invalidatedFact: SessionFact = {
        ...fact,
        validTo: invalidatedAt,
      };
      this.graph.setEdgeAttribute(edgeKey, 'fact', invalidatedFact);
      this.graph.dropEdge(edgeKey);
      this.adapter.invalidateFact(fact.id, invalidatedAt);
    }
  }

  private upsertEdge(fact: SessionFact): void {
    if (this.graph.hasEdge(fact.id)) {
      this.graph.dropEdge(fact.id);
    }
    this.graph.addDirectedEdgeWithKey(fact.id, fact.subject, fact.object, { fact });
  }

  private upsertEntityNode(nodeKey: string, seenAt: Date): void {
    if (!this.graph.hasNode(nodeKey)) {
      this.graph.addNode(nodeKey, {
        entityType: inferEntityType(nodeKey),
        firstSeen: seenAt,
        lastSeen: seenAt,
      });
      return;
    }

    const attributes = this.graph.getNodeAttributes(nodeKey);
    const firstSeen = attributes.firstSeen.valueOf() <= seenAt.valueOf() ? attributes.firstSeen : seenAt;
    const lastSeen = attributes.lastSeen.valueOf() >= seenAt.valueOf() ? attributes.lastSeen : seenAt;

    this.graph.replaceNodeAttributes(nodeKey, {
      entityType: attributes.entityType,
      firstSeen,
      lastSeen,
    });
  }

  private resolvePersistenceAvailability(): boolean {
    const adapterWithPersistence = this.adapter as ISQLiteFactAdapter & {
      isPersistenceAvailable?: () => boolean;
    };
    return adapterWithPersistence.isPersistenceAvailable?.() ?? true;
  }
}
