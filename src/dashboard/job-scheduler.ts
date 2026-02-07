import * as cron from 'node-cron';
import { join } from 'path';
import { AutomationJob, GlobalSettings, JobExecutionHistory } from '../workflow-types.js';

export interface JobExecutionResult {
  jobId: string;
  jobName: string;
  success: boolean;
  startTime: string;
  endTime: string;
  duration: number;
  itemsProcessed: number;
  itemsDeleted: number;
  error?: string;
}

interface ApprovalCleanupRecord {
  id: string;
  createdAt: string;
}

interface SpecCleanupRecord {
  name: string;
  createdAt: string;
}

export interface ApprovalCleanupStore {
  getAllApprovals(): Promise<ApprovalCleanupRecord[]>;
  deleteApproval(approvalId: string): Promise<boolean>;
}

export interface SpecCleanupStore {
  getAllSpecs(): Promise<SpecCleanupRecord[]>;
  getAllArchivedSpecs(): Promise<SpecCleanupRecord[]>;
}

export interface JobSchedulerProjectContext {
  projectPath: string;
  approvalStorage: ApprovalCleanupStore;
  parser: SpecCleanupStore;
}

export interface JobSchedulerProjectCatalog {
  getProjectsList(): Array<{ projectId: string }>;
  getProject(projectId: string): JobSchedulerProjectContext | undefined;
}

export interface JobSettingsStore {
  loadSettings(): Promise<GlobalSettings>;
  getJob(jobId: string): Promise<AutomationJob | null>;
  updateJob(jobId: string, updates: Partial<AutomationJob>): Promise<void>;
  deleteJob(jobId: string): Promise<void>;
  addJob(job: AutomationJob): Promise<void>;
  getAllJobs(): Promise<AutomationJob[]>;
}

export interface JobHistoryStore {
  recordExecution(execution: JobExecutionHistory): Promise<void>;
  getJobHistory(jobId: string, limit?: number): Promise<JobExecutionHistory[]>;
  getJobStats(jobId: string): Promise<unknown>;
}

export interface ArtifactRemover {
  remove(path: string): Promise<void>;
}

export interface JobSchedulerDependencies {
  settingsStore: JobSettingsStore;
  historyStore: JobHistoryStore;
  projectCatalog: JobSchedulerProjectCatalog;
  artifactRemover: ArtifactRemover;
}

interface CleanupResult {
  processed: number;
  deleted: number;
}

type JobCleanupHandler = (project: JobSchedulerProjectContext, daysOld: number) => Promise<CleanupResult>;

type JobType = AutomationJob['type'];

export class JobScheduler {
  private readonly settingsStore: JobSettingsStore;
  private readonly historyStore: JobHistoryStore;
  private readonly projectCatalog: JobSchedulerProjectCatalog;
  private readonly artifactRemover: ArtifactRemover;
  private readonly scheduledJobs: Map<string, cron.ScheduledTask> = new Map();
  private readonly cleanupHandlers: Record<JobType, JobCleanupHandler>;

  constructor(dependencies: JobSchedulerDependencies) {
    this.settingsStore = dependencies.settingsStore;
    this.historyStore = dependencies.historyStore;
    this.projectCatalog = dependencies.projectCatalog;
    this.artifactRemover = dependencies.artifactRemover;

    this.cleanupHandlers = {
      'cleanup-approvals': async (project, daysOld) => this.cleanupApprovals(project.approvalStorage, daysOld),
      'cleanup-specs': async (project, daysOld) => this.cleanupSpecs(project.projectPath, project.parser, daysOld),
      'cleanup-archived-specs': async (project, daysOld) => this.cleanupArchivedSpecs(project.projectPath, project.parser, daysOld),
    };
  }

  async initialize(): Promise<void> {
    try {
      const settings = await this.settingsStore.loadSettings();

      for (const job of settings.automationJobs) {
        if (job.enabled) {
          await this.runJobCatchUp(job);
        }
      }

      for (const job of settings.automationJobs) {
        if (job.enabled) {
          this.scheduleJob(job);
        }
      }

      console.error('[JobScheduler] Initialized with ' + settings.automationJobs.length + ' jobs');
    } catch (error) {
      console.error('[JobScheduler] Failed to initialize:', error);
    }
  }

  private async runJobCatchUp(job: AutomationJob): Promise<void> {
    const startTime = new Date();

    try {
      const result = await this.executeJob(job);

      if (result.itemsDeleted > 0) {
        console.error(
          `[JobScheduler] Catch-up for "${job.name}": ${result.itemsDeleted} items deleted in ${result.duration}ms`
        );
      }

      await this.recordExecution(job, result);
      await this.settingsStore.updateJob(job.id, {
        lastRun: startTime.toISOString(),
      });
    } catch (error) {
      console.error(`[JobScheduler] Catch-up failed for "${job.name}":`, error);
    }
  }

  private scheduleJob(job: AutomationJob): void {
    try {
      this.unscheduleJob(job.id);

      const task = cron.schedule(job.schedule, async () => {
        try {
          const startTime = new Date();
          const result = await this.executeJob(job);

          console.error(
            `[JobScheduler] Executed "${job.name}": ${result.itemsDeleted} items deleted in ${result.duration}ms`
          );

          await this.recordExecution(job, result);
          await this.settingsStore.updateJob(job.id, {
            lastRun: startTime.toISOString(),
          });
        } catch (error) {
          console.error(`[JobScheduler] Execution failed for "${job.name}":`, error);
        }
      });

      this.scheduledJobs.set(job.id, task);
      console.error(`[JobScheduler] Scheduled job "${job.name}" with cron: ${job.schedule}`);
    } catch (error) {
      console.error(`[JobScheduler] Failed to schedule job "${job.name}":`, error);
    }
  }

