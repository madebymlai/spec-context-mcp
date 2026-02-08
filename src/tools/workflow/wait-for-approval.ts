import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { ToolContext, ToolResponse } from '../../workflow-types.js';
import { PathUtils } from '../../core/workflow/path-utils.js';
import { validateProjectPath } from '../../core/workflow/path-utils-node.js';
import { resolveDashboardUrlForNode } from '../../core/workflow/node-dashboard-url-default.js';
import { buildApprovalDeeplink } from '../../core/workflow/dashboard-url.js';
import { findDashboardProjectByPath, type DashboardProject } from './dashboard-project-resolver.js';

type ApprovalResolutionStatus = 'approved' | 'rejected' | 'needs-revision';
type AutoDeleteMode = 'enabled' | 'disabled';
type WaitForApprovalArgs = {
  approvalId: string;
  projectPath?: string;
  timeoutMs?: number;
  autoDelete?: boolean;
};

type WaitApiComment = {
  type: string;
  selectedText?: string;
  comment: string;
};

type WaitApiPayload = {
  status?: string;
  response?: string;
  annotations?: string;
  comments?: WaitApiComment[];
  respondedAt?: string;
  autoDeleted?: boolean;
  timeout?: boolean;
  message?: string;
};

type WaitTimeoutResult = {
  kind: 'timeout';
  message?: string;
};

type WaitResolvedResult = {
  kind: 'resolved';
  status: ApprovalResolutionStatus;
  response?: string;
  annotations?: string;
  comments?: WaitApiComment[];
  respondedAt?: string;
  autoDeleted?: boolean;
};

type WaitResult = WaitTimeoutResult | WaitResolvedResult;

type JsonResponse = {
  ok: boolean;
  statusText: string;
  json(): Promise<unknown>;
};

export interface WaitForApprovalDependencies {
  validateProjectPath(projectPath: string): Promise<string>;
  translateProjectPath(projectPath: string): string;
  resolveDashboardUrl(context: ToolContext): Promise<string>;
  fetchJson(url: string, init?: RequestInit): Promise<JsonResponse>;
  createAbortController(): AbortController;
  createTimeout(callback: () => void, timeoutMs: number): ReturnType<typeof setTimeout>;
  clearTimeout(timeout: ReturnType<typeof setTimeout>): void;
  buildApprovalDeeplink(dashboardUrl: string, approvalId: string, projectId?: string): string;
}

const RESOLVED_APPROVAL_STATUSES: readonly ApprovalResolutionStatus[] = [
  'approved',
  'rejected',
  'needs-revision'
];

const STATUS_NEXT_STEP_BUILDERS: Record<ApprovalResolutionStatus, (result: WaitResolvedResult) => string[]> = {
  approved: (result) => {
    const nextSteps = ['APPROVED - Proceed to next phase'];
    if (result.response) {
      nextSteps.push(`Response: ${result.response}`);
    }
    return nextSteps;
  },
  rejected: (result) => {
    const nextSteps = [
      'REJECTED - Do not proceed',
      'Ask user for guidance on how to proceed'
    ];
    if (result.response) {
      nextSteps.push(`Reason: ${result.response}`);
    }
    return nextSteps;
  },
  'needs-revision': (result) => {
    const nextSteps = [
      'NEEDS REVISION - Update document with feedback',
      'After updating, create NEW approval request',
      'Then call wait-for-approval again'
    ];
    if (result.response) {
      nextSteps.push(`Feedback: ${result.response}`);
    }
    if (result.annotations) {
      nextSteps.push(`Notes: ${result.annotations}`);
    }
    if (result.comments && result.comments.length > 0) {
      nextSteps.push(`${result.comments.length} inline comments:`);
      result.comments.forEach((comment, index) => {
        nextSteps.push(formatInlineComment(comment, index));
      });
    }
    return nextSteps;
  }
};

function formatInlineComment(comment: WaitApiComment, index: number): string {
  if (comment.type === 'selection' && comment.selectedText) {
    const preview = comment.selectedText.length > 50
      ? `${comment.selectedText.substring(0, 50)}...`
      : comment.selectedText;
    return `  ${index + 1}. On "${preview}": ${comment.comment}`;
  }
  return `  ${index + 1}. (general): ${comment.comment}`;
}

function resolveAutoDeleteMode(autoDelete: boolean | undefined): AutoDeleteMode {
  return autoDelete === false ? 'disabled' : 'enabled';
}

