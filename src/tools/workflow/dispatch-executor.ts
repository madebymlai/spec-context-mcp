import { spawn } from 'child_process';
import { createWriteStream } from 'fs';
import { mkdir } from 'fs/promises';
import { dirname } from 'path';
import { once } from 'events';
import { finished } from 'stream/promises';
import type {
  DispatchExecutorInput,
  DispatchExecutorResult,
  IDispatchExecutor,
} from './dispatch-runtime.js';

async function ensureOutputDirectories(paths: string[]): Promise<void> {
  await Promise.all(paths.map(path => mkdir(dirname(path), { recursive: true })));
}

export function useShellForDispatch(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32';
}

export class NodeDispatchExecutor implements IDispatchExecutor {
  async execute(input: DispatchExecutorInput): Promise<DispatchExecutorResult> {
    await ensureOutputDirectories([input.contractOutputPath, input.debugOutputPath]);

    const contractOutput = createWriteStream(input.contractOutputPath, { flags: 'w', encoding: 'utf8' });
    const debugOutput = createWriteStream(input.debugOutputPath, { flags: 'w', encoding: 'utf8' });

    const startedAt = Date.now();
    const child = spawn(input.command.command, input.command.args, {
      cwd: input.projectPath,
      shell: useShellForDispatch(),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });

    child.stdout.pipe(contractOutput);
    child.stderr.pipe(debugOutput);

    child.stdin.end(input.prompt);

    const spawnErrorPromise = once(child, 'error').then(([error]) => {
      throw error;
    });
    const closePromise = once(child, 'close').then(([exitCode, signal]) => ({
      exitCode: typeof exitCode === 'number' ? exitCode : null,
      signal: signal ?? null,
    }));

    const closeResult = await Promise.race([closePromise, spawnErrorPromise]);
    await Promise.all([finished(contractOutput), finished(debugOutput)]);

    return {
      exitCode: closeResult.exitCode,
      signal: closeResult.signal,
      durationMs: Date.now() - startedAt,
      contractOutputPath: input.contractOutputPath,
      debugOutputPath: input.debugOutputPath,
    };
  }
}
