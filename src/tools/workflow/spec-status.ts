import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { stat } from 'fs/promises';
import { join } from 'path';
import { ToolContext, ToolResponse } from '../../workflow-types.js';
import { PathUtils } from '../../core/workflow/path-utils.js';
import { SpecParser } from '../../core/workflow/parser.js';
import { areFileFingerprintsEqual, type FileContentFingerprint } from '../../core/cache/file-content-cache.js';
import { getSharedFileContentCache } from '../../core/cache/shared-file-content-cache.js';
import { setBoundedMapEntry } from '../../core/cache/bounded-map.js';

interface SpecStatusCacheEntry {
  spec: Awaited<ReturnType<SpecParser['getSpec']>>;
  tasksFingerprint: FileContentFingerprint | null;
  specDirMtimeMs: number | null;
}

const specStatusCache = new Map<string, SpecStatusCacheEntry>();
const MAX_SPEC_STATUS_CACHE_ENTRIES = 512;

export const specStatusTool: Tool = {
  name: 'spec-status',
  description: `Check spec status, list specs, show my specs, get spec progress. Use when user asks about specs, their status, wants to see all specs, or says "what specs do I have".

# Instructions
Call when resuming work on a spec or checking overall completion status. Shows which phases are complete and task implementation progress. After viewing status, read tasks.md directly to see all tasks and their status markers ([ ] pending, [-] in-progress, [x] completed).`,
  inputSchema: {
    type: 'object',
    properties: {
      projectPath: { 
        type: 'string',
        description: 'Absolute path to the project root (optional - uses server context path if not provided)'
      },
      specName: { 
        type: 'string',
        description: 'Name of the specification'
      }
    },
    required: ['specName']
  },
  outputSchema: {
    type: 'object',
    properties: {
      success: { type: 'boolean' },
      message: { type: 'string' },
      data: {
        type: 'object',
        additionalProperties: true,
      },
      nextSteps: {
        type: 'array',
        items: { type: 'string' },
      },
      projectContext: {
        type: 'object',
        additionalProperties: true,
      },
    },
    required: ['success', 'message'],
  },
};

