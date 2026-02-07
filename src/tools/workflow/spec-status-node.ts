import { SpecParser } from '../../core/workflow/parser.js';
import { getSharedFileContentCache } from '../../core/cache/shared-file-content-cache.js';
import { type SpecStatusReader, type SpecStatusReaderFactory, createSpecStatusHandler } from './spec-status.js';
import type { ToolContext, ToolResponse } from '../../workflow-types.js';

const nodeSpecStatusReaderFactory: SpecStatusReaderFactory = {
  create(projectPath: string): SpecStatusReader {
    return new SpecParser(projectPath);
  },
};

const baseSpecStatusHandler = createSpecStatusHandler(nodeSpecStatusReaderFactory);

export async function specStatusHandler(args: unknown, context: ToolContext): Promise<ToolResponse> {
  return baseSpecStatusHandler(args, {
    ...context,
    fileContentCache: context.fileContentCache ?? getSharedFileContentCache(),
  });
}
