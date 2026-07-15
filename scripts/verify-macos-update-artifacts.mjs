#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const REQUIRED_EXTENSIONS = ['dmg', 'zip'];

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (!name.startsWith('--')) throw new Error(`Unexpected argument: ${name}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${name}`);
    options[name.slice(2)] = value;
    index += 1;
  }
  return options;
}

function metadataFiles(document) {
  if (!document || !Array.isArray(document.files)) {
    throw new Error('macOS update metadata must contain a files array');
  }

  return document.files.map((file) => {
    if (!file || typeof file.url !== 'string' || file.url.trim() === '') {
      throw new Error('every macOS update metadata file must contain a URL');
    }
    return file.url.trim();
  });
}

function selectRequiredFiles(urls, arch) {
  const selected = new Map();
  for (const extension of REQUIRED_EXTENSIONS) {
    const match = urls.find((url) => fileExtension(url) === extension && fileMatchesArch(url, arch));
    if (!match) {
      throw new Error(`macOS ${arch} update metadata is missing a .${extension} file`);
    }
    selected.set(extension, match);
  }
  return selected;
}

function fileExtension(value) {
  const pathname = new URL(value, 'https://update.invalid/').pathname;
  return path.extname(pathname).slice(1).toLowerCase();
}

function fileMatchesArch(value, arch) {
  const pathname = decodeURIComponent(new URL(value, 'https://update.invalid/').pathname);
  return path.basename(pathname).includes(`-${arch}.`);
}

async function readMetadata(options) {
  const metadata = options.metadata;
  const metadataUrl = options['metadata-url'];
  if (Boolean(metadata) === Boolean(metadataUrl)) {
    throw new Error('provide exactly one of --metadata or --metadata-url');
  }

  if (metadata) {
    return { text: await fs.readFile(metadata, 'utf8'), baseUrl: null };
  }

  const response = await fetch(metadataUrl, { cache: 'no-store', redirect: 'follow' });
  if (!response.ok) {
    throw new Error(`metadata request failed: HTTP ${response.status} ${metadataUrl}`);
  }
  return { text: await response.text(), baseUrl: metadataUrl };
}

async function verifyLocalFiles(selected, artifactDir) {
  if (!artifactDir) throw new Error('--artifact-dir is required with --metadata');

  for (const [extension, url] of selected) {
    const pathname = decodeURIComponent(new URL(url, 'https://update.invalid/').pathname);
    const artifactPath = path.join(artifactDir, path.basename(pathname));
    const stat = await fs.stat(artifactPath).catch(() => null);
    if (!stat?.isFile() || stat.size <= 0) {
      throw new Error(`missing local .${extension} update artifact: ${artifactPath}`);
    }
  }
}

async function verifyRemoteFiles(selected, metadataUrl) {
  for (const [extension, relativeUrl] of selected) {
    const artifactUrl = new URL(relativeUrl, metadataUrl).href;
    const response = await fetch(artifactUrl, { method: 'HEAD', cache: 'no-store', redirect: 'follow' });
    if (!response.ok) {
      throw new Error(`published .${extension} update artifact failed: HTTP ${response.status} ${artifactUrl}`);
    }
  }
}

async function verifyMacosUpdateArtifacts(options) {
  const arch = options.arch;
  if (!['x64', 'arm64'].includes(arch)) {
    throw new Error('--arch must be x64 or arm64');
  }

  const metadataResult = await readMetadata(options);
  const document = yaml.load(metadataResult.text);
  const selected = selectRequiredFiles(metadataFiles(document), arch);

  if (options.metadata) {
    await verifyLocalFiles(selected, options['artifact-dir']);
  } else {
    await verifyRemoteFiles(selected, metadataResult.baseUrl);
  }

  return selected;
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const selected = await verifyMacosUpdateArtifacts(options);
    const summary = [...selected.entries()].map(([extension, url]) => `${extension}=${url}`).join(' ');
    console.log(`macOS update artifacts verified: arch=${options.arch} ${summary}`);
  } catch (error) {
    console.error(`macOS update artifact verification failed: ${error.message}`);
    process.exitCode = 1;
  }
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) await main();

export {
  metadataFiles,
  selectRequiredFiles,
  verifyMacosUpdateArtifacts,
};