export async function specStatusHandler(args: any, context: ToolContext): Promise<ToolResponse> {
  const { specName } = args;
  const fileContentCache = context.fileContentCache ?? getSharedFileContentCache();
  
  // Use context projectPath as default, allow override via args
  const projectPath = args.projectPath || context.projectPath;
  
  if (!projectPath) {
    return {
      success: false,
      message: 'Project path is required but not provided in context or arguments'
    };
  }

  try {
    // Translate path at tool entry point (components expect pre-translated paths)
    const translatedPath = PathUtils.translatePath(projectPath);
    const cacheKey = buildSpecStatusCacheKey(translatedPath, specName);
    const specDirPath = PathUtils.getSpecPath(translatedPath, specName);
    const tasksPath = join(specDirPath, 'tasks.md');
    await fileContentCache.get(tasksPath, { namespace: 'spec-status' });
    const tasksFingerprint = fileContentCache.getFingerprint(tasksPath);
    const specDirMtimeMs = await getDirectoryMtimeMs(specDirPath);

    const cached = specStatusCache.get(cacheKey);
    const useCachedSpec =
      cached !== undefined
      && areFileFingerprintsEqual(cached.tasksFingerprint, tasksFingerprint)
      && cached.specDirMtimeMs === specDirMtimeMs;

    let spec = useCachedSpec ? cached.spec : null;
    if (!useCachedSpec) {
      const parser = new SpecParser(translatedPath);
      spec = await parser.getSpec(specName);
      if (spec) {
        setBoundedMapEntry(specStatusCache, cacheKey, {
          spec,
          tasksFingerprint,
          specDirMtimeMs,
        }, MAX_SPEC_STATUS_CACHE_ENTRIES);
      } else {
        specStatusCache.delete(cacheKey);
      }
    }
    
    if (!spec) {
      return {
        success: false,
        message: `Specification '${specName}' not found`,
        nextSteps: [
          'Check spec name',
          'Use spec-list for available specs',
          'Create spec with create-spec-doc'
        ]
      };
    }

    // Determine current phase and overall status
    let currentPhase = 'not-started';
    let overallStatus = 'not-started';
    
    if (!spec.phases.requirements.exists) {
      currentPhase = 'requirements';
      overallStatus = 'requirements-needed';
    } else if (!spec.phases.design.exists) {
      currentPhase = 'design';
      overallStatus = 'design-needed';
    } else if (!spec.phases.tasks.exists) {
      currentPhase = 'tasks';
      overallStatus = 'tasks-needed';
    } else if (spec.taskProgress && spec.taskProgress.pending > 0) {
      currentPhase = 'implementation';
      overallStatus = 'implementing';
    } else if (spec.taskProgress && spec.taskProgress.total > 0 && spec.taskProgress.completed === spec.taskProgress.total) {
      currentPhase = 'completed';
      overallStatus = 'completed';
    } else {
      currentPhase = 'implementation';
      overallStatus = 'ready-for-implementation';
    }

    // Phase details
    const phaseDetails = [
      {
        name: 'Requirements',
        status: spec.phases.requirements.exists ? (spec.phases.requirements.approved ? 'approved' : 'created') : 'missing',
        lastModified: spec.phases.requirements.lastModified
      },
      {
        name: 'Design',
        status: spec.phases.design.exists ? (spec.phases.design.approved ? 'approved' : 'created') : 'missing',
        lastModified: spec.phases.design.lastModified
      },
      {
        name: 'Tasks',
        status: spec.phases.tasks.exists ? (spec.phases.tasks.approved ? 'approved' : 'created') : 'missing',
        lastModified: spec.phases.tasks.lastModified
      },
      {
        name: 'Implementation',
        status: spec.phases.implementation.exists ? 'in-progress' : 'not-started',
        progress: spec.taskProgress
      }
    ];

    // Next steps based on current phase
    const nextSteps = [];
    switch (currentPhase) {
      case 'requirements':
        nextSteps.push('Read template: .spec-context/templates/requirements-template-v*.md');
        nextSteps.push('Create: .spec-context/specs/{name}/requirements.md');
        nextSteps.push('Request approval');
        break;
      case 'design':
        nextSteps.push('Read template: .spec-context/templates/design-template-v*.md');
        nextSteps.push('Create: .spec-context/specs/{name}/design.md');
        nextSteps.push('Request approval');
        break;
      case 'tasks':
        nextSteps.push('Read template: .spec-context/templates/tasks-template-v*.md');
        nextSteps.push('Create: .spec-context/specs/{name}/tasks.md');
        nextSteps.push('Request approval');
        break;
      case 'implementation':
        if (spec.taskProgress && spec.taskProgress.pending > 0) {
          nextSteps.push(`Read tasks: .spec-context/specs/${specName}/tasks.md`);
          nextSteps.push('Edit tasks.md: Change [ ] to [-] for task you start');
          nextSteps.push('Implement the task code');
          nextSteps.push('Edit tasks.md: Change [-] to [x] when completed');
        } else {
          nextSteps.push(`Read tasks: .spec-context/specs/${specName}/tasks.md`);
          nextSteps.push('Begin implementation by marking first task [-]');
        }
        break;
      case 'completed':
        nextSteps.push('All tasks completed (marked [x])');
        nextSteps.push('Run tests');
        break;
    }

    return {
      success: true,
      message: `Specification '${specName}' status: ${overallStatus}`,
      data: {
        name: specName,
        description: spec.description,
        currentPhase,
        overallStatus,
        createdAt: spec.createdAt,
        lastModified: spec.lastModified,
        phases: phaseDetails,
        taskProgress: spec.taskProgress || {
          total: 0,
          completed: 0,
          pending: 0
        }
      },
      nextSteps,
      projectContext: {
        projectPath,
        workflowRoot: PathUtils.getWorkflowRoot(projectPath),
        currentPhase,
        dashboardUrl: context.dashboardUrl
      }
    };
    
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      message: `Failed to get specification status: ${errorMessage}`,
      nextSteps: [
        'Check if the specification exists',
        'Verify the project path',
        'List directory .spec-context/specs/ to see available specifications'
      ]
    };
  }
}

function buildSpecStatusCacheKey(projectPath: string, specName: string): string {
  return `${projectPath}:${specName}`;
}

async function getDirectoryMtimeMs(specDirPath: string): Promise<number | null> {
  try {
    const stats = await stat(specDirPath);
    if (!stats.isDirectory()) {
      return null;
    }
    return stats.mtimeMs;
  } catch {
    return null;
  }
}
