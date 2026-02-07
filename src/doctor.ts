import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { existsSync } from 'fs';
import { platform } from 'os';
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
  fix?: string[];
}

function getPlatformInfo(): { os: string; installCmd: { python: string; buildTools: string; venv: string } } {
  const os = platform();

  if (os === 'darwin') {
    return {
      os: 'macOS',
      installCmd: {
        python: 'brew install python@3.11',
        buildTools: 'brew install cmake ninja swig',
        venv: 'Python on macOS includes venv by default',
      },
    };
  } else if (os === 'linux') {
    // Try to detect distro
    let distro = 'debian';
    if (existsSync('/etc/fedora-release') || existsSync('/etc/redhat-release')) {
      distro = 'fedora';
    } else if (existsSync('/etc/arch-release')) {
      distro = 'arch';
    }

    if (distro === 'fedora') {
      return {
        os: 'Fedora/RHEL',
        installCmd: {
          python: 'sudo dnf install python3.11',
          buildTools: 'sudo dnf install cmake ninja-build swig',
          venv: 'sudo dnf install python3.11',
        },
      };
    } else if (distro === 'arch') {
      return {
        os: 'Arch Linux',
        installCmd: {
          python: 'sudo pacman -S python',
          buildTools: 'sudo pacman -S cmake ninja swig',
          venv: 'sudo pacman -S python',
        },
      };
    } else {
      return {
        os: 'Debian/Ubuntu',
        installCmd: {
          python: 'sudo apt install python3.11',
          buildTools: 'sudo apt install cmake ninja-build swig',
          venv: 'sudo apt install python3.11-venv',
        },
      };
    }
  }

  return {
    os: 'Unknown',
    installCmd: {
      python: 'Install Python 3.10+ from https://python.org',
      buildTools: 'Install cmake, ninja, and swig',
      venv: 'Install Python venv module',
    },
  };
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
  const platformInfo = getPlatformInfo();

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const repoRoot = resolve(__dirname, '..');
  const projectRoot = process.cwd();
  const venvPython = resolve(repoRoot, '.venv', 'bin', 'python');
  const defaultPython = existsSync(venvPython) ? venvPython : 'python3';
  const pythonPath = process.env.CHUNKHOUND_PYTHON || defaultPython;

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
      fix: [
        `${platformInfo.installCmd.python}`,
        'npx spec-context-mcp setup',
      ],
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
        fix: [
          `${platformInfo.installCmd.python}`,
        ],
      });
    } else if (parsed.major < 3 || (parsed.major === 3 && parsed.minor < 10)) {
      results.push({
        name: 'Python',
        status: 'fail',
        details: `Python ${parsed.major}.${parsed.minor} detected (requires >= 3.10).`,
        hint: 'Install Python 3.10+ and/or set CHUNKHOUND_PYTHON.',
        fix: [
          `${platformInfo.installCmd.python}`,
          'npx spec-context-mcp setup',
        ],
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
        hint: 'Run the setup command to install Python dependencies.',
        fix: [
          'npx spec-context-mcp setup',
        ],
      });
    }

    const rapidYamlCheck = await runCommand(
      pythonPath,
      [
        '-c',
        [
          'import json, re',
          'import importlib.metadata as m',
          'try:',
          '  import ryml',
          'except Exception as e:',
          '  print(json.dumps({\"ok\": False, \"error\": str(e)}))',
          '  raise SystemExit(0)',
          'dist = None',
          'try:',
          '  dist = m.version(\"rapidyaml\")',
          'except Exception:',
          '  dist = None',
          'mod = getattr(ryml, \"__version__\", None) or dist',
          'def parse(v):',
          '  if not v: return None',
          '  m_ = re.match(r\"^(\\d+)\\.(\\d+)\\.(\\d+)\", str(v))',
          '  return tuple(int(x) for x in m_.groups()) if m_ else None',
          'required = (0, 10, 0)',
          'ver = parse(mod)',
          'missing = [a for a in (\"Tree\", \"walk\", \"parse_in_place\", \"emit_yaml\") if not hasattr(ryml, a)]',
          'print(json.dumps({\"ok\": True, \"dist\": dist, \"module\": mod, \"ver\": ver, \"required\": required, \"missing\": missing}))',
        ].join('\n'),
      ],
      { timeoutMs: 8000 }
    );

    if (!rapidYamlCheck.ok) {
      results.push({
        name: 'RapidYAML (ryml)',
        status: 'warn',
        details: `Unable to run RapidYAML check with ${pythonPath}.`,
        hint:
          'Install rapidyaml>=0.10.0 from the git tag v0.10.0 (PyPI currently ships an older build).',
        fix: [
          'npx spec-context-mcp setup',
          `${platformInfo.installCmd.buildTools}`,
        ],
      });
    } else {
      try {
        const parsed = JSON.parse((rapidYamlCheck.stdout || rapidYamlCheck.stderr).trim()) as {
          ok: boolean;
          error?: string;
          dist?: string | null;
          module?: string | null;
          ver?: [number, number, number] | null;
          required?: [number, number, number];
          missing?: string[];
        };

        if (!parsed.ok) {
          results.push({
            name: 'RapidYAML (ryml)',
            status: 'warn',
            details: `ryml import failed: ${parsed.error || 'unknown error'}`,
            hint:
              'Install: pip install \"rapidyaml @ git+https://github.com/biojppm/rapidyaml.git@v0.10.0\"',
            fix: [
              `${platformInfo.installCmd.buildTools}`,
              'npx spec-context-mcp setup',
            ],
          });
        } else if (parsed.missing && parsed.missing.length > 0) {
          results.push({
            name: 'RapidYAML (ryml)',
            status: 'warn',
            details: `ryml is installed but missing API: ${parsed.missing.join(', ')}`,
            hint:
              'This usually means an old rapidyaml build is installed. Install from git tag v0.10.0.',
            fix: [
              'npx spec-context-mcp setup',
            ],
          });
        } else if (parsed.ver && parsed.required) {
          const [a, b, c] = parsed.ver;
          const [ra, rb, rc] = parsed.required;
          const tooOld = a < ra || (a === ra && (b < rb || (b === rb && c < rc)));
          if (tooOld) {
            results.push({
              name: 'RapidYAML (ryml)',
              status: 'warn',
              details: `rapidyaml ${parsed.module || parsed.dist || 'unknown'} detected (requires >= 0.10.0).`,
              hint:
                'Install: pip install \"rapidyaml @ git+https://github.com/biojppm/rapidyaml.git@v0.10.0\"',
              fix: [
                'npx spec-context-mcp setup',
              ],
            });
          } else {
            results.push({
              name: 'RapidYAML (ryml)',
              status: 'ok',
              details: `rapidyaml ${parsed.module || parsed.dist || 'unknown'} detected.`,
            });
          }
        } else {
          results.push({
            name: 'RapidYAML (ryml)',
            status: 'warn',
            details: 'Unable to determine rapidyaml version.',
            hint:
              'Install rapidyaml>=0.10.0 from the git tag v0.10.0 (PyPI currently ships an older build).',
            fix: [
              'npx spec-context-mcp setup',
            ],
          });
        }
      } catch (error) {
        results.push({
          name: 'RapidYAML (ryml)',
          status: 'warn',
          details: `Unable to parse RapidYAML check output: ${String(error)}`,
          hint:
            'Install rapidyaml>=0.10.0 from the git tag v0.10.0 (PyPI currently ships an older build).',
          fix: [
            'npx spec-context-mcp setup',
          ],
        });
      }
    }
  } else {
    results.push({
      name: 'ChunkHound Import',
      status: 'warn',
      details: 'Skipped (Python not available).',
      fix: [
        `${platformInfo.installCmd.python}`,
        'npx spec-context-mcp setup',
      ],
    });
  }

  const effectiveProvider = (process.env.EMBEDDING_PROVIDER || process.env.CHUNKHOUND_EMBEDDING__PROVIDER || 'voyageai').trim();
  const embeddingApiKey =
    process.env.EMBEDDING_API_KEY ||
    process.env.CHUNKHOUND_EMBEDDING__API_KEY ||
    process.env.VOYAGEAI_API_KEY ||
    '';

  if (!embeddingApiKey) {
    results.push({
      name: 'Embedding API Key',
      status: 'warn',
      details: `No embedding API key set (provider=${effectiveProvider}).`,
      hint: 'Set EMBEDDING_API_KEY or provider-specific key in .env to enable semantic search.',
    });
  } else {
    results.push({
      name: 'Embedding API Key',
      status: 'ok',
      details: `Embedding provider ${effectiveProvider} has an API key configured.`,
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
  } catch (error) {
    const isDefault = dashboardUrl === DEFAULT_DASHBOARD_URL;
    results.push({
      name: 'Dashboard',
      status: isDefault ? 'warn' : 'fail',
      details: `Dashboard not reachable at ${dashboardUrl}: ${String(error)}`,
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
    if (result.fix && result.fix.length > 0 && result.status !== 'ok') {
      console.error('');
      console.error('       To fix:');
      for (const cmd of result.fix) {
        console.error(`         ${cmd}`);
      }
      console.error('');
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
