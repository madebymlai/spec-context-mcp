import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { resolveDashboardUrl } from './core/workflow/dashboard-url.js';
import { DEFAULT_DASHBOARD_URL } from './core/workflow/constants.js';

interface CommandResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

interface CheckResult {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  details: string;
  hint?: string;
}

function runCommand(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}
): Promise<CommandResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (result: CommandResult) => {
      if (settled) return;
      settled = true;
      resolvePromise(result);
    };

    child.stdout?.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('error', (error) => {
      finish({ ok: false, code: null, stdout, stderr, error });
    });

    child.on('close', (code) => {
      finish({ ok: code === 0, code, stdout, stderr });
    });

    if (options.timeoutMs) {
      setTimeout(() => {
        if (!settled) {
          child.kill('SIGKILL');
          finish({
            ok: false,
            code: null,
            stdout,
            stderr,
            error: new Error('Command timed out'),
          });
        }
      }, options.timeoutMs);
    }
  });
}

function parsePythonVersion(versionText: string): { major: number; minor: number } | null {
  const match = versionText.trim().match(/(\d+)\.(\d+)/);
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]) };
}

function formatStatus(status: 'ok' | 'warn' | 'fail'): string {
  switch (status) {
    case 'ok':
      return 'OK';
    case 'warn':
      return 'WARN';
    case 'fail':
      return 'FAIL';
  }
}

export async function runDoctor(): Promise<number> {
  const results: CheckResult[] = [];
  const pythonPath = process.env.CHUNKHOUND_PYTHON || 'python3';

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const repoRoot = resolve(__dirname, '..');

  const pythonVersionResult = await runCommand(
    pythonPath,
    ['-c', 'import sys; print(sys.version.split()[0])'],
    { timeoutMs: 5000 }
  );

  if (!pythonVersionResult.ok) {
    results.push({
      name: 'Python',
      status: 'fail',
      details: `Unable to run ${pythonPath}.`,
      hint: 'Install Python 3.10+ and/or set CHUNKHOUND_PYTHON.',
    });
  } else {
    const versionText = pythonVersionResult.stdout || pythonVersionResult.stderr;
    const parsed = parsePythonVersion(versionText);
    if (!parsed) {
      results.push({
        name: 'Python',
        status: 'warn',
        details: `Unable to parse Python version from "${versionText.trim()}".`,
        hint: 'Ensure Python 3.10+ is installed for ChunkHound.',
      });
    } else if (parsed.major < 3 || (parsed.major === 3 && parsed.minor < 10)) {
      results.push({
        name: 'Python',
        status: 'fail',
        details: `Python ${parsed.major}.${parsed.minor} detected (requires >= 3.10).`,
        hint: 'Install Python 3.10+ and/or set CHUNKHOUND_PYTHON.',
      });
    } else {
      results.push({
        name: 'Python',
        status: 'ok',
        details: `Python ${parsed.major}.${parsed.minor} detected (${pythonPath}).`,
      });
    }
  }

  if (pythonVersionResult.ok) {
    const chunkhoundImport = await runCommand(
      pythonPath,
      ['-c', 'import chunkhound; print("ok")'],
      {
        timeoutMs: 5000,
        env: {
          ...process.env,
          PYTHONPATH: repoRoot,
        },
      }
    );

    if (chunkhoundImport.ok) {
      results.push({
        name: 'ChunkHound Import',
        status: 'ok',
        details: 'ChunkHound module import succeeded.',
      });
    } else {
      results.push({
        name: 'ChunkHound Import',
        status: 'fail',
        details: 'Failed to import chunkhound in Python.',
        hint: 'Ensure Python dependencies are installed (see pyproject.toml).',
      });
    }
  } else {
    results.push({
      name: 'ChunkHound Import',
      status: 'warn',
      details: 'Skipped (Python not available).',
    });
  }

  const provider = (process.env.EMBEDDING_PROVIDER || process.env.CHUNKHOUND_EMBEDDING__PROVIDER || 'voyageai').trim();
  const embeddingApiKey =
    process.env.EMBEDDING_API_KEY ||
    process.env.CHUNKHOUND_EMBEDDING__API_KEY ||
    process.env.VOYAGEAI_API_KEY ||
    process.env.OPENAI_API_KEY ||
    '';

  if (!embeddingApiKey) {
    results.push({
      name: 'Embedding API Key',
      status: 'warn',
      details: `No embedding API key set (provider=${provider}).`,
      hint: 'Set EMBEDDING_API_KEY or provider-specific key to enable semantic search.',
    });
  } else {
    results.push({
      name: 'Embedding API Key',
      status: 'ok',
      details: `Embedding provider ${provider} has an API key configured.`,
    });
  }

  if (!process.env.OPENROUTER_API_KEY) {
    results.push({
      name: 'Dashboard AI Review',
      status: 'warn',
      details: 'OPENROUTER_API_KEY not set (AI review disabled).',
    });
  } else {
    results.push({
      name: 'Dashboard AI Review',
      status: 'ok',
      details: 'OPENROUTER_API_KEY is set.',
    });
  }

  const dashboardUrl = await resolveDashboardUrl({ defaultUrl: DEFAULT_DASHBOARD_URL });
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    const response = await fetch(`${dashboardUrl}/health`, { signal: controller.signal });
    clearTimeout(timeout);
    if (response.ok) {
      results.push({
        name: 'Dashboard',
        status: 'ok',
        details: `Dashboard reachable at ${dashboardUrl}.`,
      });
    } else {
      results.push({
        name: 'Dashboard',
        status: 'warn',
        details: `Dashboard responded with ${response.status} at ${dashboardUrl}.`,
        hint: 'Start with spec-context-dashboard if needed.',
      });
    }
  } catch {
    const isDefault = dashboardUrl === DEFAULT_DASHBOARD_URL;
    results.push({
      name: 'Dashboard',
      status: isDefault ? 'warn' : 'fail',
      details: `Dashboard not reachable at ${dashboardUrl}.`,
      hint: 'Start with spec-context-dashboard or update DASHBOARD_URL.',
    });
  }

  const failures = results.filter((r) => r.status === 'fail');
  const warnings = results.filter((r) => r.status === 'warn');

  console.error('Spec Context Doctor');
  console.error('--------------------');
  for (const result of results) {
    const line = `[${formatStatus(result.status)}] ${result.name}: ${result.details}`;
    console.error(line);
    if (result.hint) {
      console.error(`       Hint: ${result.hint}`);
    }
  }

  console.error('');
  if (failures.length > 0) {
    console.error(`Status: FAIL (${failures.length} failure${failures.length > 1 ? 's' : ''}, ${warnings.length} warning${warnings.length !== 1 ? 's' : ''})`);
    return 1;
  }

  if (warnings.length > 0) {
    console.error(`Status: WARN (${warnings.length} warning${warnings.length > 1 ? 's' : ''})`);
    return 0;
  }

  console.error('Status: OK');
  return 0;
}
