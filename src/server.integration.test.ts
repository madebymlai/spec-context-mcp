import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { decode } from '@toon-format/toon';
import { SpecContextServer } from './server.js';
import { resetRegistry } from './tools/registry.js';

interface ActiveSession {
  server: SpecContextServer;
  client: Client;
}

const activeSessions: ActiveSession[] = [];

async function withSession(): Promise<ActiveSession> {
  resetRegistry();

  const server = new SpecContextServer({
    name: 'spec-context-mcp-test',
    version: '1.0.0',
    dashboardUrl: 'http://localhost:5111',
    chunkhoundPython: 'python3',
  });

  const client = new Client(
    { name: 'spec-context-mcp-client-test', version: '1.0.0' },
    { capabilities: {} }
  );

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connectTransport(serverTransport),
    client.connect(clientTransport),
  ]);

  const session = { server, client };
  activeSessions.push(session);
  return session;
}

async function waitFor(condition: () => boolean, timeoutMs = 400): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error('Timed out waiting for condition');
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

function decodeToolText(result: { content?: Array<{ type: string; text: string }> }): Record<string, unknown> {
  const text = result.content?.find(part => part.type === 'text')?.text ?? '';
  const decoded = decode(text);
  return decoded && typeof decoded === 'object' ? decoded as Record<string, unknown> : {};
}

describe('SpecContextServer integration (in-memory MCP transport)', () => {
  afterEach(async () => {
    while (activeSessions.length > 0) {
      const session = activeSessions.pop()!;
      await session.client.close();
      await session.server.closeTransport();
    }
    resetRegistry();
  });

  it('enforces visibility gate and expands tools after full implementer guide', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'spec-context-server-int-'));
    try {
      const steeringDir = join(projectPath, '.spec-context', 'steering');
      await mkdir(steeringDir, { recursive: true });
      await writeFile(join(steeringDir, 'tech.md'), '# Tech\nTypeScript', 'utf8');
      await writeFile(join(steeringDir, 'principles.md'), '# Principles\nSOLID', 'utf8');

      const { client } = await withSession();
      const toolListChanged: unknown[] = [];
      client.setNotificationHandler(ToolListChangedNotificationSchema, notification => {
        toolListChanged.push(notification);
      });

      const initialTools = await client.listTools();
      const initialNames = (initialTools.tools ?? []).map(tool => tool.name);
      expect(initialNames).toContain('get-implementer-guide');
      expect(initialNames).not.toContain('search');
      expect(initialNames).not.toContain('code_research');

      const blockedSearch = await client.callTool({
        name: 'search',
        arguments: { type: 'regex', query: 'foo', projectPath },
      });
      const blockedPayload = decodeToolText(blockedSearch as any);
      expect(blockedSearch.isError).toBe(true);
      expect(blockedPayload.success).toBe(false);

      const guide = await client.callTool({
        name: 'get-implementer-guide',
        arguments: { mode: 'full', runId: 'integration-run', projectPath },
      });
      const guidePayload = decodeToolText(guide as any);
      expect(guidePayload.success).toBe(true);

      await waitFor(() => toolListChanged.length >= 1);

      const afterTools = await client.listTools();
      const afterNames = (afterTools.tools ?? []).map(tool => tool.name);
      expect(afterNames).toContain('get-implementer-guide');
      expect(afterNames).toContain('search');
      expect(afterNames).toContain('code_research');
      expect(afterNames).not.toContain('approvals');
    } finally {
      await rm(projectPath, { recursive: true, force: true });
    }
  });

  it('sends tools/list_changed on mode lock even when entry-point returns failure', async () => {
    const projectPath = await mkdtemp(join(tmpdir(), 'spec-context-server-int-fail-'));
    try {
      const { client } = await withSession();
      const toolListChanged: unknown[] = [];
      client.setNotificationHandler(ToolListChangedNotificationSchema, notification => {
        toolListChanged.push(notification);
      });

      const failedGuide = await client.callTool({
        name: 'get-implementer-guide',
        arguments: { mode: 'full', runId: 'integration-run-fail', projectPath },
      });
      const payload = decodeToolText(failedGuide as any);
      expect(payload.success).toBe(false);

      await waitFor(() => toolListChanged.length >= 1);

      const visible = await client.listTools();
      const names = (visible.tools ?? []).map(tool => tool.name);
      expect(names).toContain('get-implementer-guide');
      expect(names).toContain('search');
    } finally {
      await rm(projectPath, { recursive: true, force: true });
    }
  });
});
