import { mkdtemp, readFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { afterEach, describe, expect, it } from 'vitest';
import { NodeDispatchExecutor, useShellForDispatch } from './dispatch-executor.js';

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dispatch-executor-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0, tempDirs.length).map(dir => rm(dir, { recursive: true, force: true })));
});

describe('NodeDispatchExecutor', () => {
  it('uses shell on win32 only', () => {
    expect(useShellForDispatch('win32')).toBe(true);
    expect(useShellForDispatch('linux')).toBe(false);
    expect(useShellForDispatch('darwin')).toBe(false);
  });

  it('executes command with prompt on stdin and writes output logs', async () => {
    const dir = await createTempDir();
    const contractOutputPath = join(dir, 'contract.log');
    const debugOutputPath = join(dir, 'debug.log');

    const executor = new NodeDispatchExecutor();
    const result = await executor.execute({
      runId: 'run-1',
      role: 'implementer',
      taskId: '1',
      projectPath: dir,
      prompt: 'hello',
      command: {
        provider: 'claude',
        role: 'implementer',
        command: '/bin/sh',
        args: ['-c', "cat >/dev/null; printf 'BEGIN_DISPATCH_RESULT\\n{}\\nEND_DISPATCH_RESULT\\n'"],
        display: '/bin/sh -c ...',
      },
      contractOutputPath,
      debugOutputPath,
    });

    expect(result.exitCode).toBe(0);
    expect(result.signal).toBeNull();
    const contract = await readFile(contractOutputPath, 'utf8');
    expect(contract).toContain('BEGIN_DISPATCH_RESULT');
    const debug = await readFile(debugOutputPath, 'utf8');
    expect(debug).toBe('');
  });
});
