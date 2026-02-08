import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { ToolContext, ToolResponse } from '../../workflow-types.js';
import { join } from 'path';
import { PathUtils } from '../../core/workflow/path-utils.js';
import { validateProjectPath } from '../../core/workflow/path-utils-node.js';
import { buildApprovalDeeplink } from '../../core/workflow/dashboard-url.js';
import { readFile } from 'fs/promises';
import { validateTasksMarkdown, formatValidationErrors } from '../../core/workflow/task-validator.js';
import type { ApprovalStoreFactory, ApprovalStore, ApprovalRecord, ApprovalStatus } from './approval-store.js';
import { findDashboardProjectByPath } from './dashboard-project-resolver.js';

async function tryResolveDashboardProjectId(
  dashboardUrl: string | undefined,
  validatedProjectPath: string,
  translatedProjectPath: string
): Promise<string | null> {
  if (!dashboardUrl) return null;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 750);

  try {
    const projectsResponse = await fetch(`${dashboardUrl}/api/projects/list`, { signal: controller.signal });
    if (!projectsResponse.ok) return null;

    const projects = await projectsResponse.json() as Array<{ projectId: string; projectPath?: string; projectName: string }>;
    const project = findDashboardProjectByPath(projects, validatedProjectPath, translatedProjectPath);
    return project?.projectId ?? null;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      return null;
    }
    if (error instanceof TypeError) {
      return null;
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

type ApprovalProgressState = 'awaiting_review' | 'approved' | 'rejected' | 'needs_revision';

type ApprovalStatusProjection = {
  progressState: ApprovalProgressState;
  resolution: 'pending' | 'resolved';
  workflowOutcome: 'proceed' | 'blocked';
};

const APPROVAL_STATUS_PROJECTIONS: Record<ApprovalStatus, ApprovalStatusProjection> = {
  pending: {
    progressState: 'awaiting_review',
    resolution: 'pending',
    workflowOutcome: 'blocked',
  },
  approved: {
    progressState: 'approved',
    resolution: 'resolved',
    workflowOutcome: 'proceed',
  },
  rejected: {
    progressState: 'rejected',
    resolution: 'resolved',
    workflowOutcome: 'blocked',
  },
  'needs-revision': {
    progressState: 'needs_revision',
    resolution: 'pending',
    workflowOutcome: 'blocked',
  },
};

function projectApprovalStatus(status: ApprovalStatus): ApprovalStatusProjection {
  return APPROVAL_STATUS_PROJECTIONS[status];
}

function toApprovalStatusFlags(statusProjection: ApprovalStatusProjection): {
  isCompleted: boolean;
  canProceed: boolean;
  mustWait: boolean;
  blockNext: boolean;
} {
  const isCompleted = statusProjection.resolution === 'resolved';
  const canProceed = statusProjection.workflowOutcome === 'proceed';
  return {
    isCompleted,
    canProceed,
    mustWait: !canProceed,
    blockNext: !canProceed,
  };
}

interface ApprovalStoreContext {
  validatedProjectPath: string;
  translatedPath: string;
  approvalStore: ApprovalStore;
}

async function withApprovalStore<T>(
  projectPath: string,
  approvalStoreFactory: ApprovalStoreFactory,
  action: (context: ApprovalStoreContext) => Promise<T>,
): Promise<T> {
  const validatedProjectPath = await validateProjectPath(projectPath);
  const translatedPath = PathUtils.translatePath(validatedProjectPath);
  const approvalStore = approvalStoreFactory.create(translatedPath, validatedProjectPath);
  await approvalStore.start();
  try {
    return await action({
      validatedProjectPath,
      translatedPath,
      approvalStore,
    });
  } finally {
    await approvalStore.stop();
  }
}

const APPROVAL_NEXT_STEP_BUILDERS: Record<ApprovalStatus, (approval: ApprovalRecord, approvalUrl?: string) => string[]> = {
  pending: (_approval, approvalUrl) => {
    const nextSteps = [
      'BLOCKED - Do not proceed',
      'VERBAL APPROVAL NOT ACCEPTED - Use dashboard only',
      'Approval must be done via dashboard',
      'Continue polling with approvals action:"status"'
    ];
    if (approvalUrl) {
      nextSteps.push(`Review in dashboard: ${approvalUrl}`);
    }
    return nextSteps;
  },
  approved: (approval) => {
    const nextSteps = [
      'APPROVED - Can proceed',
      'Run approvals action:"delete" before continuing'
    ];
    if (approval.response) {
      nextSteps.push(`Response: ${approval.response}`);
    }
    return nextSteps;
  },
  rejected: (approval) => {
    const nextSteps = [
      'BLOCKED - REJECTED',
      'Do not proceed',
      'Review feedback and revise'
    ];
    if (approval.response) {
      nextSteps.push(`Reason: ${approval.response}`);
    }
    if (approval.annotations) {
      nextSteps.push(`Notes: ${approval.annotations}`);
    }
    return nextSteps;
  },
  'needs-revision': (approval) => {
    const nextSteps = [
      'BLOCKED - Do not proceed',
      'Update document with feedback',
      'Create NEW approval request'
    ];
    if (approval.response) {
      nextSteps.push(`Feedback: ${approval.response}`);
    }
    if (approval.annotations) {
      nextSteps.push(`Notes: ${approval.annotations}`);
    }
    if (approval.comments && approval.comments.length > 0) {
      nextSteps.push(`${approval.comments.length} comments for targeted fixes:`);
      approval.comments.forEach((comment, index) => {
        nextSteps.push(formatApprovalComment(comment, index));
      });
    }
    return nextSteps;
  }
};

function formatApprovalComment(comment: NonNullable<ApprovalRecord['comments']>[number], index: number): string {
  if (comment.type === 'selection' && comment.selectedText) {
    return `  Comment ${index + 1} on "${comment.selectedText.substring(0, 50)}...": ${comment.comment}`;
  }
  return `  Comment ${index + 1} (general): ${comment.comment}`;
}

export const approvalsTool: Tool = {
  name: 'approvals',
  description: `Create approval requests for spec documents. Use when submitting documents for user review.

# Instructions
Use this tool to create approval requests. After creating a request, use wait-for-approval to block until the user responds.

**Recommended flow:**
1. approvals action:"request" → get approvalId
2. wait-for-approval approvalId:"..." → blocks until resolved, auto-deletes

**Available actions:**
- 'request': Create a new approval request (primary use case)
- 'status': Check status manually (rarely needed - use wait-for-approval instead)
- 'delete': Manual cleanup (rarely needed - wait-for-approval auto-deletes)

CRITICAL: Only provide filePath parameter for requests - the dashboard reads files directly. Never include document content.`,
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['request', 'status', 'delete'],
        description: 'The action to perform: request, status, or delete'
      },
      projectPath: {
        type: 'string',
        description: 'Absolute path to the project root (optional - uses server context path if not provided)'
      },
      approvalId: {
        type: 'string',
        description: 'The ID of the approval request (required for status and delete actions)'
      },
      title: {
        type: 'string',
        description: 'Brief title describing what needs approval (required for request action)'
      },
      filePath: {
        type: 'string',
        description: 'Path to the file that needs approval, relative to project root (required for request action)'
      },
      type: {
        type: 'string',
        enum: ['document', 'action'],
        description: 'Type of approval request - "document" for content approval, "action" for action approval (required for request)'
      },
      category: {
        type: 'string',
        enum: ['spec', 'steering'],
        description: 'Category of the approval request - "spec" for specifications, "steering" for steering documents (required for request)'
      },
      categoryName: {
        type: 'string',
        description: 'Name of the spec or "steering" for steering documents (required for request)'
      }
    },
    required: ['action']
  }
};

