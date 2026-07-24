#!/usr/bin/env node

import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, '..');
const defaultManifestPath = path.join(__dirname, 'runtime-manifest.json');
const defaultRuntimeRoot = path.join(projectRoot, 'build-resources', 'runtime');
const ALLOWED_SOURCE_HOSTS = new Set([
  'nodejs.org',
  'github.com',
  'objects.githubusercontent.com',
  'github-releases.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'registry.npmjs.org',
]);
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;

const cliOptions = parseArgs(process.argv.slice(2));
const defaultPlatform = normalizePlatform(cliOptions.platform || process.platform);
const defaultArch = normalizeArch(cliOptions.arch || process.arch);

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main({
    platform: defaultPlatform,
    arch: defaultArch,
    refresh: cliOptions.refresh,
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

export async function main(options = {}) {
  const manifest = loadRuntimeManifest(options.manifestPath || defaultManifestPath);
  validateRuntimeManifest(manifest);

  const platform = normalizePlatform(options.platform || defaultPlatform);
  const arch = normalizeArch(options.arch || defaultArch);
  const refresh = options.refresh === true;
  const runtimeRoot = options.runtimeRoot || defaultRuntimeRoot;
  const downloadCacheRoot = path.resolve(
    projectRoot,
    options.downloadCacheDir || manifest.downloadCacheDir || '.cache/runtime-downloads',
  );

  console.log(`Preparing bundled runtimes for ${platform}-${arch}...`);

  fs.mkdirSync(downloadCacheRoot, { recursive: true });
  fs.rmSync(runtimeRoot, { recursive: true, force: true });
  fs.mkdirSync(runtimeRoot, { recursive: true });

  const preparedRuntimes = [];

  preparedRuntimes.push(
    await prepareDownloadedRuntime(manifest, 'node', platform, arch, runtimeRoot, downloadCacheRoot, refresh),
  );
  preparedRuntimes.push(
    await prepareDownloadedRuntime(manifest, 'python', platform, arch, runtimeRoot, downloadCacheRoot, refresh),
  );
  const xurlRuntime = await prepareDownloadedRuntime(
    manifest,
    'xurl',
    platform,
    arch,
    runtimeRoot,
    downloadCacheRoot,
    refresh,
  );
  verifyXurlRuntime(xurlRuntime.target, platform, xurlRuntime.version);
  preparedRuntimes.push(xurlRuntime);

  if (platform === 'win32') {
    preparedRuntimes.push(prepareGitRuntime(runtimeRoot));
  }

  fs.writeFileSync(
    path.join(runtimeRoot, 'manifest.json'),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        platform,
        arch,
        runtimes: preparedRuntimes,
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );

  console.log(`Bundled runtimes are ready in ${runtimeRoot}`);
}

export function loadRuntimeManifest(manifestPath = defaultManifestPath) {
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
}

export function validateRuntimeManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') {
    throw new Error('Runtime manifest must be an object');
  }

  if (!manifest.runtimes || typeof manifest.runtimes !== 'object') {
    throw new Error('Runtime manifest is missing runtimes');
  }

  for (const [runtimeName, runtime] of Object.entries(manifest.runtimes)) {
    if (!runtime.targets || typeof runtime.targets !== 'object') {
      throw new Error(`Runtime ${runtimeName} is missing targets`);
    }

    for (const [targetKey, target] of Object.entries(runtime.targets)) {
      if (!['zip', 'tar.gz', 'tar.xz'].includes(target.archiveType)) {
        throw new Error(`Runtime ${runtimeName} target ${targetKey} uses unsupported archiveType ${target.archiveType}`);
      }

      const sources = normalizeSources(target.sources);
      if (sources.length === 0) {
        throw new Error(`Runtime ${runtimeName} target ${targetKey} has no sources`);
      }

      for (const source of sources) {
        assertSafeSourceUrl(source.url, `${runtimeName}/${targetKey}`);
        if (!source.sha256 || !SHA256_PATTERN.test(source.sha256)) {
          throw new Error(`Runtime ${runtimeName} target ${targetKey} source ${source.url} has invalid sha256`);
        }
      }
    }
  }
}