function isAutoDeleteEnabled(mode: AutoDeleteMode): boolean {
  return mode === 'enabled';
}

function isApprovalResolutionStatus(value: string | undefined): value is ApprovalResolutionStatus {
  if (!value) {
    return false;
  }
  return RESOLVED_APPROVAL_STATUSES.includes(value as ApprovalResolutionStatus);
}

function normalizeWaitResult(payload: WaitApiPayload): WaitResult {
  if (payload.timeout === true) {
    return { kind: 'timeout', message: payload.message };
  }

  if (!isApprovalResolutionStatus(payload.status)) {
    throw new Error(`Invalid approval wait status: ${String(payload.status)}`);
  }

  return {
    kind: 'resolved',
    status: payload.status,
    response: payload.response,
    annotations: payload.annotations,
    comments: payload.comments,
    respondedAt: payload.respondedAt,
    autoDeleted: payload.autoDeleted
  };
}

function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException) {
    return error.name === 'AbortError';
  }
  return typeof error === 'object'
    && error !== null
    && 'name' in error
    && (error as { name?: unknown }).name === 'AbortError';
}

function parseDashboardProjectList(payload: unknown): DashboardProject[] {
  if (!Array.isArray(payload)) {
    throw new Error('Dashboard project list response is not an array');
  }
  return payload as DashboardProject[];
}

function getFailureMessageFromPayload(payload: unknown, statusText: string): string {
  if (typeof payload !== 'object' || payload === null || !('error' in payload)) {
    return statusText;
  }
  const maybeError = (payload as { error?: unknown }).error;
  return typeof maybeError === 'string' && maybeError.trim().length > 0 ? maybeError : statusText;
}

export const waitForApprovalTool: Tool = {
  name: 'wait-for-approval',
  description: `Wait for an approval to be resolved. Blocks until user approves, rejects, or requests revision in the dashboard.

# Instructions
Use this tool AFTER creating an approval request with the approvals tool. It will:
1. Block until the approval status changes from 'pending'
2. Return the result (approved/rejected/needs-revision) with any feedback
3. Auto-delete the approval request (cleanup)

This replaces the need to manually poll with approvals action:"status" and manually delete with action:"delete".

# Example Flow
1. Create document (requirements.md, design.md, etc.)
2. approvals action:"request" → get approvalId
3. wait-for-approval approvalId:"..." → blocks until user responds
4. Handle result:
   - approved: proceed to next phase
   - needs-revision: update document, create NEW approval, wait again
   - rejected: stop, ask user for guidance`,
  inputSchema: {
    type: 'object',
    properties: {
      approvalId: {
        type: 'string',
        description: 'The ID of the approval request to wait for'
      },
      projectPath: {
        type: 'string',
        description: 'Absolute path to the project root (optional - uses server context path if not provided)'
      },
      timeoutMs: {
        type: 'number',
        description: 'Maximum time to wait in milliseconds (default: 600000 = 10 minutes, max: 1800000 = 30 minutes)'
      },
      autoDelete: {
        type: 'boolean',
        description: 'Whether to auto-delete the approval after resolution (default: true)'
      }
    },
    required: ['approvalId']
  }
};

export type WaitForApprovalHandler = (
  args: WaitForApprovalArgs,
  context: ToolContext
) => Promise<ToolResponse>;

