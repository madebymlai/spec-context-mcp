import { ISessionFactStore, SessionFact, SessionFactTag } from './types.js';

const DEFAULT_MAX_VALID_FACTS = 500;

function isValidDate(value: unknown): value is Date {
  return value instanceof Date && !Number.isNaN(value.valueOf());
}

function isSessionFact(value: SessionFact): boolean {
  return typeof value.id === 'string'
    && value.id.length > 0
    && typeof value.subject === 'string'
    && value.subject.length > 0
    && typeof value.relation === 'string'
    && value.relation.length > 0
    && typeof value.object === 'string'
    && value.object.length > 0
    && Array.isArray(value.tags)
    && value.tags.length > 0
    && value.tags.every(tag => typeof tag === 'string')
    && isValidDate(value.validFrom)
    && (value.validTo === undefined || isValidDate(value.validTo))
    && typeof value.sourceTaskId === 'string'
    && value.sourceTaskId.length > 0
    && (value.sourceRole === 'implementer' || value.sourceRole === 'reviewer')
    && typeof value.confidence === 'number'
    && Number.isFinite(value.confidence);
}

export class InMemorySessionFactStore implements ISessionFactStore {
  private readonly facts = new Map<string, SessionFact>();
  private readonly subjectIndex = new Map<string, Set<string>>();

  constructor(private readonly maxValidFacts = DEFAULT_MAX_VALID_FACTS) {}

  add(facts: SessionFact[]): void {
    for (const fact of facts) {
      if (!isSessionFact(fact)) {
        continue;
      }
      this.invalidateInternal(fact.subject, fact.relation, new Date());
      this.facts.set(fact.id, fact);
      this.addIndex(fact.subject, fact.id);
    }
    if (this.countInternal() > this.maxValidFacts) {
      this.compact(this.maxValidFacts);
    }
  }

  invalidate(subject: string, relation: string): void {
    this.invalidateInternal(subject, relation, new Date());
  }

  getValid(): SessionFact[] {
    return Array.from(this.facts.values()).filter(fact => fact.validTo === undefined);
  }

  getValidByTags(tags: SessionFactTag[]): SessionFact[] {
    const tagSet = new Set(tags);
    return this.getValid().filter(fact => fact.tags.some(tag => tagSet.has(tag)));
  }

  count(): number {
    return this.countInternal();
  }

  compact(maxFacts: number): void {
    if (maxFacts < 0) {
      return;
    }
    if (this.countInternal() <= maxFacts) {
      return;
    }

    for (const [id, fact] of this.facts.entries()) {
      if (fact.validTo !== undefined) {
        this.removeFact(id, fact);
      }
    }

    const validFacts = this.getValid()
      .sort((a, b) => a.validFrom.valueOf() - b.validFrom.valueOf());

    const removeCount = Math.max(0, validFacts.length - maxFacts);
    for (let index = 0; index < removeCount; index += 1) {
      const fact = validFacts[index];
      this.removeFact(fact.id, fact);
    }
  }

  private invalidateInternal(subject: string, relation: string, validTo: Date): void {
    const ids = this.subjectIndex.get(subject);
    if (!ids) {
      return;
    }
    for (const id of ids) {
      const existing = this.facts.get(id);
      if (!existing || existing.validTo !== undefined || existing.relation !== relation) {
        continue;
      }
      this.facts.set(id, {
        ...existing,
        validTo,
      });
    }
  }

  private addIndex(subject: string, id: string): void {
    const existing = this.subjectIndex.get(subject);
    if (existing) {
      existing.add(id);
      return;
    }
    this.subjectIndex.set(subject, new Set([id]));
  }

  private removeFact(id: string, fact: SessionFact): void {
    this.facts.delete(id);
    const subjectIds = this.subjectIndex.get(fact.subject);
    if (!subjectIds) {
      return;
    }
    subjectIds.delete(id);
    if (subjectIds.size === 0) {
      this.subjectIndex.delete(fact.subject);
    }
  }

  private countInternal(): number {
    let valid = 0;
    for (const fact of this.facts.values()) {
      if (fact.validTo === undefined) {
        valid += 1;
      }
    }
    return valid;
  }
}