export function resolveRuntimeTargetKey(platform, arch) {
  return `${normalizePlatform(platform)}-${normalizeArch(arch)}`;
}

export function resolveRuntimeTarget(manifest, runtimeName, platform, arch) {
  const runtime = manifest?.runtimes?.[runtimeName];
  if (!runtime) {
    throw new Error(`Runtime ${runtimeName} is not defined in ${defaultManifestPath}`);
  }

  const targetKey = resolveRuntimeTargetKey(platform, arch);
  const target = runtime.targets?.[targetKey];
  if (!target) {
    const availableTargets = Object.keys(runtime.targets || {}).sort().join(', ');
    throw new Error(`Runtime ${runtimeName} does not define target ${targetKey}. Available targets: ${availableTargets}`);
  }

  return {
    ...target,
    key: targetKey,
    runtimeName,
    version: runtime.version,
    targetSubdir: target.targetSubdir || runtimeName,
    sources: normalizeSources(target.sources),
  };
}

export function resolveExtractedRoot(extractRoot, packageRoot) {
  if (packageRoot) {
    return path.join(extractRoot, packageRoot);
  }

  const entries = fs.readdirSync(extractRoot, { withFileTypes: true });
  if (entries.length === 1 && entries[0].isDirectory()) {
    return path.join(extractRoot, entries[0].name);
  }

  return extractRoot;
}

async function prepareDownloadedRuntime(manifest, runtimeName, platform, arch, runtimeRoot, downloadCacheRoot, refresh) {
  const target = resolveRuntimeTarget(manifest, runtimeName, platform, arch);
  const artifact = await downloadRuntimeArtifact(target, downloadCacheRoot, refresh);
  const destination = path.join(runtimeRoot, target.targetSubdir);

  installRuntimeArchive(artifact.archivePath, destination, target);
  if (runtimeName === 'node') {
    const repaired = repairNodeRuntimeEntrypoints(destination, platform);
    if (repaired.length > 0) {
      console.log(`  node: repaired bin entrypoints: ${repaired.join(', ')}`);
    }
  }
  const removedBrokenSymlinks = removeBrokenRuntimeSymlinks(destination);
  if (removedBrokenSymlinks.length > 0) {
    console.log(`  ${runtimeName}: removed broken symlinks: ${removedBrokenSymlinks.join(', ')}`);
  }

  console.log(`  ${runtimeName}: ${artifact.selectedSource.url} -> ${destination}`);

  return {
    name: runtimeName,
    version: target.version,
    source: artifact.selectedSource.url,
    archivePath: artifact.archivePath,
    cacheHit: artifact.cacheHit,
    target: destination,
  };
}

