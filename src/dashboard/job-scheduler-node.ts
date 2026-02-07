import { promises as fs } from 'fs';
import { ExecutionHistoryManager } from './execution-history-manager.js';
import {
  ArtifactRemover,
  JobScheduler,
  JobSchedulerProjectCatalog,
  JobSettingsStore,
  JobHistoryStore,
} from './job-scheduler.js';
import { SettingsManager } from './settings-manager.js';
import { ProjectManager } from './project-manager.js';

class NodeArtifactRemover implements ArtifactRemover {
  async remove(path: string): Promise<void> {
    await fs.rm(path, { recursive: true, force: true });
  }
}

function createNodeJobSettingsStore(): JobSettingsStore {
  return new SettingsManager();
}

function createNodeJobHistoryStore(): JobHistoryStore {
  return new ExecutionHistoryManager();
}

export function createNodeJobScheduler(projectCatalog: JobSchedulerProjectCatalog): JobScheduler {
  return new JobScheduler({
    settingsStore: createNodeJobSettingsStore(),
    historyStore: createNodeJobHistoryStore(),
    projectCatalog,
    artifactRemover: new NodeArtifactRemover(),
  });
}

export function createNodeJobSchedulerForProjectManager(projectManager: ProjectManager): JobScheduler {
  return createNodeJobScheduler(projectManager);
}
