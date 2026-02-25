import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { MultiProjectDashboardServer } from './multi-server.js';
import { SettingsManager } from './settings-manager.js';
import { SPEC_WORKFLOW_HOME_ENV } from '../core/workflow/global-dir.js';

const RUNTIME_ENV_KEYS = [
  'SPEC_CONTEXT_DISCIPLINE',
  'SPEC_CONTEXT_IMPLEMENTER',
  'SPEC_CONTEXT_REVIEWER',
  'SPEC_CONTEXT_IMPLEMENTER_MODEL_SIMPLE',
  'SPEC_CONTEXT_IMPLEMENTER_MODEL_COMPLEX',
  'SPEC_CONTEXT_REVIEWER_MODEL_SIMPLE',
  'SPEC_CONTEXT_REVIEWER_MODEL_COMPLEX',
  'SPEC_CONTEXT_IMPLEMENTER_REASONING_EFFORT',
  'SPEC_CONTEXT_REVIEWER_REASONING_EFFORT',
  'DASHBOARD_URL',
] as const;

interface TestServerContext {
  app: FastifyInstance;
}

function createTestServer(): TestServerContext {
  const server = new MultiProjectDashboardServer();
  const instance = server as unknown as {
    app: FastifyInstance;
    registerApiRoutes: () => void;
  };
  instance.registerApiRoutes();
  return { app: instance.app };
}

describe('MultiProjectDashboardServer runtime settings routes', () => {
  const originalEnv = process.env;
  let workflowHomeDir: string;
  const activeApps: FastifyInstance[] = [];

  beforeEach(async () => {
    process.env = { ...originalEnv };
    for (const key of RUNTIME_ENV_KEYS) {
      delete process.env[key];
    }

    workflowHomeDir = join(tmpdir(), `spec-context-runtime-settings-api-${Date.now()}-${Math.random()}`);
    process.env[SPEC_WORKFLOW_HOME_ENV] = workflowHomeDir;
    await fs.mkdir(workflowHomeDir, { recursive: true });
  });

  afterEach(async () => {
    while (activeApps.length > 0) {
      const app = activeApps.pop();
      if (app) {
        await app.close();
      }
    }
    process.env = originalEnv;
    await fs.rm(workflowHomeDir, { recursive: true, force: true });
  });

  it('GET /api/settings/runtime returns resolved runtime settings with sources', async () => {
    const { app } = createTestServer();
    activeApps.push(app);

    const response = await app.inject({
      method: 'GET',
      url: '/api/settings/runtime',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      discipline: { value: 'full', source: 'default' },
      implementer: { value: null, source: 'default' },
      reviewer: { value: null, source: 'default' },
      implementerModelSimple: { value: null, source: 'default' },
      implementerModelComplex: { value: null, source: 'default' },
      reviewerModelSimple: { value: null, source: 'default' },
      reviewerModelComplex: { value: null, source: 'default' },
      implementerReasoningEffort: { value: null, source: 'default' },
      reviewerReasoningEffort: { value: null, source: 'default' },
      dashboardUrl: { value: 'http://localhost:3000', source: 'default' },
    });
  });

  it('PUT /api/settings/runtime stores valid runtime setting fields and ignores unknown keys', async () => {
    const { app } = createTestServer();
    activeApps.push(app);
    const manager = new SettingsManager();

    const response = await app.inject({
      method: 'PUT',
      url: '/api/settings/runtime',
      payload: {
        discipline: 'standard',
        implementer: 'codex',
        reviewer: 'gemini',
        reviewerModelComplex: 'reviewer-complex-model',
        unknownKey: 'ignored',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      discipline: { value: 'standard', source: 'json' },
      implementer: { value: 'codex', source: 'json' },
      reviewer: { value: 'gemini', source: 'json' },
      reviewerModelComplex: { value: 'reviewer-complex-model', source: 'json' },
    });

    await expect(manager.getRuntimeSettings()).resolves.toEqual({
      discipline: 'standard',
      implementer: 'codex',
      reviewer: 'gemini',
      reviewerModelComplex: 'reviewer-complex-model',
    });
  });

  it('PUT /api/settings/runtime accepts null values to clear stored keys', async () => {
    process.env.SPEC_CONTEXT_IMPLEMENTER = 'claude';

    const { app } = createTestServer();
    activeApps.push(app);
    const manager = new SettingsManager();

    const setResponse = await app.inject({
      method: 'PUT',
      url: '/api/settings/runtime',
      payload: {
        implementer: 'codex',
      },
    });
    expect(setResponse.statusCode).toBe(200);

    const clearResponse = await app.inject({
      method: 'PUT',
      url: '/api/settings/runtime',
      payload: {
        implementer: null,
      },
    });

    expect(clearResponse.statusCode).toBe(200);
    expect(clearResponse.json()).toMatchObject({
      implementer: { value: 'claude', source: 'env' },
    });
    await expect(manager.getRuntimeSettings()).resolves.toEqual({});
  });

  it('PUT /api/settings/runtime returns 400 for invalid discipline values', async () => {
    const { app } = createTestServer();
    activeApps.push(app);

    const response = await app.inject({
      method: 'PUT',
      url: '/api/settings/runtime',
      payload: {
        discipline: 'expert',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: 'Invalid discipline value. Expected one of: full, standard, minimal',
    });
  });

  it('PUT /api/settings/runtime returns 400 for invalid provider values', async () => {
    const { app } = createTestServer();
    activeApps.push(app);

    const response = await app.inject({
      method: 'PUT',
      url: '/api/settings/runtime',
      payload: {
        implementer: 'unknown-provider',
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: 'Invalid implementer provider. Expected one of: claude, codex, gemini, opencode, claude-code, claude-code-cli, codex-cli, gemini-cli, opencode-cli',
    });
  });
});
