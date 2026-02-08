import { resolveDashboardUrlForNode } from '../core/workflow/node-dashboard-url.js';
import { getSharedFileContentCache } from '../core/cache/shared-file-content-cache.js';
import { createApprovalsHandler } from './workflow/approvals.js';
import { nodeApprovalStoreFactory } from './workflow/approval-store-node.js';
import { dispatchRuntimeHandler } from './workflow/dispatch-runtime-node.js';
import { specStatusHandler } from './workflow/spec-status-node.js';
import { createToolRuntime } from './index.js';
import type { ToolContext, ToolResponse } from '../workflow-types.js';

const approvalsHandlerWithNodeStore = createApprovalsHandler(nodeApprovalStoreFactory);

const nodeToolRuntime = createToolRuntime({
  resolveDashboardUrl: () => resolveDashboardUrlForNode(),
  getFileContentCache: () => getSharedFileContentCache(),
  specStatusHandler,
  approvalsHandler: async (
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolResponse> => approvalsHandlerWithNodeStore(args as any, context),
  dispatchRuntimeHandler,
});

export const getAllTools = nodeToolRuntime.getAllTools;
export const getVisibleTools = nodeToolRuntime.getVisibleTools;
export const getTools = nodeToolRuntime.getTools;
export const handleToolCall = nodeToolRuntime.handleToolCall;