  private async executeJob(job: AutomationJob): Promise<JobExecutionResult> {
    const startTime = new Date();
    let itemsProcessed = 0;
    let itemsDeleted = 0;
    let error: string | undefined;

    try {
      const cleanupHandler = this.cleanupHandlers[job.type];
      const projects = this.projectCatalog.getProjectsList();

      for (const project of projects) {
        const projectContext = this.projectCatalog.getProject(project.projectId);
        if (!projectContext) {
          throw new Error(`Project context not found for project ${project.projectId}`);
        }

        const result = await cleanupHandler(projectContext, job.config.daysOld);
        itemsProcessed += result.processed;
        itemsDeleted += result.deleted;
      }
    } catch (executionError) {
      error = executionError instanceof Error ? executionError.message : String(executionError);
    }

    const endTime = new Date();

    return {
      jobId: job.id,
      jobName: job.name,
      success: !error,
      startTime: startTime.toISOString(),
      endTime: endTime.toISOString(),
      duration: endTime.getTime() - startTime.getTime(),
      itemsProcessed,
      itemsDeleted,
      error,
    };
  }

  private async cleanupApprovals(
    approvalStorage: ApprovalCleanupStore,
    daysOld: number
  ): Promise<CleanupResult> {
    const approvals = await approvalStorage.getAllApprovals();
    const cutoffTime = Date.now() - daysOld * 24 * 60 * 60 * 1000;

    let deleted = 0;

    for (const approval of approvals) {
      const createdTime = new Date(approval.createdAt).getTime();
      if (createdTime >= cutoffTime) {
        continue;
      }

      try {
        await approvalStorage.deleteApproval(approval.id);
        deleted += 1;
      } catch (error) {
        console.error(`Failed to delete approval ${approval.id}:`, error);
      }
    }

    return { processed: approvals.length, deleted };
  }

  private async cleanupSpecs(
    projectPath: string,
    parser: SpecCleanupStore,
    daysOld: number
  ): Promise<CleanupResult> {
    const specs = await parser.getAllSpecs();
    return this.cleanupSpecCollection({
      specs,
      daysOld,
      toPath: spec => join(projectPath, '.spec-context', 'specs', spec.name),
      onDeleteError: specName => `Failed to delete spec ${specName}`,
    });
  }

  private async cleanupArchivedSpecs(
    projectPath: string,
    parser: SpecCleanupStore,
    daysOld: number
  ): Promise<CleanupResult> {
    const archivedSpecs = await parser.getAllArchivedSpecs();
    return this.cleanupSpecCollection({
      specs: archivedSpecs,
      daysOld,
      toPath: spec => join(projectPath, '.spec-context', 'archive', 'specs', spec.name),
      onDeleteError: specName => `Failed to delete archived spec ${specName}`,
    });
  }

  private async cleanupSpecCollection(args: {
    specs: SpecCleanupRecord[];
    daysOld: number;
    toPath(spec: SpecCleanupRecord): string;
    onDeleteError(specName: string): string;
  }): Promise<CleanupResult> {
    const cutoffTime = Date.now() - args.daysOld * 24 * 60 * 60 * 1000;
    let deleted = 0;

    for (const spec of args.specs) {
      const createdTime = new Date(spec.createdAt).getTime();
      if (createdTime >= cutoffTime) {
        continue;
      }

      try {
        await this.artifactRemover.remove(args.toPath(spec));
        deleted += 1;
      } catch (error) {
        console.error(`${args.onDeleteError(spec.name)}:`, error);
      }
    }

    return {
      processed: args.specs.length,
      deleted,
    };
  }

  async runJobManually(jobId: string): Promise<JobExecutionResult> {
    const job = await this.settingsStore.getJob(jobId);
    if (!job) {
      throw new Error(`Job with ID ${jobId} not found`);
    }

    return this.executeJob(job);
  }

  async updateJob(jobId: string, updates: Partial<AutomationJob>): Promise<void> {
    await this.settingsStore.updateJob(jobId, updates);

    const job = await this.settingsStore.getJob(jobId);
    if (!job) {
      return;
    }

    if (job.enabled) {
      this.scheduleJob(job);
      return;
    }

    this.unscheduleJob(job.id);
  }

  async deleteJob(jobId: string): Promise<void> {
    this.unscheduleJob(jobId);
    await this.settingsStore.deleteJob(jobId);
  }

  async addJob(job: AutomationJob): Promise<void> {
    await this.settingsStore.addJob(job);
    if (job.enabled) {
      this.scheduleJob(job);
    }
  }

  async getAllJobs(): Promise<AutomationJob[]> {
    return this.settingsStore.getAllJobs();
  }

  async getJobExecutionHistory(jobId: string, limit: number = 50) {
    return this.historyStore.getJobHistory(jobId, limit);
  }

  async getJobStats(jobId: string) {
    return this.historyStore.getJobStats(jobId);
  }

  async shutdown(): Promise<void> {
    for (const task of this.scheduledJobs.values()) {
      task.stop();
    }
    this.scheduledJobs.clear();
    console.error('[JobScheduler] Shutdown complete');
  }

  private async recordExecution(job: AutomationJob, result: JobExecutionResult): Promise<void> {
    await this.historyStore.recordExecution({
      jobId: job.id,
      jobName: job.name,
      jobType: job.type,
      executedAt: result.startTime,
      success: result.success,
      duration: result.duration,
      itemsProcessed: result.itemsProcessed,
      itemsDeleted: result.itemsDeleted,
      error: result.error,
    });
  }

  private unscheduleJob(jobId: string): void {
    const scheduled = this.scheduledJobs.get(jobId);
    if (!scheduled) {
      return;
    }

    scheduled.stop();
    this.scheduledJobs.delete(jobId);
  }
}
