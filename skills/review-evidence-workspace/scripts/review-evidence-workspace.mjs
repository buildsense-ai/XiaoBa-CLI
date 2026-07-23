#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SCHEMA_VERSION = 1;
const KINDS = new Set(['code', 'log', 'process', 'test', 'agentic', 'browser', 'note']);
const ASSESSMENTS = new Set(['confirmed', 'not-reproduced', 'needs-more-evidence']);

main();

function main() {
  try {
    const [command, ...argv] = process.argv.slice(2);
    const args = parseArgs(argv);
    if (!command || args.help === true) return printUsage();

    const root = resolveRoot(args);
    let result;
    if (command === 'init') result = initInvestigation(root, args);
    else if (command === 'record') result = recordEvidence(root, args);
    else if (command === 'show') result = showInvestigation(root, args);
    else if (command === 'snapshot') result = snapshotInvestigation(root, args);
    else throw new Error(`Unknown command: ${command}`);

    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) args[key] = true;
    else {
      args[key] = next;
      index += 1;
    }
  }
  return args;
}

function resolveRoot(args) {
  const configured = stringArg(args, 'root', false)
    || process.env.XIAOBA_REVIEW_EVIDENCE_ROOT?.trim();
  if (!configured) {
    throw new Error('Evidence root is required. Pass --root or set XIAOBA_REVIEW_EVIDENCE_ROOT.');
  }
  return path.resolve(expandHome(configured));
}

function initInvestigation(root, args) {
  const title = stringArg(args, 'title');
  const source = stringArg(args, 'source');
  const sparseDescription = stringArg(args, 'description');
  const investigationId = args.id
    ? validateId(stringArg(args, 'id'))
    : buildInvestigationId(title);
  const investigationDir = investigationPath(root, investigationId);
  if (fs.existsSync(investigationDir)) throw new Error(`Investigation already exists: ${investigationId}`);

  const now = new Date().toISOString();
  fs.mkdirSync(path.join(investigationDir, 'artifacts'), { recursive: true, mode: 0o700 });
  const record = {
    schemaVersion: SCHEMA_VERSION,
    investigationId,
    title,
    source,
    sparseDescription,
    status: 'investigating',
    createdAt: now,
    updatedAt: now,
  };
  atomicWriteJson(path.join(investigationDir, 'case.json'), record);
  appendJsonLine(path.join(investigationDir, 'events.ndjson'), {
    schemaVersion: SCHEMA_VERSION,
    eventId: crypto.randomUUID(),
    investigationId,
    type: 'investigation_created',
    occurredAt: now,
    source,
    summary: sparseDescription,
  });

  return { ok: true, investigationId, investigationDir };
}

function recordEvidence(root, args) {
  const investigationId = validateId(stringArg(args, 'id'));
  const kind = stringArg(args, 'kind');
  if (!KINDS.has(kind)) throw new Error(`Unsupported evidence kind: ${kind}`);
  const summary = stringArg(args, 'summary');
  const investigationDir = requireInvestigation(root, investigationId);
  const casePath = path.join(investigationDir, 'case.json');
  const caseRecord = readJson(casePath);
  const now = new Date().toISOString();

  let artifact;
  const artifactInput = stringArg(args, 'artifact', false);
  if (artifactInput) artifact = copyArtifact(investigationDir, artifactInput, kind);

  const event = compactObject({
    schemaVersion: SCHEMA_VERSION,
    eventId: crypto.randomUUID(),
    investigationId,
    type: 'evidence_recorded',
    occurredAt: now,
    kind,
    summary,
    hypothesis: stringArg(args, 'hypothesis', false),
    source: stringArg(args, 'source', false),
    command: stringArg(args, 'command', false),
    environment: stringArg(args, 'environment', false),
    artifact,
  });
  appendJsonLine(path.join(investigationDir, 'events.ndjson'), event);
  atomicWriteJson(casePath, { ...caseRecord, updatedAt: now });

  return { ok: true, investigationId, event };
}

function showInvestigation(root, args) {
  const investigationId = validateId(stringArg(args, 'id'));
  const investigationDir = requireInvestigation(root, investigationId);
  const events = readJsonLines(path.join(investigationDir, 'events.ndjson'));
  const artifacts = listFiles(path.join(investigationDir, 'artifacts'));
  return {
    ok: true,
    investigation: readJson(path.join(investigationDir, 'case.json')),
    eventCount: events.length,
    evidenceCount: events.filter(event => event.type === 'evidence_recorded').length,
    artifacts,
    lastEvent: events.at(-1),
  };
}

