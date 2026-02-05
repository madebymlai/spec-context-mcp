#!/usr/bin/env node
/**
 * Setup command for ChunkHound Python environment.
 * Automates the creation of a virtual environment and installation of dependencies.
 */

import { spawn, SpawnOptions } from 'child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { platform } from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface CommandResult {
    ok: boolean;
    code: number | null;
    stdout: string;
    stderr: string;
    error?: Error;
}

function runCommand(
    command: string,
    args: string[],
    options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}
): Promise<CommandResult> {
    return new Promise((resolvePromise) => {
        const spawnOptions: SpawnOptions = {
            cwd: options.cwd,
            env: options.env,
            stdio: ['ignore', 'pipe', 'pipe'],
        };

        const child = spawn(command, args, spawnOptions);

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

function runCommandWithOutput(
    command: string,
    args: string[],
    options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}
): Promise<CommandResult> {
    return new Promise((resolvePromise) => {
        const spawnOptions: SpawnOptions = {
            cwd: options.cwd,
            env: options.env,
            stdio: ['ignore', 'inherit', 'inherit'],
        };

        const child = spawn(command, args, spawnOptions);

        child.on('error', (error) => {
            resolvePromise({ ok: false, code: null, stdout: '', stderr: '', error });
        });

        child.on('close', (code) => {
            resolvePromise({ ok: code === 0, code, stdout: '', stderr: '' });
        });
    });
}

function parsePythonVersion(versionText: string): { major: number; minor: number } | null {
    const match = versionText.trim().match(/(\d+)\.(\d+)/);
    if (!match) return null;
    return { major: Number(match[1]), minor: Number(match[2]) };
}

async function findPython(): Promise<string | null> {
    // Check CHUNKHOUND_PYTHON first
    if (process.env.CHUNKHOUND_PYTHON) {
        const result = await runCommand(process.env.CHUNKHOUND_PYTHON, ['--version'], { timeoutMs: 5000 });
        if (result.ok) {
            return process.env.CHUNKHOUND_PYTHON;
        }
    }

    // Try common Python paths
    const candidates = [
        'python3.12',
        'python3.11',
        'python3.10',
        'python3',
        '/usr/local/bin/python3',
        '/opt/homebrew/bin/python3',
    ];

    for (const candidate of candidates) {
        const result = await runCommand(candidate, ['-c', 'import sys; print(sys.version.split()[0])'], { timeoutMs: 5000 });
        if (result.ok) {
            const version = parsePythonVersion(result.stdout || result.stderr);
            if (version && version.major >= 3 && version.minor >= 10) {
                return candidate;
            }
        }
    }

    return null;
}

async function checkBuildTools(): Promise<{ cmake: boolean; ninja: boolean; swig: boolean }> {
    const [cmake, ninja, swig] = await Promise.all([
        runCommand('cmake', ['--version'], { timeoutMs: 5000 }),
        runCommand('ninja', ['--version'], { timeoutMs: 5000 }),
        runCommand('swig', ['-version'], { timeoutMs: 5000 }),
    ]);

    return {
        cmake: cmake.ok,
        ninja: ninja.ok,
        swig: swig.ok,
    };
}

function getPlatformInstallInstructions(): { python: string; buildTools: string } {
    const os = platform();

    if (os === 'darwin') {
        return {
            python: 'brew install python@3.11',
            buildTools: 'brew install cmake ninja swig',
        };
    } else if (os === 'linux') {
        // Try to detect distro
        let distro = 'debian';
        try {
            if (existsSync('/etc/fedora-release') || existsSync('/etc/redhat-release')) {
                distro = 'fedora';
            } else if (existsSync('/etc/arch-release')) {
                distro = 'arch';
            }
        } catch {
            // Default to debian-style
        }

        if (distro === 'fedora') {
            return {
                python: 'sudo dnf install python3.11',
                buildTools: 'sudo dnf install cmake ninja-build swig',
            };
        } else if (distro === 'arch') {
            return {
                python: 'sudo pacman -S python',
                buildTools: 'sudo pacman -S cmake ninja swig',
            };
        } else {
            return {
                python: 'sudo apt install python3.11 python3.11-venv',
                buildTools: 'sudo apt install cmake ninja-build swig',
            };
        }
    }

    return {
        python: 'Install Python 3.10+ from https://python.org',
        buildTools: 'Install cmake, ninja, and swig for your platform',
    };
}

export async function runSetup(): Promise<number> {
    const packageRoot = resolve(__dirname, '..');
    const venvPath = resolve(packageRoot, '.venv');
    const venvPython = resolve(venvPath, 'bin', 'python');
    const venvPip = resolve(venvPath, 'bin', 'pip');
    const platformInstructions = getPlatformInstallInstructions();

    console.log('');
    console.log('spec-context-mcp Setup');
    console.log('======================');
    console.log('');

    // Step 1: Find Python
    console.log('[1/5] Detecting Python 3.10+...');
    const pythonPath = await findPython();

    if (!pythonPath) {
        console.error('');
        console.error('[FAIL] Python 3.10+ not found');
        console.error('');
        console.error('Install Python 3.10 or newer:');
        console.error(`  ${platformInstructions.python}`);
        console.error('');
        console.error('Or set CHUNKHOUND_PYTHON to your Python executable:');
        console.error('  export CHUNKHOUND_PYTHON=/path/to/python3');
        console.error('');
        return 1;
    }

    const versionResult = await runCommand(pythonPath, ['-c', 'import sys; print(sys.version.split()[0])'], { timeoutMs: 5000 });
    const version = versionResult.stdout.trim();
    console.log(`  Found: ${pythonPath} (Python ${version})`);

    // Step 2: Check build tools
    console.log('');
    console.log('[2/5] Checking build tools...');
    const tools = await checkBuildTools();
    const missingTools: string[] = [];

    if (!tools.cmake) missingTools.push('cmake');
    if (!tools.ninja) missingTools.push('ninja');
    if (!tools.swig) missingTools.push('swig');

    if (missingTools.length > 0) {
        console.log(`  [WARN] Missing: ${missingTools.join(', ')}`);
        console.log(`  Some dependencies may fail to build.`);
        console.log(`  Install with: ${platformInstructions.buildTools}`);
    } else {
        console.log('  All build tools found (cmake, ninja, swig)');
    }

    // Step 3: Create virtual environment
    console.log('');
    console.log('[3/5] Creating virtual environment...');

    if (existsSync(venvPython)) {
        console.log(`  Virtual environment already exists at ${venvPath}`);
    } else {
        const venvResult = await runCommandWithOutput(pythonPath, ['-m', 'venv', venvPath], { cwd: packageRoot });

        if (!venvResult.ok) {
            console.error('');
            console.error('[FAIL] Failed to create virtual environment');
            console.error('');
            console.error('Try installing venv support:');
            if (platform() === 'linux') {
                console.error('  sudo apt install python3.11-venv  # Debian/Ubuntu');
                console.error('  sudo dnf install python3.11       # Fedora');
            }
            console.error('');
            return 1;
        }

        console.log(`  Created: ${venvPath}`);
    }

    // Step 4: Install dependencies
    console.log('');
    console.log('[4/5] Installing Python dependencies...');
    console.log('  This may take a few minutes...');
    console.log('');

    // First upgrade pip
    await runCommandWithOutput(venvPython, ['-m', 'pip', 'install', '--upgrade', 'pip'], {
        cwd: packageRoot,
        env: { ...process.env, VIRTUAL_ENV: venvPath },
    });

    // Install the package in editable mode
    const installResult = await runCommandWithOutput(venvPip, ['install', '-e', '.'], {
        cwd: packageRoot,
        env: { ...process.env, VIRTUAL_ENV: venvPath },
    });

    if (!installResult.ok) {
        console.error('');
        console.error('[FAIL] Failed to install dependencies');
        console.error('');
        console.error('Common fixes:');
        console.error(`  1. Install build tools: ${platformInstructions.buildTools}`);
        console.error('  2. Check pyproject.toml exists in the package directory');
        console.error('  3. Try manual installation:');
        console.error(`     cd ${packageRoot}`);
        console.error(`     ${venvPip} install -e .`);
        console.error('');
        return 1;
    }

    // Step 5: Test import
    console.log('');
    console.log('[5/5] Verifying ChunkHound import...');

    const importResult = await runCommand(venvPython, ['-c', 'import chunkhound; print("ok")'], {
        cwd: packageRoot,
        env: {
            ...process.env,
            VIRTUAL_ENV: venvPath,
            PYTHONPATH: packageRoot,
        },
        timeoutMs: 10000,
    });

    if (!importResult.ok) {
        console.error('');
        console.error('[FAIL] ChunkHound import failed');
        console.error('');
        if (importResult.stderr) {
            console.error('Error:', importResult.stderr.trim());
        }
        console.error('');
        console.error('Try running doctor for more details:');
        console.error('  npx spec-context-mcp doctor');
        console.error('');
        return 1;
    }

    console.log('  ChunkHound import successful');

    // Success!
    console.log('');
    console.log('======================');
    console.log('[SUCCESS] Setup complete!');
    console.log('');
    console.log('ChunkHound will automatically use the virtual environment.');
    console.log('');
    console.log('If using CHUNKHOUND_PYTHON in your config, set it to:');
    console.log(`  ${venvPython}`);
    console.log('');
    console.log('Run "npx spec-context-mcp doctor" to verify the configuration.');
    console.log('');

    return 0;
}

// Allow running directly
if (process.argv[1]?.endsWith('setup.js') || process.argv[1]?.endsWith('setup.ts')) {
    runSetup().then((code) => process.exit(code));
}
