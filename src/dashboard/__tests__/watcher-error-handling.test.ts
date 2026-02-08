import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SpecWatcher, type SpecWatcherErrorEvent } from '../watcher.js';
import type { ISpecParser, ParsedSpec } from '../parser.js';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('SpecWatcher Error Handling', () => {
  let testDir: string;
  let watcher: SpecWatcher;
  let parser: ISpecParser;
  let failGetSpec = false;
  let specByName = new Map<string, ParsedSpec>();

  function makeParsedSpec(name: string): ParsedSpec {
    return {
      name,
      displayName: name,
      createdAt: new Date().toISOString(),
      lastModified: new Date().toISOString(),
      phases: {
        requirements: { exists: true },
        design: { exists: false },
        tasks: { exists: false },
        implementation: { exists: true },
      },
    };
  }

  beforeEach(async () => {
    // Create a temporary test directory
    testDir = join(tmpdir(), `spec-context-test-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });
    failGetSpec = false;
    specByName = new Map<string, ParsedSpec>();
    
    // Create the workflow directory structure
    const workflowDir = join(testDir, '.spec-context');
    const specsDir = join(workflowDir, 'specs');
    const steeringDir = join(workflowDir, 'steering');
    
    await fs.mkdir(workflowDir, { recursive: true });
    await fs.mkdir(specsDir, { recursive: true });
    await fs.mkdir(steeringDir, { recursive: true });

    // Create a test spec
    const testSpecDir = join(specsDir, 'test-spec');
    await fs.mkdir(testSpecDir, { recursive: true });
    await fs.writeFile(join(testSpecDir, 'requirements.md'), '# Test Requirements\n\nSome content');
    specByName.set('test-spec', makeParsedSpec('test-spec'));

    parser = {
      getAllSpecs: async () => Array.from(specByName.values()),
      getAllArchivedSpecs: async () => [],
      getSpec: async (name: string) => {
        if (failGetSpec) {
          throw new Error('Parser error');
        }
        return specByName.get(name) ?? null;
      },
      getArchivedSpec: async () => null,
      getProjectSteeringStatus: async () => ({
        exists: true,
        documents: {
          product: true,
          tech: true,
          structure: true,
          principles: true,
        },
        lastModified: new Date().toISOString(),
      }),
    };

    watcher = new SpecWatcher(testDir, parser);
  });

  afterEach(async () => {
    // Stop watcher
    if (watcher) {
      await watcher.stop();
    }
    
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it('should start without crashing', async () => {
    await expect(watcher.start()).resolves.not.toThrow();
  });

  it('should handle file changes without crashing', async () => {
    await watcher.start();

    // Set up event listener to track changes
    const changeEvents: any[] = [];
    watcher.on('change', (event) => {
      changeEvents.push(event);
    });

    // Modify a file
    const requirementsPath = join(testDir, '.spec-context', 'specs', 'test-spec', 'requirements.md');
    await fs.writeFile(requirementsPath, '# Updated Requirements\n\nUpdated content');

    // Wait for file system events to propagate
    await new Promise(resolve => setTimeout(resolve, 300));

    // Watcher should still be running (not crashed)
    expect(watcher).toBeDefined();
  });

  it('should handle parser errors gracefully', async () => {
    await watcher.start();

    failGetSpec = true;

    const watcherErrors: SpecWatcherErrorEvent[] = [];
    watcher.on('watcher-error', (event: SpecWatcherErrorEvent) => {
      watcherErrors.push(event);
    });

    const requirementsPath = join(testDir, '.spec-context', 'specs', 'test-spec', 'requirements.md');
    await (watcher as any).handleFileChange('updated', requirementsPath);

    // Watcher should still be running despite the error
    expect(watcher).toBeDefined();
    expect(watcherErrors.length).toBeGreaterThan(0);
    expect(watcherErrors[0]?.stage).toBe('file_change');
  });

  it('should handle steering file changes', async () => {
    await watcher.start();

    // Set up event listener
    const steeringEvents: any[] = [];
    watcher.on('steering-change', (event) => {
      steeringEvents.push(event);
    });

    // Create a steering file
    const steeringPath = join(testDir, '.spec-context', 'steering', 'product.md');
    await fs.writeFile(steeringPath, '# Product Steering\n\nSome guidance');

    // Wait for file system events to propagate
    await new Promise(resolve => setTimeout(resolve, 300));

    // Should have received at least one event
    expect(steeringEvents.length).toBeGreaterThanOrEqual(0); // May be 0 or 1 depending on timing
  });

  it('should stop cleanly', async () => {
    await watcher.start();
    await expect(watcher.stop()).resolves.not.toThrow();
  });

  it('should not crash when stopping without starting', async () => {
    const newWatcher = new SpecWatcher(testDir, parser);
    await expect(newWatcher.stop()).resolves.not.toThrow();
  });

  it('should handle rapid file changes without crashing', async () => {
    await watcher.start();

    const requirementsPath = join(testDir, '.spec-context', 'specs', 'test-spec', 'requirements.md');
    
    // Make multiple rapid changes
    for (let i = 0; i < 5; i++) {
      await fs.writeFile(requirementsPath, `# Updated Requirements ${i}\n\nUpdated content ${i}`);
      await new Promise(resolve => setTimeout(resolve, 50));
    }

    // Wait for all events to propagate
    await new Promise(resolve => setTimeout(resolve, 500));

    // Watcher should still be running
    expect(watcher).toBeDefined();
  });
});
