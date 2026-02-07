import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { stat } from 'fs/promises';
import { join } from 'path';
import { SpecData, ToolContext, ToolResponse, requireFileContentCache } from '../../workflow-types.js';
import { PathUtils } from '../../core/workflow/path-utils.js';
import { areFileFingerprintsEqual, type FileContentFingerprint } from '../../core/cache/file-content-cache.js';
import { setBoundedMapEntry } from '../../core/cache/bounded-map.js';

export interface SpecStatusReader {
  getSpec(name: string): Promise<SpecData | null>;
}

export interface SpecStatusReaderFactory {
  create(projectPath: string): SpecStatusReader;
}

interface SpecStatusArgs {
  projectPath?: string;
  specName: string;
}

type SpecWorkflowPhase =
  | 'requirements'
  | 'design'
  | 'tasks'
  | 'implementation'
  | 'completed';

type SpecOverallStatus =
  | 'requirements-needed'
  | 'design-needed'
  | 'tasks-needed'
  | 'implementing'
  | 'ready-for-implementation'
  | 'completed';

interface SpecWorkflowState {
  currentPhase: SpecWorkflowPhase;
  overallStatus: SpecOverallStatus;
}

interface SpecStatusCacheEntry {
  spec: SpecData;
  tasksFingerprint: FileContentFingerprint | null;
  specDirMtimeMs: number | null;
}

interface SpecStatusRule {
  matches(spec: SpecData): boolean;
  state: SpecWorkflowState;
}

const DOCUMENT_PHASES = [
  { key: 'requirements', name: 'Requirements' },
  { key: 'design', name: 'Design' },
  { key: 'tasks', name: 'Tasks' },
] as const;

const SPEC_STATUS_RULES: readonly SpecStatusRule[] = [
  {
    matches: (spec) => !spec.phases.requirements.exists,
    state: { currentPhase: 'requirements', overallStatus: 'requirements-needed' },
  },
  {
    matches: (spec) => !spec.phases.design.exists,
    state: { currentPhase: 'design', overallStatus: 'design-needed' },
  },
  {
    matches: (spec) => !spec.phases.tasks.exists,
    state: { currentPhase: 'tasks', overallStatus: 'tasks-needed' },
  },
  {
    matches: (spec) => hasPendingTasks(spec),
    state: { currentPhase: 'implementation', overallStatus: 'implementing' },
  },
  {
    matches: (spec) => areAllTasksCompleted(spec),
    state: { currentPhase: 'completed', overallStatus: 'completed' },
  },
  {
    matches: () => true,
    state: { currentPhase: 'implementation', overallStatus: 'ready-for-implementation' },
  },
];

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

export function createSpecStatusHandler(
  specStatusReaderFactory: SpecStatusReaderFactory
): (args: unknown, context: ToolContext) => Promise<ToolResponse> {
  return async function specStatusHandler(args: unknown, context: ToolContext): Promise<ToolResponse> {
    const parsedArgs = args as SpecStatusArgs;
    const specName = parsedArgs.specName;
    const projectPath = parsedArgs.projectPath ?? context.projectPath;
    const fileContentCache = requireFileContentCache(context);

    if (!projectPath) {
      return {
        success: false,
        message: 'Project path is required but not provided in context or arguments'
      };
    }

    try {
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
        const reader = specStatusReaderFactory.create(translatedPath);
        spec = await reader.getSpec(specName);
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

      const workflowState = resolveSpecWorkflowState(spec);
      const phaseDetails = buildPhaseDetails(spec);
      const nextSteps = buildNextSteps(workflowState.currentPhase, spec, specName);

      return {
        success: true,
        message: `Specification '${specName}' status: ${workflowState.overallStatus}`,
        data: {
          name: specName,
          description: spec.description,
          currentPhase: workflowState.currentPhase,
          overallStatus: workflowState.overallStatus,
          createdAt: spec.createdAt,
          lastModified: spec.lastModified,
          phases: phaseDetails,
          taskProgress: spec.taskProgress ?? {
            total: 0,
            completed: 0,
            pending: 0,
          },
        },
        nextSteps,
        projectContext: {
          projectPath,
          workflowRoot: PathUtils.getWorkflowRoot(projectPath),
          currentPhase: workflowState.currentPhase,
          dashboardUrl: context.dashboardUrl,
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
  };
}

function resolveSpecWorkflowState(spec: SpecData): SpecWorkflowState {
  for (const rule of SPEC_STATUS_RULES) {
    if (rule.matches(spec)) {
      return rule.state;
    }
  }
  throw new Error('No workflow status rule matched specification state');
}

function buildPhaseDetails(spec: SpecData): Array<{
  name: string;
  status: string;
  lastModified?: string;
  progress?: SpecData['taskProgress'];
}> {
  const phases: Array<{
    name: string;
    status: string;
    lastModified?: string;
    progress?: SpecData['taskProgress'];
  }> = DOCUMENT_PHASES.map(({ key, name }) => {
    const phase = spec.phases[key];
    return {
      name,
      status: phase.exists ? (phase.approved ? 'approved' : 'created') : 'missing',
      lastModified: phase.lastModified,
    };
  });

  phases.push({
    name: 'Implementation',
    status: spec.phases.implementation.exists ? 'in-progress' : 'not-started',
    progress: spec.taskProgress,
  });

  return phases;
}

function buildNextSteps(
  currentPhase: SpecWorkflowPhase,
  spec: SpecData,
  specName: string
): string[] {
  const nextStepBuilders: Record<SpecWorkflowPhase, () => string[]> = {
    requirements: () => [
      'Read template: .spec-context/templates/requirements-template-v*.md',
      'Create: .spec-context/specs/{name}/requirements.md',
      'Request approval',
    ],
    design: () => [
      'Read template: .spec-context/templates/design-template-v*.md',
      'Create: .spec-context/specs/{name}/design.md',
      'Request approval',
    ],
    tasks: () => [
      'Read template: .spec-context/templates/tasks-template-v*.md',
      'Create: .spec-context/specs/{name}/tasks.md',
      'Request approval',
    ],
    implementation: () => buildImplementationNextSteps(spec, specName),
    completed: () => [
      'All tasks completed (marked [x])',
      'Run tests',
    ],
  };

  return nextStepBuilders[currentPhase]();
}

function buildImplementationNextSteps(spec: SpecData, specName: string): string[] {
  if (hasPendingTasks(spec)) {
    return [
      `Read tasks: .spec-context/specs/${specName}/tasks.md`,
      'Edit tasks.md: Change [ ] to [-] for task you start',
      'Implement the task code',
      'Edit tasks.md: Change [-] to [x] when completed',
    ];
  }

  return [
    `Read tasks: .spec-context/specs/${specName}/tasks.md`,
    'Begin implementation by marking first task [-]',
  ];
}

function hasPendingTasks(spec: SpecData): boolean {
  return spec.taskProgress !== undefined && spec.taskProgress.pending > 0;
}

function areAllTasksCompleted(spec: SpecData): boolean {
  return spec.taskProgress !== undefined
    && spec.taskProgress.total > 0
    && spec.taskProgress.completed === spec.taskProgress.total;
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
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}