function prepareGitRuntime(runtimeRoot) {
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

export function verifyXurlRuntime(runtimeRoot, platform, expectedVersion) {
  const normalizedPlatform = normalizePlatform(platform);
  const executable = path.join(runtimeRoot, normalizedPlatform === 'win32' ? 'xurl.exe' : 'xurl');

  if (!fs.existsSync(executable) || !fs.statSync(executable).isFile()) {
    throw new Error(`Bundled xURL runtime is missing executable: ${executable}`);
  }

  if (normalizedPlatform !== 'win32') {
    fs.chmodSync(executable, 0o755);
  }

  const result = spawnSync(executable, ['--version'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
  const expectedOutput = `xurl ${expectedVersion}`;

  if (result.error || result.status !== 0) {
    const detail = result.error?.message || output || `exit status ${result.status}`;
    throw new Error(`Bundled xURL runtime failed its version check: ${detail}`);
  }

  if (output !== expectedOutput) {
    throw new Error(`Bundled xURL runtime version mismatch: expected "${expectedOutput}", received "${output}"`);
  }
}

async function downloadRuntimeArtifact(target, downloadCacheRoot, refresh) {
  const cacheDirectory = path.join(downloadCacheRoot, target.runtimeName, target.key);
  fs.mkdirSync(cacheDirectory, { recursive: true });

  const failures = [];

  for (const source of target.sources) {
    const archiveFileName = getArchiveFileName(source.url);
    const archivePath = path.join(cacheDirectory, archiveFileName);

    if (!refresh && fs.existsSync(archivePath)) {
      if (await hasMatchingChecksum(archivePath, source.sha256)) {
        return {
          archivePath,
          cacheHit: true,
          selectedSource: source,
        };
      }
      fs.rmSync(archivePath, { force: true });
    }

    try {
      await downloadSourceToFile(source.url, archivePath);

      if (!(await hasMatchingChecksum(archivePath, source.sha256))) {
        throw new Error(`Checksum mismatch for ${archiveFileName}`);
      }

      return {
        archivePath,
        cacheHit: false,
        selectedSource: source,
      };
    } catch (error) {
      fs.rmSync(archivePath, { force: true });
      failures.push(`${source.url}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  throw new Error(`Failed to download ${target.runtimeName} for ${target.key}.\n${failures.join('\n')}`);
}

async function downloadSourceToFile(url, destinationPath) {
  assertSafeSourceUrl(url, 'manifest source');

  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }

  assertSafeSourceUrl(response.url, 'redirect target');

  const tempPath = `${destinationPath}.tmp`;
  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });

  try {
    await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(tempPath));
    fs.renameSync(tempPath, destinationPath);
  } finally {
    if (fs.existsSync(tempPath)) {
      fs.rmSync(tempPath, { force: true });
    }
  }
}

async function hasMatchingChecksum(filePath, expectedSha256) {
  const digest = await sha256File(filePath);
  return digest.toLowerCase() === expectedSha256.toLowerCase();
}

async function sha256File(filePath) {
  const hash = createHash('sha256');

  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });

  return hash.digest('hex');
}

function installRuntimeArchive(archivePath, destination, target) {
  const extractRoot = fs.mkdtempSync(path.join(os.tmpdir(), `xiaoba-runtime-${target.runtimeName}-`));

  try {
    extractArchive(archivePath, extractRoot, target.archiveType);
    const packageRoot = resolveExtractedRoot(extractRoot, target.packageRoot);
    copyDirectoryContents(packageRoot, destination, {
      skip: target.skip || [],
    });
  } finally {
    fs.rmSync(extractRoot, { recursive: true, force: true });
  }
}

function extractArchive(archivePath, extractRoot, archiveType) {
  switch (archiveType) {
    case 'zip':
      if (process.platform === 'win32') {
        runCommand('powershell.exe', [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `Expand-Archive -LiteralPath \"${escapePowerShellPath(archivePath)}\" -DestinationPath \"${escapePowerShellPath(extractRoot)}\" -Force`,
        ]);
      } else {
        runCommand('unzip', ['-q', archivePath, '-d', extractRoot]);
      }
      return;
    case 'tar.gz':
      runCommand('tar', ['-xzf', archivePath, '-C', extractRoot]);
      return;
    case 'tar.xz':
      runCommand('tar', ['-xJf', archivePath, '-C', extractRoot]);
      return;
    default:
      throw new Error(`Unsupported archive type: ${archiveType}`);
  }
}

function runCommand(command, args) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    windowsHide: true,
  });

  if (result.status !== 0) {
    const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
    throw new Error(`${command} ${args.join(' ')} failed${output ? `: ${output}` : ''}`);
  }
}

