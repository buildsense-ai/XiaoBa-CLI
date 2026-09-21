import { afterEach, describe, test } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveReaderBaseUrl } from '../src/utils/reader-proxy';

describe('reader proxy endpoint family', () => {
  const originalEnv = { ...process.env };
  const roots: string[] = [];

  afterEach(() => {
    process.env = { ...originalEnv };
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  function writeLocalConfig(family: 'cc' | 'cn' | undefined): void {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-reader-family-'));
    roots.push(root);
    process.env.XIAOBA_USER_DATA_DIR = root;
    if (family) {
      fs.mkdirSync(path.join(root, '.xiaoba'), { recursive: true });
      fs.writeFileSync(
        path.join(root, '.xiaoba', 'catsco.json'),
        JSON.stringify({ version: 1, endpoints: { httpBaseUrl: 'https://app.catsco.cc', preferredFamily: family } }),
      );
    }
  }

  test('aligns the derived endpoint with the persisted preferred family', () => {
    delete process.env.CATSCOMPANY_READER_API_URL;
    delete process.env.READER_PROXY_URL;
    process.env.CATSCOMPANY_HTTP_BASE_URL = 'https://app.catsco.cc';
    writeLocalConfig('cn');
    assert.equal(resolveReaderBaseUrl(), 'https://app.catsco.cn/api/reader');
  });

  test('keeps the configured base when the family matches or is absent', () => {
    delete process.env.CATSCOMPANY_READER_API_URL;
    delete process.env.READER_PROXY_URL;
    process.env.CATSCOMPANY_HTTP_BASE_URL = 'https://app.catsco.cc';
    writeLocalConfig(undefined);
    assert.equal(resolveReaderBaseUrl(), 'https://app.catsco.cc/api/reader');
    writeLocalConfig('cc');
    assert.equal(resolveReaderBaseUrl(), 'https://app.catsco.cc/api/reader');
  });

  test('never rewrites non-CatsCo hosts', () => {
    delete process.env.CATSCOMPANY_READER_API_URL;
    delete process.env.READER_PROXY_URL;
    process.env.CATSCOMPANY_HTTP_BASE_URL = 'https://reader.internal.example';
    writeLocalConfig('cn');
    assert.equal(resolveReaderBaseUrl(), 'https://reader.internal.example/api/reader');
  });

  test('an explicit reader proxy override still wins', () => {
    delete process.env.CATSCOMPANY_READER_API_URL;
    process.env.READER_PROXY_URL = 'https://proxy.internal.example/api/reader';
    process.env.CATSCOMPANY_HTTP_BASE_URL = 'https://app.catsco.cc';
    writeLocalConfig('cn');
    assert.equal(resolveReaderBaseUrl(), 'https://proxy.internal.example/api/reader');
  });

  test('CATSCOMPANY_READER_API_URL still wins over family alignment', () => {
    delete process.env.READER_PROXY_URL;
    process.env.CATSCOMPANY_HTTP_BASE_URL = 'https://app.catsco.cc';
    writeLocalConfig('cn');
    process.env.CATSCOMPANY_READER_API_URL = 'https://reader.internal.example/api/reader';
    assert.equal(resolveReaderBaseUrl(), 'https://reader.internal.example/api/reader');
  });

  test('a corrupt local config never breaks the configured base', () => {
    delete process.env.CATSCOMPANY_READER_API_URL;
    delete process.env.READER_PROXY_URL;
    process.env.CATSCOMPANY_HTTP_BASE_URL = 'https://app.catsco.cc';
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoba-reader-family-'));
    roots.push(root);
    process.env.XIAOBA_USER_DATA_DIR = root;
    fs.mkdirSync(path.join(root, '.xiaoba'), { recursive: true });
    fs.writeFileSync(path.join(root, '.xiaoba', 'catsco.json'), '{not-json');
    assert.equal(resolveReaderBaseUrl(), 'https://app.catsco.cc/api/reader');
  });
});
