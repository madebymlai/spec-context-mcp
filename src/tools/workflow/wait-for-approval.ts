import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { ToolContext, ToolResponse } from '../../workflow-types.js';
import { validateProjectPath, PathUtils } from '../../core/workflow/path-utils.js';
import { resolveDashboardUrl } from '../../core/workflow/dashboard-url.js';

/**
 * Safely translate a path, with defensive checks
 */
function safeTranslatePath(path: string): string {
  if (typeof PathUtils?.translatePath !== 'function') {
    throw new Error(
      `PathUtils.translatePath is not available (got ${typeof PathUtils?.translatePath}). ` +
      'This may indicate a module loading issue. Please reinstall the package.'
    );
  }
  return PathUtils.translatePath(path);
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

export async function waitForApprovalHandler(
  args: {
    approvalId: string;
    projectPath?: string;
    timeoutMs?: number;
    autoDelete?: boolean;
  },
  context: ToolContext
): Promise<ToolResponse> {
  const projectPath = args.projectPath || context.projectPath;

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
    // Validate and resolve project path
    const validatedProjectPath = await validateProjectPath(projectPath);
    const translatedPath = safeTranslatePath(validatedProjectPath);

    // Get dashboard URL from context
    const dashboardUrl = context.dashboardUrl || await resolveDashboardUrl();

    // We need to find the projectId for this project path
    // First, get the project list from the dashboard
    const projectsResponse = await fetch(`${dashboardUrl}/api/projects/list`);
    if (!projectsResponse.ok) {
      return {
        success: false,
        message: `Dashboard not available at ${dashboardUrl}. Please start dashboard with: spec-context-dashboard`
      };
    }

    const projects = await projectsResponse.json() as Array<{ projectId: string; projectPath?: string; projectName: string }>;

    // Find project by path (check both translated and original paths)
    const project = projects.find(p => {
      if (!p.projectPath) return false;
      return p.projectPath === translatedPath ||
        p.projectPath === validatedProjectPath ||
        p.projectPath.endsWith(validatedProjectPath.split('/').pop() || '');
    });

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

    // Build wait endpoint URL
    const timeoutMs = Math.min(args.timeoutMs || 600000, 1800000);
    const autoDelete = args.autoDelete !== false;
    const waitUrl = `${dashboardUrl}/api/projects/${project.projectId}/approvals/${args.approvalId}/wait?timeout=${timeoutMs}&autoDelete=${autoDelete}`;

    // Call the wait endpoint (this will block)
    const controller = new AbortController();
    const fetchTimeout = setTimeout(() => controller.abort(), timeoutMs + 5000); // Extra buffer for network

    try {
      const response = await fetch(waitUrl, { signal: controller.signal });
      clearTimeout(fetchTimeout);

      if (!response.ok) {
        const error = await response.json() as { error?: string };
        return {
          success: false,
          message: `Wait failed: ${error.error || response.statusText}`
        };
      }

      const result = await response.json() as {
        resolved: boolean;
        status: string;
        response?: string;
        annotations?: string;
        comments?: Array<{
          type: string;
          selectedText?: string;
          comment: string;
        }>;
        respondedAt?: string;
        autoDeleted?: boolean;
        timeout?: boolean;
        message?: string;
      };

      // Handle timeout
      if (result.timeout) {
        return {
          success: false,
          message: 'Timeout waiting for approval. User has not responded yet.',
          data: {
            approvalId: args.approvalId,
            status: 'pending',
            timeout: true
          },
          nextSteps: [
            'Call wait-for-approval again to continue waiting',
            'Or check dashboard to see if user is available',
            `Dashboard: ${dashboardUrl}`
          ]
        };
      }

      // Handle resolved approval
      const canProceed = result.status === 'approved';
      const nextSteps: string[] = [];

      if (result.status === 'approved') {
        nextSteps.push('APPROVED - Proceed to next phase');
        if (result.response) {
          nextSteps.push(`Response: ${result.response}`);
        }
      } else if (result.status === 'rejected') {
        nextSteps.push('REJECTED - Do not proceed');
        nextSteps.push('Ask user for guidance on how to proceed');
        if (result.response) {
          nextSteps.push(`Reason: ${result.response}`);
        }
      } else if (result.status === 'needs-revision') {
        nextSteps.push('NEEDS REVISION - Update document with feedback');
        nextSteps.push('After updating, create NEW approval request');
        nextSteps.push('Then call wait-for-approval again');
        if (result.response) {
          nextSteps.push(`Feedback: ${result.response}`);
        }
        if (result.annotations) {
          nextSteps.push(`Notes: ${result.annotations}`);
        }
        if (result.comments && result.comments.length > 0) {
          nextSteps.push(`${result.comments.length} inline comments:`);
          result.comments.forEach((comment, index) => {
            if (comment.type === 'selection' && comment.selectedText) {
              const preview = comment.selectedText.length > 50
                ? comment.selectedText.substring(0, 50) + '...'
                : comment.selectedText;
              nextSteps.push(`  ${index + 1}. On "${preview}": ${comment.comment}`);
            } else {
              nextSteps.push(`  ${index + 1}. (general): ${comment.comment}`);
            }
          });
        }
      }

      return {
        success: true,
        message: `Approval resolved: ${result.status}${result.autoDeleted ? ' (auto-cleaned)' : ''}`,
        data: {
          approvalId: args.approvalId,
          status: result.status,
          response: result.response,
          annotations: result.annotations,
          comments: result.comments,
          respondedAt: result.respondedAt,
          autoDeleted: result.autoDeleted,
          canProceed
        },
        nextSteps,
        projectContext: {
          projectPath: validatedProjectPath,
          workflowRoot: `${validatedProjectPath}/.spec-context`,
          dashboardUrl
        }
      };

    } catch (fetchError: any) {
      clearTimeout(fetchTimeout);
      if (fetchError.name === 'AbortError') {
        return {
          success: false,
          message: 'Request timed out waiting for approval',
          data: {
            approvalId: args.approvalId,
            status: 'pending',
            timeout: true
          },
          nextSteps: [
            'Call wait-for-approval again to continue waiting',
            `Dashboard: ${dashboardUrl}`
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
}