// Type definitions for discriminated unions
type RequestApprovalArgs = {
  action: 'request';
  projectPath?: string;
  title: string;
  filePath: string;
  type: 'document' | 'action';
  category: 'spec' | 'steering';
  categoryName: string;
};

type StatusApprovalArgs = {
  action: 'status';
  projectPath?: string;
  approvalId: string;
};

type DeleteApprovalArgs = {
  action: 'delete';
  projectPath?: string;
  approvalId: string;
};

type ApprovalArgs = RequestApprovalArgs | StatusApprovalArgs | DeleteApprovalArgs;

type ApprovalsHandler = (
  args: {
    action: 'request' | 'status' | 'delete';
    projectPath?: string;
    approvalId?: string;
    title?: string;
    filePath?: string;
    type?: 'document' | 'action';
    category?: 'spec' | 'steering';
    categoryName?: string;
  },
  context: ToolContext
) => Promise<ToolResponse>;

function createApprovalsHandlerWithDependencies(approvalStoreFactory: ApprovalStoreFactory): ApprovalsHandler {
  return async (
    args: {
      action: 'request' | 'status' | 'delete';
      projectPath?: string;
      approvalId?: string;
      title?: string;
      filePath?: string;
      type?: 'document' | 'action';
      category?: 'spec' | 'steering';
      categoryName?: string;
    },
    context: ToolContext
  ): Promise<ToolResponse> => {
    const typedArgs = args as ApprovalArgs;

    switch (typedArgs.action) {
      case 'request':
        if (!args.title || !args.filePath || !args.type || !args.category || !args.categoryName) {
          return {
            success: false,
            message: 'Missing required fields for request action. Required: title, filePath, type, category, categoryName'
          };
        }
        return handleRequestApproval(typedArgs, context, approvalStoreFactory);
      case 'status':
        if (!args.approvalId) {
          return {
            success: false,
            message: 'Missing required field for status action. Required: approvalId'
          };
        }
        return handleGetApprovalStatus(typedArgs, context, approvalStoreFactory);
      case 'delete':
        if (!args.approvalId) {
          return {
            success: false,
            message: 'Missing required field for delete action. Required: approvalId'
          };
        }
        return handleDeleteApproval(typedArgs, context, approvalStoreFactory);
      default:
        throw new Error('Unhandled approvals action');
    }
  };
}

