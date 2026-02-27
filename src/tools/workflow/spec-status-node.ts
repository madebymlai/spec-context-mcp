import { stat } from 'fs/promises';
import { join } from 'path';
import { SQLiteFactAdapter } from '../../core/session/index.js';
import { SpecParser } from '../../core/workflow/parser.js';
import { getSharedFileContentCache } from '../../core/cache/shared-file-content-cache.js';
import {
  type SpecStatusReader,
  type SpecStatusReaderFactory,
  type SpecStatusGraphStatsProvider,
  createSpecStatusHandler,
} from './spec-status.js';
import type { ToolContext, ToolResponse } from '../../workflow-types.js';

const nodeSpecStatusReaderFactory: SpecStatusReaderFactory = {
  create(projectPath: string): SpecStatusReader {
    return new SpecParser(projectPath);
  },
};

const nodeSpecStatusGraphStatsProvider: SpecStatusGraphStatsProvider = {
  async getStats(projectPath: string) {
    const databasePath = join(projectPath, '.spec-context', 'knowledge-graph.db');
    try {
      const databaseStat = await stat(databasePath);
      if (!databaseStat.isFile()) {
        return null;
      }
    } catch {
      return null;
    }

    const adapter = new SQLiteFactAdapter(databasePath);
    adapter.initialize();
    const stats = adapter.getStats();
    const persistenceAvailable = adapter.isPersistenceAvailable();
    adapter.close();
    return {
      totalFacts: stats.totalFacts,
      validFacts: stats.validFacts,
      entities: stats.entities,
      persistenceAvailable,
    };
  },
};

const baseSpecStatusHandler = createSpecStatusHandler(
  nodeSpecStatusReaderFactory,
  nodeSpecStatusGraphStatsProvider,
);

export async function specStatusHandler(args: unknown, context: ToolContext): Promise<ToolResponse> {
  return baseSpecStatusHandler(args, {
    ...context,
    fileContentCache: context.fileContentCache ?? getSharedFileContentCache(),
  });
}
