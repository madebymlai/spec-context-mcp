import { FactQuery, IFactRetriever, ISessionFactStore, SessionFact } from './types.js';

const STOPWORDS = new Set<string>([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'shall', 'should',
  'may', 'might', 'can', 'could', 'of', 'in', 'to', 'for', 'with', 'on',
  'at', 'by', 'from', 'as', 'or', 'and', 'but', 'not', 'no', 'this',
  'that', 'it', 'its',
]);

const TOKEN_SPLIT_REGEX = /[\s/\-_.,:;()[\]{}]+/;
const DEFAULT_TOKEN_CHARS_PER_TOKEN = 4;

function tokenize(value: string): Set<string> {
  const tokens = value
    .toLowerCase()
    .split(TOKEN_SPLIT_REGEX)
    .map(token => token.trim())
    .filter(token => token.length > 0 && !STOPWORDS.has(token));
  return new Set(tokens);
}

function scoreFact(queryTokens: Set<string>, fact: SessionFact): number {
  if (queryTokens.size === 0) {
    return 0;
  }
  const factTokens = tokenize(`${fact.subject} ${fact.relation} ${fact.object}`);
  let matches = 0;
  for (const token of queryTokens) {
    if (factTokens.has(token)) {
      matches += 1;
    }
  }
  return matches / queryTokens.size;
}

function estimateFactTokens(fact: SessionFact, tokenCharsPerToken: number): number {
  return Math.ceil(`${fact.subject}${fact.relation}${fact.object}`.length / tokenCharsPerToken);
}

export class KeywordFactRetriever implements IFactRetriever {
  constructor(private readonly store: ISessionFactStore) {}

  retrieve(query: FactQuery): SessionFact[] {
    try {
      const sourceFacts = query.tags === undefined
        ? this.store.getValid()
        : this.store.getValidByTags(query.tags);
      if (sourceFacts.length === 0) {
        return [];
      }

      const filtered = sourceFacts.filter(fact => fact.sourceTaskId !== query.taskId);
      if (filtered.length === 0) {
        return [];
      }

      const queryTokens = tokenize(query.taskDescription);
      const ranked = filtered
        .map(fact => ({ fact, score: scoreFact(queryTokens, fact) }))
        .sort((left, right) => {
          if (right.score !== left.score) {
            return right.score - left.score;
          }
          return right.fact.validFrom.valueOf() - left.fact.validFrom.valueOf();
        })
        .slice(0, Math.max(0, query.maxFacts))
        .map(item => item.fact);

      if (query.maxTokens <= 0) {
        return [];
      }

      const withinBudget: SessionFact[] = [];
      const tokenCharsPerToken = Math.max(1, query.tokenCharsPerToken ?? DEFAULT_TOKEN_CHARS_PER_TOKEN);
      let usedTokens = 0;
      for (const fact of ranked) {
        const factTokens = estimateFactTokens(fact, tokenCharsPerToken);
        if (usedTokens + factTokens > query.maxTokens) {
          break;
        }
        withinBudget.push(fact);
        usedTokens += factTokens;
      }
      return withinBudget;
    } catch {
      return [];
    }
  }
}
