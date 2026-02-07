import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { handleToolCall } from './index.js';
import type { ToolResponse } from '../workflow-types.js';

describe('handleToolCall tool-result offloading', () => {
  let testDir: string;
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    testDir = join(tmpdir(), `tool-offload-test-${Date.now()}`);
    mkdirSync(join(testDir, '.spec-context', 'steering'), { recursive: true });
    writeFileSync(join(testDir, '.spec-context', 'steering', 'tech.md'), '# Tech\nTypeScript');
    writeFileSync(join(testDir, '.spec-context', 'steering', 'principles.md'), '# Principles\nSOLID');
    process.env.SPEC_CONTEXT_DISCIPLINE = 'full';
  });

  afterEach(() => {
    process.env = originalEnv;
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true });
    }
  });

  it('offloads large tool responses to filesystem and returns pointer + preview', async () => {
    process.env.SPEC_CONTEXT_TOOL_RESULT_OFFLOAD_CHARS = '200';
    process.env.SPEC_CONTEXT_TOOL_RESULT_PREVIEW_CHARS = '100';

    const result = await handleToolCall(
      'get-implementer-guide',
      { mode: 'full', runId: 'offload-run-1' },
      { projectPath: testDir, dashboardUrl: undefined }
    ) as ToolResponse;

    expect(result.success).toBe(true);
    expect(result.data?.offloaded).toBe(true);
    expect(result.data?.tool).toBe('get-implementer-guide');
    expect(result.data?.originalSize).toBeGreaterThan(200);
    expect(result.data?.preview.length).toBeLessThanOrEqual(100);
    expect(typeof result.data?.path).toBe('string');

    const absolutePath = join(testDir, result.data?.path as string);
    expect(existsSync(absolutePath)).toBe(true);
    const persisted = readFileSync(absolutePath, 'utf8');
    expect(persisted).toContain('Implementation Guide');
  });

  it('keeps small responses inline', async () => {
    process.env.SPEC_CONTEXT_TOOL_RESULT_OFFLOAD_CHARS = '999999';

    const result = await handleToolCall(
      'dispatch-runtime',
      { action: 'get_telemetry', runId: 'telemetry-run' },
      { projectPath: testDir, dashboardUrl: undefined }
    ) as ToolResponse;

    expect(result.success).toBe(true);
    expect(result.data?.offloaded).toBeUndefined();
    expect(typeof result.data?.dispatch_count).toBe('number');
  });

  it('cleans expired offloaded files using TTL on each write', async () => {
    process.env.SPEC_CONTEXT_TOOL_RESULT_OFFLOAD_CHARS = '200';
    process.env.SPEC_CONTEXT_TOOL_RESULT_PREVIEW_CHARS = '120';
    process.env.SPEC_CONTEXT_TOOL_RESULT_TTL_MINUTES = '30';

    const offloadDir = join(testDir, '.spec-context', 'tmp', 'tool-results');
    mkdirSync(offloadDir, { recursive: true });
    const staleFile = join(offloadDir, 'stale-result.json');
    writeFileSync(staleFile, '{"stale":true}', 'utf8');
    const oldTimestamp = new Date(Date.now() - (31 * 60 * 1000));
    utimesSync(staleFile, oldTimestamp, oldTimestamp);
    expect(existsSync(staleFile)).toBe(true);

    const result = await handleToolCall(
      'get-implementer-guide',
      { mode: 'full', runId: 'offload-run-ttl' },
      { projectPath: testDir, dashboardUrl: undefined }
    ) as ToolResponse;

    expect(result.success).toBe(true);
    expect(result.data?.offloaded).toBe(true);
    expect(existsSync(staleFile)).toBe(false);
    const remaining = readdirSync(offloadDir);
    expect(remaining.length).toBeGreaterThanOrEqual(1);
  });

  it('shares file-content cache across tool calls and exposes telemetry via dispatch-runtime', async () => {
    process.env.SPEC_CONTEXT_TOOL_RESULT_OFFLOAD_CHARS = '999999';

    const context = { projectPath: testDir, dashboardUrl: undefined };
    const implementer = await handleToolCall(
      'get-implementer-guide',
      { mode: 'full', runId: 'cache-shared-impl' },
      context
    ) as ToolResponse;
    expect(implementer.success).toBe(true);

    const reviewer = await handleToolCall(
      'get-reviewer-guide',
      { mode: 'full', runId: 'cache-shared-rev' },
      context
    ) as ToolResponse;
    expect(reviewer.success).toBe(true);

    const telemetry = await handleToolCall(
      'dispatch-runtime',
      { action: 'get_telemetry', runId: 'cache-shared-telemetry' },
      context
    ) as ToolResponse;

    expect(telemetry.success).toBe(true);
    expect(telemetry.data?.file_content_cache?.namespaces?.steering?.misses).toBeGreaterThan(0);
    expect(telemetry.data?.file_content_cache?.namespaces?.steering?.hits).toBeGreaterThan(0);
  });
});
