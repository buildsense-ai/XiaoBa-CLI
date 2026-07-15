#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
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

    const url = file.url.trim();
    let decodedUrl;
    try {
      decodedUrl = decodeURIComponent(url);
    } catch {
      throw new Error(`macOS update metadata contains an invalid URL: ${url}`);
    }
    if (decodedUrl !== url || path.posix.basename(url) !== url || /[\\?#]/.test(url)) {
      throw new Error(`macOS update metadata URL must be a plain file name: ${url}`);
    }

    if (typeof file.sha512 !== 'string' || file.sha512.trim() === '') {
      throw new Error(`macOS update metadata is missing sha512 for ${url}`);
    }

    if (!Number.isSafeInteger(file.size) || file.size <= 0) {
      throw new Error(`macOS update metadata has an invalid size for ${url}`);
    }

    return {
      url,
      sha512: file.sha512.trim(),
      size: file.size,
    };
  });
}

function selectRequiredFiles(files, arch) {
  const selected = new Map();
  for (const extension of REQUIRED_EXTENSIONS) {
    const matches = files.filter((file) => (
      fileExtension(file.url) === extension && fileMatchesArch(file.url, arch)
    ));
    if (matches.length === 0) {
      throw new Error(`macOS ${arch} update metadata is missing a .${extension} file`);
    }
    if (matches.length > 1) {
      throw new Error(`macOS ${arch} update metadata contains multiple .${extension} files`);
    }
    selected.set(extension, matches[0]);
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

  const response = await fetch(metadataUrl, {
    cache: 'no-store',
    redirect: 'follow',
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    throw new Error(`metadata request failed: HTTP ${response.status} ${metadataUrl}`);
  }
  return { text: await response.text(), baseUrl: metadataUrl };
}

async function verifyLocalFiles(selected, artifactDir) {
  if (!artifactDir) throw new Error('--artifact-dir is required with --metadata');

  for (const [extension, file] of selected) {
    const pathname = decodeURIComponent(new URL(file.url, 'https://update.invalid/').pathname);
    const artifactPath = path.join(artifactDir, path.basename(pathname));
    const stat = await fs.stat(artifactPath).catch(() => null);
    if (!stat?.isFile()) {
      throw new Error(`missing local .${extension} update artifact: ${artifactPath}`);
    }

    if (stat.size !== file.size) {
      throw new Error(
        `local .${extension} update artifact size mismatch: expected ${file.size}, got ${stat.size}`,
      );
    }

    const digest = await sha512File(artifactPath);
    if (digest !== file.sha512) {
      throw new Error(`local .${extension} update artifact sha512 mismatch: ${artifactPath}`);
    }
  }
}

function sha512File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha512');
    const stream = createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('base64')));
  });
}

async function verifyRemoteFiles(selected, metadataUrl) {
  for (const [extension, file] of selected) {
    const artifactUrl = new URL(file.url, metadataUrl).href;
    const headResponse = await fetch(artifactUrl, {
      method: 'HEAD',
      cache: 'no-store',
      redirect: 'follow',
      signal: AbortSignal.timeout(60_000),
    });
    if (!headResponse.ok) {
      throw new Error(`published .${extension} update artifact failed: HTTP ${headResponse.status} ${artifactUrl}`);
    }

    const contentLength = Number(headResponse.headers.get('content-length'));
    if (!Number.isSafeInteger(contentLength) || contentLength !== file.size) {
      throw new Error(
        `published .${extension} update artifact size mismatch: expected ${file.size}, got ${headResponse.headers.get('content-length') || 'missing'}`,
      );
    }

    const response = await fetch(artifactUrl, {
      cache: 'no-store',
      redirect: 'follow',
      signal: AbortSignal.timeout(900_000),
    });
    if (!response.ok || !response.body) {
      throw new Error(`published .${extension} update artifact download failed: HTTP ${response.status} ${artifactUrl}`);
    }

    const hash = createHash('sha512');
    let streamedSize = 0;
    for await (const chunk of response.body) {
      const buffer = Buffer.from(chunk);
      streamedSize += buffer.length;
      hash.update(buffer);
    }

    if (streamedSize !== file.size) {
      throw new Error(
        `published .${extension} update artifact streamed size mismatch: expected ${file.size}, got ${streamedSize}`,
      );
    }
    if (hash.digest('base64') !== file.sha512) {
      throw new Error(`published .${extension} update artifact sha512 mismatch: ${artifactUrl}`);
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
    const summary = [...selected.entries()]
      .map(([extension, file]) => `${extension}=${file.url}`)
      .join(' ');
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