function snapshotInvestigation(root, args) {
  const investigationId = validateId(stringArg(args, 'id'));
  const assessment = stringArg(args, 'assessment');
  if (!ASSESSMENTS.has(assessment)) throw new Error(`Unsupported assessment: ${assessment}`);
  const conclusion = stringArg(args, 'conclusion');
  const investigationDir = requireInvestigation(root, investigationId);
  const createdAt = new Date().toISOString();
  const snapshotId = `${createdAt.replace(/[-:.TZ]/g, '').slice(0, 14)}-${crypto.randomBytes(3).toString('hex')}`;
  const bundleParent = path.join(root, 'bundles', investigationId);
  const finalDirectory = path.join(bundleParent, snapshotId);
  const temporaryDirectory = `${finalDirectory}.tmp-${process.pid}`;
  fs.mkdirSync(temporaryDirectory, { recursive: true, mode: 0o700 });

  try {
    fs.copyFileSync(path.join(investigationDir, 'case.json'), path.join(temporaryDirectory, 'case.json'));
    fs.copyFileSync(path.join(investigationDir, 'events.ndjson'), path.join(temporaryDirectory, 'events.ndjson'));
    copyDirectory(path.join(investigationDir, 'artifacts'), path.join(temporaryDirectory, 'artifacts'));
    atomicWriteJson(path.join(temporaryDirectory, 'snapshot.json'), {
      schemaVersion: SCHEMA_VERSION,
      investigationId,
      snapshotId,
      assessment,
      conclusion,
      createdAt,
    });

    const files = listFiles(temporaryDirectory)
      .filter(relativePath => relativePath !== 'manifest.json')
      .map(relativePath => ({
        path: relativePath,
        bytes: fs.statSync(path.join(temporaryDirectory, relativePath)).size,
        sha256: sha256File(path.join(temporaryDirectory, relativePath)),
      }));
    atomicWriteJson(path.join(temporaryDirectory, 'manifest.json'), {
      schemaVersion: SCHEMA_VERSION,
      investigationId,
      snapshotId,
      createdAt,
      files,
    });

    fs.mkdirSync(bundleParent, { recursive: true, mode: 0o700 });
    fs.renameSync(temporaryDirectory, finalDirectory);
    makeTreeReadOnly(finalDirectory);
  } catch (error) {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    throw error;
  }

  return {
    ok: true,
    investigationId,
    snapshotId,
    bundleDirectory: finalDirectory,
    manifestPath: path.join(finalDirectory, 'manifest.json'),
  };
}

function copyArtifact(investigationDir, artifactInput, kind) {
  const sourcePath = path.resolve(expandHome(artifactInput));
  const stats = fs.statSync(sourcePath);
  if (!stats.isFile()) throw new Error(`Artifact must be a file: ${sourcePath}`);
  const safeName = path.basename(sourcePath).replace(/[^a-zA-Z0-9._-]+/g, '-').slice(-120) || 'artifact';
  const relativePath = path.posix.join('artifacts', `${Date.now()}-${kind}-${crypto.randomBytes(3).toString('hex')}-${safeName}`);
  const destination = path.join(investigationDir, ...relativePath.split('/'));
  fs.copyFileSync(sourcePath, destination, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(destination, 0o600);
  return {
    path: relativePath,
    originalName: path.basename(sourcePath),
    bytes: stats.size,
    sha256: sha256File(destination),
  };
}

function investigationPath(root, investigationId) {
  return path.join(root, 'investigations', validateId(investigationId));
}

function requireInvestigation(root, investigationId) {
  const directory = investigationPath(root, investigationId);
  if (!fs.existsSync(path.join(directory, 'case.json'))) {
    throw new Error(`Unknown investigation: ${investigationId}`);
  }
  return directory;
}

function validateId(value) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(value)) {
    throw new Error('Investigation id must use 1-80 letters, numbers, dot, underscore, or hyphen.');
  }
  return value;
}

function buildInvestigationId(title) {
  const slug = title.toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'investigation';
  return validateId(`${slug}-${Date.now().toString(36)}-${crypto.randomBytes(2).toString('hex')}`);
}

function stringArg(args, key, required = true) {
  const value = typeof args[key] === 'string' ? args[key].trim() : '';
  if (required && !value) throw new Error(`Missing required --${key}`);
  return value || undefined;
}

function atomicWriteJson(filePath, value) {
  const temporaryPath = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporaryPath, filePath);
}

function appendJsonLine(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600 });
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readJsonLines(filePath) {
  return fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
}

function copyDirectory(source, destination) {
  if (!fs.existsSync(source)) return;
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) copyDirectory(from, to);
    else if (entry.isFile()) fs.copyFileSync(from, to);
  }
}

function listFiles(directory, prefix = '') {
  if (!fs.existsSync(directory)) return [];
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const relativePath = prefix ? path.posix.join(prefix, entry.name) : entry.name;
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(entryPath, relativePath));
    else if (entry.isFile()) files.push(relativePath);
  }
  return files.sort();
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function makeTreeReadOnly(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      makeTreeReadOnly(entryPath);
      fs.chmodSync(entryPath, 0o500);
    } else if (entry.isFile()) fs.chmodSync(entryPath, 0o400);
  }
  fs.chmodSync(directory, 0o500);
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== ''));
}

function expandHome(value) {
  return value === '~' ? os.homedir() : value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value;
}

function printUsage() {
  process.stdout.write([
    'review-evidence-workspace <init|record|show|snapshot> [options]',
    'Root is required through --root or XIAOBA_REVIEW_EVIDENCE_ROOT.',
  ].join('\n') + '\n');
}