export function createApprovalsHandler(approvalStoreFactory: ApprovalStoreFactory): ApprovalsHandler {
  return createApprovalsHandlerWithDependencies(approvalStoreFactory);
}

async function handleRequestApproval(
  args: RequestApprovalArgs,
  context: ToolContext,
  approvalStoreFactory: ApprovalStoreFactory
): Promise<ToolResponse> {
  // Use context projectPath as default, allow override via args
  const projectPath = args.projectPath || context.projectPath;

  if (!projectPath) {
    return {
      success: false,
      message: 'Project path is required but not provided in context or arguments'
    };
  }

  try {
    return withApprovalStore(projectPath, approvalStoreFactory, async ({
      validatedProjectPath,
      translatedPath,
      approvalStore,
    }) => {
      const dashboardProjectId = await tryResolveDashboardProjectId(context.dashboardUrl, validatedProjectPath, translatedPath);

      const existingApprovals = await approvalStore.getAllPendingApprovals();
      const existingApproval = existingApprovals.find(
        a => a.filePath === args.filePath && a.categoryName === args.categoryName
      );

      if (existingApproval) {
        const approvalUrl = context.dashboardUrl
          ? buildApprovalDeeplink(context.dashboardUrl, existingApproval.id, dashboardProjectId || undefined)
          : undefined;
        return {
          success: true,
          message: `Found existing pending approval. Use wait-for-approval to block until user responds.`,
          data: {
            approvalId: existingApproval.id,
            title: existingApproval.title,
            filePath: existingApproval.filePath,
            type: existingApproval.type,
            status: existingApproval.status,
            createdAt: existingApproval.createdAt,
            dashboardUrl: context.dashboardUrl,
            approvalUrl,
            reusedExisting: true
          },
          nextSteps: [
            `NEXT: Call wait-for-approval approvalId:"${existingApproval.id}"`,
            'This will block until user approves/rejects/requests-revision',
            'Auto-cleanup happens on resolution',
            approvalUrl ? `Review in dashboard: ${approvalUrl}` : 'Start dashboard: spec-context-dashboard'
          ],
          projectContext: {
            projectPath: validatedProjectPath,
            workflowRoot: join(validatedProjectPath, '.spec-context'),
            dashboardUrl: context.dashboardUrl
          }
        };
      }

      if (args.filePath.endsWith('tasks.md')) {
        try {
          const fullPath = join(validatedProjectPath, args.filePath);
          const content = await readFile(fullPath, 'utf-8');
          const validationResult = validateTasksMarkdown(content);

          if (!validationResult.valid) {
            const errorMessages = formatValidationErrors(validationResult);

            return {
              success: false,
              message: 'Tasks document has format errors that must be fixed before approval',
              data: {
                errorCount: validationResult.errors.length,
                warningCount: validationResult.warnings.length,
                summary: validationResult.summary
              },
              nextSteps: [
                'Fix the format errors listed below',
                'Ensure each task has: checkbox (- [ ]), numeric ID (1.1), description',
                'Ensure metadata uses underscores: _Requirements: ..._',
                'Ensure _Prompt ends with underscore',
                'Re-request approval after fixing',
                ...errorMessages
              ]
            };
          }
        } catch (fileError) {
          const errorMessage = fileError instanceof Error ? fileError.message : String(fileError);
          return {
            success: false,
            message: `Failed to read tasks file for validation: ${errorMessage}`
          };
        }
      }

      const approvalId = await approvalStore.createApproval(
        args.title,
        args.filePath,
        args.category,
        args.categoryName,
        args.type
      );

      const approvalUrl = context.dashboardUrl
        ? buildApprovalDeeplink(context.dashboardUrl, approvalId, dashboardProjectId || undefined)
        : undefined;

      return {
        success: true,
        message: `Approval request created. Now call wait-for-approval to block until user responds.`,
        data: {
          approvalId,
          title: args.title,
          filePath: args.filePath,
          type: args.type,
          status: 'pending',
          dashboardUrl: context.dashboardUrl,
          approvalUrl,
        },
        nextSteps: [
          `NEXT: Call wait-for-approval approvalId:"${approvalId}"`,
          'This will block until user approves/rejects/requests-revision',
          'Auto-cleanup happens on resolution',
          approvalUrl ? `Review in dashboard: ${approvalUrl}` : 'Start dashboard: spec-context-dashboard'
        ],
        projectContext: {
          projectPath: validatedProjectPath,
          workflowRoot: join(validatedProjectPath, '.spec-context'),
          dashboardUrl: context.dashboardUrl
        }
      };
    });

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      message: `Failed to create approval request: ${errorMessage}`
    };
  }
}

