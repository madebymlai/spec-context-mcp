import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { resetRegistry, getSessionMode, getVisibilityTier, escalateTier } from './tools/registry.js';

const handlerMap = new Map<unknown, (request: any) => Promise<any>>();
const sendToolListChangedMock = vi.fn().mockResolvedValue(undefined);
const handleToolCallMock = vi.fn();
const getToolsMock = vi.fn(() => []);

vi.mock('@modelcontextprotocol/sdk/server/index.js', () => {
  class MockServer {
    constructor(_info: unknown, _options: unknown) {}

    setRequestHandler(schema: unknown, handler: (request: any) => Promise<any>): void {
      handlerMap.set(schema, handler);
    }

    sendToolListChanged = sendToolListChangedMock;
    connect = vi.fn();
    close = vi.fn().mockResolvedValue(undefined);
  }

  return { Server: MockServer };
});

vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: class {},
}));

vi.mock('./tools/index.js', () => ({
  getTools: () => getToolsMock(),
  handleToolCall: (...args: any[]) => handleToolCallMock(...args),
}));

vi.mock('./prompts/index.js', () => ({
  handlePromptList: vi.fn(async () => ({ prompts: [] })),
  handlePromptGet: vi.fn(async () => ({ messages: [] })),
}));

vi.mock('./bridge/chunkhound-bridge.js', () => ({
  initChunkHoundBridge: vi.fn(),
  resetChunkHoundBridge: vi.fn(),
}));

vi.mock('./core/workflow/dashboard-url.js', () => ({
  resolveDashboardUrl: vi.fn(async () => 'http://localhost:5111'),
}));

import { SpecContextServer } from './server.js';

describe('SpecContextServer tool visibility gate', () => {
  beforeEach(() => {
    resetRegistry();
    handlerMap.clear();
    sendToolListChangedMock.mockClear();
    handleToolCallMock.mockReset();
    getToolsMock.mockClear();
  });

  function createServerAndCallHandler() {
    new SpecContextServer({
      name: 'spec-context-mcp-test',
      version: '1.0.0',
      dashboardUrl: 'http://localhost:5111',
      chunkhoundPython: 'python3',
    });

    const callHandler = handlerMap.get(CallToolRequestSchema);
    expect(typeof callHandler).toBe('function');
    return callHandler as (request: any) => Promise<any>;
  }

  it('rejects hidden tool calls before handler execution', async () => {
    const callHandler = createServerAndCallHandler();
    handleToolCallMock.mockResolvedValue({ success: true, message: 'should not run' });

    const response = await callHandler({
      params: {
        name: 'search',
        arguments: {},
      },
    });

    expect(handleToolCallMock).not.toHaveBeenCalled();
    expect(response.isError).toBe(true);
    expect(String(response.content?.[0]?.text ?? '')).toContain('not available in the current session mode');
    expect(getSessionMode()).toBe('undetermined');
    expect(sendToolListChangedMock).not.toHaveBeenCalled();
  });

  it('notifies tools/list_changed even when entry-point handler throws after mode lock', async () => {
    const callHandler = createServerAndCallHandler();
    handleToolCallMock.mockRejectedValue(new Error('boom'));

    const response = await callHandler({
      params: {
        name: 'get-implementer-guide',
        arguments: { mode: 'full' },
      },
    });

    expect(response.isError).toBe(true);
    expect(String(response.content?.[0]?.text ?? '')).toContain('boom');
    expect(getSessionMode()).toBe('implementer');
    expect(sendToolListChangedMock).toHaveBeenCalledTimes(1);
  });

  it('notifies tools/list_changed when tier changes without a new mode transition', async () => {
    const callHandler = createServerAndCallHandler();
    handleToolCallMock.mockImplementation(async (name: string) => {
      if (name === 'spec-status') {
        escalateTier();
      }
      return { success: true, message: 'ok' };
    });

    await callHandler({
      params: {
        name: 'get-implementer-guide',
        arguments: { mode: 'full' },
      },
    });
    sendToolListChangedMock.mockClear();

    await callHandler({
      params: {
        name: 'spec-status',
        arguments: {},
      },
    });

    expect(getSessionMode()).toBe('implementer');
    expect(getVisibilityTier()).toBe(2);
    expect(sendToolListChangedMock).toHaveBeenCalledTimes(1);
  });
});