function copyDirectory(source, target, options = {}) {
  const skipNames = new Set(options.skip || []);
  fs.cpSync(source, target, {
    recursive: true,
    force: true,
    dereference: false,
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

function copyDirectoryContents(source, target, options = {}) {
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });

  for (const entry of fs.readdirSync(source)) {
    copyDirectory(path.join(source, entry), path.join(target, entry), options);
  }
}

const POSIX_NODE_BIN_LINKS = [
  {
    name: 'npm',
    target: path.join('..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  },
  {
    name: 'npx',
    target: path.join('..', 'lib', 'node_modules', 'npm', 'bin', 'npx-cli.js'),
  },
  {
    name: 'corepack',
    target: path.join('..', 'lib', 'node_modules', 'corepack', 'dist', 'corepack.js'),
  },
];

export function repairNodeRuntimeEntrypoints(nodeRuntimeRoot, platform = process.platform) {
  if (normalizePlatform(platform) === 'win32') {
    return [];
  }

  const binDir = path.join(nodeRuntimeRoot, 'bin');
  if (!fs.existsSync(binDir)) {
    return [];
  }

  const repaired = [];

  for (const link of POSIX_NODE_BIN_LINKS) {
    const linkPath = path.join(binDir, link.name);
    const targetPath = path.resolve(binDir, link.target);

    if (!fs.existsSync(targetPath)) {
      throw new Error(`Bundled Node runtime is missing ${link.name} target: ${targetPath}`);
    }

    if (isExpectedSymlink(linkPath, link.target)) {
      continue;
    }

    // Node.js v24+ does not remove broken symlinks with rmSync({ force: true }).
    // Use unlinkSync which reliably removes symlink entries regardless of target state.
    try {
      fs.unlinkSync(linkPath);
    } catch {
      fs.rmSync(linkPath, { force: true, recursive: true });
    }
    fs.symlinkSync(link.target, linkPath);
    fs.chmodSync(targetPath, 0o755);
    repaired.push(link.name);
  }

  return repaired;
}

export function removeBrokenRuntimeSymlinks(runtimeRoot) {
  if (!fs.existsSync(runtimeRoot)) {
    return [];
  }

  const removed = [];

  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      const stat = fs.lstatSync(entryPath);

      if (stat.isSymbolicLink()) {
        if (!fs.existsSync(entryPath)) {
          try {
            fs.unlinkSync(entryPath);
          } catch {
            fs.rmSync(entryPath, { force: true, recursive: true });
          }
          removed.push(path.relative(runtimeRoot, entryPath));
        }
        continue;
      }

      if (stat.isDirectory()) {
        walk(entryPath);
      }
    }
  }

  walk(runtimeRoot);
  return removed.sort();
}

function isExpectedSymlink(linkPath, expectedTarget) {
  try {
    const stat = fs.lstatSync(linkPath);
    if (!stat.isSymbolicLink()) {
      return false;
    }
    return path.normalize(fs.readlinkSync(linkPath)) === path.normalize(expectedTarget);
  } catch {
    return false;
  }
}

function resolveCommand(command) {
  const lookup = process.platform === 'win32' ? 'where' : 'which';
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

function normalizeSources(sources) {
  return (sources || []).map((source) => {
    if (typeof source === 'string') {
      return { url: source };
    }
    return source;
  });
}

function assertSafeSourceUrl(url, context) {
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error(`Invalid URL in ${context}: ${url}`);
  }

  if (parsedUrl.protocol !== 'https:') {
    throw new Error(`Non-HTTPS URL in ${context}: ${url}`);
  }

  if (!ALLOWED_SOURCE_HOSTS.has(parsedUrl.hostname.toLowerCase())) {
    throw new Error(`Unapproved host in ${context}: ${parsedUrl.hostname}`);
  }
}

function getArchiveFileName(url) {
  const pathname = new URL(url).pathname;
  return decodeURIComponent(path.basename(pathname));
}

function escapePowerShellPath(value) {
  return value.replace(/`/g, '``').replace(/"/g, '`"');
}

function parseArgs(args) {
  const options = {
    refresh: false,
  };
  const positionals = [];

  for (const argument of args) {
    if (argument === '--refresh') {
      options.refresh = true;
      continue;
    }
    positionals.push(argument);
  }

  if (positionals[0]) {
    options.platform = positionals[0];
  }
  if (positionals[1]) {
    options.arch = positionals[1];
  }

  return options;
}

export function normalizePlatform(value) {
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

export function normalizeArch(value) {
  if (value === 'x86_64' || value === 'amd64') {
    return 'x64';
  }
  if (value === 'aarch64') {
    return 'arm64';
  }
  return value;
}