async function handleGetApprovalStatus(
  args: StatusApprovalArgs,
  context: ToolContext,
  approvalStoreFactory: ApprovalStoreFactory
): Promise<ToolResponse> {
  const projectPath = args.projectPath || context.projectPath;
  if (!projectPath) {
    return {
      success: false,
      message: 'Project path is required. Please provide projectPath parameter.'
    };
  }

  try {
    return withApprovalStore(projectPath, approvalStoreFactory, async ({
      validatedProjectPath,
      approvalStore,
    }) => {
      const approval = await approvalStore.getApproval(args.approvalId);

      if (!approval) {
        return {
          success: false,
          message: `Approval request not found: ${args.approvalId}`
        };
      }

      const statusProjection = projectApprovalStatus(approval.status);
      const statusFlags = toApprovalStatusFlags(statusProjection);
      const approvalUrl = context.dashboardUrl ? buildApprovalDeeplink(context.dashboardUrl, args.approvalId) : undefined;
      const nextSteps = APPROVAL_NEXT_STEP_BUILDERS[approval.status](approval, approvalUrl);

      return {
        success: true,
        message: approval.status === 'pending'
          ? `BLOCKED: Status is ${approval.status}. Verbal approval is NOT accepted. Use dashboard only.`
          : `Approval status: ${approval.status}`,
        data: {
          approvalId: args.approvalId,
          title: approval.title,
          type: approval.type,
          status: approval.status,
          createdAt: approval.createdAt,
          respondedAt: approval.respondedAt,
          response: approval.response,
          annotations: approval.annotations,
          comments: approval.comments,
          progressState: statusProjection.progressState,
          isCompleted: statusFlags.isCompleted,
          canProceed: statusFlags.canProceed,
          mustWait: statusFlags.mustWait,
          blockNext: statusFlags.blockNext,
          dashboardUrl: context.dashboardUrl,
          approvalUrl
        },
        nextSteps,
        projectContext: {
          projectPath: validatedProjectPath,
          workflowRoot: join(validatedProjectPath, '.spec-context'),
          dashboardUrl: context.dashboardUrl
        }
      };
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      message: `Failed to check approval status: ${errorMessage}`
    };
  }
}

async function handleDeleteApproval(
  args: DeleteApprovalArgs,
  context: ToolContext,
  approvalStoreFactory: ApprovalStoreFactory
): Promise<ToolResponse> {
  const projectPath = args.projectPath || context.projectPath;
  if (!projectPath) {
    return {
      success: false,
      message: 'Project path is required. Please provide projectPath parameter.'
    };
  }

  try {
    return withApprovalStore(projectPath, approvalStoreFactory, async ({
      validatedProjectPath,
      approvalStore,
    }) => {
      const approval = await approvalStore.getApproval(args.approvalId);
      if (!approval) {
        return {
          success: false,
          message: `Approval request "${args.approvalId}" not found`,
          nextSteps: [
            'Verify approval ID',
            'Check status with approvals action:"status"'
          ]
        };
      }

      const statusProjection = projectApprovalStatus(approval.status);
      if (statusProjection.resolution === 'pending') {
        const approvalUrl = context.dashboardUrl ? buildApprovalDeeplink(context.dashboardUrl, args.approvalId) : undefined;
        return {
          success: false,
          message: `BLOCKED: Cannot delete - status is "${approval.status}". This approval is still awaiting review. VERBAL APPROVAL NOT ACCEPTED. Use dashboard only.`,
          data: {
            approvalId: args.approvalId,
            currentStatus: approval.status,
            title: approval.title,
            blockProgress: true,
            canProceed: false
          },
          nextSteps: [
            'STOP - Cannot delete pending approval',
            'Wait for approval or rejection',
            'Poll with approvals action:"status"',
            ...(approvalUrl ? [`Review in dashboard: ${approvalUrl}`] : []),
            'Delete only after status changes to approved, rejected, or needs-revision'
          ]
        };
      }

      const deleted = await approvalStore.deleteApproval(args.approvalId);

      if (deleted) {
        return {
          success: true,
          message: `Approval request "${args.approvalId}" deleted successfully`,
          data: {
            deletedApprovalId: args.approvalId,
            title: approval.title,
            category: approval.category,
            categoryName: approval.categoryName
          },
          nextSteps: [
            'Cleanup complete',
            'Continue to next phase'
          ],
          projectContext: {
            projectPath: validatedProjectPath,
            workflowRoot: join(validatedProjectPath, '.spec-context'),
            dashboardUrl: context.dashboardUrl
          }
        };
      }

      return {
        success: false,
        message: `Failed to delete approval request "${args.approvalId}"`,
        nextSteps: [
          'Check file permissions',
          'Verify approval exists',
          'Retry'
        ]
      };
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      message: `Failed to delete approval: ${errorMessage}`,
      nextSteps: [
        'Check project path',
        'Verify permissions',
        'Check approval system'
      ]
    };
  }
}
