import { createHash } from 'crypto';
import type { ImplementerResult, ReviewerResult } from '../../tools/workflow/dispatch-contract-schemas.js';

export type SessionFactTag = 'file_change' | 'convention' | 'decision' | 'error' | 'dependency' | 'test';

export interface SessionFact {
  readonly id: string;
  readonly subject: string;
  readonly relation: string;
  readonly object: string;
  readonly tags: ReadonlyArray<SessionFactTag>;
  readonly validFrom: Date;
  readonly validTo: Date | undefined;
  readonly sourceTaskId: string;
  readonly sourceRole: 'implementer' | 'reviewer';
  readonly confidence: number;
}

export interface ISessionFactStore {
  add(facts: SessionFact[]): void;
  invalidate(subject: string, relation: string): void;
  getValid(): SessionFact[];
  getValidByTags(tags: SessionFactTag[]): SessionFact[];
  count(): number;
  compact(maxFacts: number): void;
}

export interface IFactExtractor {
  extractFromImplementer(result: ImplementerResult, taskId: string): SessionFact[];
  extractFromReviewer(result: ReviewerResult, taskId: string): SessionFact[];
}

export interface FactQuery {
  readonly taskDescription: string;
  readonly taskId: string;
  readonly tags: SessionFactTag[] | undefined;
  readonly maxFacts: number;
  readonly maxTokens: number;
  readonly tokenCharsPerToken?: number;
}

export interface IFactRetriever {
  retrieve(query: FactQuery): SessionFact[];
}

export function createFactId(subject: string, relation: string, object: string): string {
  const hash = createHash('sha256');
  hash.update(`${subject}\u001f${relation}\u001f${object}`, 'utf8');
  return hash.digest('hex').slice(0, 16);
}
