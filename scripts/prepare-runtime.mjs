#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, '..');
const runtimeRoot = path.join(projectRoot, 'build-resources', 'runtime');
const platform = normalizePlatform(process.argv[2] || process.platform);

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main();
}

export function main() {
  console.log(`Preparing bundled runtimes for ${platform}...`);

  fs.rmSync(runtimeRoot, { recursive: true, force: true });
  fs.mkdirSync(runtimeRoot, { recursive: true });

  const manifest = {
    generatedAt: new Date().toISOString(),
    platform,
    runtimes: [],
  };

  manifest.runtimes.push(prepareNodeRuntime());
  manifest.runtimes.push(preparePythonRuntime());

  if (platform === 'win32') {
    manifest.runtimes.push(prepareGitRuntime());
  }

  fs.writeFileSync(path.join(runtimeRoot, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  console.log(`Bundled runtimes are ready in ${runtimeRoot}`);
}

function prepareNodeRuntime() {
  const installRoot = getNodeInstallRoot();
  const targetRoot = path.join(runtimeRoot, 'node');
  copyDirectory(installRoot, targetRoot);
  console.log(`  node: ${installRoot} -> ${targetRoot}`);
  return {
    name: 'node',
    source: installRoot,
    target: targetRoot,
  };
}

function preparePythonRuntime() {
  const installRoot = getPythonInstallRoot();
  const targetRoot = path.join(runtimeRoot, 'python');
  copyDirectory(installRoot, targetRoot, {
    skip: ['__pycache__', 'test', 'tests'],
  });
  console.log(`  python: ${installRoot} -> ${targetRoot}`);
  return {
    name: 'python',
    source: installRoot,
    target: targetRoot,
  };
}

function prepareGitRuntime() {
  const gitExecutable = resolveCommand('git');
  if (!gitExecutable) {
    throw new Error('git executable not found');
  }

  const installRoot = path.dirname(path.dirname(gitExecutable));
  const targetRoot = path.join(runtimeRoot, 'git');
  copyDirectory(installRoot, targetRoot, {
    skip: ['doc', 'man'],
  });
  console.log(`  git: ${installRoot} -> ${targetRoot}`);
  return {
    name: 'git',
    source: installRoot,
    target: targetRoot,
  };
}

function getNodeInstallRoot() {
  if (platform === 'win32') {
    return path.dirname(process.execPath);
  }

  return path.dirname(path.dirname(process.execPath));
}

function getPythonInstallRoot() {
  if (process.env.PYTHON_LOCATION && fs.existsSync(process.env.PYTHON_LOCATION)) {
    return process.env.PYTHON_LOCATION;
  }

  const commands = platform === 'win32'
    ? [
        { command: 'python', args: ['-c', 'import sys; print(sys.executable)'] },
        { command: 'py', args: ['-c', 'import sys; print(sys.executable)'] },
      ]
    : [
        { command: 'python3', args: ['-c', 'import sys; print(sys.executable)'] },
        { command: 'python', args: ['-c', 'import sys; print(sys.executable)'] },
      ];

  for (const candidate of commands) {
    const result = spawnSync(candidate.command, candidate.args, {
      encoding: 'utf8',
      windowsHide: true,
    });
    if (result.status === 0) {
      const executable = (result.stdout || '').trim();
      if (executable && fs.existsSync(executable)) {
        return inferPythonInstallRoot(executable, platform);
      }
    }
  }

  throw new Error('python runtime not found');
}

export function inferPythonInstallRoot(executable, currentPlatform = platform) {
  const executableDirectory = path.dirname(executable);

  if (currentPlatform === 'win32') {
    return executableDirectory;
  }

  return path.basename(executableDirectory) === 'bin'
    ? path.dirname(executableDirectory)
    : executableDirectory;
}

function resolveCommand(command) {
  const lookup = platform === 'win32' ? 'where' : 'which';
  const result = spawnSync(lookup, [command], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0) {
    return undefined;
  }

  return `${result.stdout || ''}${result.stderr || ''}`
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(Boolean);
}

function copyDirectory(source, target, options = {}) {
  const skipNames = new Set(options.skip || []);
  fs.cpSync(source, target, {
    recursive: true,
    force: true,
    dereference: true,
    filter: (src) => {
      const name = path.basename(src);
      if (skipNames.has(name)) {
        return false;
      }

      if (name.endsWith('.pyc')) {
        return false;
      }

      return true;
    },
  });
}

function normalizePlatform(value) {
  if (value === 'windows' || value === 'win') {
    return 'win32';
  }
  if (value === 'mac' || value === 'macos' || value === 'darwin') {
    return 'darwin';
  }
  if (value === 'linux') {
    return 'linux';
  }
  return value;
}
