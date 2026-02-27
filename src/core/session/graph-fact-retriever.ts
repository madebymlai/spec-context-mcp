import { GraphSessionFactStore } from './graph-session-fact-store.js';
import { KeywordFactRetriever, KEYWORD_STOPWORDS } from './fact-retriever.js';
import type { FactQuery, IFactRetriever, SessionFact, SessionFactTag } from './types.js';

const TOKEN_SPLIT_REGEX = /[\s/\-_.,:;()[\]{}]+/;
const DEFAULT_MAX_HOPS = 2;
const DEFAULT_TOKEN_CHARS_PER_TOKEN = 4;
const MILLIS_PER_DAY = 24 * 60 * 60 * 1000;

interface GraphFactRetrieverConfig {
  readonly maxHops?: number;
}

interface RankedFact {
  readonly fact: SessionFact;
  readonly score: number;
}

export interface GraphRetrievalMetrics {
  readonly factsRetrieved: number;
  readonly graphHopsUsed: number;
  readonly retrievalTimeMs: number;
  readonly graphNodes: number;
  readonly graphEdges: number;
  readonly persistenceAvailable: boolean;
}

function tokenizeTaskDescription(taskDescription: string): Set<string> {
  const tokens = taskDescription
    .toLowerCase()
    .split(TOKEN_SPLIT_REGEX)
    .map(token => token.trim())
    .filter(token => token.length > 2 && !KEYWORD_STOPWORDS.has(token));
  return new Set(tokens);
}

function estimateFactTokens(fact: SessionFact, tokenCharsPerToken: number): number {
  return Math.ceil(`${fact.subject}${fact.relation}${fact.object}`.length / tokenCharsPerToken);
}

function daysSince(from: Date, now: Date): number {
  const elapsedMs = now.valueOf() - from.valueOf();
  if (elapsedMs <= 0) {
    return 0;
  }
  return elapsedMs / MILLIS_PER_DAY;
}

function includesAnyTag(fact: SessionFact, tags: ReadonlyArray<SessionFactTag>): boolean {
  const tagSet = new Set(tags);
  return fact.tags.some(tag => tagSet.has(tag));
}

export class GraphFactRetriever implements IFactRetriever {
  private readonly maxHops: number;

  private readonly keywordFallback: IFactRetriever;

  private lastRetrievalMetrics: GraphRetrievalMetrics = {
    factsRetrieved: 0,
    graphHopsUsed: 0,
    retrievalTimeMs: 0,
    graphNodes: 0,
    graphEdges: 0,
    persistenceAvailable: false,
  };

  constructor(
    private readonly store: GraphSessionFactStore,
    config: GraphFactRetrieverConfig = {},
  ) {
    this.maxHops = Math.max(0, config.maxHops ?? DEFAULT_MAX_HOPS);
    this.keywordFallback = new KeywordFactRetriever(store);
  }

  retrieve(query: FactQuery): SessionFact[] {
    const startedAt = Date.now();
    const storeStats = this.store.getStats();

    const finalize = (facts: SessionFact[], graphHopsUsed: number): SessionFact[] => {
      this.lastRetrievalMetrics = {
        factsRetrieved: facts.length,
        graphHopsUsed,
        retrievalTimeMs: Math.max(0, Date.now() - startedAt),
        graphNodes: storeStats.entities,
        graphEdges: storeStats.validFacts,
        persistenceAvailable: storeStats.persistenceAvailable,
      };
      return facts;
    };

    const matchedNodes = this.findMatchedNodeKeys(query.taskDescription);
    if (matchedNodes.length === 0) {
      return finalize(this.keywordFallback.retrieve(query), 0);
    }

    const factsById = this.collectFactsByGraphDistance(matchedNodes);
    if (factsById.size === 0) {
      return finalize([], 0);
    }

    const filteredFacts = this.applyFilters(Array.from(factsById.values()), query);
    if (filteredFacts.length === 0) {
      return finalize([], 0);
    }

    const graphHopsUsed = filteredFacts.reduce(
      (maxHops, item) => Math.max(maxHops, item.hopDistance),
      0,
    );
    const rankedFacts = this.rankFacts(filteredFacts, new Date())
      .slice(0, Math.max(0, query.maxFacts))
      .map(item => item.fact);

    const budgetedFacts = this.applyTokenBudget(rankedFacts, query.maxTokens, query.tokenCharsPerToken);
    return finalize(budgetedFacts, graphHopsUsed);
  }

  getLastRetrievalMetrics(): GraphRetrievalMetrics {
    return {
      ...this.lastRetrievalMetrics,
    };
  }

