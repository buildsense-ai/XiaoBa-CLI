import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const moduleUrl = pathToFileURL(
  path.join(process.cwd(), 'scripts/verify-macos-update-artifacts.mjs'),
).href;

function sha512(value: string) {
  return createHash('sha512').update(value).digest('base64');
}

test('macOS update artifact verification requires local DMG and ZIP files', async () => {
  const { verifyMacosUpdateArtifacts } = await import(moduleUrl) as any;
  const root = await mkdtemp(path.join(os.tmpdir(), 'catsco-macos-update-'));
  const metadataPath = path.join(root, 'latest-mac.yml');
  const dmgName = 'CatsCo-1.4.4-mac-arm64.dmg';
  const zipName = 'CatsCo-1.4.4-mac-arm64.zip';

  try {
    await writeFile(metadataPath, [
      'version: 1.4.4',
      'files:',
      `  - url: ${dmgName}`,
      `    sha512: ${sha512('dmg')}`,
      '    size: 3',
      `  - url: ${zipName}`,
      `    sha512: ${sha512('zip')}`,
      '    size: 3',
      '',
    ].join('\n'));
    await writeFile(path.join(root, dmgName), 'dmg');
    await writeFile(path.join(root, zipName), 'zip');

    const selected = await verifyMacosUpdateArtifacts({
      metadata: metadataPath,
      'artifact-dir': root,
      arch: 'arm64',
    });

    assert.equal(selected.get('dmg').url, dmgName);
    assert.equal(selected.get('zip').url, zipName);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('macOS update artifact verification rejects metadata without ZIP', async () => {
  const { verifyMacosUpdateArtifacts } = await import(moduleUrl) as any;
  const root = await mkdtemp(path.join(os.tmpdir(), 'catsco-macos-update-'));
  const metadataPath = path.join(root, 'latest-mac.yml');
  const dmgName = 'CatsCo-1.4.4-mac-x64.dmg';

  try {
    await writeFile(metadataPath, [
      'version: 1.4.4',
      'files:',
      `  - url: ${dmgName}`,
      `    sha512: ${sha512('dmg')}`,
      '    size: 3',
      '',
    ].join('\n'));
    await writeFile(path.join(root, dmgName), 'dmg');

    await assert.rejects(
      verifyMacosUpdateArtifacts({
        metadata: metadataPath,
        'artifact-dir': root,
        arch: 'x64',
      }),
      /missing a \.zip file/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('macOS update artifact verification rejects the wrong architecture', async () => {
  const { selectRequiredFiles } = await import(moduleUrl) as any;

  assert.throws(
    () => selectRequiredFiles([
      { url: 'CatsCo-1.4.4-mac-x64.dmg', sha512: 'dmg', size: 1 },
      { url: 'CatsCo-1.4.4-mac-x64.zip', sha512: 'zip', size: 1 },
    ], 'arm64'),
    /macOS arm64 update metadata is missing a \.dmg file/,
  );
});

test('macOS update artifact verification rejects duplicate artifacts', async () => {
  const { selectRequiredFiles } = await import(moduleUrl) as any;

  assert.throws(
    () => selectRequiredFiles([
      { url: 'CatsCo-1.4.4-mac-x64.dmg', sha512: 'dmg-a', size: 1 },
      { url: 'CatsCo-1.4.4-alt-mac-x64.dmg', sha512: 'dmg-b', size: 1 },
      { url: 'CatsCo-1.4.4-mac-x64.zip', sha512: 'zip', size: 1 },
    ], 'x64'),
    /contains multiple \.dmg files/,
  );
});

test('macOS update artifact verification accepts identical duplicate metadata entries', async () => {
  const { selectRequiredFiles } = await import(moduleUrl) as any;
  const duplicateDmg = {
    url: 'CatsCo-1.4.4-mac-x64.dmg',
    sha512: 'same-dmg',
    size: 10,
  };

  const selected = selectRequiredFiles([
    duplicateDmg,
    { ...duplicateDmg },
    { url: 'CatsCo-1.4.4-mac-x64.zip', sha512: 'zip', size: 20 },
  ], 'x64');

  assert.deepEqual(selected.get('dmg'), duplicateDmg);
});

test('macOS update artifact verification rejects conflicting duplicate metadata entries', async () => {
  const { selectRequiredFiles } = await import(moduleUrl) as any;

  assert.throws(
    () => selectRequiredFiles([
      { url: 'CatsCo-1.4.4-mac-x64.dmg', sha512: 'dmg-a', size: 10 },
      { url: 'CatsCo-1.4.4-mac-x64.dmg', sha512: 'dmg-b', size: 10 },
      { url: 'CatsCo-1.4.4-mac-x64.zip', sha512: 'zip', size: 20 },
    ], 'x64'),
    /contains multiple \.dmg files/,
  );
});

test('macOS update artifact verification checks published DMG and ZIP URLs', async () => {
  const { verifyMacosUpdateArtifacts } = await import(moduleUrl) as any;
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    if (request.url === '/updates/latest-mac.yml') {
      response.writeHead(200, { 'content-type': 'text/yaml' });
      response.end([
        'version: 1.4.4',
        'files:',
        '  - url: CatsCo-1.4.4-mac-arm64.dmg',
        `    sha512: ${sha512('dmg')}`,
        '    size: 3',
        '  - url: CatsCo-1.4.4-mac-arm64.zip',
        `    sha512: ${sha512('zip')}`,
        '    size: 3',
        '',
      ].join('\n'));
      return;
    }

    if (request.method === 'HEAD' && /^\/updates\/CatsCo-1\.4\.4-mac-arm64\.(dmg|zip)$/.test(request.url || '')) {
      response.writeHead(200, { 'content-length': '3' });
      response.end();
      return;
    }

    if (request.method === 'GET' && request.url === '/updates/CatsCo-1.4.4-mac-arm64.dmg') {
      response.writeHead(200, { 'content-length': '3' });
      response.end('dmg');
      return;
    }

    if (request.method === 'GET' && request.url === '/updates/CatsCo-1.4.4-mac-arm64.zip') {
      response.writeHead(200, { 'content-length': '3' });
      response.end('zip');
      return;
    }

    response.writeHead(404);
    response.end();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, 'object');
  const metadataUrl = `http://127.0.0.1:${(address as any).port}/updates/latest-mac.yml`;

  try {
    await verifyMacosUpdateArtifacts({
      'metadata-url': metadataUrl,
      arch: 'arm64',
    });
    assert.deepEqual(requests, [
      'GET /updates/latest-mac.yml',
      'HEAD /updates/CatsCo-1.4.4-mac-arm64.dmg',
      'GET /updates/CatsCo-1.4.4-mac-arm64.dmg',
      'HEAD /updates/CatsCo-1.4.4-mac-arm64.zip',
      'GET /updates/CatsCo-1.4.4-mac-arm64.zip',
    ]);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('macOS update artifact verification rejects a local checksum mismatch', async () => {
  const { verifyMacosUpdateArtifacts } = await import(moduleUrl) as any;
  const root = await mkdtemp(path.join(os.tmpdir(), 'catsco-macos-update-'));
  const metadataPath = path.join(root, 'latest-mac.yml');
  const dmgName = 'CatsCo-1.4.4-mac-x64.dmg';
  const zipName = 'CatsCo-1.4.4-mac-x64.zip';

  try {
    await writeFile(metadataPath, [
      'version: 1.4.4',
      'files:',
      `  - url: ${dmgName}`,
      `    sha512: ${sha512('bad')}`,
      '    size: 3',
      `  - url: ${zipName}`,
      `    sha512: ${sha512('zip')}`,
      '    size: 3',
      '',
    ].join('\n'));
    await writeFile(path.join(root, dmgName), 'dmg');
    await writeFile(path.join(root, zipName), 'zip');

    await assert.rejects(
      verifyMacosUpdateArtifacts({
        metadata: metadataPath,
        'artifact-dir': root,
        arch: 'x64',
      }),
      /sha512 mismatch/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('macOS update artifact verification rejects nested or absolute artifact URLs', async () => {
  const { metadataFiles } = await import(moduleUrl) as any;

  for (const url of [
    'subdir/CatsCo-1.4.4-mac-arm64.zip',
    'https://example.com/CatsCo-1.4.4-mac-arm64.zip',
  ]) {
    assert.throws(
      () => metadataFiles({ files: [{ url, sha512: 'checksum', size: 3 }] }),
      /URL must be a plain file name/,
    );
  }
});

test('macOS update artifact verification rejects a remote size mismatch', async () => {
  const { verifyMacosUpdateArtifacts } = await import(moduleUrl) as any;
  const server = createServer((request, response) => {
    if (request.url === '/updates/latest-mac.yml') {
      response.writeHead(200, { 'content-type': 'text/yaml' });
      response.end([
        'version: 1.4.4',
        'files:',
        '  - url: CatsCo-1.4.4-mac-arm64.dmg',
        `    sha512: ${sha512('dmg')}`,
        '    size: 3',
        '  - url: CatsCo-1.4.4-mac-arm64.zip',
        `    sha512: ${sha512('zip')}`,
        '    size: 3',
        '',
      ].join('\n'));
      return;
    }

    if (request.method === 'HEAD') {
      response.writeHead(200, { 'content-length': '2' });
      response.end();
      return;
    }

    response.writeHead(404);
    response.end();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, 'object');

  try {
    await assert.rejects(
      verifyMacosUpdateArtifacts({
        'metadata-url': `http://127.0.0.1:${(address as any).port}/updates/latest-mac.yml`,
        arch: 'arm64',
      }),
      /size mismatch: expected 3, got 2/,
    );
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('macOS update artifact verification rejects same-size remote content', async () => {
  const { verifyMacosUpdateArtifacts } = await import(moduleUrl) as any;
  const server = createServer((request, response) => {
    if (request.url === '/updates/latest-mac.yml') {
      response.writeHead(200, { 'content-type': 'text/yaml' });
      response.end([
        'version: 1.4.4',
        'files:',
        '  - url: CatsCo-1.4.4-mac-arm64.dmg',
        `    sha512: ${sha512('dmg')}`,
        '    size: 3',
        '  - url: CatsCo-1.4.4-mac-arm64.zip',
        `    sha512: ${sha512('zip')}`,
        '    size: 3',
        '',
      ].join('\n'));
      return;
    }

    if (request.method === 'HEAD') {
      response.writeHead(200, { 'content-length': '3' });
      response.end();
      return;
    }

    if (request.method === 'GET') {
      response.writeHead(200, { 'content-length': '3' });
      response.end('bad');
      return;
    }

    response.writeHead(404);
    response.end();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, 'object');

  try {
    await assert.rejects(
      verifyMacosUpdateArtifacts({
        'metadata-url': `http://127.0.0.1:${(address as any).port}/updates/latest-mac.yml`,
        arch: 'arm64',
      }),
      /sha512 mismatch/,
    );
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
