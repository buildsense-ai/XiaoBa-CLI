#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const options = parseArgs(process.argv.slice(2));
const root = path.resolve(options.root || process.cwd());
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = options.version || packageJson.version;
const commit = options.commit || git(root, ['rev-parse', 'HEAD']).trim();
const shortCommit = commit.slice(0, 8);
const releaseId = `${version}-${shortCommit}`;
const outputDir = path.resolve(options.outputDir || path.join(root, 'release', 'worker'));
const artifactPath = path.resolve(
  options.output || path.join(outputDir, `catsco-worker-${releaseId}-linux-x64.tar.gz`),
);

if (process.platform !== 'linux' || process.arch !== 'x64') {
  throw new Error(
    `Worker artifacts must be built on linux-x64; current platform is ${process.platform}-${process.arch}`,
  );
}

for (const required of ['dist', 'package.json', 'package-lock.json']) {
  if (!fs.existsSync(path.join(root, required))) {
    throw new Error(`Missing required build input: ${required}`);
  }
}

fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
const stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'catsco-worker-artifact-'));
const appRoot = path.join(stagingRoot, 'app');

try {
  fs.mkdirSync(appRoot, { recursive: true });
  fs.cpSync(path.join(root, 'dist'), path.join(appRoot, 'dist'), {
    recursive: true,
    dereference: false,
  });
  copyTrackedFiles(root, appRoot, [
    '.env.example',
    'dashboard',
    'package-lock.json',
    'package.json',
    'prompts',
    'skills',
  ], options.archiveSource);

  run('npm', [
    'ci',
    '--omit=dev',
    '--ignore-scripts',
    '--prefer-offline',
    '--no-audit',
    '--fund=false',
  ], { cwd: appRoot });

  run('node', [
    '-e',
    'require("sharp"); const canvas = require("@napi-rs/canvas"); canvas.createCanvas(2, 2); require("deasync");',
  ], { cwd: appRoot });

  const manifest = {
    schemaVersion: 1,
    product: 'catsco-worker',
    version,
    commit,
    releaseId,
    platform: 'linux',
    arch: 'x64',
    node: process.version,
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(
    path.join(appRoot, 'worker-release.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );

  run('tar', ['-C', stagingRoot, '-czf', artifactPath, 'app']);
  const sha256 = hashFile(artifactPath);
  fs.writeFileSync(`${artifactPath}.sha256`, `${sha256}  ${path.basename(artifactPath)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify({ ...manifest, artifactPath, sha256 }, null, 2)}\n`);
} finally {
  fs.rmSync(stagingRoot, { recursive: true, force: true });
}

function parseArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') {
      process.stdout.write(
        'Usage: node scripts/build-linux-worker-artifact.mjs [--root PATH] [--output PATH] [--output-dir PATH] [--version VERSION] [--commit SHA] [--archive-source]\n',
      );
      process.exit(0);
    }
    if (arg === '--archive-source') {
      parsed.archiveSource = true;
      continue;
    }
    const key = {
      '--root': 'root',
      '--output': 'output',
      '--output-dir': 'outputDir',
      '--version': 'version',
      '--commit': 'commit',
    }[arg];
    if (!key || !args[index + 1]) throw new Error(`Unknown or incomplete argument: ${arg}`);
    parsed[key] = args[index + 1];
    index += 1;
  }
  return parsed;
}

function copyTrackedFiles(sourceRoot, destinationRoot, pathspecs, archiveSource = false) {
  if (archiveSource) {
    for (const relativePath of pathspecs) {
      const source = path.join(sourceRoot, relativePath);
      if (!fs.existsSync(source)) continue;
      const destination = path.join(destinationRoot, relativePath);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.cpSync(source, destination, { recursive: true, dereference: false });
    }
    return;
  }

  const tracked = git(sourceRoot, ['ls-files', '-z', '--', ...pathspecs])
    .split('\0')
    .filter(Boolean);
  for (const relativePath of tracked) {
    const source = path.join(sourceRoot, relativePath);
    if (!fs.statSync(source).isFile()) continue;
    const destination = path.join(destinationRoot, relativePath);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
  }
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function run(command, args, options = {}) {
  execFileSync(command, args, {
    ...options,
    stdio: options.stdio || 'inherit',
  });
}

function hashFile(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}