export function createWaitForApprovalHandler(
  dependencies: WaitForApprovalDependencies
): WaitForApprovalHandler {
  return async (
    args: WaitForApprovalArgs,
    context: ToolContext
  ): Promise<ToolResponse> => {
    const projectPath = args.projectPath ?? context.projectPath;

    if (!projectPath) {
      return {
        success: false,
        message: 'Project path is required but not provided in context or arguments'
      };
    }

    if (!args.approvalId) {
      return {
        success: false,
        message: 'approvalId is required'
      };
    }

    try {
      const validatedProjectPath = await dependencies.validateProjectPath(projectPath);
      const translatedPath = dependencies.translateProjectPath(validatedProjectPath);
      const dashboardUrl = await dependencies.resolveDashboardUrl(context);

      const projectsResponse = await dependencies.fetchJson(`${dashboardUrl}/api/projects/list`);
      if (!projectsResponse.ok) {
        return {
          success: false,
          message: `Dashboard not available at ${dashboardUrl}. Please start dashboard with: spec-context-dashboard`
        };
      }

      const projectsPayload = await projectsResponse.json();
      const projects = parseDashboardProjectList(projectsPayload);
      const project = findDashboardProjectByPath(projects, validatedProjectPath, translatedPath);
      if (!project) {
        return {
          success: false,
          message: `Project not registered with dashboard. Path: ${validatedProjectPath}`,
          nextSteps: [
            'Ensure dashboard is running: spec-context-dashboard',
            'The MCP server should auto-register on startup'
          ]
        };
      }

      const timeoutMs = Math.min(args.timeoutMs ?? 600000, 1800000);
      const autoDeleteMode = resolveAutoDeleteMode(args.autoDelete);
      const waitUrl = `${dashboardUrl}/api/projects/${project.projectId}/approvals/${args.approvalId}/wait?timeout=${timeoutMs}&autoDelete=${isAutoDeleteEnabled(autoDeleteMode)}`;
      const approvalUrl = dependencies.buildApprovalDeeplink(dashboardUrl, args.approvalId, project.projectId);

      const controller = dependencies.createAbortController();
      const fetchTimeout = dependencies.createTimeout(() => controller.abort(), timeoutMs + 5000);

      try {
        const waitResponse = await dependencies.fetchJson(waitUrl, { signal: controller.signal });
        dependencies.clearTimeout(fetchTimeout);

        if (!waitResponse.ok) {
          const errorPayload = await waitResponse.json();
          return {
            success: false,
            message: `Wait failed: ${getFailureMessageFromPayload(errorPayload, waitResponse.statusText)}`
          };
        }

        const rawResult = await waitResponse.json() as WaitApiPayload;
        const waitResult = normalizeWaitResult(rawResult);
        if (waitResult.kind === 'timeout') {
          return {
            success: false,
            message: waitResult.message ?? 'Timeout waiting for approval. User has not responded yet.',
            data: {
              approvalId: args.approvalId,
              status: 'pending',
              timeout: true,
              approvalUrl,
            },
            nextSteps: [
              'Call wait-for-approval again to continue waiting',
              'Or check dashboard to see if user is available',
              `Review in dashboard: ${approvalUrl}`
            ]
          };
        }

        const canProceed = waitResult.status === 'approved';
        const nextSteps = STATUS_NEXT_STEP_BUILDERS[waitResult.status](waitResult);

        return {
          success: true,
          message: `Approval resolved: ${waitResult.status}${waitResult.autoDeleted ? ' (auto-cleaned)' : ''}`,
          data: {
            approvalId: args.approvalId,
            status: waitResult.status,
            response: waitResult.response,
            annotations: waitResult.annotations,
            comments: waitResult.comments,
            respondedAt: waitResult.respondedAt,
            autoDeleted: waitResult.autoDeleted,
            canProceed,
            approvalUrl,
          },
          nextSteps,
          projectContext: {
            projectPath: validatedProjectPath,
            workflowRoot: `${validatedProjectPath}/.spec-context`,
            dashboardUrl
          }
        };
      } catch (fetchError) {
        dependencies.clearTimeout(fetchTimeout);
        if (isAbortError(fetchError)) {
          return {
            success: false,
            message: 'Request timed out waiting for approval',
            data: {
              approvalId: args.approvalId,
              status: 'pending',
              timeout: true,
              approvalUrl
            },
            nextSteps: [
              'Call wait-for-approval again to continue waiting',
              `Review in dashboard: ${approvalUrl}`
            ]
          };
        }
        throw fetchError;
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        message: `Failed to wait for approval: ${errorMessage}`,
        nextSteps: [
          'Ensure dashboard is running',
          'Check network connectivity',
          'Verify approvalId is correct'
        ]
      };
    }
  };
}

const defaultWaitForApprovalDependencies: WaitForApprovalDependencies = {
  validateProjectPath,
  translateProjectPath: (projectPath) => PathUtils.translatePath(projectPath),
  resolveDashboardUrl: async (context) => context.dashboardUrl ?? resolveDashboardUrlForNode(),
  fetchJson: (url, init) => fetch(url, init),
  createAbortController: () => new AbortController(),
  createTimeout: (callback, timeoutMs) => setTimeout(callback, timeoutMs),
  clearTimeout: (timeout) => clearTimeout(timeout),
  buildApprovalDeeplink,
};

export const waitForApprovalHandler = createWaitForApprovalHandler(defaultWaitForApprovalDependencies);
