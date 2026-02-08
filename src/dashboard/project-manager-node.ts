import { SpecParser } from './parser.js';
import { SpecWatcher } from './watcher.js';
import { ApprovalStorage } from './approval-storage.js';
import { SpecArchiveService } from '../core/workflow/archive-service.js';
import { ProjectRegistry } from '../core/workflow/project-registry.js';
import {
  ProjectManager,
  type ProjectManagerDependencies,
  type ProjectComponentFactory,
} from './project-manager.js';

const nodeProjectComponentFactory: ProjectComponentFactory = {
  createParser: (projectPath) => new SpecParser(projectPath),
  createWatcher: (projectPath, parser) => new SpecWatcher(projectPath, parser),
  createApprovalStorage: (translatedPath, originalPath) => new ApprovalStorage(translatedPath, originalPath),
  createArchiveService: (projectPath) => new SpecArchiveService(projectPath),
};

export function createNodeProjectManagerDependencies(): ProjectManagerDependencies {
  return {
    registry: new ProjectRegistry(),
    componentFactory: nodeProjectComponentFactory,
  };
}

export function createNodeProjectManager(overrides: Partial<ProjectManagerDependencies> = {}): ProjectManager {
  const defaults = createNodeProjectManagerDependencies();
  return new ProjectManager({
    registry: overrides.registry ?? defaults.registry,
    componentFactory: overrides.componentFactory ?? defaults.componentFactory,
  });
}
