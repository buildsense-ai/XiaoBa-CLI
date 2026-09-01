import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import yaml from 'js-yaml';

const DAY_MS = 24 * 60 * 60 * 1000;

const RELEASE_PATTERNS = [
  /^update\/CatsCo-(.+)-win\.exe(?:\.blockmap)?$/,
  /^update\/CatsCo-(.+)-linux\.(?:AppImage|deb)(?:\.blockmap)?$/,
  /^update\/macos-(x64|arm64)\/CatsCo-(.+)-mac-\1\.(?:dmg|zip)(?:\.blockmap)?$/,
];

function releaseVersionForKey(key) {
  for (const pattern of RELEASE_PATTERNS) {
    const match = pattern.exec(String(key || ''));
    if (match) return match.length === 2 ? match[1] : match[2];
  }
  return '';
}

function parseVersion(value) {
  const match = /^(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?$/.exec(String(value || ''));
  if (!match) return null;
  return {
    numbers: match[1].split('.').map((part) => Number.parseInt(part, 10)),
    prerelease: match[2] || '',
  };
}

export function compareReleaseVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return String(left).localeCompare(String(right), 'en', { numeric: true });
  const width = Math.max(a.numbers.length, b.numbers.length);
  for (let index = 0; index < width; index += 1) {
    const diff = (a.numbers[index] || 0) - (b.numbers[index] || 0);
    if (diff !== 0) return diff;
  }
  if (a.prerelease === b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;
  return a.prerelease.localeCompare(b.prerelease, 'en', { numeric: true });
}

function metadataVersions(documents) {
  const versions = new Set();
  for (const document of documents) {
    const parsed = yaml.load(document);
    if (parsed && typeof parsed === 'object' && typeof parsed.version === 'string') {
      versions.add(parsed.version.trim());
    }
  }
  return versions;
}

function groupReleaseObjects(objects) {
  const groups = new Map();
  const ignoredKeys = [];
  for (const object of objects) {
    const key = String(object?.Key || '');
    const version = releaseVersionForKey(key);
    if (!version) {
      ignoredKeys.push(key);
      continue;
    }
    const row = {
      key,
      version,
      size: Number(object?.Size || 0),
      lastModified: String(object?.LastModified || ''),
    };
    if (!groups.has(version)) groups.set(version, []);
    groups.get(version).push(row);
  }
  return { groups, ignoredKeys };
}

export function buildReleaseRetentionPlan({
  objects,
  metadataDocuments = [],
  keepVersions = 2,
  minAgeDays = 30,
  maxDeleteObjects = 80,
  now = Date.now(),
}) {
  if (!Array.isArray(objects)) throw new Error('objects must be an array');
  if (!Number.isInteger(keepVersions) || keepVersions < 1) throw new Error('keepVersions must be at least 1');
  if (!Number.isFinite(minAgeDays) || minAgeDays < 1) throw new Error('minAgeDays must be at least 1');
  if (!Number.isInteger(maxDeleteObjects) || maxDeleteObjects < 1) throw new Error('maxDeleteObjects must be at least 1');

  const { groups, ignoredKeys } = groupReleaseObjects(objects);
  const versions = [...groups.keys()].sort(compareReleaseVersions).reverse();
  const protectedVersions = metadataVersions(metadataDocuments);
  versions.slice(0, keepVersions).forEach((version) => protectedVersions.add(version));

  const cutoff = now - minAgeDays * DAY_MS;
  const eligible = versions
    .filter((version) => !protectedVersions.has(version))
    .map((version) => {
      const rows = groups.get(version);
      const timestamps = rows.map((row) => Date.parse(row.lastModified));
      const fullyOlderThanCutoff = timestamps.every((stamp) => Number.isFinite(stamp) && stamp < cutoff);
      return { version, rows, fullyOlderThanCutoff };
    })
    .filter((group) => group.fullyOlderThanCutoff)
    .sort((left, right) => compareReleaseVersions(left.version, right.version));

  const deleteObjects = [];
  const deleteVersions = [];
  const deferredVersions = [];
  for (const group of eligible) {
    if (deleteObjects.length + group.rows.length > maxDeleteObjects) {
      deferredVersions.push(group.version);
      continue;
    }
    deleteVersions.push(group.version);
    deleteObjects.push(...group.rows.sort((a, b) => a.key.localeCompare(b.key)));
  }

  return {
    generatedAt: new Date(now).toISOString(),
    policy: { keepVersions, minAgeDays, maxDeleteObjects },
    protectedVersions: [...protectedVersions].sort(compareReleaseVersions).reverse(),
    deleteVersions,
    deferredVersions,
    deleteObjects,
    ignoredKeys,
    totals: {
      knownVersions: versions.length,
      knownObjects: [...groups.values()].reduce((total, rows) => total + rows.length, 0),
      deleteObjects: deleteObjects.length,
      deleteBytes: deleteObjects.reduce((total, row) => total + row.size, 0),
    },
  };
}

function parseArgs(argv) {
  const options = { metadata: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];
    if (arg === '--listing') options.listing = value;
    else if (arg === '--metadata') options.metadata.push(value);
    else if (arg === '--keep-versions') options.keepVersions = Number(value);
    else if (arg === '--min-age-days') options.minAgeDays = Number(value);
    else if (arg === '--max-delete-objects') options.maxDeleteObjects = Number(value);
    else throw new Error(`unknown argument: ${arg}`);
    index += 1;
  }
  if (!options.listing) throw new Error('--listing is required');
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const listing = JSON.parse(fs.readFileSync(options.listing, 'utf8'));
  const metadataDocuments = options.metadata.map((file) => fs.readFileSync(file, 'utf8'));
  const plan = buildReleaseRetentionPlan({
    objects: listing.Contents || [],
    metadataDocuments,
    keepVersions: options.keepVersions ?? 2,
    minAgeDays: options.minAgeDays ?? 30,
    maxDeleteObjects: options.maxDeleteObjects ?? 80,
  });
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    console.error(`release retention planning failed: ${error.message}`);
    process.exitCode = 1;
  }
}