  private findMatchedNodeKeys(taskDescription: string): string[] {
    const graph = this.store.getGraph();
    const nodeKeys = graph.nodes();
    if (nodeKeys.length === 0) {
      return [];
    }

    const tokens = tokenizeTaskDescription(taskDescription);
    if (tokens.size === 0) {
      return [];
    }

    const normalizedNodes = nodeKeys.map(nodeKey => ({
      nodeKey,
      normalized: nodeKey.toLowerCase(),
    }));

    const exactMatches = new Set<string>();
    for (const token of tokens) {
      for (const node of normalizedNodes) {
        if (node.normalized === token || node.normalized.endsWith(`/${token}`)) {
          exactMatches.add(node.nodeKey);
        }
      }
    }

    const substringMatches = new Set<string>();
    for (const token of tokens) {
      for (const node of normalizedNodes) {
        if (exactMatches.has(node.nodeKey)) {
          continue;
        }
        if (node.normalized.includes(token)) {
          substringMatches.add(node.nodeKey);
        }
      }
    }

    return [...exactMatches, ...substringMatches];
  }

  private collectFactsByGraphDistance(matchedNodes: string[]): Map<string, { fact: SessionFact; hopDistance: number }> {
    const graph = this.store.getGraph();
    const factsById = new Map<string, { fact: SessionFact; hopDistance: number }>();

    for (const startNode of matchedNodes) {
      if (!graph.hasNode(startNode)) {
        continue;
      }

      const visitedNodes = new Set<string>([startNode]);
      const queue: Array<{ nodeKey: string; hopDistance: number }> = [{ nodeKey: startNode, hopDistance: 0 }];

      while (queue.length > 0) {
        const next = queue.shift();
        if (next === undefined) {
          break;
        }

        const edgeKeys = new Set<string>([
          ...graph.outboundEdges(next.nodeKey),
          ...graph.inboundEdges(next.nodeKey),
        ]);

        for (const edgeKey of edgeKeys) {
          if (!graph.hasEdge(edgeKey)) {
            continue;
          }
          const fact = graph.getEdgeAttribute(edgeKey, 'fact');
          const existing = factsById.get(fact.id);
          if (existing === undefined || next.hopDistance < existing.hopDistance) {
            factsById.set(fact.id, { fact, hopDistance: next.hopDistance });
          }

          if (next.hopDistance >= this.maxHops) {
            continue;
          }

          const oppositeNode = graph.opposite(next.nodeKey, edgeKey);
          if (visitedNodes.has(oppositeNode)) {
            continue;
          }
          visitedNodes.add(oppositeNode);
          queue.push({ nodeKey: oppositeNode, hopDistance: next.hopDistance + 1 });
        }
      }
    }

    return factsById;
  }

  private applyFilters(
    scoredFacts: Array<{ fact: SessionFact; hopDistance: number }>,
    query: FactQuery,
  ): Array<{ fact: SessionFact; hopDistance: number }> {
    const withoutSelfFacts = scoredFacts.filter(item => item.fact.sourceTaskId !== query.taskId);
    const tags = query.tags;
    if (tags === undefined) {
      return withoutSelfFacts;
    }
    return withoutSelfFacts.filter(item => includesAnyTag(item.fact, tags));
  }

  private rankFacts(
    scoredFacts: Array<{ fact: SessionFact; hopDistance: number }>,
    now: Date,
  ): RankedFact[] {
    return scoredFacts
      .map(item => {
        const recencyScore = 1 / (1 + daysSince(item.fact.validFrom, now) / 30);
        const distanceScore = 1 / (item.hopDistance + 1);
        return {
          fact: item.fact,
          score: distanceScore * recencyScore * item.fact.confidence,
        };
      })
      .sort((left, right) => {
        if (right.score !== left.score) {
          return right.score - left.score;
        }
        if (right.fact.validFrom.valueOf() !== left.fact.validFrom.valueOf()) {
          return right.fact.validFrom.valueOf() - left.fact.validFrom.valueOf();
        }
        return right.fact.id.localeCompare(left.fact.id);
      });
  }

  private applyTokenBudget(
    rankedFacts: SessionFact[],
    maxTokens: number,
    tokenCharsPerToken: number | undefined,
  ): SessionFact[] {
    if (maxTokens <= 0) {
      return [];
    }

    const budgetedFacts: SessionFact[] = [];
    const charsPerToken = Math.max(1, tokenCharsPerToken ?? DEFAULT_TOKEN_CHARS_PER_TOKEN);
    let consumedTokens = 0;

    for (const fact of rankedFacts) {
      const requiredTokens = estimateFactTokens(fact, charsPerToken);
      if (consumedTokens + requiredTokens > maxTokens) {
        break;
      }
      budgetedFacts.push(fact);
      consumedTokens += requiredTokens;
    }

    return budgetedFacts;
  }
}
