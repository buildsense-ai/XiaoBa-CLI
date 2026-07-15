import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const moduleUrl = pathToFileURL(
  path.join(process.cwd(), 'scripts/verify-macos-update-artifacts.mjs'),
).href;

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
      '    sha512: dmg-checksum',
      `  - url: ${zipName}`,
      '    sha512: zip-checksum',
      '',
    ].join('\n'));
    await writeFile(path.join(root, dmgName), 'dmg');
    await writeFile(path.join(root, zipName), 'zip');

    const selected = await verifyMacosUpdateArtifacts({
      metadata: metadataPath,
      'artifact-dir': root,
      arch: 'arm64',
    });

    assert.equal(selected.get('dmg'), dmgName);
    assert.equal(selected.get('zip'), zipName);
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
      '    sha512: dmg-checksum',
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
      'CatsCo-1.4.4-mac-x64.dmg',
      'CatsCo-1.4.4-mac-x64.zip',
    ], 'arm64'),
    /macOS arm64 update metadata is missing a \.dmg file/,
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
        '  - url: CatsCo-1.4.4-mac-arm64.zip',
        '',
      ].join('\n'));
      return;
    }

    if (request.method === 'HEAD' && /^\/updates\/CatsCo-1\.4\.4-mac-arm64\.(dmg|zip)$/.test(request.url || '')) {
      response.writeHead(200);
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
  const metadataUrl = `http://127.0.0.1:${(address as any).port}/updates/latest-mac.yml`;

  try {
    await verifyMacosUpdateArtifacts({
      'metadata-url': metadataUrl,
      arch: 'arm64',
    });
    assert.deepEqual(requests, [
      'GET /updates/latest-mac.yml',
      'HEAD /updates/CatsCo-1.4.4-mac-arm64.dmg',
      'HEAD /updates/CatsCo-1.4.4-mac-arm64.zip',
    ]);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
