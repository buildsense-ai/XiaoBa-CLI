import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const DEFAULT_MANIFEST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'cats-company', 'docs', 'xiaoba-cli-compatibility.json');

function readManifest(manifestPath = DEFAULT_MANIFEST) {
  if (!fs.existsSync(manifestPath)) {
    return null;
  }
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot read CatsCompany compatibility manifest: ${error.message}`);
  }
  if (!manifest || manifest.schemaVersion !== 1 || typeof manifest.clientRepository !== 'string' || !manifest.clientRepository.trim() || !Array.isArray(manifest.protocols) || manifest.protocols.length === 0) {
    throw new Error('CatsCompany compatibility manifest has an invalid schema');
  }
  for (const protocol of manifest.protocols) {
    if (!protocol || typeof protocol.id !== 'string' || !protocol.id.trim() || typeof protocol.minimumClientCommit !== 'string' || !protocol.minimumClientCommit.trim()) {
      throw new Error('Every CatsCompany compatibility protocol needs id and minimumClientCommit');
    }
  }
  return manifest;
}

function currentCommit() {
  return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

async function githubGet(apiPath, token, fetchImpl = globalThis.fetch) {
  const apiUrl = (process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/$/, '');
  const response = await fetchImpl(`${apiUrl}${apiPath}`, {
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': 'xiaoba-release-compat',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub compatibility lookup failed (${response.status}) for ${apiPath}`);
  }
  return response.json();
}

async function containsCommit(repository, requiredCommit, targetRef, token, fetchImpl) {
  const result = await githubGet(`/repos/${repository}/compare/${requiredCommit}...${targetRef}`, token, fetchImpl);
  return result.status === 'ahead' || result.status === 'identical';
}

export async function verifyCompatibility({ manifestPath = DEFAULT_MANIFEST, token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN, currentSha = currentCommit(), fetchImpl = globalThis.fetch } = {}) {
  const manifest = readManifest(manifestPath);
  if (!manifest) {
    return ['[compatibility] CatsCompany manifest is not present on this branch; compatibility check skipped during rollout.'];
  }
  const failures = [];
  for (const protocol of manifest.protocols) {
    const included = await containsCommit(manifest.clientRepository, protocol.minimumClientCommit, currentSha, token, fetchImpl);
    if (!included) {
      failures.push(`${protocol.id}: release commit ${currentSha} does not contain ${protocol.minimumClientCommit}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(failures.join('\n'));
  }
  return [`XiaoBa release compatibility passed: ${manifest.protocols.length} protocol(s) satisfy CatsCompany.`];
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const manifestPathArg = process.argv[2];
  verifyCompatibility({ manifestPath: manifestPathArg || DEFAULT_MANIFEST })
    .then((messages) => messages.forEach((message) => console.log(message)))
    .catch((error) => {
      console.error(`ERROR: ${error.message}`);
      process.exitCode = 1;
    });
}
